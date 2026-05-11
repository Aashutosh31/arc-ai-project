const fs = require('fs');
const path = require('path');

const providers = new Map();

const registerProvider = (provider) => {
  if (!provider) return;

  const providerId = String(provider.id || provider.providerId || provider.name || '').trim().toLowerCase();
  if (!providerId || typeof provider.generate !== 'function') return;

  providers.set(providerId, provider);

  if (Array.isArray(provider.aliases)) {
    for (const alias of provider.aliases) {
      const normalizedAlias = String(alias || '').trim().toLowerCase();
      if (normalizedAlias) {
        providers.set(normalizedAlias, provider);
      }
    }
  }
};

const loadProviders = (dir) => {
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir);

  for (const file of files) {
    const fullPath = path.join(dir, file);

    if (fs.statSync(fullPath).isDirectory()) {
      loadProviders(fullPath);
      continue;
    }

    if (!file.endsWith('.js') || file === 'index.js' || file === 'utils.js') continue;

    try {
      const provider = require(fullPath);
      registerProvider(provider);
      if (provider?.id) {
        console.log(`[LLM Provider Registry] Loaded provider: ${provider.id}`);
      }
    } catch (error) {
      console.error(`[LLM Provider Registry] Failed to load provider at ${fullPath}:`, error.message);
    }
  }
};

loadProviders(__dirname);

const getProvider = (name) => providers.get(String(name || '').trim().toLowerCase());

const listProviders = () => {
  const uniqueProviders = new Map();

  for (const [key, provider] of providers.entries()) {
    if (provider && provider.id) {
      uniqueProviders.set(provider.id, provider);
    } else {
      uniqueProviders.set(key, provider);
    }
  }

  return Array.from(uniqueProviders.values()).sort((left, right) => {
    const leftPriority = Number(right?.priority || 0);
    const rightPriority = Number(left?.priority || 0);
    return rightPriority - leftPriority;
  });
};

const getAvailableProviders = () => listProviders().filter((provider) => {
  if (!provider) return false;
  if (typeof provider.isAvailable !== 'function') return true;
  try {
    return Boolean(provider.isAvailable());
  } catch (error) {
    console.warn(`[LLM Provider Registry] Availability check failed for ${provider.id}:`, error.message);
    return false;
  }
});

module.exports = {
  getAvailableProviders,
  getProvider,
  listProviders,
  registerProvider
};