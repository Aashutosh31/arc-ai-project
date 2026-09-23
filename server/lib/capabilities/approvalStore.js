'use strict';

// JARVIS Action Substrate — slice 4C: SERVER-AUTHORITATIVE APPROVAL STATE.
//
// The interactive approval gate around a single execution attempt. This is
// the authoritative state holder only — it knows nothing about sockets; the
// TaskExecutor choke point requests + waits, and the server wires the
// socket resolve handler onto resolve().
//
// PERSISTENCE TRADEOFF (documented): approval records are transient,
// in-memory, and per-process on purpose. An approval is a bounded-lifetime,
// interactive gate over an execution attempt that is itself in-flight in THIS
// process. If the process dies mid-wait, the awaiting execution dies with it —
// a durable approval record with no alive execution would only orphan state
// (or, worse, let a stale durable "approved" later release a NEW execution).
// The identity that MUST survive restarts — the side-effect dedup key — is
// already served by the DB-backed idempotencyStore (slice 3). Multi-node
// approval coordination and durable out-of-band approval (mobile push,
// e-mail links) are future concerns, intentionally not built here.
//
// Single-use + exactly-once: every terminal transition is an atomic
// compare-and-swap on the record state. JS is single-threaded and each
// transition (a) loads the record, (b) validates state === PENDING and TTL,
// (c) mutates, (d) resolves the waiter — with NO await between load and
// store, so concurrent approve/deny/timeout/cancel events serialize and
// exactly ONE wins. A non-PENDING record can never be re-transitioned.
//
// Identity: a record is bound at creation to executionId, authenticated
// userId, workspaceId (when applicable) and capabilityId. resolve() re-checks
// every value it is given against that stored binding and the current state;
// the server transport never trusts a client-supplied userId/executionId.

const crypto = require('crypto');
const observability = require('./observability');

const STATES = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  DENIED: 'DENIED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
});
const TERMINAL = Object.freeze([
  STATES.APPROVED,
  STATES.DENIED,
  STATES.EXPIRED,
  STATES.CANCELLED,
]);
const TERMINAL_SET = new Set(TERMINAL);

// Socket.IO transport names (repo convention: `agent:*`).
const EVENTS = Object.freeze({
  APPROVAL_REQUESTED: 'agent:approval:requested',
  APPROVAL_RESOLVE: 'agent:approval:resolve',
});

