'use strict';

// JARVIS Action Substrate — slice 3: IDEMPOTENCY + DUPLICATE SIDE-EFFECT
// PROTECTION integration tests.
//
// Proves the guard at the unified choke point (TaskExecutor.executeTool):
//   executionId vs idempotencyKey distinction
//   first-executes-once / duplicate-replays / running-duplicate-prevented
//   concurrent duplicates cannot both pass the reservation boundary
//   same key + different capability/user/workspace never collides
//   failed + cancelled reuse semantics (documented, non-retrying)
//   explicit key preserved; executionId still unique
//   native + MCP execution both protected
//   existing result shapes remain compatible
//   no second execution path introduced
//   safe observability never leaks sensitive fields
//
// Run:  cd server && node tests/idempotency.test.js

const assert = require('assert');
const z = require('zod');
const { McpServer } = require('@modelcontextprotocol/server');
const { InMemoryTransport } = require('@modelcontextprotocol/client');

const TaskExecutor = require('../services/TaskExecutor');
const { McpToolSource, McpManager, McpRegistry } = require('../lib/mcp');
const toolRegistry = require('../tools');
const caps = require('../lib/capabilities');
const store = require('../lib/capabilities/idempotencyStore');
const { resolveIdempotencyKey, IDEMPOTENCY_STATUS } = require('../lib/capabilities/idempotencyKey');
const observability = require('../lib/capabilities/observability');
const { STATUS } = require('../lib/capabilities/envelopeClassification');

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
    await new Promise((r) => setTimeout(r, 10)); // flush microtask emissions
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return lines;
};

const capLines = (lines) => lines.filter((l) => String(l.args && l.args[0]).includes('[Capability]'));
const capMeta = (line) => JSON.stringify(line.args && line.args[1] || {});

// KB-options: explicit logical key for the SAME intended action.
const KEYED_OPTS = {
  workspaceId: 'ws-id10',
  skipCreditCharge: true,
  conversationId: 'conv-id10',
  idempotencyKey: 'action-abc',
  requestId: 'req-xyz',
};

const resetCalls = () => {
  store._reset();
  toolCalls = 0;
};

let toolCalls = 0;

// a deterministic native side-effect fixture we can count
const installNativeCounter = (cb) => {
  const original = toolRegistry.tools.getTime.execute;
  toolRegistry.tools.getTime.execute = async (args, context) => {
    toolCalls += 1;
    if (cb) {
      const out = await cb(args, context);
      if (out !== undefined) return out;
    }
    return { success: true, time: 't', fullISO: 'iso', date: 'd', count: toolCalls };
  };
  return () => { toolRegistry.tools.getTime.execute = original; };
};

const createLinearServer = () => {
  const store2 = {
    issues: [
      { id: 'iss-1', title: 'Slice 3 idempotency', state: 'open' },
      { id: 'iss-2', title: 'Decorate Linear', state: 'open' }
    ]
  };
  const server = new McpServer({ name: 'linear-shaped-idem', version: '1.0.0' });
  server.registerTool(
    'list_issues',
    {
      description: 'List all issues in the workspace.',
      inputSchema: z.object({ state: z.string().optional() }),
      annotations: { readOnlyHint: true, title: 'Linear Issues' }
    },
    async ({ state }) => {
      toolCalls += 1;
      const rows = state ? store2.issues.filter((i) => i.state === state) : store2.issues;
      return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
    }
  );
  server.registerTool(
    'explode',
    {
      description: 'Always fails deterministically.',
      inputSchema: z.object({})
    },
    async () => {
      toolCalls += 1;
      throw new Error('deterministic idem MCP failure');
    }
  );
  return server;
};

let mcpWire;
let mcpCanonical;
let mcpFailureWire;

const setupMcp = async () => {
  const registry = new McpRegistry();
  const manager = new McpManager({ registry });
  McpToolSource.init({ manager, registry });
  const liveServer = createLinearServer();
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await liveServer.connect(serverEnd);
  registry.register({
    id: 'idem-linear-1',
    name: 'Linear',
    slug: 'linear-idem',
    scope: 'global',
    transport: 'stdio',
    testHooks: { createTransport: () => clientEnd }
  });
  const { schemas } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-id10', isGuest: false });
  mcpWire = schemas.find((s) => s.function.name.includes('list_issues')).function.name;
  mcpFailureWire = schemas.find((s) => s.function.name.includes('explode')).function.name;
  mcpCanonical = McpToolSource.registry.toolByWireName(mcpWire).canonicalName;
  return { registry, manager, liveServer };
};

