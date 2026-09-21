'use strict';

// Jev decision provider.
//
// Jev is a System One evaluation model exposed through Vercel AI Gateway.
// It answers bounded typed questions (boolean / choice / score), never
// executes anything. Provider-specific answers are normalized into the ARC
// decision contract at this boundary; the rest of ARC only ever sees the
// normalized result.
//
// The caller must treat this provider as optional: any failure (timeout,
// rate limit, malformed response, missing SDK/key) becomes a legacy fallback
// via DecisionEngine. Jev must NEVER block an ordinary ARC request.

const { QUESTIONS, OPERATION_OPTIONS, RISK_CRITERIA, buildDecisionResult } = require('./decisionTypes');

class JevDecisionError extends Error {
  constructor(code, cause = null) {
    super(`jev:${code}`);
    this.name = 'JevDecisionError';
    this.code = code;
    this.cause = cause || null;
  }
}

const withTimeout = (promise, ms, timeoutLabel) => {
  if (!(ms > 0)) return promise;
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new JevDecisionError(timeoutLabel)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
};

const clamp01 = (n) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
};

// The raw SDK boolean probability is P(value = true). The ARC contract stores
// the probability OF THE CHOSEN value, so a `false` verdict carries 1 - P(true).
const normalizeBoolean = (raw, fallback) => {
  if (!raw || typeof raw !== 'object') return { value: fallback, probability: 0 };
  const pTrue = clamp01(raw.probability);
  const value = pTrue >= 0.5;
  return { value, probability: value ? pTrue : 1 - pTrue };
};

const normalizeChoice = (raw, allowed) => {
  if (!raw || typeof raw !== 'object') return { value: 'other', probability: 0 };
  const chosen = String(raw.choice || '');
  const value = allowed.includes(chosen) ? chosen : 'other';
  let probability = 0;
  try {
    probability = clamp01(raw.probabilities && raw.probabilities[chosen]);
  } catch { probability = 0; }
  return { value, probability };
};

const normalizeScore = (raw, criteria) => {
  if (!raw || typeof raw !== 'object') return { value: 0, probability: 0 };
  const levelCount = Math.max(1, Array.isArray(criteria) ? criteria.length : 1);
  const maxIndex = levelCount - 1;
  const score = Number(raw.score);
  const normalized = Number.isFinite(score)
    ? clamp01(score / maxIndex) * 100
    : 0;
  let probability = 0;
  try {
    const probs = raw.probabilities;
    if (probs && typeof probs === 'object') {
      probability = clamp01(Math.max(0, ...Object.values(probs).map(Number)));
    }
  } catch { probability = 0; }
  return { value: Math.round(normalized * 10) / 10, probability };
};

// Lazy ESM import of the AI SDK. The SDK is ESM-only; dynamic import keeps
// the CommonJS server loading it only when Jev is actually invoked.
let sdk = null;
let sdkPromise = null;
const loadSdk = async () => {
  if (sdk) return sdk;
  if (!sdkPromise) {
    sdkPromise = (async () => {
      try {
        const mod = await import('ai');
        if (typeof mod.experimental_evaluate !== 'function') {
          throw new JevDecisionError('sdk-evaluate-missing');
        }
        sdk = mod;
        return sdk;
      } catch (err) {
        sdkPromise = null;
        if (err instanceof JevDecisionError) throw err;
        throw new JevDecisionError('sdk-unavailable', err);
      }
    })();
  }
  return sdkPromise;
};

class JevDecisionEngine {
  constructor({ evaluateFn = null, policy = null } = {}) {
    this.evaluateFn = evaluateFn; // test injectable; null -> live SDK
    this._policy = policy || null;
  }

  policy() {
    return this._policy;
  }

  // Is Jev usable at all right now? Disabled or keyless -> null (legacy).
  isAvailable(policy) {
    const cfg = policy || this._policy;
    if (!cfg) return false;
    return Boolean(cfg.jevEnabled && cfg.gatewayKeyConfigured);
  }

  // Evaluate all four bounded decisions in one Jev request. Returns the
  // normalized ARC decision result (provider 'jev') or throws JevDecisionError.
  async decide({ state, signal = null } = {}) {
    const cfg = this._policy;
    const startedAt = Date.now();
    const evaluate = typeof this.evaluateFn === 'function'
      ? this.evaluateFn
      : (await loadSdk()).experimental_evaluate;

    let raw;
    try {
      const request = {
        model: cfg.jevModel, // 'typesafe-ai/jev' via Vercel AI Gateway
        state,
        questions: QUESTIONS,
        maxRetries: 0
      };
      if (signal) request.abortSignal = signal;
      const options = [request];
      const rawResult = await withTimeout(
        evaluate(...options),
        cfg.decisionTimeoutMs,
        'timeout'
      );
      raw = rawResult?.answers || rawResult || null;
    } catch (err) {
      if (err instanceof JevDecisionError) throw err;
      throw new JevDecisionError('request-failed', err);
    }
    if (!raw || typeof raw !== 'object') {
      throw new JevDecisionError('malformed');
    }

    const needsExternalCapability = normalizeBoolean(raw.needsExternalCapability, false);
    const operation = normalizeChoice(raw.operation, OPERATION_OPTIONS);
    const risk = normalizeScore(raw.risk, RISK_CRITERIA);
    const needsConfirmation = normalizeBoolean(raw.needsConfirmation, false);

    // Confidence in the DECIDING value (needsExternalCapability): the
    // probability of the value actually chosen (normalization already folded
    // direction into the field).
    const confidence = needsExternalCapability.probability;

    return buildDecisionResult({
      needsExternalCapability,
      operation,
      risk,
      needsConfirmation,
      provider: 'jev',
      latencyMs: Date.now() - startedAt,
      confidence,
      reason: null
    });
  }
}

module.exports = {
  JevDecisionEngine,
  JevDecisionError,
  normalizeBoolean,
  normalizeChoice,
  normalizeScore
};