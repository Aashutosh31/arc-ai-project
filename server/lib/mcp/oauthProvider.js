'use strict';

// ARC bridge between MCP server configs and the official MCP TypeScript SDK
// (v2) OAuth authorization lifecycle.
//
// Roles:
//  - Silent provider  (`createSilentProvider`): attached to the
//    StreamableHTTP transport on normal connects. Supplies stored bearer
//    tokens, persists SDK-driven refreshes, and FAILS CLOSED (no browser
//    redirect) when interactive authorization is required.
//  - Interactive provider (`createInteractiveProvider`): drives the
//    start-authorization leg. Captures the authorization URL into the
//    transaction instead of redirecting (the start endpoint is XHR), and
//    completes the callback leg after state/issuer validation.
//
// Both implement the SDK `OAuthClientProvider` storage contract with secure
// server-side persistence:
//  - tokens(ctx) / saveTokens(tokens, ctx) — encrypted Mongo blob keyed by
//    (ARC user, MCP config, authorization-server issuer). The SDK stamps
//    stored tokens with `issuer`; we preserve it and key on it per RFC 6749.
//  - clientInformation(ctx) / saveClientInformation(info, ctx) — same blob,
//    so dynamically-registered client secrets never touch plaintext Mongo.
//  - discoveryState / saveDiscoveryState — transaction-scoped (SEP-2352
//    callback-leg issuer binding); persisted alongside the PKCE verifier.
//  - invalidateCredentials(scope) — scoped forgetting.
//
// Client registration follows the SDK/spec priority: CIMD first where the
// authorization server advertises support, DCR fallback for backwards
// compatibility. ARC only supplies `clientMetadata`; the SDK selects the
// mechanism.
//
// SECURITY: tokens, verifiers, codes, and client secrets never leave this
// module except inside SDK token HTTP calls. Nothing here logs credentials.

const McpOAuthCredential = require('../../models/McpOAuthCredential');
const secureTokens = require('./secureTokens');
const logger = require('./logger');

let sdk = null;
const getSdk = () => {
  if (!sdk) sdk = require('@modelcontextprotocol/client');
  return sdk;
};

// ---- URL configuration ------------------------------------------------------

const stripTrailingSlash = (s) => String(s || '').replace(/\/+$/, '');

const publicBackendBase = () => stripTrailingSlash(
  process.env.PUBLIC_BACKEND_URL
  || process.env.BACKEND_URL
  || process.env.BACKEND_BASE_URL
  || `http://localhost:${process.env.PORT || 5000}`
);

const publicFrontendBase = () => stripTrailingSlash(
  (process.env.FRONTEND_URL || '').split(',')[0]
  || process.env.PUBLIC_FRONTEND_URL
  || 'http://localhost:5173'
);

const oauthCallbackUrl = () => `${publicBackendBase()}/api/mcp/oauth/callback`;

// ---- error signalling -------------------------------------------------------

// Thrown by the silent provider when the transport needs interactive
// authorization (no tokens / refresh failed). The connection layer maps this
// to an AUTH_REQUIRED failure instead of a generic 401.
class OAuthAuthorizationRequired extends Error {
  constructor(message, { configId = null, issuer = null } = {}) {
    super(message || 'Authorization required — reconnect');
    this.name = 'OAuthAuthorizationRequired';
    this.configId = configId;
    this.issuer = issuer;
  }
}

const isOAuthAuthorizationRequired = (err) => {
  if (!err) return false;
  if (err instanceof OAuthAuthorizationRequired) return true;
  if (err?.name === 'UnauthorizedError') return true;
  // SDK OAuth failures (e.g. refresh rejected with invalid_grant) mean the
  // session cannot recover without user interaction.
  if (err?.name === 'OAuthError') return true;
  if (err?.code === 'invalid_grant' || err?.code === 'invalid_client') return true;
  const status = err?.status ?? err?.statusCode;
  if (status === 401) return true;
  const msg = String(err?.message || '');
  if (/invalid_grant|invalid_client/i.test(msg)) return true;
  return /authorization required|requires authorization|version negotiation failed/i.test(msg) && /authoriz/i.test(msg);
};

