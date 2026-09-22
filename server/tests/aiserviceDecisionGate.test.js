/* AIService → Jev decision-gate LIVE wiring tests.
 *
 * Run with: node tests/aiserviceDecisionGate.test.js
 *
 * These are the "real integration" tests that the isolated decisionLayer
 * suite cannot provide: they exercise the ACTUAL AIService singleton and
 * prove that the upstream decision gate is wired into the request path.
 *
 * Baseline defect this guards:
 *   - AIService referenced this.decisionEngine / decisionPolicy but they
 *     were never imported or assigned. The gate threw a TypeError, was
 *     swallowed by catch, and fail-opened on EVERY request — the upstream
 *     Jev MCP skip gate never ran.
 *
 * Contracts under test:
 *   - AIService exposes the real decisionEngine + decisionPolicy (facade)
 *   - DecisionEngine.decide is actually invoked by AIService
 *   - decisionPolicy.shouldSkipMcp is actually consulted
 *   - high-confidence no-tool -> skipMcpGate true (MCP bypassed)
 *   - tool-signal           -> skipMcpGate false (MCP path entered)
 *   - engine timeout/throw / low-confidence -> FAIL OPEN (null, false)
 *   - missing engine        -> fail open, never throws
 *   - attachments disable skipping
 *   - Jev has no tool-execution surface
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

console.log('AIService Jev Decision-Gate Wiring Tests');
console.log('========================================');

const AIService = require('../services/AIService');
const facade = require('../services/decision');

const restore = (obj, key, value) => {
  if (value === undefined) delete obj[key];
  else obj[key] = value;
};

(async () => {
  // 1. Wiring regression: the live singleton must carry the decision refs.
  await check('AIService exposes a live decisionEngine + decisionPolicy', async () => {
    assert.ok(AIService.decisionEngine, 'this.decisionEngine must be defined');
    assert.ok(AIService.decisionPolicy, 'this.decisionPolicy must be defined');
    assert.strictEqual(typeof AIService.decisionEngine.decide, 'function');
    assert.strictEqual(typeof AIService.decisionPolicy.shouldSkipMcp, 'function');
  });

  // 2. The live refs ARE the facade's singleton (not a stale copy).
  await check('AIService uses the services/decision facade singleton', async () => {
    assert.strictEqual(AIService.decisionEngine, facade.decisionEngine);
    assert.strictEqual(AIService.decisionPolicy, facade.decisionPolicy);
  });

  // 3. Real engine over the seam: greeting -> high-confidence no-tool skip.
  await check('greeting (hello) -> decision made by AIService, skipMcp TRUE', async () => {
    const gate = await AIService.evaluateUpstreamDecisionGate({
      request: 'hello',
      query: 'hello',
      signal: null,
    });
    assert.ok(gate.decisionGate, 'decisionGate must be produced');
    assert.strictEqual(gate.decisionGate.provider, 'deterministic');
    assert.strictEqual(gate.decisionGate.operation.value, 'chat');
    assert.strictEqual(gate.skipMcpGate, true);
  });

  // 4. Knowledge question -> high-confidence no-tool skip.
  await check('knowledge question (What is React?) -> skipMcp TRUE', async () => {
    const gate = await AIService.evaluateUpstreamDecisionGate({
      request: 'What is React?',
      query: 'What is React?',
      signal: null,
    });
    assert.strictEqual(gate.decisionGate.provider, 'deterministic');
    assert.strictEqual(gate.skipMcpGate, true);
  });

  // 5. Tool signal -> MCP path must stay open.
  await check('tool request (List my Linear projects) -> skipMcp FALSE', async () => {
    const gate = await AIService.evaluateUpstreamDecisionGate({
      request: 'List my Linear projects',
      query: 'List my Linear projects',
      signal: null,
    });
    assert.strictEqual(gate.decisionGate.provider, 'deterministic');
    assert.strictEqual(gate.decisionGate.operation.value, 'mcp');
    assert.strictEqual(gate.skipMcpGate, false);
  });

  // 6. Attachment guard: even a no-tool verdict cannot skip with media.
  await check('attachments disable skipping (hasAttachment)', async () => {
    const gate = await AIService.evaluateUpstreamDecisionGate({
      request: 'hello',
      query: 'hello',
      hasAttachment: true,
      signal: null,
    });
    assert.strictEqual(gate.skipMcpGate, false);
  });

  // 7. Active working-state surface forces the full pipeline.
  await check('active working-state disables skipping', async () => {
    const gate = await AIService.evaluateUpstreamDecisionGate({
      request: 'hello',
      query: 'hello',
      workingState: { activeMedia: { title: 'track', videoId: 'x' } },
      signal: null,
    });
    assert.strictEqual(gate.skipMcpGate, false);
  });

  // 8. Jev timeout/unavailable -> FAIL OPEN (never blocks a request).
  await check('engine throw/timeout -> fail open to legacy behavior', async () => {
    const prev = AIService.decisionEngine;
    AIService.decisionEngine = {
      policy: prev.policy,
      decide: async () => {
        throw new Error('jev-timeout');
      },
    };
    try {
      const gate = await AIService.evaluateUpstreamDecisionGate({
        request: 'hello',
        query: 'hello',
        signal: null,
      });
      assert.strictEqual(gate.decisionGate, null);
      assert.strictEqual(gate.skipMcpGate, false);
    } finally {
      restore(AIService, 'decisionEngine', prev);
    }
  });

  // 9. Low-confidence / legacy decision never suppresses the pipeline.
  await check('legacy low-confidence decision -> skipMcp FALSE', async () => {
    const prev = AIService.decisionEngine;
    AIService.decisionEngine = {
      policy: prev.policy,
      decide: async () =>
        facade.decisionTypes.buildDecisionResult({
          provider: 'legacy',
          needsExternalCapability: { value: false, probability: 0 },
        }),
    };
    try {
      const gate = await AIService.evaluateUpstreamDecisionGate({
        request: 'do whatever seems right',
        query: 'do whatever seems right',
        signal: null,
      });
      assert.strictEqual(gate.decisionGate.provider, 'legacy');
      assert.strictEqual(gate.skipMcpGate, false);
    } finally {
      restore(AIService, 'decisionEngine', prev);
    }
  });

  // 10. Missing engine short-circuit: structure only, still fail-open.
  await check('missing engine -> fail open, no throw', async () => {
    const prev = AIService.decisionEngine;
    AIService.decisionEngine = null;
    try {
      const gate = await AIService.evaluateUpstreamDecisionGate({
        request: 'hello',
        query: 'hello',
        signal: null,
      });
      assert.strictEqual(gate.decisionGate, null);
      assert.strictEqual(gate.skipMcpGate, false);
    } finally {
      restore(AIService, 'decisionEngine', prev);
    }
  });

  // 11. AIService really calls DecisionEngine.decide (spy on the seam).
  await check('AIService invokes DecisionEngine.decide with the request', async () => {
    const prevEngine = AIService.decisionEngine;
    const prevPolicy = AIService.decisionPolicy;
    let decidedRequest = null;
    let policyConsulted = null;
    let decideArgs = null;
    AIService.decisionEngine = {
      policy: prevPolicy.loadPolicy(),
      decide: async (args) => {
        decideArgs = args;
        decidedRequest = args.request;
        return facade.decisionTypes.buildDecisionResult({
          provider: 'deterministic',
          needsExternalCapability: { value: false, probability: 1 },
          operation: { value: 'chat', probability: 1 },
          confidence: 1,
        });
      },
    };
    AIService.decisionPolicy = {
      ...prevPolicy,
      shouldSkipMcp: (result, opts) => {
        policyConsulted = { result, opts };
        return prevPolicy.shouldSkipMcp(result, opts);
      },
    };
    try {
      const gate = await AIService.evaluateUpstreamDecisionGate({
        request: 'hello there',
        query: 'hello there',
        signal: null,
      });
      assert.strictEqual(decidedRequest, 'hello there');
      assert.strictEqual(gate.skipMcpGate, true);
      assert.ok(policyConsulted, 'decisionPolicy.shouldSkipMcp must be consulted');
      assert.strictEqual(policyConsulted.result.provider, 'deterministic');
    } finally {
      restore(AIService, 'decisionEngine', prevEngine);
      restore(AIService, 'decisionPolicy', prevPolicy);
    }
  });

  // 12. Jev exposes no execution surface (can never run a tool).
  await check('Jev has no tool-execution surface', async () => {
    const engine = AIService.decisionEngine;
    assert.strictEqual(typeof engine.jev.execute, 'undefined');
    assert.strictEqual(typeof engine.jev.executeTool, 'undefined');
    assert.strictEqual(typeof engine.jev.callTool, 'undefined');
    assert.strictEqual(typeof engine.execute, 'undefined');
    assert.strictEqual(typeof engine.executeTool, 'undefined');
    assert.ok(typeof engine.jev.decide === 'function', 'Jev only answers decisions');
  });

  // 13. The live request path uses the seam (guards against bypass).
  await check('processQuery routes the gate through the seam method', async () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/AIService'), 'utf8');
    const usesSeam = src.split('const decisionGate = upstreamGate.decisionGate;').length >= 2;
    assert.ok(usesSeam, 'processQuery must consume evaluateUpstreamDecisionGate');
    assert.ok(
      src.indexOf('this.evaluateUpstreamDecisionGate({') !== -1,
      'seam method must be referenced on the instance',
    );
  });

  console.log('\nResult: ' + pass + ' pass, ' + fail + ' fail');
  process.exitCode = fail > 0 ? 1 : 0;
})();