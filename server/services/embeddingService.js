const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');

const embeddingCache = new Map();
const MAX_CACHE_SIZE = 200;

// Gemini is ARC's embedding provider (Mistral was removed from the
// runtime). The model + output width are configurable; the default width
// preserves the 1024-dimensional space the existing Pinecone index was
// built for, so stored vectors stay comparable without a re-index.
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const EMBEDDING_DIMENSIONS = Math.max(64, Number(process.env.GEMINI_EMBEDDING_DIMENSIONS) || 1024);

const normalizeText = (text) => String(text || '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 4000);

const cacheKeyFor = (text) => crypto.createHash('sha1').update(normalizeText(text)).digest('hex');

const evictOldCacheEntries = () => {
  if (embeddingCache.size <= MAX_CACHE_SIZE) return;
  const keys = Array.from(embeddingCache.keys());
  for (let index = 0; index < Math.ceil(MAX_CACHE_SIZE * 0.25); index += 1) {
    embeddingCache.delete(keys[index]);
  }
};

let warnedMissingKey = false;

const getEmbedding = async (text, { signal } = {}) => {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const key = cacheKeyFor(normalized);
  const cached = embeddingCache.get(key);
  if (cached) return cached;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Graceful degradation (same contract as the Pinecone-disabled path):
    // callers treat a null vector as "skip vector search", so the server
    // boots and answers from MongoDB-only retrieval.
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn('[Embeddings] GEMINI_API_KEY is not defined. Semantic vector search is disabled; retrieval falls back to MongoDB only.');
    }
    return null;
  }

  if (signal?.aborted) return null;

  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: [{ parts: [{ text: normalized }] }],
    config: {
      taskType: 'SEMANTIC_SIMILARITY',
      outputDimensionality: EMBEDDING_DIMENSIONS
    }
  });

  const vector = response?.embeddings?.[0]?.values || null;
  if (!Array.isArray(vector)) {
    throw new Error('Embedding response did not include a valid vector.');
  }

  embeddingCache.set(key, vector);
  evictOldCacheEntries();
  return vector;
};

module.exports = {
  getEmbedding,
  normalizeText,
  cacheKeyFor
};
