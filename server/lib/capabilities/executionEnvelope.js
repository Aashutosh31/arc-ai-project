'use strict';

// JARVIS Action Substrate — slice 2: EXECUTION ENVELOPE.
//
// A normalized, additive runtime contract around the EXISTING single governed
// execution choke point (TaskExecutor.executeTool). It is NOT a second
// execution engine: it records lifecycle, duration, timeout/cancellation
// declarations, conservative error classification and safe observability for
// exactly the executions the existing code already performs.
//
// Guarantees:
//   - one executionId per invocation (cap-<uuid>)
//   - one start event, one terminal event; terminal can never be emitted twice
//   - existing result objects pass through unchanged
//   - no new timeouts, no new cancellation mechanisms, no retries, no fallback
//   - capability metadata sourced from the authoritative native/MCP registries
//     (via the slice-1 discovery builders) — never a duplicate registry

const { randomUUID } = require('crypto');
const { McpToolSource, isMcpToolName, limits } = require('../mcp');
const toolRegistry = require('../../tools');
const { buildNativeCapability, buildMcpCapability } = require('./discover');
const { mcpRiskFor } = require('./risk');
const { SOURCE_NATIVE, SOURCE_MCP } = require('./capabilityTypes');
const { classifyOutcome, terminalEventFor, STATUS, isTerminal } = require('./envelopeClassification');
const observability = require('./observability');

// Existing MCP default timeout recorded as the DECLARED timeout contract.
// Never enforced here; the adapter already applies it during callTool.
const MCP_DECLARED_TIMEOUT_MS = limits.REQUEST_TIMEOUT_MS || 30000;

// Resolve authoritative capability metadata for a tool name. Never throws.
// Native wins first (native tools are never shadowed by an MCP server);
// MCP falls back to the live registry entry. Returns a capability object
// (from slices-1 builders) or null when unresolvable in this process.
const resolveCapability = (toolName, { isGuest = false } = {}) => {
  try {
    const native = buildNativeCapability(toolRegistry.getTool(toolName));
    if (native) return native;
  } catch {
    // Fall through to MCP resolution below.
  }

  if (!isMcpToolName(toolName)) return null;
  try {
    const registry = McpToolSource && McpToolSource.registry;
    const entry = registry && typeof registry.toolByWireName === 'function'
      ? registry.toolByWireName(toolName)
      : null;
    if (!entry) return null;
    const config = registry && typeof registry.get === 'function' ? registry.get(entry.configId) : null;
    if (!config) return null;
    const capability = buildMcpCapability(config, {
      originalToolName: entry.originalToolName,
      canonicalName: entry.canonicalName,
      wireName: entry.wireName,
    }, Boolean(isGuest));
    // Live-discovered configs carry annotations on the registry ENTRY (not in
    // config.tools), so fall back to the authoritative entry when the config
    // had none to classify. Never duplicates a registry — same entry source.
    if (capability && capability.scope == null && entry.annotations) {
      const fallback = mcpRiskFor(entry.annotations);
      if (fallback) {
        capability.scope = fallback.scope;
        capability.risk = fallback.risk;
      }
      capability.annotations = entry.annotations;
    }
    return capability;
  } catch {
    return null;
  }
};

