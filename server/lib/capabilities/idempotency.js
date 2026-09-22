'use strict';

// JARVIS Action Substrate — slice 3: IDEMPOTENCY ORCHESTRATOR.
//
// Thin coordination between the execution envelope (slice 2), the idempotency
// store (Phase D) and the safe decision semantics (Phase E). It does NOT
// perform capability resolution, policy, execution, or retries — it only
// guards the side-effect boundary at TaskExecutor.executeTool.
//
// Flow (Phase F), preserving every existing layer (MCP auth, policy, Jev
// gate, schema validation, cancellation, timeouts, clientAction):
//   resolve capability (envelope)
//   -> derive/validate idempotency identity
//   -> acquire/reserve idempotency record (ATOMIC)
//   -> if duplicate: return existing outcome (no side effect)
//   -> envelope.start()
//   -> existing native/MCP execution
//   -> envelope.finalize()
//   -> settle idempotency record

const { resolveIdempotencyKey, buildReplayResult, IDEMPOTENCY_STATUS } = require('./idempotencyKey');
const store = require('./idempotencyStore');
const observability = require('./observability');

const OUTCOME_STATUS = {
  [IDEMPOTENCY_STATUS.SUCCEEDED]: 'succeeded',
  [IDEMPOTENCY_STATUS.FAILED]: 'failed',
  [IDEMPOTENCY_STATUS.CANCELLED]: 'cancelled',
};

// Mapped envelope status -> persisted idempotency record status.
const persistStatusFor = (status) => {
  switch (status) {
    case 'succeeded':
      return IDEMPOTENCY_STATUS.SUCCEEDED;
    case 'failed':
      return IDEMPOTENCY_STATUS.FAILED;
    case 'cancelled':
      return IDEMPOTENCY_STATUS.CANCELLED;
    default:
      return null; // non-terminal → leave record RUNNING
  }
};

// Build the idempotency decision for ONE execution request.
// opts: { envelope, executionOptions }
// Returns { idempotency, decision, result? }
//   idempotency.enabled=false -> no protection requested (pass-through)
//   decision = 'execute'     -> caller must run the side effect
//   decision = 'replay'      -> caller must NOT run; return decision.result
//   decision = 'inProgress'  -> caller must NOT run; return decision.result
const preflight = async ({ envelope, executionOptions = {} }) => {
  const identity = resolveIdempotencyKey({
    capabilityId: envelope.capabilityId,
    userId: envelope.userId,
    workspaceId: envelope.workspaceId,
    conversationId: envelope.conversationId,
    executionId: envelope.executionId,
    explicitKey: executionOptions.idempotencyKey,
    requestId: executionOptions.requestId,
    toolCallId: executionOptions.toolCallId,
  });

  if (!identity.enabled) {
    return {
      idempotency: { enabled: false, key: null, keyHash: null },
      decision: 'execute',
    };
  }

  let reservation;
  try {
    reservation = await store.reserve({
      key: identity.key,
      capabilityId: envelope.capabilityId,
      source: envelope.source,
      userId: envelope.userId,
      workspaceId: envelope.workspaceId,
      conversationId: envelope.conversationId,
      executionId: envelope.executionId,
    });
  } catch (err) {
    // A THROWING store is still a store failure: fail-open (never block the
    // request path). Without this, an unhandled reserve rejection would
    // propagate out of executeTool and fail the request — accidentally
    // fail-CLOSED, contradicting the documented contract.
    reservation = { reserved: false, error: err && err.message };
  }

  if (!reservation.reserved && reservation.error) {
    // Store failure: FAIL-OPEN. A substrate-side persistence hiccup must not
    // invent a duplicate or freeze the request path; the execution proceeds
    // as if no dedup was requested. (No retry policy exists; this is not one.)
    observability.log(observability.LOG_EVENTS.IDEMPOTENCY_RESERVATION_ERROR, {
      executionId: envelope.executionId,
      capabilityId: envelope.capabilityId,
      source: envelope.source,
      workspaceId: envelope.workspaceId,
      idempotencyKeyHash: identity.keyHash,
    });
    return {
      idempotency: { enabled: true, key: identity.key, keyHash: identity.keyHash },
      decision: 'execute',
      reservationError: true,
    };
  }

  if (!reservation.reserved) {
    // Duplicate: never run the side effect again. Surface the prior record.
    const prior = reservation.record;
    const isRunning = prior && prior.status === IDEMPOTENCY_STATUS.RUNNING;
    const decision = isRunning ? 'inProgress' : 'replay';
    const result = isRunning
      ? buildReplayResult('inProgress', { duplicateOf: prior.executionId })
      : buildReplayResult('replay', {
          duplicateOf: prior.executionId,
          status: prior.status,
          errorType: prior.outcome && prior.outcome.errorType || null,
        });

    // Safe observability: only identifiers + status, never the logical key.
    observability.log(observability.LOG_EVENTS.IDEMPOTENCY_DUPLICATE_PREVENTED, {
      executionId: envelope.executionId,
      capabilityId: envelope.capabilityId,
      source: envelope.source,
      workspaceId: envelope.workspaceId,
      idempotencyKeyHash: identity.keyHash,
      duplicateDetected: true,
      duplicateStatus: isRunning ? IDEMPOTENCY_STATUS.RUNNING : prior.status,
    });

    return {
      idempotency: { enabled: true, key: identity.key, keyHash: identity.keyHash },
      decision,
      result,
    };
  }

  return {
    idempotency: { enabled: true, key: identity.key, keyHash: identity.keyHash },
    decision: 'execute',
  };
};

// Settle a reserved record after the envelope is terminal. Never throws.
const settle = async ({ envelope, idempotency }) => {
  if (!idempotency || !idempotency.enabled || !idempotency.key) return;
  const status = persistStatusFor(envelope.status);
  if (!status) return; // non-terminal; record stays RUNNING
  try {
    await store.settle(idempotency.key, {
      executionId: envelope.executionId,
      status,
      errorType: envelope.errorType || null,
      durationMs: envelope.durationMs,
    });
  } catch (err) {
    // Post-execution settlement must never fail the execution result.
    // (store.settle already returns {ok:false} on error; this guards against
    // an unexpected throw so the "Never throws" contract holds unconditionally.)
    observability.log(observability.LOG_EVENTS.IDEMPOTENCY_RESERVATION_ERROR, {
      executionId: envelope.executionId,
      capabilityId: envelope.capabilityId,
      source: envelope.source,
      workspaceId: envelope.workspaceId,
      idempotencyKeyHash: idempotency.keyHash || null,
      phase: 'settle',
      error: err && err.message,
    });
  }
};

module.exports = {
  preflight,
  settle,
  persistStatusFor,
  OUTCOME_STATUS,
};