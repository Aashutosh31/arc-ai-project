'use strict';

// ARC Decision Engine abstraction.
//
//   request
//    │
//    ▼
// DeterministicDecisionEngine      (cheap, high-confidence only)
//    │  certain? ───── yes ──► decision
//    │  no
//    ▼
// JevDecisionEngine               (System One, via Vercel AI Gateway)
//    │  confidence high? ──── yes ──► decision
//    │  no / unavailable
//    ▼
// legacy / existing ARC routing    (authoritative result)
//
// The rest of ARC depends on this interface, never on Jev directly. Jev is a
// provider behind the abstraction and can never execute anything.
//
// Telemetry here is intentionally minimal (provider / operation / key booleans
// / latency / reason). No API keys, no private context, no conversation
// history, no tool internals are ever logged.

const decisionTypes = require('./decisionTypes');
const decisionPolicy = require('./decisionPolicy');
const { classify } = require('./deterministicDecisionEngine');
const { JevDecisionEngine } = require('./jevDecisionEngine');

const toFlat = (fields) =>
  Object.entries(fields || {})
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, '_')}`)
    .join(' ');

const telemetry = (level, fields) => {
  try {
    console[level](`[Decision] ${toFlat(fields)}`);
  } catch {
    // telemetry must never break the request path
  }
};

const legacyTelemetry = (policy, reason) =>
  policy.failOpen
    ? telemetry('warn', { provider: 'legacy', reason })
    : telemetry('error', { provider: 'legacy', reason, failOpen: false });

class DecisionEngine {
  constructor({ deterministic = { classify }, jev = null, policy = null } = {}) {
    this.deterministic = deterministic;
    this.jev = jev || (policy ? new JevDecisionEngine({ policy }) : new JevDecisionEngine());
    this.policy = policy || decisionPolicy.loadPolicy();
  }

  highestConfidenceLayer() {
    return this.policy.jevEnabled && this.policy.gatewayKeyConfigured ? 'jev' : 'deterministic';
  }

  // Main entry point. Returns a normalized ARC decision result.
  async decide({
    request = '',
    query = null,
    recentContext = [],
    workingState = null,
    pendingTool = null,
    hasAttachment = false,
    signal = null
  } = {}) {
    const startedAt = Date.now();
    const selectionQuery = query == null ? request : query;

    // 1. Deterministic fast path.
    let det;
    try {
      det = this.deterministic.classify({
        request,
        query: selectionQuery,
        workingState,
        pendingTool,
        hasAttachment
      });
    } catch {
      det = { certain: false, reason: 'classifier-error' };
    }
    if (det && det.certain && det.decision) {
      const decision = det.decision;
      telemetry('log', {
        provider: decision.provider,
        needsExternalCapability: decision.needsExternalCapability.value,
        confidence: Number(decision.confidence.toFixed(4)),
        operation: decision.operation.value,
        reason: decision.reason || null,
        latencyMs: Date.now() - startedAt
      });
      return decision;
    }

    // 2. Jev provider (System One) when available.
    const jevAvailable = (() => {
      try { return this.jev.isAvailable(this.policy); } catch { return false; }
    })();
    if (jevAvailable) {
      const state = decisionTypes.buildDecisionState({
        request,
        query: selectionQuery,
        recentContext,
        workingState
      });
      try {
        const decision = await this.jev.decide({ state, signal });
        if (decisionPolicy.isHighConfidenceTool(decision, this.policy)
          || decisionPolicy.isHighConfidenceNoTool(decision, this.policy)) {
          telemetry('log', {
            provider: decision.provider,
            needsExternalCapability: decision.needsExternalCapability.value,
            confidence: Number(decision.confidence.toFixed(4)),
            operation: decision.operation.value,
            latencyMs: decision.latencyMs
          });
          return decision;
        }
        legacyTelemetry(this.policy, 'low-confidence');
        return this.legacy(decision, 'low-confidence', startedAt);
      } catch (err) {
        const code = (err && err.code) ? String(err.code) : 'request-failed';
        legacyTelemetry(this.policy, code);
        return this.legacy(null, code, startedAt);
      }
    }

    // 3. Legacy / existing ARC routing (authoritative fallback).
    const reason = this.policy.jevEnabled
      ? 'jev-unavailable'
      : 'jev-disabled';
    telemetry('log', { provider: 'legacy', reason, latencyMs: Date.now() - startedAt });
    return this.legacy(null, reason, startedAt);
  }

  legacy(source, reason, startedAt) {
    return decisionTypes.buildDecisionResult({
      provider: 'legacy',
      latencyMs: Date.now() - startedAt,
      confidence: 0,
      reason,
      needsExternalCapability: { value: false, probability: 0 }
    });
  }
}

module.exports = { DecisionEngine, decisionTypes, decisionPolicy };