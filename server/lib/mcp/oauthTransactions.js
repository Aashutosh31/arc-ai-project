'use strict';

// Short-lived, single-use OAuth authorization transactions (in-memory only,
// never persisted).
//
// The OAuth callback itself may not carry a normal logged-in browser session,
// so the callback is authorized by a transaction identifier instead. Each
// transaction is bound to:
//   - authenticated initiating ARC user (userId)
//   - MCP server config (configId) + workspace context
//   - authorization server issuer (once discovered)
//   - OAuth `state` (CSRF) + PKCE code verifier
//   - expiry timestamp
//
// Security properties:
//  - Transactions expire (default 10 minutes) and are single-use: the first
//    callback leg consumes the record; replays fail.
//  - The user is NEVER identified from user-controlled callback parameters.
//    The callback resolves userId/configId from the server-side record keyed
//    by the opaque transaction id embedded in `state`.
//  - No tokens, codes, or secrets are logged (see logger SAFE_FIELDS — only
//    ids and expiries are surfaced).

const crypto = require('crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;

// txId → record. In-memory by design: authorization handshakes must not
// survive process restarts (stale verifiers would be unusable anyway).
const _transactions = new Map();

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

const now = () => Date.now();

const pruneExpired = () => {
  const t = now();
  for (const [id, rec] of _transactions) {
    if (!rec || rec.expiresAt <= t) _transactions.delete(id);
  }
};

// Creates a transaction. `state` embeds the tx id (`<txId>.<random>`) so the
// provider redirect_uri stays stable and no custom redirect_uri query params
// are needed for user binding.
const createTransaction = ({
  userId,
  configId,
  workspaceId = null,
  scope = null,
  ttlMs = DEFAULT_TTL_MS
} = {}) => {
  if (!userId) throw new Error('OAuth transaction requires a userId.');
  if (!configId) throw new Error('OAuth transaction requires a configId.');
  pruneExpired();
  const txId = `mcp_oauth_${randomToken(16)}`;
  const state = `${txId}.${randomToken(24)}`;
  const record = {
    txId,
    state,
    userId: String(userId),
    configId: String(configId),
    workspaceId: workspaceId ? String(workspaceId) : null,
    scope: scope || null,
    issuer: null,
    resourceMetadataUrl: null,
    authorizationServerUrl: null,
    authorizationUrl: null,
    codeVerifier: null,
    discoveryState: null,
    createdAt: now(),
    expiresAt: now() + ttlMs,
    consumed: false
  };
  _transactions.set(txId, record);
  return record;
};

const getTransaction = (txId) => {
  if (!txId) return null;
  const rec = _transactions.get(String(txId));
  if (!rec) return null;
  if (rec.expiresAt <= now() || rec.consumed) {
    _transactions.delete(String(txId));
    return null;
  }
  return rec;
};

// Constant-time state comparison (CSRF protection). Never throws.
const statesEqual = (a, b) => {
  try {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
};

// RFC 9207 issuer pre-check BEFORE redeeming the code. Returns true when the
// callback may proceed: no `iss` param, or it matches the recorded issuer.
const issuerMatches = (record, iss) => {
  if (!iss) return true;
  if (!record || !record.issuer) return true;
  return String(iss) === String(record.issuer);
};
// Extracts the tx id from a callback `state` value WITHOUT trusting it:
// callers must still load the record and compare the full state string.
const txIdFromState = (state) => {
  if (typeof state !== 'string' || !state) return null;
  const dot = state.indexOf('.');
  if (dot <= 0) return null;
  const txId = state.slice(0, dot);
  if (!txId.startsWith('mcp_oauth_')) return null;
  return txId;
};

const updateTransaction = (txId, patch = {}) => {
  const rec = getTransaction(txId);
  if (!rec) return null;
  Object.assign(rec, patch);
  return rec;
};

// Single-use consumption. Returns the record and removes it so replays fail.
const consumeTransaction = (txId) => {
  const rec = getTransaction(txId);
  if (!rec) return null;
  _transactions.delete(String(txId));
  return { ...rec, consumed: true };
};

const deleteTransaction = (txId) => {
  _transactions.delete(String(txId));
};

const transactionExpired = (rec) => !rec || rec.expiresAt <= now();

// Test hook: deterministic short TTLs without waiting.
const _clearAll = () => _transactions.clear();

module.exports = {
  DEFAULT_TTL_MS,
  createTransaction,
  getTransaction,
  txIdFromState,
  statesEqual,
  issuerMatches,
  updateTransaction,
  consumeTransaction,
  deleteTransaction,
  transactionExpired,
  _clearAll,
  _store: _transactions
};
