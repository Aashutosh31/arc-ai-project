/* Jev System One decision-layer tests — run with: node tests/decisionLayer.test.js
 *
 * Covers the DecisionEngine abstraction (deterministic fast path -> Jev ->
 * legacy fallback), the normalized decision contract, the MCP skip gate, and
 * the guarantee that Jev can never execute a tool.
 *
 * Pure logic tests: no DB, no provider calls, no MCP servers. Jev evaluation
 * is injected as a fake `evaluateFn` where the live AI Gateway path is not
 * exercised (no key in CI).
 *
 * Contract under test:
 *  - deterministic answers ONLY what it can answer conclusively
 *  - Jev probability fields express confidence in the CHOSEN value
 *  - shouldSkipMcp is true ONLY for high-confidence no-tool decisions with no
 *    attachment, no pending tool, and no active working-state surface
 *  - every failure mode degrades to provider 'legacy' (fail-open)
 *  - Jev exposes no tool-execution surface
 */

const assert = require('assert');

let pass = 0;
let fail = 0;

async function check(label, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    fail += 1;
    process.exitCode = 1;
    console.error(`  FAIL  ${label}\n        ${err.message}`);
  }
}

console.log('Jev Decision Layer Tests');
console.log('========================');

const { DecisionEngine } = require('../services/decision/DecisionEngine');
const { JevDecisionEngine } = require('../services/decision/jevDecisionEngine');
const decisionPolicy = require('../services/decision/decisionPolicy');
const deterministic = require('../services/decision/deterministicDecisionEngine');
const { buildDecisionResult, buildDecisionState, clamp01 } = require('../services/decision/decisionTypes');

const basePolicy = () => decisionPolicy.loadPolicy();

// Fake provider returning SDK-shaped answers.
const jevAnswers = (needsProbability) => ({ type: 'boolean', probability: needsProbability });
const fakeEvaluate = (needsBoolean) => async () => Promise.resolve({
  answers: {
    needsExternalCapability: needsBoolean,
    operation: { type: 'choice', choice: 'chat', probabilities: { chat: 0.99, other: 0.01 } },
    risk: { type: 'score', score: 0, probabilities: { 0: 0.95 } },
    needsConfirmation: { type: 'boolean', probability: 0.02 }
  }
});

const jevPolicy = () => ({ ...basePolicy(), jevEnabled: true, gatewayKeyConfigured: true });

