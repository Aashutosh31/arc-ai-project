'use strict';

// JARVIS Action Substrate — slice 4B: EXECUTION-TIME AUTHORIZATION
// ENFORCEMENT at the real execution boundary.
//
// Proves at the unified choke point (TaskExecutor.executeTool):
//   1.  native AUTO executes
//   2.  native DENIED never executes (tool body never invoked)
//   3.  native DENIED does not charge credits
//   4.  native DENIED produces no clientAction
//   5.  native APPROVAL_REQUIRED stays transitional/non-blocking (4B)
//   6.  MCP policy denial remains denied
//   7.  capability policy cannot override MCP denial
//   8.  direct TaskExecutor execution cannot bypass DENIED
//   9.  continuation path cannot bypass DENIED (structural: single gate)
//  10.  planner path cannot bypass DENIED (structural: single gate)
//  11.  recovery path cannot bypass DENIED (behavioral retry)
//  12.  authoritative capability identity is used (not the raw requested name)
//  13.  forged/substituted authorization claims fail safely
//  14.  unknown capability fails safely
//  15.  malformed capability/policy fails safely
//  16.  authorization does not alter the existing successful result shape
//  17.  idempotency still behaves correctly
//  18.  execution envelope still behaves correctly
//  19.  Jev remains uninvolved in execution authorization
//  20.  no second execution path exists
//
// Run: cd server && node tests/taskExecutorAuthorization.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const z = require('zod');
const { McpServer } = require('@modelcontextprotocol/server');
const { InMemoryTransport } = require('@modelcontextprotocol/client');

// The credit service is mocked BEFORE TaskExecutor is loaded so the
// choke point picks up a credit-recording consumption stub. Counts every
// charge attempt and reports success — proving denied executions never
// reach the credit boundary (and Mongo-independent non-skip runs work).
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
const { SCOPES, RISKS } = caps.capabilityTypes;

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
    console.error(`  FAIL  ${label}\n        ${err && err.stack ? err.message : String(err)}`);
  }
}

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
    await new Promise((r) => setTimeout(r, 15)); // flush microtask emissions
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return lines;
};

const capLines = (lines) => lines.filter((l) => String(l.args && l.args[0]).includes('[Capability]'));
const capEventOf = (event) => (lines) => capLines(lines).filter((l) => l.args[0] === `[Capability] ${event}`);

const KEYED_OPTS = {
  workspaceId: 'ws-4b',
  skipCreditCharge: true,
  conversationId: 'conv-4b',
  idempotencyKey: '4b-key',
  requestId: '4b-req',
};

// No idempotency identity: every call executes fresh through the gate. Used
// everywhere except the two idempotency-dedup tests (which need KEYED_OPTS).
const PLAIN_OPTS = {
  workspaceId: 'ws-4b',
  skipCreditCharge: true,
  conversationId: 'conv-4b',
};

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
  toolCalls = 0;
  creditMock.log.length = 0;
  caps.operatorPolicy.resetOperatorPolicy();
};

const denyPolicy = (capabilityId, reason = 'operator-block') => ({
  entries: [{ id: capabilityId, action: 'deny', reason }],
  guestDenied: [],
  workspaceRestricted: [],
});

const approvalPolicy = (capabilityId, reason = 'approve-first') => ({
  entries: [{ id: capabilityId, action: 'approval_required', reason }],
  guestDenied: [],
  workspaceRestricted: [],
});

// ---- MCP fixtures ----------------------------------------------------------

// Denied-path MCP fixture: seeded registry, NO live connection. The pipeline
// denial path never needs to connect, so this proves MCP authority without
// any network. Allowed tools still resolve for capability metadata.
const seedDeniedMcp = async () => {
  const registry = new McpRegistry();
  const manager = new McpManager({ registry });
  McpToolSource.init({ manager, registry });
  registry.register({
    id: '4b-mcp-1',
    name: 'Secured',
    slug: 'secured',
    scope: 'global',
    transport: 'stdio',
    deniedTools: ['do_not_touch'],
    tools: [
      { name: 'do_not_touch', description: 'blocked by MCP policy', inputSchema: { type: 'object', properties: {} } },
      { name: 'harmless_read', description: 'a permitted reader', inputSchema: { type: 'object', properties: {} } },
    ],
  });
  return { registry };
};

