'use strict';

// JARVIS Action Substrate — slice 3: IDEMPOTENCY + DUPLICATE-SIDE-EFFECT
// PROTECTION (pure key/scope/result helpers; no I/O, no policy).
//
// executionId vs idempotencyKey:
//   executionId    unique PHYSICAL execution instance (cap-<uuid>).
//   idempotencyKey LOGICAL identity of one intended action.
//     request A: executionId=exec-001, idempotencyKey=K
//     request B: executionId=exec-002, idempotencyKey=K
//     B must NOT blindly repeat the side effect; it replays A's outcome.
//
// Key derivation rules (see docs/ja-jarvis-action-substrate.md):
//   - explicit caller key preferred (executionOptions.idempotencyKey)
//   - otherwise a natural per-action request identity
//     (executionOptions.requestId ?? executionOptions.toolCallId)
//   - the key is a SHA-256 digest of [ capabilityId \0 userId \0 workspaceId
//     \0 conversationId \0 logicalKey ] so the SAME logical key can NEVER
//     collide across different capabilities, users, or workspaces
//   - the digest itself is the only thing ever stored/logged — no secrets
//   - if NO logical source exists, protection is PASS-THROUGH (unique key per
//     invocation). This is the narrowest SAFE fallback: any capability-level
//     fallback would collapse distinct actions together. Callers that want
//     dedup supply a logical key; the substrate never probes arbitrary tool
//     args (they may be secrets) and never logs the raw logical key.

const { createHash } = require('crypto');

// Terminal lifecycle statuses persisted on the idempotency record. These are
// substrate-internal and deliberately stay separate from the PLAN-level
// Execution model statuses (PLANNED/RUNNING/COMPLETED/...) — the substrate
// records capability-execution outcomes, not plan progress.
const IDEMPOTENCY_STATUS = Object.freeze({
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

const normalizePart = (v) => (v == null ? '' : String(v));

// Deterministic, secret-free digest. Fixed-width hex; collisions are
// cryptographically negligible for this namespace width.
const digest = (parts) =>
  createHash('sha256')
    .update(parts.map(normalizePart).join('\u0000'))
    .digest('hex');

const REDACTED_LENGTH = 12;
const redact = (key) => (typeof key === 'string' && key ? key.slice(0, REDACTED_LENGTH) : null);

// Derive the idempotency identity for one invocation.
// opts: { capabilityId, userId, workspaceId, conversationId, executionId,
//         explicitKey, requestId, toolCallId }
// Returns:
//   {
//     enabled: boolean,                 // false => pass-through (unique key)
//     key: string | null,               // sha256(scope+logical) when enabled
//     keyHash: string | null,           // truncated safe reference for logs
//     logicalKey: string | null,        // caller/request identity, never logged
//     scope: { capabilityId, userId, workspaceId, conversationId },  // stored
//     uniqueKey: string,                // always-present unique fallback key
//   }
const resolveIdempotencyKey = (opts = {}) => {
  const {
    capabilityId = null,
    userId = null,
    workspaceId = null,
    conversationId = null,
    executionId = null,
    explicitKey = null,
    requestId = null,
    toolCallId = null,
  } = opts;

  const scope = {
    capabilityId: normalizePart(capabilityId),
    userId: normalizePart(userId),
    workspaceId: normalizePart(workspaceId),
    conversationId: normalizePart(conversationId),
  };

  // Explicit caller key wins; otherwise fall back to a natural per-action
  // request identity. toolCallId exists already in AIService continuation
  // pipelines; requestId is the generic transport/request identifier.
  const logicalKey =
    explicitKey != null && String(explicitKey).length > 0
      ? String(explicitKey)
      : requestId != null && String(requestId).length > 0
        ? String(requestId)
        : toolCallId != null && String(toolCallId).length > 0
          ? String(toolCallId)
          : null;

  const uniqueKey = digest([capabilityId, userId, workspaceId, conversationId, executionId || `cap-${Date.now()}-${Math.random()}`]);

  if (logicalKey == null) {
    // Safe pass-through: no logical action identity exists. Permit the
    // execution (the existing behavior) but with no dedup claims. The
    // substrate never guesses a logical identity from tool args.
    return {
      enabled: false,
      key: null,
      keyHash: null,
      logicalKey: null,
      scope,
      uniqueKey,
    };
  }

  const key = digest([...Object.values(scope), logicalKey]);
  return {
    enabled: true,
    key,
    keyHash: redact(key),
    logicalKey,
    scope,
    uniqueKey: key,
  };
};

// Normalized replay result returned instead of executing a side effect a
// second time. Shape is stable, deterministic, and contains NO tool outputs.
// Distinguishes terminal replay (previously SUCCEEDED/FAILED/CANCELLED) from
// a still-running duplicate.
const buildReplayResult = (decision, { duplicateOf = null, status = null, errorType = null } = {}) => {
  if (decision === 'inProgress') {
    return {
      success: false,
      replay: true,
      inProgress: true,
      duplicateOf,
    };
  }
  const succeeded = status === IDEMPOTENCY_STATUS.SUCCEEDED;
  return {
    success: succeeded,
    replay: true,
    duplicateOf,
    outcome: {
      status,
      errorType,
    },
  };
};

module.exports = {
  IDEMPOTENCY_STATUS,
  digest,
  redact,
  resolveIdempotencyKey,
  buildReplayResult,
  normalizePart,
};