'use strict';

// Safe structured observability for the capability execution substrate.
//
// Mirrors lib/mcp/logger.js rules:
//   - explicit, grep-stable event names
//   - whitelist-safe scalar metadata only
//   - never log tool inputs, outputs, credentials, or arbitrary payloads
//   - logger failure can never break the request path (microtask emission)
//
// Events surfaced from the execution envelope:
//   capability.execution.started
//   capability.execution.succeeded
//   capability.execution.failed
//   capability.execution.cancelled
//   capability.idempotency.duplicatePrevented
//   capability.idempotency.reservationError

const LOG_EVENTS = Object.freeze({
  EXECUTION_STARTED: 'capability.execution.started',
  EXECUTION_SUCCEEDED: 'capability.execution.succeeded',
  EXECUTION_FAILED: 'capability.execution.failed',
  EXECUTION_CANCELLED: 'capability.execution.cancelled',
  IDEMPOTENCY_DUPLICATE_PREVENTED: 'capability.idempotency.duplicatePrevented',
  IDEMPOTENCY_RESERVATION_ERROR: 'capability.idempotency.reservationError'
});

// Whitelist of safe scalar fields allowed in logs. Anything not listed here
// is dropped before emission — no secret-sniffing heuristics, no fallbacks.
const SAFE_FIELDS = new Set([
  'executionId', 'capabilityId', 'toolName', 'source',
  'workspaceId', 'status', 'durationMs', 'errorType',
  'risk', 'scope', 'timeoutMs', 'cancellation', 'idempotency',
  'idempotencyKeyHash', 'duplicateDetected', 'duplicateStatus'
]);

const prune = (fields) => {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (!SAFE_FIELDS.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') {
      if (Array.isArray(value)) out[key] = value.map((v) => String(v));
      continue;
    }
    out[key] = value;
  }
  return out;
};

const enqueueMicrotask = (fn) => {
  try {
    Promise.resolve().then(fn);
  } catch {
    // Observability must never throw into the caller.
  }
};

const log = (event, fields) => {
  let meta = {};
  try {
    meta = prune(fields);
  } catch {
    meta = {};
  }
  enqueueMicrotask(() => {
    console.log(`[Capability] ${event}`, meta);
  });
};

module.exports = {
  LOG_EVENTS,
  SAFE_FIELDS,
  log,
  _prune: prune
};