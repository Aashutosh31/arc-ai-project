'use strict';

// Decision engine policy: configuration + confidence classification.
//
// Jev is a decision signal, never an unquestionable authority. Explicit
// thresholds distinguish HIGH-confidence tool/no-tool calls (act on them)
// from LOW-confidence ones (fall back to the existing deterministic/legacy
// ARC routing). A low-confidence decision NEVER silently suppresses an
// otherwise required safety/tool path.

const { clamp01 } = require('./decisionTypes');
const { hasActiveWorkingState: surfaceIsActive } = require('./deterministicDecisionEngine');

const readEnv = (name, fallback) => {
  const raw = process.env[name];
  return raw === undefined || raw === null || String(raw).trim() === '' ? fallback : String(raw).trim();
};

const readFlag = (name, fallback = true) => {
  const raw = readEnv(name, null);
  if (raw === null) return fallback;
  return !['0', 'false', 'no', 'off', 'disabled'].includes(String(raw).toLowerCase());
};

const readNumber = (name, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const raw = readEnv(name, null);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const loadPolicy = () => ({
  jevEnabled: readFlag('JEV_ENABLED', true),
  jevModel: readEnv('JEV_MODEL', 'typesafe-ai/jev'),
  noToolThreshold: clamp01(readNumber('JEV_NO_TOOL_THRESHOLD', 0.9, { min: 0, max: 1 })),
  toolThreshold: clamp01(readNumber('JEV_TOOL_THRESHOLD', 0.9, { min: 0, max: 1 })),
  decisionTimeoutMs: readNumber('JEV_DECISION_TIMEOUT_MS', 500, { min: 50, max: 10000 }),
  failOpen: readFlag('JEV_FAIL_OPEN', true),
  gatewayKeyConfigured: Boolean(process.env.AI_GATEWAY_API_KEY && String(process.env.AI_GATEWAY_API_KEY).trim() !== '')
});

// Does this decision confidently say "no external capability / tool needed"?
// Only decisions actually produced by a decision provider (deterministic or
// Jev) can authorize skipping MCP. A legacy fallback never qualifies.
const isHighConfidenceNoTool = (result, policy) => {
  if (!result || result.provider === 'legacy' || result.provider === 'degraded') return false;
  const ne = result.needsExternalCapability || {};
  return ne.value === false && typeof ne.probability === 'number' && ne.probability >= policy.noToolThreshold;
};

// Does this decision confidently say "external capability / tool needed"?
const isHighConfidenceTool = (result, policy) => {
  if (!result || result.provider === 'legacy' || result.provider === 'degraded') return false;
  const ne = result.needsExternalCapability || {};
  return ne.value === true && typeof ne.probability === 'number' && ne.probability >= policy.toolThreshold;
};

const isLowConfidence = (result, policy) => !isHighConfidenceNoTool(result, policy) && !isHighConfidenceTool(result, policy);

// Confidence in the selected value itself (corrects for direction): if the
// chosen value is `false`, the relevant probability is 1 - P(true).
const valueConfidence = (ne, policy) => {
  if (!ne || typeof ne.probability !== 'number') return 0;
  return ne.value === false ? Math.min(1, Math.max(0, 1 - ne.probability)) : clamp01(ne.probability);
};

// ---- MCP gate -----------------------------------------------------------------
// The ONE authoritative check used before any expensive MCP work begins.
// Returns true only when the decision confidently classifies the request as
// conversational (no external capability) and none of the hard safety guards
// are present. Guards re-assert the inviolable cases even if a provider got
// the classification wrong:
//   - attached documents/images          -> normal multimodal path
//   - an active pending tool-call flow   -> normal path (argument gathering)
//   - active working-state surfaces      -> possible tool continuation
//
// The caller passes the raw working-state object (it knows which surfaces are
// live); the flag form is kept for callers that already computed it.
const shouldSkipMcp = (result, {
  policy,
  hasAttachments = false,
  hasPendingTool = false,
  hasActiveWorkingState = false,
  workingState = null
} = {}) => {
  if (hasAttachments) return false;
  if (hasPendingTool) return false;
  if (workingState !== null && workingState !== undefined) {
    if (surfaceIsActive(workingState)) return false;
  } else if (hasActiveWorkingState) {
    return false;
  }
  return isHighConfidenceNoTool(result, policy);
};

module.exports = {
  loadPolicy,
  readFlag,
  readNumber,
  isHighConfidenceNoTool,
  isHighConfidenceTool,
  isLowConfidence,
  valueConfidence,
  shouldSkipMcp
};