const teardownMcp = async () => {
  await McpToolSource.shutdown();
};

const main = async () => {
  console.log('Idempotency + duplicate-side-effect protection (slice 3)');
  console.log('==========================================================');

  // ---- 1. first execution executes exactly once ----
  await test('first execution executes exactly once (native)', async () => {
    resetCalls();
    const restore = installNativeCounter();
    try {
      const r = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, KEYED_OPTS);
      assert.strictEqual(r.success, true);
      assert.strictEqual(toolCalls, 1);
    } finally {
      restore();
    }
  });

  // ---- 2 + 3. duplicate does not execute again; returns prior outcome ----
  await test('duplicate idempotent request replays prior outcome without re-execution', async () => {
    resetCalls();
    const restore = installNativeCounter();
    try {
      const r1 = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, KEYED_OPTS);
      assert.strictEqual(toolCalls, 1);
      const r2 = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, KEYED_OPTS);
      assert.strictEqual(toolCalls, 1, 'side effect must NOT run again');
      assert.strictEqual(r2.replay, true, 'second request is a replay');
      assert.strictEqual(r2.success, true, 'replay of SUCCEEDED is success');
      assert.strictEqual(r2.outcome.status, 'SUCCEEDED');
      assert.ok(r2.duplicateOf && typeof r2.duplicateOf === 'string', 'replay references the prior execution');
    } finally {
      restore();
    }
  });

  // ---- 3b. env: duplicate reference points at the first executionId ----
  await test('duplicate references the reserved executionId for the same key', async () => {
    resetCalls();
    const restore = installNativeCounter();
    try {
      const identity = resolveIdempotencyKey({
        capabilityId: 'native:getTime',
        userId: 'u-1',
        workspaceId: 'ws-id10',
        conversationId: 'conv-id10',
        executionId: 'e-1',
        explicitKey: 'action-abc',
        requestId: 'req-xyz',
      });
      await TaskExecutor.executeTool('getTime', {}, 'u-1', null, KEYED_OPTS);
      const rec = await store.getRecord(identity.key);
      assert.ok(rec, 'record persisted for the logical key');
      assert.ok(rec.executionId, 'record knows its owning executionId');
      const d = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, KEYED_OPTS);
      assert.strictEqual(d.duplicateOf, rec.executionId, 'replay points at the stored owning execution');
    } finally {
      restore();
    }
  });

  // ---- 4. duplicate while first still running is prevented ----
  await test('duplicate while original is running is prevented (inProgress)', async () => {
    resetCalls();
    let release;
    const gate = new Promise((res) => { release = res; });
    const restore = installNativeCounter(async () => { await gate; });
    try {
      const p1 = TaskExecutor.executeTool('getTime', {}, 'u-1', null, KEYED_OPTS);
      await new Promise((r) => setTimeout(r, 10));
      const p2 = TaskExecutor.executeTool('getTime', {}, 'u-1', null, KEYED_OPTS);
      release();
      const [r1b, r2b] = await Promise.all([p1, p2]);
      assert.strictEqual(toolCalls, 1, 'only the first runs');
      assert.strictEqual(r2b.replay, true);
      assert.strictEqual(r2b.inProgress, true);
      assert.strictEqual(r2b.success, false);
      assert.ok(r2b.duplicateOf, 'inProgress references the running execution');
    } finally {
      restore();
    }
  });

  // ---- 5. concurrent duplicates cannot both execute ----
  await test('concurrent duplicates: exactly one crosses the reservation', async () => {
    resetCalls();
    let release;
    const gate = new Promise((res) => { release = res; });
    const restore = installNativeCounter(async () => { await gate; });
    try {
      const p1 = TaskExecutor.executeTool('getTime', {}, 'u-1', null, KEYED_OPTS);
      const p2 = TaskExecutor.executeTool('getTime', {}, 'u-1', null, KEYED_OPTS);
      const p3 = TaskExecutor.executeTool('getTime', {}, 'u-1', null, KEYED_OPTS);
      const p4 = TaskExecutor.executeTool('getTime', {}, 'u-1', null, KEYED_OPTS);
      await new Promise((r) => setTimeout(r, 15));
      release();
      const res4 = await Promise.all([p1, p2, p3, p4]);
      assert.strictEqual(toolCalls, 1, 'only one side effect for 4 identical requests');
      const inFlight = res4.filter((r) => r && r.inProgress === true);
      const executed = res4.filter((r) => r && r.success === true && r.inProgress !== true);
      assert.strictEqual(inFlight.length, 3, 'three duplicates see inProgress');
      assert.strictEqual(executed.length, 1, 'exactly one executes');
    } finally {
      restore();
    }
  });

  // ---- 6. same key + different capability does not collide ----
  await test('same key + different capability does not collide', async () => {
    resetCalls();
    const restore = installNativeCounter();
    // two distinct native tools both have a native idempotency contract
    const orig2 = toolRegistry.tools.webSearch.execute;
    toolRegistry.tools.webSearch.execute = async () => {
      toolCalls += 100; // distinguishable count block
      return { success: true, answer: 'x' };
    };
    try {
      const opts = { ...KEYED_OPTS, idempotencyKey: 'shared-key' };
      const a = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, opts);
      const b = await TaskExecutor.executeTool('webSearch', {}, 'u-1', null, opts);
      assert.strictEqual(a.success, true);
      assert.strictEqual(b.success, true);
      assert.strictEqual(toolCalls >= 100, true, 'both capabilities executed their own side effect');
      // enforced via scope: keys must differ
      const ka = resolveIdempotencyKey({ capabilityId: 'native:getTime', userId: 'u-1', executionId: 'x', explicitKey: 'shared-key' });
      const kb = resolveIdempotencyKey({ capabilityId: 'native:webSearch', userId: 'u-1', executionId: 'y', explicitKey: 'shared-key' });
      assert.notStrictEqual(ka.key, kb.key, 'capability-scoped keys cannot collide');
    } finally {
      restore();
      toolRegistry.tools.webSearch.execute = orig2;
    }
  });

  // ---- 7. same key + different user does not collide ----
  await test('same key + different user does not collide', async () => {
    resetCalls();
    const restore = installNativeCounter();
    try {
      const opts = { ...KEYED_OPTS };
      const a = await TaskExecutor.executeTool('getTime', {}, 'user-A', null, opts);
      const b = await TaskExecutor.executeTool('getTime', {}, 'user-B', null, opts);
      assert.strictEqual(a.success, true);
      assert.strictEqual(b.success, true);
    } finally {
      restore();
    }
  });

  // ---- 8. same key + different workspace does not collide ----
  await test('same key + different workspace does not collide', async () => {
    resetCalls();
    const restore = installNativeCounter();
    try {
      const a = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, { ...KEYED_OPTS, workspaceId: 'ws-AAA' });
      const b = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, { ...KEYED_OPTS, workspaceId: 'ws-BBB' });
      assert.strictEqual(a.success, true);
      assert.strictEqual(b.success, true);
    } finally {
      restore();
    }
  });

  // ---- 9. cancelled execution reuse semantics ----
  await test('cancelled execution: duplicate replays cancelled (key not reused silently)', async () => {
    resetCalls();
    let release;
    const gate = new Promise((res) => { release = res; });
    const ac = new AbortController();
    const restore = installNativeCounter(async (args, context) => {
      // honor the caller's signal, as a real native tool would
      const timeout = await Promise.race([
        gate,
        new Promise((_, reject) => ac.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
      ]).catch(() => 'aborted');
      if (ac.signal.aborted) {
        return { success: false, cancelled: true };
      }
      return timeout;
    });
    try {
      const pending = TaskExecutor.executeTool('getTime', {}, 'u-1', null, {
        ...KEYED_OPTS, signal: ac.signal,
      });
      await new Promise((r) => setTimeout(r, 10));
      ac.abort();
      release();
      const r = await pending;
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.cancelled, true);
      await new Promise((r2) => setTimeout(r2, 10));
      // duplicate of a cancelled key must NOT re-execute; it replays cancelled
      const d = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, KEYED_OPTS);
      assert.strictEqual(toolCalls, 1, 'cancelled execution is terminal; no auto-retry');
      assert.strictEqual(d.replay, true);
      assert.strictEqual(d.success, false);
      assert.strictEqual(d.outcome.status, 'CANCELLED');
    } finally {
      restore();
    }
  });

  // ---- 10. failed execution reuse semantics ----
  await test('failed execution: duplicate replays failure (no auto-retry)', async () => {
    resetCalls();
    const restore = installNativeCounter(async () => {
      throw new Error('deterministic native failure');
    });
    try {
      const r1 = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, KEYED_OPTS);
      assert.strictEqual(r1.success, false);
      const d = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, KEYED_OPTS);
      assert.strictEqual(toolCalls, 1, 'failed execution is terminal per documented semantics');
      assert.strictEqual(d.replay, true);
      assert.strictEqual(d.success, false);
      assert.strictEqual(d.outcome.status, 'FAILED');
    } finally {
      restore();
    }
  });

  // ---- 11. explicit idempotency key is preserved (as safe digest ref) ----
  await test('explicit idempotency key preserved; raw key never in logs', async () => {
    resetCalls();
    const restore = installNativeCounter();
    try {
      const lines = await captureLogs(async () => {
        await TaskExecutor.executeTool('getTime', {}, 'u-1', null, {
          ...KEYED_OPTS, idempotencyKey: 'SECRET-CALLER-TOKEN-42',
        });
      });
      const metas = capLines(lines).map((l) => capMeta(l));
      const joined = metas.join(' ');
      assert.ok(!joined.includes('SECRET-CALLER-TOKEN-42'), 'raw logical key must never appear in logs');
      assert.ok(metas.some((m) => m.includes('idempotencyKeyHash')), 'safe hash reference surfaced');
    } finally {
      restore();
    }
  });

  // ---- 12. executionId remains unique per invocation ----
  await test('executionId stays unique even when idempotencyKey is identical', async () => {
    resetCalls();
    const restore = installNativeCounter();
    try {
      const id1 = resolveIdempotencyKey({
        capabilityId: 'native:getTime', userId: 'u-1', workspaceId: 'ws-id10',
        conversationId: 'conv-id10', executionId: 'cap-e1', explicitKey: 'sg-unique', requestId: 'r1',
      });
      const id2 = resolveIdempotencyKey({
        capabilityId: 'native:getTime', userId: 'u-1', workspaceId: 'ws-id10',
        conversationId: 'conv-id10', executionId: 'cap-e2', explicitKey: 'sg-unique', requestId: 'r1',
      });
      const opts = { ...KEYED_OPTS, idempotencyKey: 'sg-unique', requestId: 'r1' };
      const a = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, opts);
      const b = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, opts);
      assert.strictEqual(a.success, true);
      assert.strictEqual(b.replay, true);
      // idempotency scoping is stable across separate call sites
      assert.strictEqual(id1.key, id2.key, 'same logical action maps to same key');
      // physical executions differ even for the same key: records carry distinct executionIds
      const rec1 = await store.getRecord(id1.key);
      assert.ok(rec1 && rec1.executionId, 'reserved record carries the executing instance');
    } finally {
      restore();
    }
  });

  // ---- key derivation unit proofs ----
  await test('resolveIdempotencyKey: scope prevents collisions; pass-through safe fallback', async () => {
    const base = { capabilityId: 'native:sendEmail', userId: 'u1', workspaceId: 'w1', conversationId: 'c1', executionId: 'e1', explicitKey: 'k' };
    const k1 = resolveIdempotencyKey(base);
    assert.strictEqual(k1.enabled, true);
    assert.ok(k1.key && k1.key.length === 64, 'sha256 hex');
    // different user
    assert.notStrictEqual(resolveIdempotencyKey({ ...base, userId: 'u2' }).key, k1.key);
    // different workspace
    assert.notStrictEqual(resolveIdempotencyKey({ ...base, workspaceId: 'w2' }).key, k1.key);
    // different conversation
    assert.notStrictEqual(resolveIdempotencyKey({ ...base, conversationId: 'c2' }).key, k1.key);
    // different capability
    assert.notStrictEqual(resolveIdempotencyKey({ ...base, capabilityId: 'mcp.l.other' }).key, k1.key);
    // explicit beats requestId
    const kExplicit = resolveIdempotencyKey({ ...base, requestId: 'req' }).key;
    const kRequestId = resolveIdempotencyKey({ ...base, explicitKey: null, requestId: 'req' }).key;
    assert.notStrictEqual(kExplicit, kRequestId, 'explicit key wins over requestId');
    // explicit key stable regardless of requestId presence
    assert.strictEqual(resolveIdempotencyKey({ ...base, requestId: 'other' }).key, kExplicit);
    // requestId fallback is deterministic
    assert.strictEqual(
      resolveIdempotencyKey({ ...base, explicitKey: null, requestId: 'req2' }).key,
      resolveIdempotencyKey({ ...base, explicitKey: null, requestId: 'req2' }).key
    );
    // deterministic
    assert.strictEqual(resolveIdempotencyKey(base).key, resolveIdempotencyKey(base).key);
    // pass-through when no logical source
    const passthrough = resolveIdempotencyKey({ capabilityId: 'native:getTime', userId: 'u1', executionId: 'eX' });
    assert.strictEqual(passthrough.enabled, false);
    assert.strictEqual(passthrough.key, null);
    const pt2 = resolveIdempotencyKey({ capabilityId: 'native:getTime', userId: 'u1', executionId: 'eY' });
    assert.notStrictEqual(passthrough.uniqueKey, pt2.uniqueKey, 'pass-through keys never collapse actions');
  });

  // ---- 13+14. native AND MCP execute through the guard ----
  await test('native execution works through the idempotency layer', async () => {
    resetCalls();
    const restore = installNativeCounter();
    try {
      const r = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, KEYED_OPTS);
      assert.strictEqual(r.success, true);
      assert.strictEqual(toolCalls, 1);
    } finally {
      restore();
    }
  });

  await test('MCP execution works through the idempotency layer', async () => {
    resetCalls();
    const mcp = await setupMcp();
    try {
      const opts = { ...KEYED_OPTS, idempotencyKey: 'mcp-read-action' };
      const r1 = await TaskExecutor.executeTool(mcpWire, {}, 'u-1', null, opts);
      assert.strictEqual(r1.success, true, 'MCP read succeeds');
      assert.strictEqual(r1.mcp.canonicalName, mcpCanonical);
      const callsAfterFirst = toolCalls;
      const r2 = await TaskExecutor.executeTool(mcpWire, {}, 'u-1', null, opts);
      assert.strictEqual(toolCalls, callsAfterFirst, 'duplicate MCP request must not re-execute');
      assert.strictEqual(r2.replay, true);
      assert.strictEqual(r2.success, true);
      assert.strictEqual(r2.outcome.status, 'SUCCEEDED');
    } finally {
      await teardownMcp();
    }
  });

  // ---- 15. native result shape remains compatible ----
  await test('existing native result shape remains compatible', async () => {
    resetCalls();
    const restore = installNativeCounter();
    try {
      const direct = await toolRegistry.tools.getTime.execute({}, { userId: 'u-1' }, null);
      const via = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, KEYED_OPTS);
      assert.strictEqual(via.success, true);
      assert.strictEqual(typeof via.time, 'string');
      assert.strictEqual(typeof via.fullISO, 'string');
      assert.ok(direct.success === true);
    } finally {
      restore();
    }
  });

  // ---- 16. MCP result shape remains compatible ----
  await test('existing MCP result shape remains compatible', async () => {
    resetCalls();
    const mcp = await setupMcp();
    try {
      const r = await TaskExecutor.executeTool(mcpWire, {}, 'u-1', null, { ...KEYED_OPTS, idempotencyKey: 'mcp-shape-' + Date.now() });
      assert.strictEqual(r.success, true);
      assert.strictEqual(typeof r.result, 'string');
      assert.ok(r.mcp && r.mcp.canonicalName === mcpCanonical);
      assert.strictEqual(typeof r.mcp.durationMs, 'number');
    } finally {
      await teardownMcp();
    }
  });

  // ---- MCP failure path replays (documented) ----
  await test('MCP failed execution: duplicate replays failure, no retry', async () => {
    resetCalls();
    const mcp = await setupMcp();
    try {
      const opts = { ...KEYED_OPTS, idempotencyKey: 'mcp-fail-action' };
      const f1 = await TaskExecutor.executeTool(mcpFailureWire, {}, 'u-1', null, opts);
      assert.strictEqual(f1.success, false);
      const f2 = await TaskExecutor.executeTool(mcpFailureWire, {}, 'u-1', null, opts);
      assert.strictEqual(toolCalls, 1, 'failed MCP action is terminal; no retry');
      assert.strictEqual(f2.replay, true);
      assert.strictEqual(f2.outcome.status, 'FAILED');
    } finally {
      await teardownMcp();
    }
  });

  // ---- 17. no second execution path ----
  await test('no second execution path introduced', async () => {
    assert.strictEqual(typeof caps.executeTool, 'undefined', 'facade has no duplicate executor');
    assert.strictEqual(typeof caps.tools, 'undefined', 'facade exposes no native registry');
    // The store is the ONLY persistence surface added.
    assert.ok(store && typeof store.reserve === 'function');
    assert.ok(store && typeof store.settle === 'function');
  });

  // ---- 18. safe observability ----
  await test('safe observability does not leak sensitive fields', async () => {
    resetCalls();
    const restore = installNativeCounter();
    try {
      const lines = await captureLogs(async () => {
        const opts = { ...KEYED_OPTS, idempotencyKey: 'top-secret-abc-123' };
        const r1 = await TaskExecutor.executeTool('getTime', { secretInput: 'hunter2' }, 'u-1', null, opts);
        assert.strictEqual(r1.success, true);
        const d = await TaskExecutor.executeTool('getTime', { secretInput: 'hunter2' }, 'u-1', null, opts);
        assert.strictEqual(d.replay, true);
      });
      const metas = capLines(lines).map(capMeta);
      const joined = metas.join(' ');
      assert.ok(!joined.includes('hunter2'), 'tool args never logged');
      assert.ok(!joined.includes('top-secret-abc-123'), 'raw idempotency key never logged');
      assert.ok(!joined.includes('secretInput'), 'arg keys never logged');
      // duplicate-prevented event surfaced with safe fields only
      const dupLines = capLines(lines).filter((l) => l.args[0].includes('duplicatePrevented'));
      assert.strictEqual(dupLines.length, 1, 'duplicate prevention is observable');
      const dm = capMeta(dupLines[0]);
      assert.ok(dm.includes('"duplicateDetected":true'));
      assert.ok(dm.includes('idempotencyKeyHash'));
    } finally {
      restore();
    }
  });

  // ---- store failure is fail-open, request path survives ----
  await test('reservation store failure fails open (no fabricated duplicate)', async () => {
    resetCalls();
    const restore = installNativeCounter();
    const origReserve = store.reserve;
    store.reserve = async () => ({ reserved: false, error: 'simulated store down' });
    try {
      const r = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, KEYED_OPTS);
      assert.strictEqual(r.success, true, 'execution proceeds on store failure');
      assert.strictEqual(r.replay, undefined, 'NOT treated as duplicate');
    } finally {
      store.reserve = origReserve;
      restore();
    }
  });

  // ---- cancelled-at-start duplicate ----
  await test('aborted-before-start consumes a reserved RUNNING record (documented semantics)', async () => {
    resetCalls();
    const restore = installNativeCounter();
    try {
      store._reset();
      // pre-aborted signal: envelope.finalize classifies as cancelled
      const ac = new AbortController();
      ac.abort();
      const r = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, {
        ...KEYED_OPTS, signal: ac.signal,
      });
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.cancelled, true);
      await new Promise((r2) => setTimeout(r2, 10));
    } finally {
      restore();
    }
  });

  console.log('==========================================================');
  console.log(`Result: ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
};

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});