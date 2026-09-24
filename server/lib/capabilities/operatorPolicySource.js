'use strict';

// JARVIS Action Substrate — slice 4E item 2: Mongo-backed authoritative
// operator policy source with bounded runtime refresh.
//
// Layering (boundaries unchanged):
//   authorizationPolicy.js  — PURE verdict engine. No storage, no I/O.
//                             Never learns about Mongo.
//   operatorPolicy.js       — the process-local knob TaskExecutor already
//                             reads on every execution (in-process only;
//                             zero DB round trips per request).
//   operatorPolicySource.js — THIS module: the single authoritative store
//                             behind the knob. Loads/upserts THE ONE
//                             OperatorPolicy document, validates it, and
//                             hydrates operatorPolicy.setOperatorPolicy.
// There is exactly one policy authority: the unique-key OperatorPolicy
// document, read/written only here.
//
// Freshness bound: while the bounded timer runs, the in-process policy is
// refreshed at least every FRESHNESS_BOUND_MS (default 60s, override with
// OPERATOR_POLICY_REFRESH_MS, floor 1s). An operator PUT applies to the
// in-process policy immediately (no timer wait). Between refreshes,
// executions read only the cached policy — no per-request Mongo access
// exists anywhere in the execution path.
//
// Failure behavior (documented, all preserve last-known-good):
//   - Mongo unavailable during refresh  -> ok:false, lastError
//     'mongo-unavailable'; connection state is checked BEFORE issuing a
//     query so a disconnected server fails fast instead of buffering.
//   - Malformed persisted document      -> ok:false, lastError
//     'malformed-persisted'; the bad document is NOT applied and NOT
//     overwritten (an operator PUT repairs it).
//   - Missing document                  -> re-created from the guest-deny
//     defaults via upsert (unique key prevents duplicates; an E11000
//     concurrent-insert race retries as a plain update).
//   - A refresh read that races an operator write is discarded via a
//     revision check, so a stale read can never clobber newer in-process
//     state.
//   - Operator PUTs are serialized through an in-process write chain:
//     last writer wins for BOTH the persisted document and the in-process
//     policy, and a failed persist never touches the in-process policy.

const operatorPolicy = require('./operatorPolicy');

const POLICY_KEY = 'operator-policy';

// Default freshness bound: one minute. Operator PUTs bypass this bound by
// applying immediately; the bound only governs interval/on-demand refresh.
const FRESHNESS_BOUND_MS = 60 * 1000;
const ENV_REFRESH_MS = 'OPERATOR_POLICY_REFRESH_MS';

const ERR = Object.freeze({
  UNAVAILABLE: 'mongo-unavailable',
  MALFORMED: 'malformed-persisted',
});

class PolicyValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyValidationError';
    this.code = 'MALFORMED_POLICY';
  }
}

// The model is required lazily-bound at module load; tests swap it through
// require.cache BEFORE requiring this module (same pattern as the credit
// service stub).
const OperatorPolicy = require('../../models/OperatorPolicy');

// ---- validation -------------------------------------------------------------
// Strict, whitelist-only. Rejects unknown fields (this is also the "no
// arbitrary Mongo operators from the request body" guard: any '$…' key is an
// unknown field), validates every value, and returns a FRESH object with only
// the three policy fields — callers never receive references into the input.

const POLICY_FIELDS = ['guestDenied', 'workspaceRestricted', 'entries'];
const STORE_META_FIELDS = ['_id', 'key', 'updatedAt', '__v'];

// native:wireName  |  mcp.slug.tool  (matches discover.js id derivation)
const CAP_ID_RE = /^(native:[A-Za-z0-9_]{1,128}|mcp\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{1,256})$/;
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENTRY_NAME_RE = /^[A-Za-z0-9_.-]{1,256}$/;
const ENTRY_ACTIONS = ['auto', 'approval_required', 'deny', 'unspecified'];

const MAX_LIST = 1000;
const MAX_STRING = 256;

const fail = (message) => {
  throw new PolicyValidationError(message);
};