// Allowed-path MCP fixture: live in-memory MCP server (readOnlyHint), so an
// MCP-authorized tool actually executes end-to-end.
const createReadServer = () => {
  const server = new McpServer({ name: '4b-reader', version: '1.0.0' });
  server.registerTool(
    'read_status',
    {
      description: 'Reads the current status (read-only).',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      toolCalls += 1;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    }
  );
  return server;
};

// ---- main ------------------------------------------------------------------

const main = async () => {
  console.log('Execution-time authorization enforcement (slice 4B)');
  console.log('====================================================');
  resetEverything();

  // 1. native AUTO executes
  await test('native AUTO executes normally (getTime)', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    try {
      const r = await TaskExecutor.executeTool('getTime', {}, 'u-4b', null, KEYED_OPTS);
      assert.strictEqual(r.success, true);
      assert.strictEqual(toolCalls, 1);
    } finally { restore(); }
  });

  // 2. native DENIED never executes
  await test('native DENIED never executes the tool body', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    caps.operatorPolicy.setOperatorPolicy(denyPolicy('native:getTime'));
    try {
      const r = await TaskExecutor.executeTool('getTime', {}, 'u-4b', null, KEYED_OPTS);
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.errorType, 'execution.not_authorized');
      assert.strictEqual(toolCalls, 0, 'denied tool must never run');
      assert.strictEqual(r.authorization.state, 'denied');
      assert.strictEqual(r.authorization.requiresApproval, false);
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 3. native DENIED does not charge credits
  await test('native DENIED does not charge execution credits', async () => {
    resetEverything();
    const restore = installNativeCounter('webSearch');
    caps.operatorPolicy.setOperatorPolicy(denyPolicy('native:webSearch'));
    try {
      const denied = await TaskExecutor.executeTool('webSearch', { query: 'x' }, 'u-4b', null,
        { workspaceId: 'ws-4b' }); // NO skipCreditCharge -> credit path is live
      assert.strictEqual(denied.success, false);
      assert.strictEqual(denied.errorType, 'execution.not_authorized');
      assert.strictEqual(creditMock.log.length, 0, 'denied must not consume credits');
      assert.strictEqual(toolCalls, 0);

      caps.operatorPolicy.resetOperatorPolicy();
      const allowed = await TaskExecutor.executeTool('webSearch', { query: 'x' }, 'u-4b', null,
        { workspaceId: 'ws-4b' });
      assert.strictEqual(allowed.success, true);
      assert.strictEqual(creditMock.log.length, 1, 'allowed path still consumes credits once');
      assert.strictEqual(creditMock.log[0].reason, 'webSearch');
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 4. native DENIED produces no clientAction
  await test('native DENIED emits no clientAction and no socket event', async () => {
    resetEverything();
    const socketEvents = [];
    const socket = { emit: (event, payload) => socketEvents.push({ event, payload }) };
    caps.operatorPolicy.setOperatorPolicy(denyPolicy('native:changeTheme'));
    try {
      const r = await TaskExecutor.executeTool('changeTheme', { theme: 'synthwave' }, 'u-4b', socket, PLAIN_OPTS);
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.clientAction, undefined, 'denied result must carry no clientAction');
      assert.ok(!socketEvents.some((e) => e.event === 'ai:client:action'), 'no clientAction emitted');

      caps.operatorPolicy.resetOperatorPolicy();
      const allowed = await TaskExecutor.executeTool('changeTheme', { theme: 'synthwave' }, 'u-4b', socket, PLAIN_OPTS);
      assert.strictEqual(allowed.success, true);
      assert.strictEqual(allowed.clientAction.type, 'CHANGE_THEME',
        'undernied changeTheme still returns its clientAction');
    } finally { caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 5. APPROVAL_REQUIRED stays transitional / non-blocking
  await test('native APPROVAL_REQUIRED remains transitional (executes, verdict-only)', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
    try {
      const r = await TaskExecutor.executeTool('getTime', {}, 'u-4b', null, PLAIN_OPTS);
      assert.strictEqual(r.success, true, 'approval-required must NOT block in 4B');
      assert.strictEqual(toolCalls, 1);
      assert.strictEqual(r.authorization, undefined, 'approved result carries no denial metadata');
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }

    // Verdict metadata is observable, not fabricated into the result.
    const logs = await captureLogs(async () => {
      const restore2 = installNativeCounter('getTime');
      caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
      try { await TaskExecutor.executeTool('getTime', {}, 'u-4b', null, PLAIN_OPTS); }
      finally { restore2(); caps.operatorPolicy.resetOperatorPolicy(); }
    });
    const approvalEvents = capEventOf('capability.authorization.approval_required')(logs);
    assert.strictEqual(approvalEvents.length, 1, 'approval_required verdict is observable');
    assert.strictEqual(approvalEvents[0].args[1].state, 'approval_required');
  });

  // 6 + 7. MCP policy denial is authoritative and non-overridable
  await test('MCP policy denial remains denied', async () => {
    resetEverything();
    const { registry } = await seedDeniedMcp();
    try {
      const denyEntry = registry.toolByWireName('mcp_secured_do_not_touch');
      assert.ok(denyEntry, 'denied wire tool must still resolve (server-side policy)');
      const r = await TaskExecutor.executeTool('mcp_secured_do_not_touch', {}, 'u-4b', null, KEYED_OPTS);
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.errorType, 'execution.not_authorized');
      assert.strictEqual(r.authorization.state, 'denied');
      assert.strictEqual(r.authorization.reason, 'mcp-denied');
      assert.strictEqual(r.authorization.policySource, 'mcp-authority');
      assert.strictEqual(toolCalls, 0);
      assert.strictEqual(creditMock.log.length, 0);
    } finally {
      await McpToolSource.shutdown();
      caps.operatorPolicy.resetOperatorPolicy();
    }
  });

  await test('capability policy cannot override an MCP denial', async () => {
    resetEverything();
    const { registry } = await seedDeniedMcp();
    try {
      const capId = registry.toolByWireName('mcp_secured_do_not_touch').canonicalName;
      // Even an explicit operator "auto" for the exact capability id cannot
      // resurrect a tool denied by the authoritative MCP policy.
      caps.operatorPolicy.setOperatorPolicy({
        entries: [{ id: capId, action: 'auto', reason: 'operator-wants-it' }],
        guestDenied: [],
        workspaceRestricted: [],
      });
      const r = await TaskExecutor.executeTool('mcp_secured_do_not_touch', {}, 'u-4b', null, KEYED_OPTS);
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.errorType, 'execution.not_authorized');
      assert.strictEqual(r.authorization.policySource, 'mcp-authority');
    } finally {
      await McpToolSource.shutdown();
      caps.operatorPolicy.resetOperatorPolicy();
    }
  });

  // MCP-authorized read-only tool still executes (readOnly auto).
  await test('MCP tool authorized by pipeline executes normally', async () => {
    resetEverything();
    const registry = new McpRegistry();
    const manager = new McpManager({ registry });
    McpToolSource.init({ manager, registry });
    const server = createReadServer();
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    await server.connect(serverEnd);
    registry.register({
      id: '4b-reader-1',
      name: 'Reader',
      slug: 'reader',
      scope: 'global',
      transport: 'stdio',
      testHooks: { createTransport: () => clientEnd },
    });
    try {
      const { schemas } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-4b', isGuest: false });
      const wire = schemas.find((s) => s.function.name.includes('read_status')).function.name;
      const r = await TaskExecutor.executeTool(wire, {}, 'u-4b', null, KEYED_OPTS);
      assert.strictEqual(r.success, true);
      assert.strictEqual(toolCalls, 1, 'MCP-authorized tool must execute');
    } finally {
      await McpToolSource.shutdown();
      caps.operatorPolicy.resetOperatorPolicy();
    }
  });

  // 8. direct TaskExecutor execution cannot bypass DENIED
  await test('direct TaskExecutor execution cannot bypass DENIED', async () => {
    resetEverything();
    const restore = installNativeCounter('copyToClipboard');
    caps.operatorPolicy.setOperatorPolicy(denyPolicy('native:copyToClipboard'));
    try {
      const r = await TaskExecutor.executeTool('copyToClipboard', { text: 'x' }, 'u-4b', null, KEYED_OPTS);
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.errorType, 'execution.not_authorized');
      assert.strictEqual(toolCalls, 0);
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 11. recovery path behaviorally cannot bypass DENIED
  await test('recovery retry cannot bypass DENIED', async () => {
    resetEverything();
    const restore = installNativeCounter('webSearch');
    caps.operatorPolicy.setOperatorPolicy(denyPolicy('native:webSearch'));
    try {
      const recovery = await ToolRecoveryManager.recoverToolResult({
        toolName: 'webSearch',
        args: { query: 'x' },
        result: { success: false, error: 'network timeout occurred' },
        userId: 'u-4b',
        retryCount: 0,
        workspaceId: 'ws-4b',
      });
      assert.strictEqual(recovery.recovered, false, 'denied retry must not recover');
      assert.strictEqual(toolCalls, 0, 'denied retry never executed the tool');
      assert.strictEqual(creditMock.log.length, 0, 'denied retry charges no credits');
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 12. authoritative capability identity is used
  await test('authorization keys on the authoritative capability id, not the raw name', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    try {
      // A deny entry pointing at a DIFFERENT id/name must not block getTime.
      caps.operatorPolicy.setOperatorPolicy(denyPolicy('native:webSearch'));
      const allowed = await TaskExecutor.executeTool('getTime', {}, 'u-4b', null, PLAIN_OPTS);
      assert.strictEqual(allowed.success, true);
      assert.strictEqual(toolCalls, 1);

      // A deny entry keyed source+name (no id) still resolves to the same
      // authoritative capability.
      caps.operatorPolicy.setOperatorPolicy({
        entries: [{ source: 'native', name: 'getTime', action: 'deny', reason: 'by-name' }],
        guestDenied: [],
        workspaceRestricted: [],
      });
      const denied = await TaskExecutor.executeTool('getTime', {}, 'u-4b', null, PLAIN_OPTS);
      assert.strictEqual(denied.success, false);
      assert.strictEqual(denied.errorType, 'execution.not_authorized');
      assert.strictEqual(toolCalls, 1, 'second attempt must NOT execute (denied by name-rule)');
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 13. forged/substituted authorization claims fail safely
  await test('forged mcpAuthorized claim on a native/denied tool cannot override', async () => {
    resetEverything();
    const restore = installNativeCounter('openWebsite');
    caps.operatorPolicy.setOperatorPolicy(denyPolicy('native:openWebsite'));
    try {
      const r = await TaskExecutor.executeTool('openWebsite', { url: 'https://x' }, 'u-4b', null, {
        ...KEYED_OPTS,
        mcpAuthorized: true, // caller claims MCP authority for a NATIVE tool
      });
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.errorType, 'execution.not_authorized');
      assert.strictEqual(toolCalls, 0);
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 14. unknown capability fails safely
  await test('unknown capability fails safely (no execution)', async () => {
    resetEverything();
    const r = await TaskExecutor.executeTool('totally_not_a_tool', {}, 'u-4b', null, KEYED_OPTS);
    assert.strictEqual(r.success, false);
    assert.strictEqual(toolCalls, 0);
    assert.strictEqual(creditMock.log.length, 0);
  });

  // 15. malformed capability/policy fails safe
  await test('malformed policy input fails safe (engine keeps legacy defaults)', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    try {
      const r = await TaskExecutor.executeTool('getTime', {}, 'u-4b', null, {
        ...KEYED_OPTS,
        authorizationPolicy: 'garbage-not-an-object',
      });
      assert.strictEqual(r.success, true, 'malformed policy must not break execution');
      assert.strictEqual(toolCalls, 1);
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 16. successful result shape is unchanged
  await test('authorization does not alter the existing successful result shape', async () => {
    resetEverything();
    const r = await TaskExecutor.executeTool('getTime', {}, 'u-4b', null, KEYED_OPTS);
    assert.strictEqual(r.success, true);
    assert.ok('time' in r && 'date' in r && 'fullISO' in r, 'original result fields preserved');
    assert.strictEqual(r.authorization, undefined, 'no authorization metadata leaks into success results');
    assert.ok(!('executionId' in r), 'no envelope leakage either');
  });

  // 17. idempotency still behaves correctly
  await test('idempotency still deduplicates identical allowed requests', async () => {
    resetEverything();
    const restore = installNativeCounter('getTime');
    try {
      const r1 = await TaskExecutor.executeTool('getTime', {}, 'u-4b', null, KEYED_OPTS);
      const r2 = await TaskExecutor.executeTool('getTime', {}, 'u-4b', null, KEYED_OPTS);
      assert.strictEqual(r1.success, true);
      assert.strictEqual(toolCalls, 1, 'exactly one execute despite two requests');
      assert.strictEqual(r2.replay, true, 'duplicate is detected and replayed, not re-executed');
      assert.strictEqual(r2.success, true, 'replay carries the prior terminal status');
      assert.strictEqual(r2.outcome.status, 'SUCCEEDED');
    } finally { restore(); }
  });

  await test('denied executions settle cleanly and deduplicate', async () => {
    resetEverything();
    const restore = installNativeCounter('sendEmail');
    caps.operatorPolicy.setOperatorPolicy(denyPolicy('native:sendEmail'));
    try {
      const r1 = await TaskExecutor.executeTool('sendEmail', { recipient: 'a@b.c' }, 'u-4b', null, KEYED_OPTS);
      const r2 = await TaskExecutor.executeTool('sendEmail', { recipient: 'a@b.c' }, 'u-4b', null, KEYED_OPTS);
      assert.strictEqual(r1.success, false);
      assert.strictEqual(r1.errorType, 'execution.not_authorized');
      assert.strictEqual(toolCalls, 0, 'denied tool never runs even across requests');
      assert.strictEqual(r2.replay, true, 'denied outcome deduplicates like any other terminal');
      assert.strictEqual(r2.success, false);
      assert.strictEqual(r2.outcome.status, 'FAILED');
      assert.strictEqual(r2.outcome.errorType, 'authorization',
        'the settled denial classifies as an authorization failure');
    } finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
  });

  // 18. execution envelope still behaves correctly
  await test('envelope records a single terminal (authorization) for denied executions', async () => {
    resetEverything();
    const logs = await captureLogs(async () => {
      const restore = installNativeCounter('getTime');
      caps.operatorPolicy.setOperatorPolicy(denyPolicy('native:getTime'));
      try { await TaskExecutor.executeTool('getTime', {}, 'u-4b', null, KEYED_OPTS); }
      finally { restore(); caps.operatorPolicy.resetOperatorPolicy(); }
    });
    const started = capEventOf('capability.execution.started')(logs);
    const failed = capEventOf('capability.execution.failed')(logs);
    const deniedObs = capEventOf('capability.authorization.denied')(logs);
    assert.strictEqual(started.length, 1);
    assert.strictEqual(failed.length, 1);
    assert.strictEqual(deniedObs.length, 1);
    assert.strictEqual(failed[0].args[1].status, 'failed');
    assert.strictEqual(failed[0].args[1].errorType, 'authorization');
    assert.strictEqual(failed[0].args[1].executionId, started[0].args[1].executionId,
      'one envelope identity across the denied attempt');
    assert.strictEqual(deniedObs[0].args[1].state, 'denied');
  });

  // 19. Jev remains uninvolved in execution authorization
  await test('Jev is not consulted anywhere in the execution authorization path', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'TaskExecutor.js'), 'utf8');
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/require\(['"][^'"]*(decision|Jev)[^'"]*['"]\)/i.test(codeOnly),
      'TaskExecutor must not load the decision/Jev layer');
    assert.ok(/authorizeCapability/.test(src), 'execution boundary uses authorizationPolicy');
    assert.ok(/operatorPolicy/.test(src), 'execution boundary reads the operator policy base');
  });

  // 9 + 10 + 20. structural: every caller converges on the single choke point
  await test('no second execution path exists (single gate covers all callers)', () => {
    const servicesDir = path.join(__dirname, '..', 'services');
    const toolsDir = path.join(__dirname, '..', 'tools');
    for (const file of ['AIService.js', 'TaskPlanner.js', 'ToolRecoveryManager.js']) {
      const src = fs.readFileSync(path.join(servicesDir, file), 'utf8');
      const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      assert.ok(/TaskExecutor\.executeTool\(/.test(codeOnly),
        `${file} must converge on TaskExecutor.executeTool`);
      assert.ok(!/TaskExecutor\._executeToolCore\(/.test(codeOnly),
        `${file} must not reach the core body directly`);
      assert.ok(!/\.execute\(args, context, socket\)/.test(codeOnly),
        `${file} must not invoke tool bodies directly`);
    }
    // Only TaskExecutor (native) and McpManager internals (MCP transport)
    // may invoke an executable tool body anywhere outside tools/ definitions.
    const candidateDirs = ['services', 'tools', 'lib/capabilities', 'lib/unified'];
    for (const dir of candidateDirs) {
      const full = path.join(__dirname, '..', dir);
      if (!fs.existsSync(full)) continue;
      for (const file of fs.readdirSync(full)) {
        if (file === 'TaskExecutor.js') continue;
        if (!file.endsWith('.js')) continue;
        const src = fs.readFileSync(path.join(full, file), 'utf8');
        if (/\.execute\(/.test(src) && /\.execute\(args/.test(src)) {
          if (file.endsWith('.template.js')) continue;
          assert.ok(false, `${dir}/${file} appears to invoke a tool body directly`);
        }
      }
    }
  });

  console.log(`\n${pass + fail} tests, ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});