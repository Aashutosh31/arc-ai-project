const { Pinecone } = require('@pinecone-database/pinecone');
const crypto = require('crypto');
const { getEmbedding, normalizeText, cacheKeyFor } = require('./embeddingService');

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pinecone.index(process.env.PINECONE_INDEX || 'arc-brain');

const getNamespace = (userId) => `user_${String(userId)}`;

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

const upsertTextVector = async ({ userId, kind, entityId, text, metadata = {}, signal = null }) => {
  if (!shouldIndexText(text)) return { skipped: true };

  const vector = await getEmbedding(text, { signal });
  if (!vector) return { skipped: true };

  const namespace = getNamespace(userId);
  const id = makeVectorId(kind, entityId, text);

  await index.upsert({
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

const removeVectorsByEntity = async ({ userId, kind, entityId }) => {
  const namespace = getNamespace(userId);
  const prefix = `${kind}_${String(entityId)}_`;

  try {
    const stats = await index.describeIndexStats({ namespace });
    const namespaces = stats?.namespaces || {};
    if (!namespaces[namespace]) return { success: true, deleted: 0 };
  } catch {
    // Best-effort cleanup; ignore if stats unavailable.
  }

  try {
    await index.deleteMany({ namespace, filter: { userId: String(userId), kind, entityId: String(entityId) } });
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