const assertPlainObject = (value, what) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${what} must be a plain object`);
  }
};

const rejectDollarKeys = (obj, where) => {
  for (const key of Object.keys(obj)) {
    if (typeof key === 'string' && key.startsWith('$')) {
      fail(`mongo operator key "${key}" is not accepted at ${where}`);
    }
  }
};

const rejectUnknownKeys = (obj, allowed, where) => {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    fail(`unknown policy field(s) at ${where}: ${unknown.join(', ')}`);
  }
};

const requireString = (value, what, re, maxLen = MAX_STRING) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLen) {
    fail(`${what} must be a non-empty string of at most ${maxLen} characters`);
  }
  if (re && !re.test(value)) {
    fail(`${what} is not in a recognized format: ${JSON.stringify(value)}`);
  }
  return value;
};

/**
 * Validate + normalize a policy object.
 *  - fromStore:false — request body / in-memory candidate: exactly the three
 *    policy fields, all required (PUT is a full replace).
 *  - fromStore:true  — a persisted OperatorPolicy document: the three policy
 *    fields plus the store's meta fields, all tolerated; a missing policy
 *    field counts as malformed/partial and is rejected (never hydrate a
 *    partial document over a good in-process policy).
 * Throws PolicyValidationError (code MALFORMED_POLICY) on any problem.
 * Always returns a freshly-built object.
 */
const validatePolicyShape = (input, { fromStore = false } = {}) => {
  assertPlainObject(input, 'policy');
  rejectDollarKeys(input, 'policy');
  const allowed = fromStore ? POLICY_FIELDS.concat(STORE_META_FIELDS) : POLICY_FIELDS;
  rejectUnknownKeys(input, allowed, 'policy');
  if (fromStore && input.key !== undefined && input.key !== POLICY_KEY) {
    fail(`policy document key mismatch: ${JSON.stringify(input.key)}`);
  }

  for (const field of POLICY_FIELDS) {
    if (input[field] === undefined || input[field] === null) {
      fail(`policy.${field} is required`);
    }
  }

  if (!Array.isArray(input.guestDenied)) fail('policy.guestDenied must be an array');
  if (input.guestDenied.length > MAX_LIST) fail(`policy.guestDenied exceeds ${MAX_LIST} items`);
  const guestDenied = input.guestDenied.map((id, i) =>
    requireString(id, `policy.guestDenied[${i}]`, CAP_ID_RE, 512)
  );

  if (!Array.isArray(input.workspaceRestricted)) {
    fail('policy.workspaceRestricted must be an array');
  }
  if (input.workspaceRestricted.length > MAX_LIST) {
    fail(`policy.workspaceRestricted exceeds ${MAX_LIST} items`);
  }
  const workspaceRestricted = input.workspaceRestricted.map((rule, i) => {
    const at = `policy.workspaceRestricted[${i}]`;
    assertPlainObject(rule, at);
    rejectDollarKeys(rule, at);
    rejectUnknownKeys(rule, ['id', 'workspaceIds'], at);
    let id = null;
    if (rule.id !== undefined && rule.id !== null) {
      id = requireString(rule.id, `${at}.id`, CAP_ID_RE, 512);
    }
    if (!Array.isArray(rule.workspaceIds)) fail(`${at}.workspaceIds must be an array`);
    if (rule.workspaceIds.length > MAX_LIST) fail(`${at}.workspaceIds exceeds ${MAX_LIST} items`);
    const workspaceIds = rule.workspaceIds.map((ws, j) =>
      requireString(ws, `${at}.workspaceIds[${j}]`, WORKSPACE_ID_RE)
    );
    return { id, workspaceIds };
  });

  if (!Array.isArray(input.entries)) fail('policy.entries must be an array');
  if (input.entries.length > MAX_LIST) fail(`policy.entries exceeds ${MAX_LIST} items`);
  const entries = input.entries.map((entry, i) => {
    const at = `policy.entries[${i}]`;
    assertPlainObject(entry, at);
    rejectDollarKeys(entry, at);
    rejectUnknownKeys(entry, ['id', 'source', 'name', 'action', 'reason'], at);
    if (typeof entry.action !== 'string' || !ENTRY_ACTIONS.includes(entry.action)) {
      fail(`${at}.action must be one of ${ENTRY_ACTIONS.join(', ')}`);
    }
    const hasId = entry.id !== undefined && entry.id !== null;
    const hasSource = entry.source !== undefined && entry.source !== null;
    const hasName = entry.name !== undefined && entry.name !== null;
    if (!hasId && !(hasSource && hasName)) {
      fail(`${at} needs an id, or both source and name`);
    }
    const clean = { id: null, source: null, name: null, action: entry.action, reason: null };
    if (hasId) clean.id = requireString(entry.id, `${at}.id`, CAP_ID_RE, 512);
    if (hasSource) {
      if (entry.source !== 'native' && entry.source !== 'mcp') {
        fail(`${at}.source must be "native" or "mcp"`);
      }
      clean.source = entry.source;
    }
    if (hasName) clean.name = requireString(entry.name, `${at}.name`, ENTRY_NAME_RE);
    if (entry.reason !== undefined && entry.reason !== null) {
      clean.reason = requireString(entry.reason, `${at}.reason`, null, MAX_STRING);
    }
    return clean;
  });

  return { guestDenied, workspaceRestricted, entries };
};

// The default document: current guest-deny defaults, empty operator entries.
const defaultPolicyDocument = () => ({
  guestDenied: [...operatorPolicy.GUEST_DENY_DEFAULTS],
  workspaceRestricted: [],
  entries: [],
});

// ---- module state -----------------------------------------------------------

let inFlight = null;            // single-flight refresh/hydrate promise
let writeChain = Promise.resolve(); // serializes operator PUTs
let refreshTimer = null;
let timerIntervalMs = null;
let revision = 0;               // bumped on every in-process apply
let lastLoadedAt = null;        // last successful apply
let lastAttemptAt = null;       // last refresh/PUT attempt
let lastError = null;           // null | 'mongo-unavailable' | 'malformed-persisted'
let hydratedFromStore = false;  // false => still the in-memory seeded base

const ERR_STORE_UNAVAILABLE = 'POLICY_STORE_UNAVAILABLE';
const ERR_STORE_FAILED = 'POLICY_STORE_ERROR';

// Real mongoose models expose .db (the connection) — use it to fail fast
// while disconnected instead of letting queries buffer for 10s. A stub model
// without .db is assumed ready.
const storeReady = () => {
  const conn = OperatorPolicy && OperatorPolicy.db;
  if (conn && typeof conn.readyState === 'number') return conn.readyState === 1;
  return true;
};

const isConnectionError = (err) => {
  const name = err && err.name;
  return (
    name === 'MongooseServerSelectionError' ||
    name === 'MongoNetworkError' ||
    name === 'MongoNotConnectedError' ||
    name === 'BufferingTimeoutError' ||
    (typeof err.code === 'number' && err.code === 50)
  );
};

const applyPolicy = (clean, source) => {
  operatorPolicy.setOperatorPolicy(clean);
  revision += 1;
  lastLoadedAt = Date.now();
  lastError = null;
  hydratedFromStore = source !== 'seed';
};

// ---- refresh / hydrate (single-flight) --------------------------------------

const runRefresh = async (reason = 'on-demand') => {
  if (inFlight) return inFlight;

  const revStart = revision;
  lastAttemptAt = Date.now();

  const run = (async () => {
    if (!storeReady()) {
      lastError = ERR.UNAVAILABLE;
      return { ok: false, reason: ERR.UNAVAILABLE, refreshedFor: reason, preserved: true };
    }

    let doc;
    try {
      doc = await OperatorPolicy.findOne({ key: POLICY_KEY }).lean();
    } catch (err) {
      lastError = ERR.UNAVAILABLE;
      return {
        ok: false,
        reason: ERR.UNAVAILABLE,
        refreshedFor: reason,
        preserved: true,
        error: String(err && err.message ? err.message : err),
      };
    }

    let createdDefault = false;
    if (!doc) {
      // Missing document: restore the default authority via upsert (unique
      // key => no duplicates). E11000 means a concurrent insert won the
      // race — re-read it instead of failing.
      try {
        doc = await OperatorPolicy.findOneAndUpdate(
          { key: POLICY_KEY },
          { $setOnInsert: defaultPolicyDocument() },
          { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
        ).lean();
        createdDefault = true;
      } catch (err) {
        if (err && err.code === 11000) {
          try {
            doc = await OperatorPolicy.findOne({ key: POLICY_KEY }).lean();
            createdDefault = false;
          } catch (retryErr) {
            lastError = ERR.UNAVAILABLE;
            return { ok: false, reason: ERR.UNAVAILABLE, refreshedFor: reason, preserved: true, error: String(retryErr && retryErr.message ? retryErr.message : retryErr) };
          }
        } else {
          lastError = isConnectionError(err) || !storeReady() ? ERR.UNAVAILABLE : ERR.UNAVAILABLE;
          return { ok: false, reason: ERR.UNAVAILABLE, refreshedFor: reason, preserved: true, error: String(err && err.message ? err.message : err) };
        }
      }
    }

    let clean;
    try {
      clean = validatePolicyShape(doc, { fromStore: true });
    } catch (err) {
      // Malformed/partial persisted state: keep last-known-good, do NOT
      // overwrite the document (operator repairs it with PUT).
      lastError = ERR.MALFORMED;
      return {
        ok: false,
        reason: ERR.MALFORMED,
        refreshedFor: reason,
        preserved: true,
        error: err.message,
      };
    }

    if (revision !== revStart) {
      // An operator write applied while this read was in flight — discard
      // the stale read rather than clobber newer in-process state. The next
      // bounded refresh converges.
      return { ok: true, discardedStale: true, refreshedFor: reason };
    }

    applyPolicy(clean, 'store');
    return { ok: true, refreshedFor: reason, createdDefault };
  })();

  inFlight = run;
  try {
    return await run;
  } finally {
    if (inFlight === run) inFlight = null;
  }
};

// Startup hydration: load the authoritative document, or create it from the
// guest-deny defaults if it does not exist yet. Single-flight, so a startup
// race (double call) still produces exactly one document.
const hydrate = () => runRefresh('startup');

// Explicit on-demand refresh (also used by the bounded interval).
const refresh = (reason = 'on-demand') => runRefresh(reason);

// ---- bounded refresh interval ------------------------------------------------

const parseInterval = (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return FRESHNESS_BOUND_MS;
  return Math.max(1000, Math.floor(n));
};

/**
 * Start the bounded refresh timer. Freshness bound == the interval: while
 * running, the cached policy is at most `intervalMs` old (plus one read).
 * An explicit intervalMs >= 10ms is honored as given (tests use short
 * intervals); otherwise OPERATOR_POLICY_REFRESH_MS, else 60s (floor 1s).
 */
const startRefreshTimer = ({ intervalMs } = {}) => {
  stopRefreshTimer();
  let ms;
  if (intervalMs !== undefined && intervalMs !== null) {
    const n = Number(intervalMs);
    ms = Number.isFinite(n) && n > 0 ? Math.max(10, Math.floor(n)) : FRESHNESS_BOUND_MS;
  } else {
    ms = parseInterval(process.env[ENV_REFRESH_MS]);
  }
  timerIntervalMs = ms;
  refreshTimer = setInterval(() => {
    runRefresh('interval').catch(() => {});
  }, ms);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  return { intervalMs: ms };
};

const stopRefreshTimer = () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
};

// ---- operator PUT (serialized, atomic, immediate in-process apply) -----------

const persistAtomic = async (clean) => {
  const $set = {
    guestDenied: clean.guestDenied,
    workspaceRestricted: clean.workspaceRestricted,
    entries: clean.entries,
    updatedAt: new Date(),
  };
  try {
    return await OperatorPolicy.findOneAndUpdate(
      { key: POLICY_KEY },
      { $set },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();
  } catch (err) {
    if (err && err.code === 11000) {
      // Concurrent first-insert lost the unique-key race — retry as a plain
      // update of the document that now exists.
      const doc = await OperatorPolicy.findOneAndUpdate(
        { key: POLICY_KEY },
        { $set },
        { new: true, runValidators: true }
      ).lean();
      if (doc) return doc;
    }
    throw err;
  }
};

/**
 * Validate + atomically persist + immediately apply to the in-process policy.
 * Validation happens synchronously BEFORE enqueueing (malformed input never
 * enters the write chain). Writes are serialized so concurrent PUTs cannot
 * interleave the document write and the in-process apply: last writer wins
 * consistently in both places. A failed persist leaves the in-process policy
 * untouched (last-known-good).
 */
const replacePolicy = (input) => {
  const clean = validatePolicyShape(input, { fromStore: false });

  const task = writeChain.then(async () => {
    lastAttemptAt = Date.now();

    let doc;
    try {
      if (!storeReady()) {
        const err = new Error('Policy store unavailable; in-process policy unchanged.');
        err.code = ERR_STORE_UNAVAILABLE;
        throw err;
      }
      doc = await persistAtomic(clean);
    } catch (err) {
      if (err && err.code === 'MALFORMED_POLICY') throw err;
      const wrapped = new Error(
        err && err.code === ERR_STORE_UNAVAILABLE
          ? err.message
          : 'Failed to persist operator policy; in-process policy unchanged.'
      );
      wrapped.code =
        err && err.code === ERR_STORE_UNAVAILABLE
          ? ERR_STORE_UNAVAILABLE
          : isConnectionError(err) || !storeReady()
            ? ERR_STORE_UNAVAILABLE
            : ERR_STORE_FAILED;
      throw wrapped;
    }

    // Prefer what the store actually returned (post-writeValidators view);
    // fall back to the validated input if the store echoed something the
    // validator would reject (defensive — should not happen).
    let applied;
    try {
      applied = validatePolicyShape(doc, { fromStore: true });
    } catch (_) {
      applied = clean;
    }
    applyPolicy(applied, 'operator-put');
    return { policy: applied };
  });

  // Keep the chain alive regardless of individual task outcomes.
  writeChain = task.then(
    () => undefined,
    () => undefined
  );
  return task;
};

// ---- safe representations ----------------------------------------------------

const getMeta = () => ({
  source: hydratedFromStore ? 'mongo' : 'seed',
  freshnessBoundMs: timerIntervalMs || FRESHNESS_BOUND_MS,
  lastLoadedAt,
  lastAttemptAt,
  nextRefreshAt:
    refreshTimer && lastAttemptAt !== null && timerIntervalMs
      ? lastAttemptAt + timerIntervalMs
      : null,
  lastError,
  revision,
});

/**
 * Safe, secret-free policy representation served by GET /api/policy.
 * Built entirely from the in-process cache — a GET never touches Mongo.
 */
const getSafeRepresentation = () => {
  const policy = operatorPolicy.getOperatorPolicy();
  return {
    policy: {
      guestDenied: [...(policy.guestDenied || [])],
      workspaceRestricted: (policy.workspaceRestricted || []).map((rule) => ({
        id: rule.id === undefined ? null : rule.id,
        workspaceIds: [...(rule.workspaceIds || [])],
      })),
      entries: (policy.entries || []).map((entry) => ({
        id: entry.id === undefined ? null : entry.id,
        source: entry.source === undefined ? null : entry.source,
        name: entry.name === undefined ? null : entry.name,
        action: entry.action,
        reason: entry.reason === undefined ? null : entry.reason,
      })),
    },
    meta: getMeta(),
  };
};

module.exports = {
  POLICY_KEY,
  FRESHNESS_BOUND_MS,
  hydrate,
  refresh,
  startRefreshTimer,
  stopRefreshTimer,
  replacePolicy,
  validatePolicyShape,
  defaultPolicyDocument,
  getSafeRepresentation,
  getMeta,
  PolicyValidationError,
};
