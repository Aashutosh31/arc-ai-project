/* AIService REQUEST-PATH decision-gate tests (guest harness).
 *
 * Run with: node tests/aiserviceDecisionGateRequestPath.test.js
 *
 * Drives the REAL AIService.processQuery() end-to-end in a guest context so
 * no Mongo/network is required, and proves at the request-path level that:
 *
 *   - a conversational turn ("hello") never triggers MCP discovery
 *     (schemasForRequest is NOT called; the run completes normally)
 *   - a tool turn ("List my Linear projects") DOES enter the MCP path
 *     (schemasForRequest IS called)
 *   - the on-path DecisionEngine verdict is captured and matches the
 *     discovery behavior (false -> no MCP, true -> MCP)
 *
 * Implements the real request path  REQUEST -> AIService -> DecisionEngine
 * -> decisionPolicy.shouldSkipMcp -> MCP gate.
 * Jev never executes anything: the only "execution" here is the LLM stub.
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

console.log('AIService Request-Path Decision-Gate Tests');
console.log('==========================================');

const AIService = require('../services/AIService');
const GuestSession = require('../models/GuestSession');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const AIMemory = require('../models/AIMemory');
const ttsService = require('../services/ttsService');
const { McpToolSource } = require('../lib/mcp');

// ---- Stub registry (all restored in restoreStubs) ----
const stubs = [];
const healingStub =
  (owner, key, fn) =>
  (...args) =>
    fn(...args);

function patch(target, key, fn) {
  if (!target || target[key] === fn) return;
  stubs.push({ target, key, prev: target[key] });
  target[key] = (typeof target[key] === 'function')
    ? healingStub(target, key, fn)
    : fn;
}

function restoreStubs() {
  for (const { target, key, prev } of stubs.reverse()) {
    if (prev === undefined) delete target[key];
    else target[key] = prev;
  }
  stubs.length = 0;
}

const makeSocket = () => ({
  id: 'test-socket',
  isInterrupted: false,
  emit: () => {},
  on: () => {},
  off: () => {},
});

(async () => {
  // Primary seam spies: record the on-path decision + MCP discovery calls.
  const realDecide = AIService.decisionEngine.decide.bind(AIService.decisionEngine);
  const realSchemasForRequest = McpToolSource.schemasForRequest.bind(McpToolSource);
  const decisions = [];
  let schemaCallCount = 0;

  patch(AIService.decisionEngine, 'decide', async (args) => {
    const decision = await realDecide(args);
    decisions.push(decision);
    return decision;
  });
  patch(McpToolSource, 'schemasForRequest', async (opts) => {
    schemaCallCount += 1;
    return { schemas: [], metadata: null, failures: [], blocked: [] };
  });

  // Runtime stubs (guest flow: no Mongo, no network, no real LLM).
  patch(GuestSession, 'findOne', async () => ({
    creditsRemaining: 12,
    save: async () => {},
  }));
  patch(AIService.workspaceRuntime, 'resolveWorkspace', async () => null);
  patch(ttsService, 'isServerTtsActive', () => false);
  patch(ttsService, 'getDefaultTtsLanguage', () => 'en-US');
  patch(AIService.llmRouter, 'generate', async () => ({
    text: 'ok',
    model: 'test-model',
    provider: 'test',
    tokens: { input: 2, output: 3 },
    fallbackUsed: false,
    route: null,
  }));
  patch(AIService.llmRouter, 'streamingRuntime', {
    consume: async () => 'ok',
    emitText: async () => 'ok',
  });
  patch(AIService, 'streamingRuntime', {
    consume: async () => 'ok',
    emitText: async () => 'ok',
  });
  // Defensive DB-model stubs (unexpected-path insurance; guest normally
  // avoids these branches entirely).
  patch(Conversation, 'findById', async () => null);
  patch(Conversation, 'findByIdAndUpdate', async () => {});
  patch(Conversation, 'create', async (doc) => ({ _id: 'conv-stub', ...doc }));
  patch(Message, 'create', async (doc) => ({ _id: 'msg-stub', ...doc }));
  patch(Message, 'findById', async () => ({ _id: 'msg-stub' }));
  patch(Message, 'findByIdAndUpdate', async () => {});
  patch(AIMemory, 'find', async () => []);

  try {
    // ---- Case A: conversational turn must NOT touch MCP ----
    await check('request path: "hello" bypasses MCP discovery entirely', async () => {
      const result = await AIService.processQuery(
        'guest_auth_test',
        'hello',
        makeSocket(),
        null,
        null,
        null,
        null,
        null,
      );
      assert.strictEqual(typeof result, 'string', 'processQuery must complete');
      assert.strictEqual(
        schemaCallCount,
        0,
        'schemasForRequest must NOT be called for a no-tool turn',
      );
      assert.ok(decisions.length >= 1, 'DecisionEngine must have run in the path');
      const last = decisions[decisions.length - 1];
      assert.strictEqual(last.needsExternalCapability.value, false, 'verdict: no external capability');
      assert.strictEqual(typeof last.needsExternalCapability.probability, 'number');
    });

    // ---- Case B: tool turn must enter MCP discovery ----
    const before = schemaCallCount;
    await check('request path: "List my Linear projects" enters MCP discovery', async () => {
      const result = await AIService.processQuery(
        'guest_auth_test',
        'List my Linear projects',
        makeSocket(),
        null,
        null,
        null,
        null,
        null,
      );
      assert.strictEqual(typeof result, 'string', 'processQuery must complete');
      assert.ok(
        schemaCallCount > before,
        'schemasForRequest must be called for a tool turn',
      );
      const last = decisions[decisions.length - 1];
      assert.ok(last, 'must have run a decision for the tool turn');
      assert.strictEqual(last.needsExternalCapability.value, true, 'verdict: external capability required');
    });

    // ---- Jev never executes a tool from the request path ----
    await check('request path: Jev decides but never executes anything', async () => {
      const engine = AIService.decisionEngine;
      assert.strictEqual(typeof engine.jev.execute, 'undefined');
      const providerNamespace = Object.getOwnPropertyNames(Object.getPrototypeOf(engine.jev));
      assert.ok(!providerNamespace.includes('execute'), 'Jev prototype has no execute');
      // The only execution surface in the harness is the stub LLM.
      assert.ok(!decisions.some((d) => typeof d.execute === 'function'));
    });
  } finally {
    restoreStubs();
  }

  console.log('\nResult: ' + pass + ' pass, ' + fail + ' fail');
  process.exitCode = fail > 0 ? 1 : 0;
})();