// Bounded interactive round-trip. Mirrors the repository MCP constant
// `REQUEST_TIMEOUT_MS` (`server/lib/mcp/limits.js`, default 30000,
// env-tunable) — the only authority for one bounded interactive request. An
// approval is exactly that: one bounded interactive round-trip.
const DEFAULT_TTL_MS = (() => {
  const n = Number(process.env.APPROVAL_TTL_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30000;
})();

const genId = () => `apr-${crypto.randomBytes(9).toString('hex')}`;

const finiteNonNeg = (v, fallback) =>
  Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;

const records = new Map();

const settle = (resolve, record) => resolve(snapshot(record));

const snapshot = (record) => ({
  approvalId: record.approvalId,
  executionId: record.executionId,
  userId: record.userId,
  workspaceId: record.workspaceId,
  capabilityId: record.capabilityId,
  source: record.source,
  toolName: record.toolName,
  risk: record.risk,
  scope: record.scope,
  reason: record.reason,
  state: record.state,
  decision: record.decision,
  createdAt: record.createdAt,
  expiresAt: record.expiresAt,
  resolvedAt: record.resolvedAt,
});

const normalizeId = (v) => (v === undefined || v === null ? undefined : String(v));

const stateReason = (state) => {
  if (state === STATES.EXPIRED) return 'expired';
  if (TERMINAL_SET.has(state)) return 'already_resolved';
  return 'not_pending';
};

// Emit the lifecycle observability event for a transition. Never throws.
const emit = (event, record) => {
  try {
    observability.log(event, {
      approvalId: record.approvalId,
      executionId: record.executionId,
      capabilityId: record.capabilityId,
      toolName: record.toolName,
      source: record.source,
      workspaceId: record.workspaceId,
      risk: record.risk,
      scope: record.scope,
      state: record.state,
      decision: record.decision || null,
      reason: record.reason || null,
      durationMs: finiteNonNeg(record.resolvedAt - record.createdAt, 0),
    });
  } catch {
    // Observability must never break the approval path.
  }
};

// Atomic CAS terminal transition. Returns true if THIS call moved the record
// out of PENDING (the exact-once winner), false otherwise. No await between
// check and mutate → serializable under single-threaded concurrency.
const transition = (record, state, decision) => {
  if (record.state !== STATES.PENDING) return false;
  if (record._timer) {
    clearTimeout(record._timer);
    record._timer = null;
  }
  record.state = state;
  record.decision = decision || null;
  record.resolvedAt = Date.now();
  emit(eventFor(state), record);
  if (record._resolve) settle(record._resolve, record);
  return true;
};

const eventFor = (state) => {
  switch (state) {
    case STATES.APPROVED: return observability.LOG_EVENTS.APPROVAL_APPROVED;
    case STATES.DENIED: return observability.LOG_EVENTS.APPROVAL_DENIED;
    case STATES.EXPIRED: return observability.LOG_EVENTS.APPROVAL_EXPIRED;
    case STATES.CANCELLED: return observability.LOG_EVENTS.APPROVAL_CANCELLED;
    default: return null;
  }
};

const onTimeout = (approvalId) => {
  const record = records.get(approvalId);
  if (!record) return;
  transition(record, STATES.EXPIRED, null);
};

// ---- public API -------------------------------------------------------------

// create({ executionId, userId, workspaceId, capabilityId, source, toolName,
//   risk, scope, reason, ttlMs? }) -> public record (state PENDING).
// Throws only for programming errors (missing execution identity); the caller
// (TaskExecutor) treats any throw as fail-closed.
const create = ({
  executionId,
  userId,
  workspaceId = null,
  capabilityId,
  source,
  toolName = null,
  risk = null,
  scope = null,
  reason = null,
  ttlMs = DEFAULT_TTL_MS,
}) => {
  if (!executionId || !userId || !capabilityId) {
    throw new Error('approvalStore: executionId, userId and capabilityId are required');
  }
  const now = Date.now();
  const ttl = finiteNonNeg(ttlMs, DEFAULT_TTL_MS) || DEFAULT_TTL_MS;
  const record = {
    approvalId: genId(),
    executionId: String(executionId),
    userId: String(userId),
    workspaceId: workspaceId === undefined || workspaceId === null ? null : String(workspaceId),
    capabilityId: String(capabilityId),
    source: source || null,
    toolName: toolName || null,
    risk: risk || null,
    scope: scope || null,
    reason: reason || null,
    state: STATES.PENDING,
    decision: null,
    createdAt: now,
    expiresAt: now + ttl,
    resolvedAt: null,
    _timer: null,
    _resolve: null,
  };
  let resolveFn;
  record._waiter = new Promise((res) => { resolveFn = res; });
  record._resolve = resolveFn;
  record._timer = setTimeout(() => onTimeout(record.approvalId), ttl);
  if (typeof record._timer.unref === 'function') record._timer.unref();

  records.set(record.approvalId, record);
  emit(observability.LOG_EVENTS.APPROVAL_REQUESTED, { ...record, resolvedAt: now });
  prune();
  return snapshot(record);
};

// resolve({ approvalId, decision, userId, executionId?, workspaceId?,
//   capabilityId? }) — the ONLY way to approve/deny an approval.
//
//   decision: 'approve' | 'deny'
//   userId:   REQUIRED — authenticated server identity (never from the client)
//   executionId / workspaceId / capabilityId: OPTIONAL expected bindings;
//     every one given is re-checked against the STORED record and any
//     mismatch is rejected. The server transport passes none of them — the
//     stored binding is authoritative.
//
// Exactly one winning terminal decision is possible per approval. Returns
//   { ok:true,  state, record }       — this call transitioned PENDING
//   { ok:false, reason, state?, record }
const resolve = ({ approvalId, decision, userId, executionId, workspaceId, capabilityId }) => {
  const approvalIdNorm = normalizeId(approvalId);
  const record = records.get(approvalIdNorm);
  if (!record) return { ok: false, reason: 'unknown' };

  if (decision !== 'approve' && decision !== 'deny') {
    return { ok: false, reason: 'invalid_decision', state: record.state, record: snapshot(record) };
  }

  // Identity: authenticated user must match the binding.
  if (normalizeId(userId) !== record.userId) {
    return { ok: false, reason: 'user_mismatch', state: record.state, record: snapshot(record) };
  }
  if (executionId !== undefined && normalizeId(executionId) !== record.executionId) {
    return { ok: false, reason: 'execution_mismatch', state: record.state, record: snapshot(record) };
  }
  if (workspaceId !== undefined && normalizeId(workspaceId) !== record.workspaceId) {
    return { ok: false, reason: 'workspace_mismatch', state: record.state, record: snapshot(record) };
  }
  if (capabilityId !== undefined && normalizeId(capabilityId) !== record.capabilityId) {
    return { ok: false, reason: 'capability_mismatch', state: record.state, record: snapshot(record) };
  }

  // Lazy TTL enforcement: a PENDING record past its expiry expires now and
  // can never be approved. Exactly one caller (this one) wins the expiry.
  if (record.state === STATES.PENDING && Date.now() >= record.expiresAt) {
    transition(record, STATES.EXPIRED, null);
    return { ok: false, reason: 'expired', state: STATES.EXPIRED, record: snapshot(record) };
  }

  if (record.state !== STATES.PENDING) {
    return { ok: false, reason: stateReason(record.state), state: record.state, record: snapshot(record) };
  }

  const target = decision === 'approve' ? STATES.APPROVED : STATES.DENIED;
  const won = transition(record, target, decision);
  return won
    ? { ok: true, state: record.state, record: snapshot(record) }
    : { ok: false, reason: 'already_resolved', state: record.state, record: snapshot(record) };
};

// cancel({ approvalId, userId }) — intentional request cancellation (execution
// abort / user stop). User-bound, like everything else.
const cancel = ({ approvalId, userId }) => {
  const approvalIdNorm = normalizeId(approvalId);
  const record = records.get(approvalIdNorm);
  if (!record) return { ok: false, reason: 'unknown' };
  if (normalizeId(userId) !== record.userId) {
    return { ok: false, reason: 'user_mismatch', state: record.state, record: snapshot(record) };
  }
  if (record.state === STATES.PENDING && Date.now() >= record.expiresAt) {
    transition(record, STATES.EXPIRED, null);
    return { ok: false, reason: 'expired', state: STATES.EXPIRED, record: snapshot(record) };
  }
  if (record.state !== STATES.PENDING) {
    return { ok: false, reason: stateReason(record.state), state: record.state, record: snapshot(record) };
  }
  const won = transition(record, STATES.CANCELLED, null);
  return won
    ? { ok: true, state: record.state, record: snapshot(record) }
    : { ok: false, reason: 'already_resolved', state: record.state, record: snapshot(record) };
};

// The awaiting execution's promise. Terminal records resolve immediately with
// their snapshot; PENDING records resolve exactly once when a terminal
// transition wins.
const waitForDecision = (approvalId) => {
  const record = records.get(normalizeId(approvalId));
  if (!record) return Promise.resolve({ state: STATES.EXPIRED, approvalId: normalizeId(approvalId), reason: 'unknown' });
  if (record.state !== STATES.PENDING) {
    return Promise.resolve(snapshot(record));
  }
  return record._waiter;
};

const read = (approvalId) => {
  const record = records.get(normalizeId(approvalId));
  return record ? snapshot(record) : null;
};

const list = () => Array.from(records.values()).map(snapshot);

// Test/teardown surface.
const _reset = () => {
  for (const record of records.values()) {
    if (record._timer) clearTimeout(record._timer);
  }
  records.clear();
};
const _expireNow = (approvalId) => {
  const record = records.get(normalizeId(approvalId));
  if (!record) return false;
  return transition(record, STATES.EXPIRED, null);
};

// Bounded retention: drop terminal records after TTL (cheap; records are
// small and the map stays tiny). PENDING records are governed by their own
// unref'd timer.
const prune = () => {
  const now = Date.now();
  for (const [id, record] of records) {
    if (TERMINAL_SET.has(record.state) && now - (record.resolvedAt || record.createdAt) > DEFAULT_TTL_MS) {
      if (record._timer) clearTimeout(record._timer);
      records.delete(id);
    }
  }
};

const shutdown = () => _reset();

module.exports = {
  STATES,
  TERMINAL,
  TERMINAL_SET,
  EVENTS,
  DEFAULT_TTL_MS,
  create,
  resolve,
  cancel,
  waitForDecision,
  read,
  list,
  prune,
  _reset,
  _expireNow,
  shutdown,
};