class ExecutionEnvelope {
  // opts: { toolName, userId, workspaceId, conversationId, signal, executionOptions, isGuest }
  constructor(opts = {}) {
    const exec = opts.executionOptions || {};
    this.executionId = `cap-${randomUUID()}`;
    this.toolName = opts.toolName || null;
    this.userId = opts.userId || null;
    this.workspaceId = opts.workspaceId || null;
    this.conversationId = opts.conversationId || null;

    const capability = resolveCapability(this.toolName, {
      isGuest: Boolean(opts.isGuest),
    });
    this.capabilityId = capability ? capability.id : null;
    this.source = capability ? capability.source : (isMcpToolName(this.toolName) ? SOURCE_MCP : SOURCE_NATIVE);
    this.risk = capability ? capability.risk : null;
    this.scope = capability ? capability.scope : null;

    // Declared (not enforced) execution metadata — recorded from the existing
    // contract. Default negotiable: null; NS-recorded MCP default on the MCP
    // path; explicit caller timeout wins when present.
    this.declaredTimeoutMs =
      typeof exec.timeoutMs === 'number'
        ? exec.timeoutMs
        : (this.source === SOURCE_MCP ? MCP_DECLARED_TIMEOUT_MS : null);
    this.cancellationDeclaration = 'cooperative';
    this.idempotency = capability ? capability.idempotency || 'safe' : 'safe';

    this.signal = opts.signal || (exec.signal) || null;
    this.signalProvided = Boolean(this.signal);
    this.signalAbortedAtStart = Boolean(this.signal && this.signal.aborted);

    // Slice 3: idempotency identity reference (safe digest only, assigned by
    // the orchestrator after preflight). Never the raw logical key.
    this.idempotencyKey = opts.idempotencyKey || null;

    this.status = STATUS.STARTED;
    this.errorType = null;
    this.startedAtMs = null;
    this.completedAtMs = null;
    this.durationMs = null;

    this._startEmitted = false;
    this._terminalEmitted = false;
  }

  // ---- lifecycle ----

  start() {
    if (this._startEmitted) return this;
    this._startEmitted = true;
    this.status = STATUS.STARTED;
    this.startedAtMs = Date.now();
    observability.log(observability.LOG_EVENTS.EXECUTION_STARTED, this._safeFields());
    return this;
  }

  markRunning() {
    if (isTerminal(this.status)) return this;
    if (this.status !== STATUS.RUNNING) this.status = STATUS.RUNNING;
    return this;
  }

  // Finalize with the ORIGINAL result object. Returns result unchanged so the
  // existing public result semantics are preserved exactly.
  finalize(result, { signalAborted = false } = {}) {
    if (this._terminalEmitted) return result;
    this._terminalEmitted = true;

    const aborted = signalAborted || Boolean(this.signal && this.signal.aborted) || this.signalAbortedAtStart;
    const outcome = classifyOutcome(result, { signalAborted: aborted });
    this.status = outcome.status;
    this.errorType = outcome.errorType;
    this.completedAtMs = Date.now();
    if (this.startedAtMs !== null) {
      this.durationMs = this.completedAtMs - this.startedAtMs;
    }

    const event = terminalEventFor(this.status);
    if (event) observability.log(event, this._safeFields());
    return result;
  }

  // ---- metadata ----

  // Safe metadata snapshot: identifiers + declarations only. Never includes
  // tool inputs, tool outputs, errors bodies, or secrets.
  summary() {
    return {
      executionId: this.executionId,
      capabilityId: this.capabilityId,
      toolName: this.toolName,
      source: this.source,
      userId: this.userId,
      workspaceId: this.workspaceId,
      conversationId: this.conversationId,
      status: this.status,
      errorType: this.errorType,
      startedAtMs: this.startedAtMs,
      completedAtMs: this.completedAtMs,
      durationMs: this.durationMs,
      declaredTimeoutMs: this.declaredTimeoutMs,
      cancellationDeclaration: this.cancellationDeclaration,
      signalProvided: this.signalProvided,
      signalAborted: Boolean(this.signal && this.signal.aborted),
      idempotency: this.idempotency,
      idempotencyKey: this.idempotencyKey,
      risk: this.risk,
      scope: this.scope,
    };
  }

  _safeFields() {
    return {
      executionId: this.executionId,
      capabilityId: this.capabilityId,
      toolName: this.toolName,
      source: this.source,
      workspaceId: this.workspaceId,
      status: this.status,
      durationMs: this.durationMs,
      errorType: this.errorType,
      risk: this.risk,
      scope: this.scope,
      timeoutMs: this.declaredTimeoutMs,
      cancellation: this.cancellationDeclaration,
      idempotency: this.idempotency,
      idempotencyKeyHash: this.idempotencyKey,
    };
  }
}

// Factory used at the choke point. isGuest mirrors the existing
// TaskExecutor/creditService actor classification.
const createExecutionEnvelope = (opts = {}) => new ExecutionEnvelope(opts);

module.exports = {
  ExecutionEnvelope,
  createExecutionEnvelope,
  resolveCapability,
  STATUS,
  isTerminal,
};