'use strict';

// JARVIS Action Substrate — slice 4C: EXECUTION-TIME APPROVAL GATE.
//
// Proves at the unified choke point (TaskExecutor.executeTool) that
// APPROVAL_REQUIRED is now a real, server-authoritative approval workflow:
//  14.  APPROVAL_REQUIRED does not execute immediately
//  15.  approval continues the SAME execution (exactly once)
//  16.  denial prevents execution
//  17.  expiry prevents execution
//  18.  cancellation prevents execution
//  19.  credits are not charged before approval
//  20.  approved execution charges/executes exactly once
//  21.  duplicate approval cannot execute twice
//  22.  concurrent approve race produces exactly one winner
//  23.  wrong-user approval is rejected
//  24.  wrong-workspace approval is rejected
//  25.  stale/expired approval is rejected
//  26.  direct TaskExecutor path obeys approval (no bypass, no-session fails closed)
//  27.  continuation path obeys approval
//  28.  planner path obeys approval
//  29.  recovery path obeys approval
//  30.  MCP denial remains denial (approval cannot override it)
//  31.  idempotency remains correct across the approval lifecycle
//  32.  execution envelope remains correct
//  +    Socket.IO event contract (server events + raw engine.io client)
//
// Run: cd server && node tests/taskExecutorApproval.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

// The credit service is mocked BEFORE TaskExecutor is loaded so the choke
// point picks up a credit-recording consumption stub (proves approvals-precede
// credits and approved-executions charge once).
const creditMock = {
  log: [],
  consumeCredits: async (actorId, amount = 1, reason = 'usage') => {
    creditMock.log.push({ actorId, amount, reason });
    return { success: true, creditsRemaining: 990, consumed: amount };
  },
  isGuestActorId: (id) => String(id || '').startsWith('guest_'),
};
require.cache[require.resolve('../services/creditService.js')] = {
  id: require.resolve('../services/creditService.js'),
  filename: require.resolve('../services/creditService.js'),
  loaded: true,
  exports: creditMock,
};

const TaskExecutor = require('../services/TaskExecutor');
const ToolRecoveryManager = require('../services/ToolRecoveryManager');
const { McpToolSource, McpManager, McpRegistry } = require('../lib/mcp');
const toolRegistry = require('../tools');
const caps = require('../lib/capabilities');
const store = require('../lib/capabilities/idempotencyStore');
const observability = require('../lib/capabilities/observability');
const approvalStore = require('../lib/capabilities/approvalStore');

let pass = 0;
let fail = 0;

async function test(label, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    fail += 1;
    process.exitCode = 1;
    console.error(`  FAIL  ${label}\n        ${err && err.message ? err.message : String(err)}`);
  }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// ---- helpers ---------------------------------------------------------------

const captureLogs = async (fn) => {
  const lines = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...a) => { lines.push({ type: 'log', args: a }); };
  console.warn = (...a) => { lines.push({ type: 'warn', args: a }); };
  console.error = (...a) => { lines.push({ type: 'error', args: a }); };
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 20)); // flush microtask emissions
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return lines;
};
const capLines = (lines) => lines.filter((l) => String(l.args && l.args[0]).includes('[Capability]'));
const capEventOf = (event) => (lines) => capLines(lines).filter((l) => l.args[0] === `[Capability] ${event}`);

const PLAIN_OPTS = {
  workspaceId: 'ws-4c',
  skipCreditCharge: true,
  conversationId: 'conv-4c',
};

const approvalPolicy = (capabilityId, reason = 'approve-first') => ({
  entries: [{ id: capabilityId, action: 'approval_required', reason }],
  guestDenied: [],
  workspaceRestricted: [],
});

const fakeSocket = (uid) => ({
  userId: uid,
  emitted: [],
  emit(event, payload) {
    this.emitted.push({ event, payload });
    return this;
  },
});

let toolCalls = 0;

const installNativeCounter = (name, cb) => {
  const tool = toolRegistry.tools[name];
  const original = tool.execute;
  tool.execute = async (args, context) => {
    toolCalls += 1;
    if (cb) {
      const out = await cb(args, context, original);
      if (out !== undefined) return out;
    }
    return { success: true, name, count: toolCalls };
  };
  return () => { tool.execute = original; };
};

