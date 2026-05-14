const crypto = require('crypto');

const embeddingCache = new Map();
const MAX_CACHE_SIZE = 200;

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

const getEmbedding = async (text, { signal } = {}) => {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const key = cacheKeyFor(normalized);
  const cached = embeddingCache.get(key);
  if (cached) return cached;

  const response = await fetch('https://api.mistral.ai/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'mistral-embed',
      input: [normalized]
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(`Embedding request failed with status ${response.status}`);
  }

  const data = await response.json();
  const vector = data?.data?.[0]?.embedding || null;
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