(async () => {
  console.log('\nDeterministic fast path');
  console.log('-----------------------');

  await check('greeting -> certain no-tool', async () => {
    const det = deterministic.classify({ request: 'hello there' });
    assert.equal(det.certain, true);
    assert.equal(det.decision.needsExternalCapability.value, false);
    assert.equal(det.decision.needsExternalCapability.probability, 1);
    assert.equal(det.decision.provider, 'deterministic');
  });

  await check('capability verb -> certain tool', async () => {
    const det = deterministic.classify({ request: 'create a linear issue about bugs' });
    assert.equal(det.certain, true);
    assert.equal(det.decision.needsExternalCapability.value, true);
  });

  await check('knowledge question -> certain no-tool', async () => {
    const det = deterministic.classify({ request: 'explain closures in javascript' });
    assert.equal(det.certain, true);
    assert.equal(det.decision.needsExternalCapability.value, false);
    assert.equal(det.decision.reason, 'deterministic-knowledge');
  });

  await check('continuous question defers (uncertain)', async () => {
    const det = deterministic.classify({ request: 'make me a sandwich' });
    assert.equal(det.certain, false);
  });

  await check('greeting + attachment defers', async () => {
    const det = deterministic.classify({ request: 'hello', hasAttachment: true });
    assert.equal(det.certain, false);
  });

  await check('greeting + active state defers', async () => {
    const det = deterministic.classify({ request: 'hello', workingState: { activeSearch: { tool: 'searchFiles' } } });
    assert.equal(det.certain, false);
  });

  await check('greeting + pending tool defers', async () => {
    const det = deterministic.classify({ request: 'hello', pendingTool: { toolName: 'linear.createIssue' } });
    assert.equal(det.certain, false);
  });

  console.log('\nJev normalization (injected answers)');
  console.log('-----------------------------------');

  await check('no-tool verdict -> probability of chosen value', async () => {
    const engine = new JevDecisionEngine({
      policy: jevPolicy(),
      evaluateFn: fakeEvaluate(jevAnswers(0.03))
    });
    const r = await engine.decide({ state: buildDecisionState({ request: 'what is ARC' }) });
    assert.equal(r.provider, 'jev');
    assert.equal(r.needsExternalCapability.value, false);
    assert.equal(r.needsExternalCapability.probability, 0.97);
    assert.equal(r.confidence, 0.97);
  });

  await check('tool verdict -> probability of chosen value', async () => {
    const engine = new JevDecisionEngine({
      policy: jevPolicy(),
      evaluateFn: fakeEvaluate(jevAnswers(0.97))
    });
    const r = await engine.decide({ state: buildDecisionState({ request: 'create a linear issue' }) });
    assert.equal(r.needsExternalCapability.value, true);
    assert.equal(r.needsExternalCapability.probability, 0.97);
    assert.equal(r.operation.value, 'chat');
  });

  await check('operation defaults to other on unknown choice', async () => {
    const engine = new JevDecisionEngine({
      policy: jevPolicy(),
      evaluateFn: async () => Promise.resolve({
        answers: {
          needsExternalCapability: { type: 'boolean', probability: 0.95 },
          operation: { type: 'choice', choice: 'not-a-valid-op', probabilities: { 'not-a-valid-op': 1 } },
          risk: { type: 'score', score: 4, probabilities: { 4: 0.8 } },
          needsConfirmation: { type: 'boolean', probability: 0.9 }
        }
      })
    });
    const r = await engine.decide({ state: buildDecisionState({ request: 'x' }) });
    assert.equal(r.operation.value, 'other');
  });

  await check('risk score clamped to 0..100', async () => {
    const engine = new JevDecisionEngine({
      policy: jevPolicy(),
      evaluateFn: async () => Promise.resolve({
        answers: {
          needsExternalCapability: { type: 'boolean', probability: 0.95 },
          operation: { type: 'choice', choice: 'mcp', probabilities: { mcp: 1 } },
          risk: { type: 'score', score: 4, probabilities: { 4: 1 } },
          needsConfirmation: { type: 'boolean', probability: 0.05 }
        }
      })
    });
    const r = await engine.decide({ state: buildDecisionState({ request: 'x' }) });
    assert.equal(r.risk.value, 100);
    assert.ok(r.risk.probability <= 1);
  });

  await check('timeout surfaces as jev:timeout error then legacy', async () => {
    const engine = new DecisionEngine({
      deterministic,
      jev: new JevDecisionEngine({
        policy: { ...jevPolicy(), decisionTimeoutMs: 30 },
        evaluateFn: () => new Promise(() => { /* never resolves */ })
      }),
      policy: { ...jevPolicy(), decisionTimeoutMs: 30 }
    });
    const r = await engine.decide({ request: 'summarize our deployment risks' });
    assert.equal(r.provider, 'legacy');
    assert.equal(r.reason, 'timeout');
  });

  console.log('\nDecisionEngine orchestration');
  console.log('---------------------------');

  await check('deterministic tool -> not skipped by gate', async () => {
    const engine = new DecisionEngine({ deterministic, policy: basePolicy() });
    const r = await engine.decide({ request: 'create a notion page' });
    assert.equal(r.provider, 'deterministic');
    const skip = decisionPolicy.shouldSkipMcp(r, { policy: engine.policy });
    assert.equal(skip, false);
  });

  await check('deterministic greeting -> skipped by gate', async () => {
    const engine = new DecisionEngine({ deterministic, policy: basePolicy() });
    const r = await engine.decide({ request: 'hello there' });
    const skip = decisionPolicy.shouldSkipMcp(r, { policy: engine.policy });
    assert.equal(skip, true);
  });

  await check('no gateway key / disabled -> legacy jev-unavailable', async () => {
    const engine = new DecisionEngine({ deterministic, policy: { ...basePolicy(), jevEnabled: true, gatewayKeyConfigured: false } });
    const r = await engine.decide({ request: 'summarize our deployment risks' });
    assert.equal(r.provider, 'legacy');
    assert.equal(r.reason, 'jev-unavailable');
  });

  await check('Jev high-confidence no-tool -> provider jev, gate skips', async () => {
    const engine = new DecisionEngine({
      deterministic,
      jev: new JevDecisionEngine({ policy: jevPolicy(), evaluateFn: fakeEvaluate(jevAnswers(0.03)) }),
      policy: jevPolicy()
    });
    const r = await engine.decide({ request: 'help me reason through the trade-off' });
    assert.equal(r.provider, 'jev');
    const skip = decisionPolicy.shouldSkipMcp(r, { policy: engine.policy });
    assert.equal(skip, true);
  });

  await check('Jev low-confidence -> legacy low-confidence, no skip', async () => {
    const engine = new DecisionEngine({
      deterministic,
      jev: new JevDecisionEngine({ policy: jevPolicy(), evaluateFn: fakeEvaluate(jevAnswers(0.5)) }),
      policy: jevPolicy()
    });
    const r = await engine.decide({ request: 'unclear request' });
    assert.equal(r.provider, 'legacy');
    assert.equal(r.reason, 'low-confidence');
    assert.equal(decisionPolicy.shouldSkipMcp(r, { policy: engine.policy }), false);
  });

  await check('Jev failure (thrown) -> legacy request-failed', async () => {
    const engine = new DecisionEngine({
      deterministic,
      jev: new JevDecisionEngine({
        policy: jevPolicy(),
        evaluateFn: async () => { throw new Error('upstream 500'); }
      }),
      policy: jevPolicy()
    });
    const r = await engine.decide({ request: 'an odd request' });
    assert.equal(r.provider, 'legacy');
    assert.equal(r.reason, 'request-failed');
  });

  console.log('\nMCP gate safety matrix');
  console.log('----------------------');

  const highConfNoTool = buildDecisionResult({
    provider: 'deterministic',
    latencyMs: 1,
    confidence: 1,
    needsExternalCapability: { value: false, probability: 1 }
  });

  const highConfTool = buildDecisionResult({
    provider: 'deterministic',
    latencyMs: 1,
    confidence: 1,
    needsExternalCapability: { value: true, probability: 1 }
  });

  const legacy = buildDecisionResult({
    provider: 'legacy',
    latencyMs: 1,
    confidence: 0,
    needsExternalCapability: { value: false, probability: 0 }
  });

  await check('high-confidence no-tool + clean -> skip', async () => {
    assert.equal(decisionPolicy.shouldSkipMcp(highConfNoTool, { policy: basePolicy() }), true);
  });

  await check('high-confidence no-tool + attachment -> NO skip', async () => {
    assert.equal(decisionPolicy.shouldSkipMcp(highConfNoTool, { policy: basePolicy(), hasAttachments: true }), false);
  });

  await check('high-confidence no-tool + pending tool -> NO skip', async () => {
    assert.equal(decisionPolicy.shouldSkipMcp(highConfNoTool, { policy: basePolicy(), hasPendingTool: true }), false);
  });

  await check('high-confidence no-tool + active working state -> NO skip', async () => {
    assert.equal(decisionPolicy.shouldSkipMcp(highConfNoTool, {
      policy: basePolicy(),
      workingState: { activeMedia: { tool: 'play_media' } }
    }), false);
  });

  await check('flag form of active state also blocks skip', async () => {
    assert.equal(decisionPolicy.shouldSkipMcp(highConfNoTool, { policy: basePolicy(), hasActiveWorkingState: true }), false);
  });

  await check('high-confidence tool -> NO skip', async () => {
    assert.equal(decisionPolicy.shouldSkipMcp(highConfTool, { policy: basePolicy() }), false);
  });

  await check('legacy result -> NEVER skip', async () => {
    assert.equal(decisionPolicy.shouldSkipMcp(legacy, { policy: basePolicy() }), false);
  });

  await check('low confidence (no tool but below threshold) -> NO skip', async () => {
    const low = buildDecisionResult({
      provider: 'deterministic',
      latencyMs: 1,
      confidence: 0.4,
      needsExternalCapability: { value: false, probability: 0.4 }
    });
    assert.equal(decisionPolicy.shouldSkipMcp(low, { policy: basePolicy() }), false);
  });

  await check('valueConfidence reflects chosen direction', () => {
    assert.equal(decisionPolicy.valueConfidence({ value: false, probability: 0.1 }, basePolicy()), 0.9);
    assert.equal(decisionPolicy.valueConfidence({ value: true, probability: 0.9 }, basePolicy()), 0.9);
    assert.equal(decisionPolicy.valueConfidence(null, basePolicy()), 0);
  });

  console.log('\nJev can never execute tools');
  console.log('---------------------------');

  await check('JevDecisionEngine has no execution surface', () => {
    const engine = new JevDecisionEngine({ policy: jevPolicy(), evaluateFn: fakeEvaluate(jevAnswers(0.03)) });
    assert.equal(typeof engine.execute, 'undefined');
    assert.equal(typeof engine.callTool, 'undefined');
    assert.equal(typeof engine.invoke, 'undefined');
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(engine));
    assert.ok(!proto.some((k) => /exec|call|invoke|run|tool/.test(k)));
  });

  await check('decision result never includes tool endpoints', async () => {
    const engine = new DecisionEngine({ deterministic, policy: basePolicy() });
    const r = await engine.decide({ request: 'hello' });
    assert.equal(r.toolEndpoint, undefined);
    assert.equal(r.mcpSchemas, undefined);
  });

  console.log('\nPolicy + contract');
  console.log('-----------------');

  await check('defaults match spec', () => {
    assert.ok(basePolicy().jevEnabled);
    assert.equal(basePolicy().jevModel, 'typesafe-ai/jev');
    assert.equal(basePolicy().noToolThreshold, 0.9);
    assert.equal(basePolicy().toolThreshold, 0.9);
    assert.equal(basePolicy().decisionTimeoutMs, 500);
    assert.ok(basePolicy().failOpen);
    assert.equal(basePolicy().gatewayKeyConfigured, false);
  });

  await check('env overrides feed the policy', () => {
    process.env.JEV_NO_TOOL_THRESHOLD = '0.75';
    process.env.JEV_DECISION_TIMEOUT_MS = '9000';
    const p = decisionPolicy.loadPolicy();
    assert.equal(p.noToolThreshold, 0.75);
    assert.equal(p.decisionTimeoutMs, 9000);
    delete process.env.JEV_NO_TOOL_THRESHOLD;
    delete process.env.JEV_DECISION_TIMEOUT_MS;
  });

  await check('thresholds are clamped to [0,1]', () => {
    process.env.JEV_NO_TOOL_THRESHOLD = '99';
    const p = decisionPolicy.loadPolicy();
    assert.equal(p.noToolThreshold, 1);
    delete process.env.JEV_NO_TOOL_THRESHOLD;
  });

  await check('buildDecisionState compacts pathological input', () => {
    const s = buildDecisionState({ request: 'x'.repeat(100000) });
    assert.ok(s.request.length <= 600);
    assert.ok(clamp01(2) === 1 && clamp01(-1) === 0);
  });

  await check('knowledge questions classify deterministic no-tool', async () => {
    for (const text of ['what is React?', 'explain JavaScript closures', 'how does a linked list work?']) {
      const r = deterministic.classify({ request: text, query: text });
      assert.equal(r.certain, true, text);
      assert.equal(r.decision.needsExternalCapability.value, false, text);
      assert.equal(r.decision.confidence, 1, text);
      assert.equal(r.decision.reason, 'deterministic-knowledge', text);
      assert.equal(
        decisionPolicy.shouldSkipMcp(r.decision, { policy: basePolicy(), hasAttachments: false, hasPendingTool: false, workingState: null }),
        true,
        text
      );
    }
  });

  await check('knowledge rule never skips personal/workspace lookups', async () => {
    for (const text of ['what is my project deadline?', 'what is in the document?', 'what time is it?']) {
      const r = deterministic.classify({ request: text, query: text });
      assert.equal(r.certain, false, text);
    }
    // Tool signal always wins over a knowledge opener.
    const live = deterministic.classify({ request: 'what is the weather in London?', query: 'what is the weather in London?' });
    assert.equal(live.certain, true);
    assert.equal(live.decision.needsExternalCapability.value, true);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error(`FAILED: ${fail} test(s)`);
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});