const resetEverything = () => {
  store._reset();
  approvalStore._reset();
  toolCalls = 0;
  creditMock.log.length = 0;
  caps.operatorPolicy.resetOperatorPolicy();
};

// Wait until exactly one PENDING approval (matching a predicate) exists.
const waitForApproval = async (predicate = () => true, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = approvalStore.list().filter((a) => a.state === 'PENDING' && predicate(a));
    if (list.length >= 1) return list[0];
    await tick(5);
  }
  throw new Error('approval not requested in time');
};

const seedDeniedMcp = async () => {
  const registry = new McpRegistry();
  const manager = new McpManager({ registry });
  McpToolSource.init({ manager, registry });
  registry.register({
    id: '4c-mcp-1',
    name: 'Secured',
    slug: 'secured',
    scope: 'global',
    transport: 'stdio',
    deniedTools: ['do_not_touch'],
    tools: [
      { name: 'do_not_touch', description: 'blocked by MCP policy', inputSchema: { type: 'object', properties: {} } },
    ],
  });
  return { registry };
};

// ---- main ------------------------------------------------------------------

const main = async () => {
  console.log('Execution-time approval gate (slice 4C)');
  console.log('========================================');

  // 14 + 15. requested -> blocked immediately; approve -> executes exactly once
  await test('APPROVAL_REQUIRED does not execute until approved; approval continues execution once', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    const sock = fakeSocket('u-4c');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      const p = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, PLAIN_OPTS);
      const approval = await waitForApproval();
      assert.strictEqual(toolCalls, 0, 'must NOT execute before approval');
      assert.strictEqual(approval.state, 'PENDING');
      assert.strictEqual(approval.capabilityId, 'native:getTime');
      assert.strictEqual(approval.userId, 'u-4c');
      assert.strictEqual(approval.source, 'native');
      const reqEvent = sock.emitted.find((e) => e.event === 'agent:approval:requested');
      assert.ok(reqEvent, 'requested event emitted on the initiating socket');
      assert.strictEqual(reqEvent.payload.approvalId, approval.approvalId);
      const out = approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-4c' });
      assert.strictEqual(out.ok, true);
      const r = await p;
      assert.strictEqual(r.success, true, 'approved execution succeeds');
      assert.strictEqual(toolCalls, 1, 'exactly one execution after approval');
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // approval + requested event carry the same executing envelope id.
  await test('approval binds to the exact executing envelope id', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    const sock = fakeSocket('u-4c');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      const p = (async () => {
        const r = await TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, PLAIN_OPTS);
        return r;
      })();
      const approval = await waitForApproval();
      // envelope executionId is the same one surfaced in the requested event.
      const reqEvent = sock.emitted.find((e) => e.event === 'agent:approval:requested');
      assert.strictEqual(approval.executionId, reqEvent.payload.executionId,
        'approval + requested event carry the same executing envelope');
      assert.ok(String(approval.executionId).startsWith('cap-'));
      approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-4c' });
      const r = await p;
      assert.strictEqual(r.success, true);
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 16. denial prevents execution
  await test('denial prevents execution', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    const sock = fakeSocket('u-4c');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      const p = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, PLAIN_OPTS);
      const approval = await waitForApproval();
      approvalStore.resolve({ approvalId: approval.approvalId, decision: 'deny', userId: 'u-4c' });
      const r = await p;
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.errorType, 'execution.not_authorized');
      assert.strictEqual(r.authorization.approvalState, 'DENIED');
      assert.strictEqual(r.authorization.decision, 'deny');
      assert.strictEqual(toolCalls, 0, 'denied approval never executes');
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 17. expiry prevents execution
  await test('expiry prevents execution (TTL bounded)', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    const sock = fakeSocket('u-4c');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      const p = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, { ...PLAIN_OPTS, approvalTtlMs: 30 });
      const approval = await waitForApproval();
      approvalStore._expireNow(approval.approvalId); // deterministic expiry
      const r = await p;
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.errorType, 'execution.not_authorized');
      assert.strictEqual(r.authorization.approvalState, 'EXPIRED');
      assert.strictEqual(toolCalls, 0, 'expired approval never executes');
      // a late approve after expiry is rejected
      const late = approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-4c' });
      assert.strictEqual(late.ok, false);
      assert.strictEqual(approvalStore.read(approval.approvalId).state, 'EXPIRED');
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 18. cancellation prevents execution
  await test('cancellation (execution abort) prevents execution', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    const sock = fakeSocket('u-4c');
    const controller = new AbortController();
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      const p = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, { ...PLAIN_OPTS, signal: controller.signal });
      const approval = await waitForApproval();
      controller.abort();
      const r = await p;
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.cancelled, true, 'cancelled result flagged');
      assert.strictEqual(r.errorType, 'execution.not_authorized');
      assert.strictEqual(approvalStore.read(approval.approvalId).state, 'CANCELLED',
        'PENDING approval transitions to CANCELLED on abort');
      assert.strictEqual(toolCalls, 0, 'cancelled approval never executes');
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 19 + 20. credits not charged before approval; charged+executed once after
  await test('credits are not charged before approval; approved execution charges and executes once', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    const sock = fakeSocket('u-4c');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      const p = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, { workspaceId: 'ws-4c', conversationId: 'conv-4c' });
      const approval = await waitForApproval();
      assert.strictEqual(creditMock.log.length, 0, 'credit boundary untouched while awaiting approval');
      assert.strictEqual(toolCalls, 0);
      approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-4c' });
      const r = await p;
      assert.strictEqual(r.success, true);
      assert.strictEqual(toolCalls, 1, 'exactly one execution');
      assert.strictEqual(creditMock.log.length, 1, 'exactly one credit charge');
      assert.strictEqual(creditMock.log[0].reason, 'getTime');
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 21. duplicate approval cannot execute twice
  await test('duplicate approval cannot execute twice', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    const sock = fakeSocket('u-4c');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      const p = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, PLAIN_OPTS);
      const approval = await waitForApproval();
      const first = approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-4c' });
      const second = approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-4c' });
      const third = approvalStore.resolve({ approvalId: approval.approvalId, decision: 'deny', userId: 'u-4c' });
      assert.strictEqual(first.ok, true);
      assert.strictEqual(second.ok, false, 'second approve rejected');
      assert.strictEqual(third.ok, false, 'approve-then-deny rejected');
      const r = await p;
      assert.strictEqual(r.success, true);
      assert.strictEqual(toolCalls, 1, 'duplicate decisions never double-execute');
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 22. concurrent approve race produces exactly one winner
  await test('concurrent approve race produces exactly one winner and one execution', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    const sock = fakeSocket('u-4c');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      const p = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, PLAIN_OPTS);
      const approval = await waitForApproval();
      const outs = await Promise.all(
        Array.from({ length: 8 }, () =>
          approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-4c' }))
      );
      const winners = outs.filter((o) => o.ok === true);
      assert.strictEqual(winners.length, 1, 'exactly one approve wins the CAS');
      assert.strictEqual(approvalStore.read(approval.approvalId).state, 'APPROVED');
      const r = await p;
      assert.strictEqual(r.success, true);
      assert.strictEqual(toolCalls, 1);
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 23. wrong-user approval rejected
  await test('wrong-user approval is rejected and cannot release the execution', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    const sock = fakeSocket('u-4c');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      const p = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, PLAIN_OPTS);
      const approval = await waitForApproval();
      const evil = approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-evil' });
      assert.strictEqual(evil.ok, false);
      assert.strictEqual(evil.reason, 'user_mismatch');
      assert.strictEqual(approvalStore.read(approval.approvalId).state, 'PENDING', 'still pending for the real user');
      assert.strictEqual(toolCalls, 0);
      const right = approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-4c' });
      assert.strictEqual(right.ok, true);
      const r = await p;
      assert.strictEqual(r.success, true);
      assert.strictEqual(toolCalls, 1);
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 24. wrong-workspace approval rejected
  await test('wrong-workspace approval is rejected', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    const sock = fakeSocket('u-4c');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      const p = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, PLAIN_OPTS);
      const approval = await waitForApproval();
      const wrongWs = approvalStore.resolve({
        approvalId: approval.approvalId, decision: 'approve', userId: 'u-4c', workspaceId: 'ws-other',
      });
      assert.strictEqual(wrongWs.ok, false);
      assert.strictEqual(wrongWs.reason, 'workspace_mismatch');
      const right = approvalStore.resolve({
        approvalId: approval.approvalId, decision: 'approve', userId: 'u-4c', workspaceId: approval.workspaceId,
      });
      assert.strictEqual(right.ok, true);
      const r = await p;
      assert.strictEqual(r.success, true);
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 25. stale approval rejected (expired can never approve)
  await test('stale approval is rejected (expired + already-resolved both)', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    const sock = fakeSocket('u-4c');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      const p = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, { ...PLAIN_OPTS, approvalTtlMs: 25 });
      const approval = await waitForApproval();
      await tick(50);
      assert.strictEqual(approvalStore.read(approval.approvalId).state, 'EXPIRED', 'TTL fired on its own');
      const stale = approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-4c' });
      assert.strictEqual(stale.ok, false);
      assert.strictEqual(stale.reason, 'expired');
      const r = await p;
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.authorization.approvalState, 'EXPIRED');
      assert.strictEqual(toolCalls, 0);
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 26. direct TaskExecutor path obeys approval; no-session fails closed
  await test('direct TaskExecutor path obeys approval (no bypass; no session fails closed)', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      // No authenticated socket -> approval cannot be established -> safe failure.
      const noSession = await TaskExecutor.executeTool('getTime', {}, 'u-4c', null, PLAIN_OPTS);
      assert.strictEqual(noSession.success, false);
      assert.strictEqual(noSession.errorType, 'execution.not_authorized');
      assert.ok(String(noSession.authorization.reason).includes('no-session'));
      assert.strictEqual(approvalStore.list().length, 0, 'no approval state for an unrequestable approval');
      assert.strictEqual(toolCalls, 0);

      // Socket-authenticated identity mismatch is also fail-closed.
      const otherUserSocket = fakeSocket('u-evil');
      const mismatch = await TaskExecutor.executeTool('getTime', {}, 'u-4c', otherUserSocket, PLAIN_OPTS);
      assert.strictEqual(mismatch.success, false);
      assert.strictEqual(mismatch.errorType, 'execution.not_authorized');
      assert.strictEqual(toolCalls, 0);
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 27. continuation path obeys approval (structural + behavioral at the gate)
  await test('continuation path obeys approval (single gate; continuation-style call waits)', async () => {
    resetEverything();
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'AIService.js'), 'utf8');
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.strictEqual((codeOnly.match(/TaskExecutor\.executeTool\(/g) || []).length > 0, true,
      'continuation/main flow converge on TaskExecutor.executeTool');
    assert.ok(!/TaskExecutor\._executeToolCore\(/.test(codeOnly), 'no direct core bypass');
    assert.ok(!/\.execute\(args, context, socket\)/.test(codeOnly), 'no direct tool-body invocation');

    const restore = installNativeCounter('getTime');
    const sock = fakeSocket('u-4c');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      // Continuation re-runs use conversationId + workspaceId, exactly like
      // the AIService continuation call sites.
      const p = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, PLAIN_OPTS);
      const approval = await waitForApproval();
      assert.strictEqual(toolCalls, 0);
      approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-4c' });
      const r = await p;
      assert.strictEqual(r.success, true);
      assert.strictEqual(toolCalls, 1);
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 28. planner path obeys approval
  await test('planner path obeys approval (source gate + planner-style call fails closed without session)', async () => {
    resetEverything();
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'TaskPlanner.js'), 'utf8');
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(/TaskExecutor\.executeTool\(/.test(codeOnly), 'planner converges on the choke point');
    assert.ok(!/TaskExecutor\._executeToolCore\(/.test(codeOnly), 'planner never reaches the core directly');

    const restore = installNativeCounter('getTime');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      // Planner-style background call with no session: fail-closed, no side effect.
      const r = await TaskExecutor.executeTool('getTime', {}, 'u-4c', null, {
        workspaceId: 'ws-4c', conversationId: 'conv-plan-4c', skipCreditCharge: true,
      });
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.errorType, 'execution.not_authorized');
      assert.strictEqual(toolCalls, 0);
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 29. recovery path obeys approval
  await test('recovery path obeys approval (retry cannot bypass)', async () => {
    resetEverything();
    const restore = installNativeCounter('webSearch');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:webSearch'));
    try {
      const recovery = await ToolRecoveryManager.recoverToolResult({
        toolName: 'webSearch',
        args: { query: 'x' },
        result: { success: false, error: 'network timeout occurred' },
        userId: 'u-4c',
        retryCount: 0,
        workspaceId: 'ws-4c',
      });
      assert.strictEqual(recovery.recovered, false, 'approval-gated retry cannot auto-recover');
      assert.strictEqual(toolCalls, 0, 'retry never executed the tool');
      assert.strictEqual(approvalStore.list().length, 0, 'no session for the retry -> no approval created');
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 30. MCP denial remains denial; approval cannot override it
  await test('MCP denial remains denial; approval cannot override MCP authority', async () => {
    resetEverything();
    const { registry } = await seedDeniedMcp();
    const sock = fakeSocket('u-4c');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('mcp:secured:do_not_touch'));
    try {
      const r = await TaskExecutor.executeTool('mcp_secured_do_not_touch', {}, 'u-4c', sock, PLAIN_OPTS);
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.errorType, 'execution.not_authorized');
      assert.strictEqual(r.authorization.state, 'denied');
      assert.strictEqual(r.authorization.policySource, 'mcp-authority');
      assert.strictEqual(approvalStore.list().length, 0, 'MCP denial never creates an approval');
      assert.strictEqual(toolCalls, 0);
    } finally {
      await McpToolSource.shutdown();
      caps.operatorPolicy.resetOperatorPolicy();
    }
  });

  // 31. idempotency remains correct across the approval lifecycle
  await test('idempotency: duplicate logical request yields one approval, one execution', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    const sock = fakeSocket('u-4c');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    const keyed = (k, requestId) => ({
      workspaceId: 'ws-4c', skipCreditCharge: true, conversationId: 'conv-4c',
      idempotencyKey: k, requestId,
    });
    try {
      const a = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, keyed('k-31', 'r-31a'));
      const b = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, keyed('k-31', 'r-31b'));
      const approval = await waitForApproval();
      await tick(30); // let both preflights settle
      assert.strictEqual(approvalStore.list().length, 1, 'one logical action -> exactly one approval');
      approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-4c' });
      const [ra, rb] = await Promise.all([a, b]);
      const winners = [ra, rb].filter((r) => r && !r.replay);
      const replays = [ra, rb].filter((r) => r && r.replay);
      assert.strictEqual(winners.length, 1, 'exactly one request owns the execution');
      assert.strictEqual(replays.length, 1, 'the duplicate is an in-progress replay');
      assert.strictEqual(winners[0].success, true);
      assert.strictEqual(toolCalls, 1, 'exactly one execution for the logical action');
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  await test('idempotency: approved execution settles SUCCEEDED; later duplicate replays, never re-executes', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    const sock = fakeSocket('u-4c');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      const p1 = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, { ...PLAIN_OPTS, idempotencyKey: 'k-31b', requestId: 'r1' });
      const approval = await waitForApproval();
      approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-4c' });
      const r1 = await p1;
      assert.strictEqual(r1.success, true);
      assert.strictEqual(toolCalls, 1);

      const r2 = await TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, { ...PLAIN_OPTS, idempotencyKey: 'k-31b', requestId: 'r2' });
      assert.strictEqual(r2.replay, true, 'later duplicate replays the terminal success');
      assert.strictEqual(r2.outcome.status, 'SUCCEEDED');
      assert.strictEqual(toolCalls, 1, 'never re-executed');
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  await test('idempotency: approval timeout settles a consistent FAILED (no replayable success)', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    const sock = fakeSocket('u-4c');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      const p1 = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, { ...PLAIN_OPTS, idempotencyKey: 'k-31c', requestId: 'r1', approvalTtlMs: 30 });
      const approval = await waitForApproval();
      await tick(50); // TTL fires -> EXPIRED
      const r1 = await p1;
      assert.strictEqual(r1.success, false);
      assert.strictEqual(r1.errorType, 'execution.not_authorized');
      assert.strictEqual(r1.authorization.approvalState, 'EXPIRED');
      assert.strictEqual(toolCalls, 0);

      const r2 = await TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, { ...PLAIN_OPTS, idempotencyKey: 'k-31c', requestId: 'r2' });
      assert.strictEqual(r2.replay, true, 'duplicate replays the settled failure');
      assert.strictEqual(r2.success, false, 'never a replayable success');
      assert.strictEqual(r2.outcome.status, 'FAILED');
      assert.strictEqual(r2.outcome.errorType, 'authorization');
      assert.strictEqual(toolCalls, 0);
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  await test('idempotency: denied approval settles FAILED, never a replayable success', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    const sock = fakeSocket('u-4c');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      const p1 = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, { ...PLAIN_OPTS, idempotencyKey: 'k-31d', requestId: 'r1' });
      const approval = await waitForApproval();
      approvalStore.resolve({ approvalId: approval.approvalId, decision: 'deny', userId: 'u-4c' });
      const r1 = await p1;
      assert.strictEqual(r1.success, false);
      assert.strictEqual(r1.errorType, 'execution.not_authorized');
      const r2 = await TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, { ...PLAIN_OPTS, idempotencyKey: 'k-31d', requestId: 'r2' });
      assert.strictEqual(r2.replay, true);
      assert.strictEqual(r2.success, false, 'denied approval must not produce a success replay');
      assert.strictEqual(r2.outcome.status, 'FAILED');
      assert.strictEqual(toolCalls, 0);
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 32. execution envelope remains correct
  await test('envelope: approved round-trip emits a single started+succeeded on the same execution id', async () => {
    resetEverything();
    const logs = await captureLogs(async () => {
      const restore = installNativeCounter('getTime');
      const sock = fakeSocket('u-4c');
      caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
      try {
        const p = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, PLAIN_OPTS);
        const approval = await waitForApproval();
        approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-4c' });
        const r = await p;
        assert.strictEqual(r.success, true);
      } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
    });
    const started = capEventOf('capability.execution.started')(logs);
    const succeeded = capEventOf('capability.execution.succeeded')(logs);
    const requested = capEventOf('capability.approval.requested')(logs);
    const approved = capEventOf('capability.approval.approved')(logs);
    assert.strictEqual(started.length, 1, 'single started');
    assert.strictEqual(succeeded.length, 1, 'single succeeded');
    assert.strictEqual(requested.length, 1, 'single approval.requested');
    assert.strictEqual(approved.length, 1, 'single approval.approved');
    assert.strictEqual(succeeded[0].args[1].executionId, started[0].args[1].executionId, 'same envelope id');
    assert.notStrictEqual(approved[0].args[1].approvalId, started[0].args[1].executionId, 'approval id distinct from execution id');
  });

  await test('envelope: denied approval records a single authorization failure terminal', async () => {
    resetEverything();
    const logs = await captureLogs(async () => {
      const restore = installNativeCounter('getTime');
      const sock = fakeSocket('u-4c');
      caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
      try {
        const p = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, PLAIN_OPTS);
        const approval = await waitForApproval();
        approvalStore.resolve({ approvalId: approval.approvalId, decision: 'deny', userId: 'u-4c' });
        const r = await p;
        assert.strictEqual(r.success, false);
      } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
    });
    const failed = capEventOf('capability.execution.failed')(logs);
    const denied = capEventOf('capability.approval.denied')(logs);
    assert.strictEqual(failed.length, 1);
    assert.strictEqual(failed[0].args[1].status, 'failed');
    assert.strictEqual(failed[0].args[1].errorType, 'authorization');
    assert.strictEqual(denied.length, 1);
  });

  // Notification scope: only the initiating socket sees the request.
  await test('approval request is delivered only to the initiating socket', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    const sock = fakeSocket('u-4c');
    const bystander = fakeSocket('u-other');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      const p = TaskExecutor.executeTool('getTime', {}, 'u-4c', sock, PLAIN_OPTS);
      const approval = await waitForApproval();
      assert.strictEqual(bystander.emitted.length, 0, 'bystander socket sees nothing');
      assert.ok(sock.emitted.some((e) => e.event === 'agent:approval:requested'), 'only initiating socket notified');
      const payload = sock.emitted.find((e) => e.event === 'agent:approval:requested').payload;
      assert.deepStrictEqual(
        Object.keys(payload).sort(),
        ['approvalId', 'capabilityId', 'executionId', 'expiresAt', 'reason', 'risk', 'scope', 'source', 'state', 'toolName'].sort(),
        'request payload is safe preview metadata only '
      );
      assert.ok(!JSON.stringify(payload).match(/arg|secret|credential|token|password|auth|result|output/i),
        'never leaks args/credentials/auth data/outputs');
      approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-4c' });
      await p;
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // ---- Socket.IO event contract (real server wiring + raw engine.io client) ----
  await test('Socket.IO transport: requested reaches the client, resolve approves exactly once', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    const httpServer = http.createServer();
    const io = new Server(httpServer);
    io.use((socket, next) => {
      socket.userId = String(socket.handshake.query.uid || 'u-4c');
      next();
    });
    let socketsByUser = {};
    io.on('connection', (socket) => {
      socketsByUser[socket.userId] = socket;
      socket.on('agent:approval:resolve', async (data, ack) => {
        const out = approvalStore.resolve({
          approvalId: data && data.approvalId,
          decision: data && data.decision,
          userId: socket.userId,
        });
        if (typeof ack === 'function') ack(out);
      });
    });
    await new Promise((r) => httpServer.listen(0, r));
    const port = httpServer.address().port;
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));

    const clientA = await openRawClient(port, 'u-4c');
    const clientB = await openRawClient(port, 'u-evil');
    try {
      let attempts = 0;
      while ((!socketsByUser['u-4c'] || !socketsByUser['u-evil']) && attempts++ < 100) await tick(10);
      const serverSocket = socketsByUser['u-4c'];
      assert.ok(serverSocket, 'u-4c server socket captured');
      assert.ok(socketsByUser['u-evil'], 'u-evil server socket captured');

      const p = TaskExecutor.executeTool('getTime', {}, 'u-4c', serverSocket, PLAIN_OPTS);
      const req = await clientA.waitForEvent('agent:approval:requested', 2000);
      const payload = req && req[1];
      assert.ok(payload && payload.approvalId, 'requested event carries approvalId');
      assert.strictEqual(payload.toolName, 'getTime');
      assert.notStrictEqual(payload.approvalId, payload.executionId);
      assert.strictEqual(toolCalls, 0, 'no execution before approval over the transport');

      // Wrong user's socket cannot approve.
      clientB.send('agent:approval:resolve', { approvalId: payload.approvalId, decision: 'approve' });
      await clientB.flushSend(100);
      assert.strictEqual(approvalStore.read(payload.approvalId).state, 'PENDING',
        'different-user socket cannot approve');

      // Authenticated user approves over the wire.
      clientA.send('agent:approval:resolve', { approvalId: payload.approvalId, decision: 'approve' });
      const r = await p;
      assert.strictEqual(r.success, true, 'approval over the transport continues execution');
      assert.strictEqual(toolCalls, 1, 'exactly one execution via the transport');

      // The same approval cannot be re-approved (stale UI).
      clientA.send('agent:approval:resolve', { approvalId: payload.approvalId, decision: 'approve' });
      await clientA.flushSend(100);
      assert.strictEqual(toolCalls, 1, 'duplicate wire approve never double-executes');

      // Deny over the wire prevents execution.
      const callsBeforeDeny = toolCalls;
      const pD = TaskExecutor.executeTool('getTime', {}, 'u-4c', serverSocket, PLAIN_OPTS);
      const reqD = await clientA.waitForEvent('agent:approval:requested', 2000);
      const payloadD = reqD && reqD[1];
      assert.ok(payloadD && payloadD.approvalId, 'second requested event carries approvalId');
      clientA.send('agent:approval:resolve', { approvalId: payloadD.approvalId, decision: 'deny' });
      const denied = await pD;
      assert.strictEqual(denied.success, false, 'wire denial never executes');
      assert.strictEqual(denied.errorType, 'execution.not_authorized');
      assert.strictEqual(denied.authorization.approvalState, 'DENIED');
      assert.strictEqual(toolCalls, callsBeforeDeny, 'denied wire approval never executes');

      // Timeout over the wire (respond too late) never executes.
      const callsBeforeExpiry = toolCalls;
      const pE = TaskExecutor.executeTool('getTime', {}, 'u-4c', serverSocket, { ...PLAIN_OPTS, approvalTtlMs: 80 });
      const reqE = await clientA.waitForEvent('agent:approval:requested', 2000);
      const payloadE = reqE && reqE[1];
      assert.ok(payloadE && payloadE.approvalId, 'third requested event carries approvalId');
      await new Promise((r) => setTimeout(r, 150)); // let the TTL fire on its own
      assert.strictEqual(approvalStore.read(payloadE.approvalId).state, 'EXPIRED', 'TTL fired over the wire');
      const expired = await pE;
      assert.strictEqual(expired.success, false, 'expired wire approval never executes');
      assert.strictEqual(expired.errorType, 'execution.not_authorized');
      assert.strictEqual(expired.authorization.approvalState, 'EXPIRED');
      assert.strictEqual(toolCalls, callsBeforeExpiry, 'expired wire approval never executes');
    } finally {
      restore();
      caps.operatorPolicy.resetOperatorPolicy();
      clientA.close();
      clientB.close();
      socketsByUser = {};
      io.close();
      await new Promise((r) => httpServer.close(r));
    }
  });

  console.log(`\n${pass + fail} tests, ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
};

// ---- minimal raw engine.io/socket.io v4 WebSocket client (Node >= 22) ------
const openRawClient = async (port, uid) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket&uid=${encodeURIComponent(uid)}`);
  const events = [];
  const waiters = [];
  let connectedResolve;
  let connectedReject;
  const connected = new Promise((res, rej) => { connectedResolve = res; connectedReject = rej; });

  ws.onerror = (err) => connectedReject(new Error(`ws error: ${err && err.message ? err.message : 'unknown'}`));

  ws.onopen = () => {
    // Engine.IO v4: wait for the server open packet ('0'...), then send the
    // socket.io namespace CONNECT ('40').
  };

  ws.onmessage = async (ev) => {
    const data = typeof ev.data === 'string' ? ev.data : await ev.data.text();
    for (const packet of data.split('\x1e')) {
      if (!packet) continue;
      const type = packet[0];
      if (type === '2') { try { ws.send('3'); } catch { /* closing */ } continue; }
      if (type === '0') { try { ws.send('40'); } catch { /* closing */ } continue; }
      if (type === '4') {
        const inner = packet.slice(1);
        if (inner.startsWith('0')) {
          connectedResolve();
          continue;
        }
        if (inner.startsWith('2')) {
          let parsed;
          try { parsed = JSON.parse(inner.slice(1)); } catch { continue; }
          events.push(parsed);
          for (const w of waiters.splice(0)) w();
        }
      }
    }
  };

  const deadline = Date.now() + 3000;
  await Promise.race([
    connected,
    new Promise((_, rej) => setTimeout(() => rej(new Error('raw client connect timeout')), 3000)),
  ]);

  return {
    connected,
    events,
    send(event, payload) {
      try { ws.send(`42${JSON.stringify([event, payload])}`); } catch { /* closing */ }
    },
    async flushSend(ms = 100) {
      await new Promise((r) => setTimeout(r, ms));
    },
    async waitForEvent(name, timeoutMs = 2000) {
      const take = () => {
        const idx = events.findIndex((e) => e && e[0] === name);
        if (idx === -1) return undefined;
        return events.splice(idx, 1)[0];
      };
      const immediate = take();
      if (immediate) return immediate;
      return new Promise((resolve, reject) => {
        const ticker = () => {
          const f = take();
          if (f) { clearTimeout(timer); resolve(f); }
        };
        const timer = setTimeout(() => {
          const i = waiters.indexOf(ticker);
          if (i !== -1) waiters.splice(i, 1);
          reject(new Error(`event ${name} not received`));
        }, timeoutMs);
        waiters.push(ticker);
      });
    },
    close() { try { ws.close(); } catch { /* closing */ } },
  };
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});