// ---- encrypted credential persistence ---------------------------------------
// Pluggable backend: Mongo (default, encrypted blob per document) or an
// injected memory backend for tests (server never hits Mongo in tests —
// blobs stay ENCRYPTED in both, so redaction/issuer tests remain meaningful).

const modelAvailable = () => {
  try {
    const mongoose = require('mongoose');
    return Boolean(McpOAuthCredential) && mongoose.connection?.readyState === 1;
  } catch {
    return false;
  }
};

const mongoBackend = {
  name: 'mongo',
  available: () => modelAvailable(),
  async findIssuer(userId, configId, issuer) {
    const doc = await McpOAuthCredential.findOne({
      userId: String(userId), configId: String(configId), issuer: String(issuer)
    }).lean();
    return doc || null;
  },
  async findLatest(userId, configId) {
    const docs = await McpOAuthCredential.find({ userId: String(userId), configId: String(configId) })
      .sort({ updatedAt: -1 }).limit(1).lean();
    return (docs && docs[0]) || null;
  },
  async upsert(userId, configId, issuer, encryptedBlob, meta) {
    await McpOAuthCredential.findOneAndUpdate(
      { userId: String(userId), configId: String(configId), issuer: String(issuer) },
      { $set: { encryptedBlob, ...meta } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  },
  async remove(userId, configId, issuer = null) {
    const filter = { userId: String(userId), configId: String(configId) };
    if (issuer) filter.issuer = String(issuer);
    const res = await McpOAuthCredential.deleteMany(filter);
    return res?.deletedCount || 0;
  },
  async listMeta(userId, configId) {
    return McpOAuthCredential.find({ userId: String(userId), configId: String(configId) })
      .select('issuer scope tokenType expiresAt clientId accountLabel lastAuthorizedAt updatedAt')
      .lean();
  },
  async count(userId, configId) {
    return McpOAuthCredential.countDocuments({ userId: String(userId), configId: String(configId) });
  }
};

const createMemoryBackend = () => {
  const store = new Map(); // `${userId}|${configId}|${issuer}` → { encryptedBlob, meta }
  const key = (u, c, i) => `${u}|${c}|${i}`;
  return {
    name: 'memory',
    available: () => true,
    async findIssuer(userId, configId, issuer) {
      const rec = store.get(key(userId, configId, issuer));
      return rec ? { encryptedBlob: rec.encryptedBlob, ...rec.meta, issuer } : null;
    },
    async findLatest(userId, configId) {
      let best = null;
      for (const [k, rec] of store) {
        const [u, c, i] = k.split('|');
        if (u !== String(userId) || c !== String(configId)) continue;
        if (!best || (rec.meta.updatedAt || 0) > (best.meta.updatedAt || 0)) {
          best = { encryptedBlob: rec.encryptedBlob, ...rec.meta, issuer: i };
        }
      }
      return best;
    },
    async upsert(userId, configId, issuer, encryptedBlob, meta) {
      store.set(key(userId, configId, issuer), {
        encryptedBlob,
        meta: { ...meta, updatedAt: Date.now() }
      });
    },
    async remove(userId, configId, issuer = null) {
      let n = 0;
      for (const k of [...store.keys()]) {
        const [u, c, i] = k.split('|');
        if (u !== String(userId) || c !== String(configId)) continue;
        if (issuer && i !== String(issuer)) continue;
        store.delete(k);
        n += 1;
      }
      return n;
    },
    async listMeta(userId, configId) {
      const out = [];
      for (const [k, rec] of store) {
        const [u, c, i] = k.split('|');
        if (u !== String(userId) || c !== String(configId)) continue;
        out.push({ issuer: i, ...rec.meta });
      }
      return out;
    },
    async count(userId, configId) {
      let n = 0;
      for (const k of store.keys()) {
        const [u, c] = k.split('|');
        if (u === String(userId) && c === String(configId)) n += 1;
      }
      return n;
    },
    _store: store
  };
};

let _backendOverride = null;
const backend = () => (_backendOverride && _backendOverride.available() ? _backendOverride : mongoBackend);

// Test hook: inject the memory backend (blobs remain encrypted).
const __setCredentialBackend = (b) => { _backendOverride = b || null; };
const __resetCredentialBackend = () => { _backendOverride = null; };
// Test hook: read the RAW persisted blob (server-side only) to assert it is
// encrypted. Never exposed through any API route.
const __readRawBlob = async (userId, configId, issuer) => {
  if (!backend().available()) return null;
  const record = issuer
    ? await backend().findIssuer(userId, configId, issuer)
    : await backend().findLatest(userId, configId);
  return record ? record.encryptedBlob : null;
};

const readBlob = (record) => {
  if (!record || !record.encryptedBlob) return null;
  try {
    return secureTokens.decryptJson(record.encryptedBlob);
  } catch {
    return null;
  }
};

// Most-recently-saved record for (user, config) — used for the transport's
// per-request bearer-token read (SDK calls tokens() with no ctx there).
const loadTokens = async (userId, configId, issuer = null) => {
  if (!backend().available()) return undefined;
  const record = issuer
    ? await backend().findIssuer(userId, configId, issuer)
    : await backend().findLatest(userId, configId);
  if (!record) return undefined;
  const blob = readBlob(record);
  const tokens = blob && blob.tokens ? blob.tokens : null;
  if (!tokens || typeof tokens !== 'object' || !tokens.access_token) return undefined;
  // Preserve the SDK issuer stamp; keying already matched it when ctx given.
  return { ...tokens };
};

const loadClientInformation = async (userId, configId, issuer = null) => {
  if (!backend().available()) return undefined;
  const record = issuer
    ? await backend().findIssuer(userId, configId, issuer)
    : await backend().findLatest(userId, configId);
  if (!record) return undefined;
  const blob = readBlob(record);
  const info = blob && blob.clientInfo ? blob.clientInfo : null;
  if (!info || typeof info !== 'object' || !info.client_id) return undefined;
  return { ...info };
};

const normalizeExpiryMs = (tokens) => {
  const raw = tokens?.expires_at ?? tokens?.expiresAt ?? null;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // SDK uses seconds-since-epoch; tolerate ms defensively.
  return n > 1e12 ? Math.floor(n) : Math.floor(n * 1000);
};

const saveTokens = async (userId, configId, tokens, ctx = null) => {
  const issuer = String(ctx?.issuer || tokens?.issuer || '');
  if (!issuer) throw new Error('Cannot persist OAuth tokens without an issuer binding.');
  const existing = await backend().findIssuer(userId, configId, issuer);
  const prevBlob = readBlob(existing) || {};
  const blob = {
    tokens: { ...tokens, issuer },
    clientInfo: prevBlob.clientInfo || null
  };
  const encryptedBlob = secureTokens.encryptJson(blob);
  const meta = {
    scope: typeof tokens?.scope === 'string' ? tokens.scope : (existing?.scope || null),
    tokenType: tokens?.token_type || existing?.tokenType || null,
    expiresAt: normalizeExpiryMs(tokens),
    lastAuthorizedAt: new Date()
  };
  await backend().upsert(userId, configId, issuer, encryptedBlob, meta);
  logger.log(logger.LOG_EVENTS.OAUTH_TOKENS_SAVED, { configId: String(configId), scope: meta.scope });
};

const saveClientInformation = async (userId, configId, info, ctx = null) => {
  const issuer = String(ctx?.issuer || info?.issuer || '');
  if (!issuer) throw new Error('Cannot persist OAuth client information without an issuer binding.');
  const existing = await backend().findIssuer(userId, configId, issuer);
  const prevBlob = readBlob(existing) || {};
  const stamped = { ...info, issuer };
  const blob = { tokens: prevBlob.tokens || null, clientInfo: stamped };
  const encryptedBlob = secureTokens.encryptJson(blob);
  await backend().upsert(userId, configId, issuer, encryptedBlob, {
    scope: existing?.scope || null,
    tokenType: existing?.tokenType || null,
    expiresAt: existing?.expiresAt ?? null,
    clientId: info?.client_id || existing?.clientId || null,
    accountLabel: existing?.accountLabel || null,
    lastAuthorizedAt: existing?.lastAuthorizedAt || new Date()
  });
};

const deleteCredentials = async (userId, configId, issuer = null) => {
  if (!backend().available()) return 0;
  return backend().remove(userId, configId, issuer);
};

const hasCredentials = async (userId, configId) => {
  if (!backend().available()) return false;
  const count = await backend().count(userId, configId);
  return count > 0;
};

// Safe metadata only — never tokens, verifiers, codes, or secrets.
const credentialStatus = async (userId, configId) => {
  if (!backend().available()) {
    return { authorized: false, reason: secureTokens.isEncryptionAvailable() ? 'no_credentials' : 'encryption_unavailable' };
  }
  const records = await backend().listMeta(userId, configId);
  if (!records.length) return { authorized: false, reason: 'no_credentials' };
  const nowMs = Date.now();
  const servers = records.map((d) => {
    const expired = typeof d.expiresAt === 'number' ? d.expiresAt <= nowMs : null;
    return {
      issuer: d.issuer,
      scope: d.scope || null,
      tokenType: d.tokenType || null,
      expiresAt: d.expiresAt || null,
      expired,
      clientId: d.clientId || null,
      accountLabel: d.accountLabel || null,
      lastAuthorizedAt: d.lastAuthorizedAt || null
    };
  });
  const anyValid = servers.some((s) => s.expired === false || s.expired === null);
  return {
    authorized: anyValid,
    expired: !anyValid,
    authorizationServers: servers.map((s) => s.issuer),
    scopes: [...new Set(servers.map((s) => s.scope).filter(Boolean))],
    lastAuthorizedAt: servers.reduce((acc, s) => {
      const t = s.lastAuthorizedAt ? new Date(s.lastAuthorizedAt).getTime() : 0;
      return t > acc ? t : acc;
    }, 0) || null,
    servers
  };
};

// ---- provider ---------------------------------------------------------------

const defaultClientMetadata = (scope) => ({
  client_name: 'ARC MCP Client',
  redirect_uris: [oauthCallbackUrl()],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  ...(scope ? { scope } : {}),
  token_endpoint_auth_method: 'none'
});

class ArcOAuthProvider {
  constructor({ userId, config, transaction = null, onRedirect = null, failClosed = false } = {}) {
    if (!userId) throw new Error('ArcOAuthProvider requires userId.');
    if (!config) throw new Error('ArcOAuthProvider requires config.');
    this._userId = String(userId);
    this._config = config;
    this._tx = transaction; // in-memory tx record (interactive flow) or null
    this._onRedirect = typeof onRedirect === 'function' ? onRedirect : null;
    this._failClosed = failClosed === true;
    const rawScope = config.oauthScope || (transaction && transaction.scope) || null;
    this._scope = rawScope || undefined;
  }

  get redirectUrl() {
    return oauthCallbackUrl();
  }

  get clientMetadata() {
    return defaultClientMetadata(this._scope);
  }

  // Client ID Metadata Document (CIMD) URL. When the deployment configures
  // MCP_OAUTH_CLIENT_METADATA_URL *and* the authorization server advertises
  // `client_id_metadata_document_supported`, the SDK prefers CIMD; otherwise
  // it falls back to Dynamic Client Registration. Unset by default.
  get clientMetadataUrl() {
    const url = (process.env.MCP_OAUTH_CLIENT_METADATA_URL || '').trim();
    return url || undefined;
  }

  async state() {
    if (this._tx && this._tx.state) return this._tx.state;
    if (this._failClosed) throw new OAuthAuthorizationRequired('Authorization required — reconnect', { configId: this._config.id });
    throw new Error('OAuth state is unavailable outside an authorization transaction.');
  }

  async clientInformation(ctx) {
    return loadClientInformation(this._userId, this._config.id, ctx?.issuer || null);
  }

  async saveClientInformation(info, ctx) {
    await saveClientInformation(this._userId, this._config.id, info, ctx || null);
  }

  async tokens(ctx) {
    return loadTokens(this._userId, this._config.id, ctx?.issuer || null);
  }

  async saveTokens(tokens, ctx) {
    await saveTokens(this._userId, this._config.id, tokens, ctx || null);
  }

  async redirectToAuthorization(authorizationUrl) {
    const url = String(authorizationUrl);
    if (this._tx) {
      this._tx.authorizationUrl = url;
    }
    if (this._onRedirect) {
      await this._onRedirect(url);
      return;
    }
    if (this._failClosed) {
      throw new OAuthAuthorizationRequired('Authorization required — reconnect', { configId: this._config.id });
    }
    throw new OAuthAuthorizationRequired('Authorization required — reconnect', { configId: this._config.id });
  }

  async saveCodeVerifier(verifier) {
    if (this._tx) {
      this._tx.codeVerifier = String(verifier);
      return;
    }
    throw new Error('No authorization transaction is active for this provider.');
  }

  async codeVerifier() {
    if (this._tx && this._tx.codeVerifier) return this._tx.codeVerifier;
    throw new Error('PKCE code verifier is unavailable (transaction expired or already consumed).');
  }

  async saveDiscoveryState(state) {
    if (this._tx) {
      this._tx.discoveryState = state || null;
      const issuer = state?.authorizationServerMetadata?.issuer || state?.issuer || null;
      if (issuer && !this._tx.issuer) this._tx.issuer = String(issuer);
    }
  }

  async discoveryState() {
    if (this._tx) return this._tx.discoveryState || undefined;
    return undefined;
  }

  async invalidateCredentials(scope) {
    if (scope === 'all' || scope === 'tokens') {
      // Remove token material but keep the registered client where possible.
      // Simplest correct behavior: delete credential docs (client re-registers
      // via DCR on next authorization; CIMD needs no stored secret).
      await deleteCredentials(this._userId, this._config.id);
    } else if (scope === 'client') {
      await deleteCredentials(this._userId, this._config.id);
    }
    if (this._tx) {
      if (scope === 'all' || scope === 'verifier') this._tx.codeVerifier = null;
      if (scope === 'all' || scope === 'discovery') this._tx.discoveryState = null;
    }
  }
}

const createSilentProvider = ({ userId, config } = {}) =>
  new ArcOAuthProvider({ userId, config, transaction: null, onRedirect: null, failClosed: true });

const createInteractiveProvider = ({ userId, config, transaction, onRedirect } = {}) => {
  if (!transaction) throw new Error('Interactive OAuth provider requires a transaction.');
  return new ArcOAuthProvider({ userId, config, transaction, onRedirect, failClosed: false });
};

// ---- SDK discovery helpers (used by routes for pre-flight/status) ------------

const discoverProtectedResource = async (serverUrl) => {
  const sdkMod = getSdk();
  return sdkMod.discoverOAuthProtectedResourceMetadata(serverUrl);
};

const discoverAuthServer = async (serverUrl, { resourceMetadataUrl = undefined } = {}) => {
  const sdkMod = getSdk();
  return sdkMod.discoverAuthorizationServerMetadata(serverUrl, { resourceMetadataUrl });
};

module.exports = {
  publicBackendBase,
  publicFrontendBase,
  oauthCallbackUrl,
  OAuthAuthorizationRequired,
  isOAuthAuthorizationRequired,
  modelAvailable,
  createMemoryBackend,
  __setCredentialBackend,
  __resetCredentialBackend,
  __readRawBlob,
  loadTokens,
  loadClientInformation,
  saveTokens,
  saveClientInformation,
  deleteCredentials,
  hasCredentials,
  credentialStatus,
  defaultClientMetadata,
  ArcOAuthProvider,
  createSilentProvider,
  createInteractiveProvider,
  discoverProtectedResource,
  discoverAuthServer
};
