// JARVIS Phase 3 — relevance-first memory candidates.
//
// The old path fetched the 20 newest memories/facts and ranked only those, so
// an old-but-relevant fact could never be recalled. This service widens the
// candidate pool with the existing MongoDB text indexes, then merges pinned /
// recent records. It is intentionally deterministic and additive: if a text
// index is missing or Mongo fails, callers fall back to the same recency pool
// they used before.
const AIMemory = require('../models/AIMemory');
const UserFact = require('../models/UserFact');

const MAX_QUERY_CHARS = 220;

const buildTextSearch = (query) => {
  const text = String(query || '').replace(/\u0000/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
  return text ? { $text: { $search: text } } : null;
};

const findRelevant = async ({ Model, filter, query, timeField, limit }) => {
  const search = buildTextSearch(query);
  if (!search) return [];
  try {
    return await Model.find(
      { ...filter, ...search },
      { score: { $meta: 'textScore' } }
    )
      .sort({ score: { $meta: 'textScore' }, pinned: -1, [timeField]: -1 })
      .limit(limit)
      .lean();
  } catch (error) {
    // A missing text index (fresh DB / migration window) must never break a
    // chat turn. Recency candidates below still provide the old behaviour.
    console.warn('[MemoryRetrieval] text search unavailable:', error?.message || error);
    return [];
  }
};

const mergeCandidates = (relevant, recent) => {
  const seen = new Set();
  const merged = [];
  for (const doc of [...(relevant || []), ...(recent || [])]) {
    if (!doc || !doc._id) continue;
    const key = String(doc._id);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(doc);
  }
  return merged;
};

const loadCandidates = async ({
  Model,
  userId,
  workspaceId = null,
  query = '',
  timeField = 'createdAt',
  recentLimit = 20,
  relevantLimit = 20,
}) => {
  if (!userId) return [];
  // Preserve the existing isolation contract exactly: null means the global
  // workspace, never "all workspaces".
  const filter = { userId, workspaceId: workspaceId || null };
  const [relevant, recent] = await Promise.all([
    findRelevant({ Model, filter, query, timeField, limit: relevantLimit }),
    Model.find(filter)
      .sort({ pinned: -1, [timeField]: -1 })
      .limit(recentLimit)
      .lean(),
  ]);
  return mergeCandidates(relevant, recent);
};

const loadMemoryCandidates = (options = {}) => loadCandidates({
  ...options,
  Model: AIMemory,
  timeField: 'timestamp',
});

const loadFactCandidates = (options = {}) => loadCandidates({
  ...options,
  Model: UserFact,
  timeField: 'createdAt',
});

module.exports = {
  loadMemoryCandidates,
  loadFactCandidates,
  buildTextSearch,
  mergeCandidates,
};
