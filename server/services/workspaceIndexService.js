const { Pinecone } = require('@pinecone-database/pinecone');
const crypto = require('crypto');
const { getEmbedding, normalizeText, cacheKeyFor } = require('./embeddingService');

let pineconeClient = null;
let pineconeIndex = null;
let warnedMissingPineconeKey = false;

// Lazily create the Pinecone client on first use so the server can boot when
// PINECONE_API_KEY is unconfigured. Index writes/deletes become no-ops that
// report { skipped: true }; callers already treat failures as non-fatal.
const getPineconeIndex = () => {
    if (pineconeIndex) return pineconeIndex;
    const apiKey = process.env.PINECONE_API_KEY;
    if (!apiKey) {
        if (!warnedMissingPineconeKey) {
            warnedMissingPineconeKey = true;
            console.warn('[WorkspaceIndex] PINECONE_API_KEY is not defined. Vector indexing is disabled; data remains in MongoDB only.');
        }
        return null;
    }
    pineconeClient = pineconeClient || new Pinecone({ apiKey });
    pineconeIndex = pineconeIndex || pineconeClient.index(process.env.PINECONE_INDEX || 'arc-brain');
    return pineconeIndex;
};

const getNamespace = (userId, workspaceId = null) => (workspaceId ? `workspace_${String(workspaceId)}` : `user_${String(userId)}`);

const makeVectorId = (kind, entityId, text) => {
  const suffix = crypto.createHash('sha1').update(normalizeText(text)).digest('hex').slice(0, 12);
  return `${kind}_${String(entityId)}_${suffix}`;
};

const shouldIndexText = (text) => {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (normalized.length < 24) return false;
  return true;
};

const upsertTextVector = async ({ userId, kind, entityId, text, metadata = {}, signal = null, workspaceId = null }) => {
  if (!shouldIndexText(text)) return { skipped: true };

  const vector = await getEmbedding(text, { signal });
  if (!vector) return { skipped: true };

  const targetIndex = getPineconeIndex();
  if (!targetIndex) return { skipped: true };

  const namespace = getNamespace(userId, workspaceId);
  const id = makeVectorId(kind, entityId, text);

  await targetIndex.upsert({
    records: [
      {
        id,
        values: vector,
        metadata: {
          userId: String(userId),
          kind,
          entityId: String(entityId),
          text: normalizeText(text).slice(0, 1000),
          cacheKey: cacheKeyFor(text),
          timestamp: new Date().toISOString(),
          ...metadata
        }
      }
    ],
    namespace
  });

  return { success: true, id, namespace };
};

const removeVectorsByEntity = async ({ userId, kind, entityId, workspaceId = null }) => {
  const targetIndex = getPineconeIndex();
  if (!targetIndex) return { skipped: true };

  const namespace = getNamespace(userId, workspaceId);
  const prefix = `${kind}_${String(entityId)}_`;

  try {
    const stats = await targetIndex.describeIndexStats({ namespace });
    const namespaces = stats?.namespaces || {};
    if (!namespaces[namespace]) return { success: true, deleted: 0 };
  } catch {
    // Best-effort cleanup; ignore if stats unavailable.
  }

  try {
    await targetIndex.deleteMany({ namespace, filter: { userId: String(userId), kind, entityId: String(entityId) } });
  } catch (error) {
    console.warn('[WorkspaceIndex] deleteMany fallback failed:', error?.message || error);
  }

  return { success: true, prefix };
};

module.exports = {
  upsertTextVector,
  removeVectorsByEntity,
  getNamespace
};
