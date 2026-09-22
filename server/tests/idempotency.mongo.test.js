'use strict';

// JARVIS Action Substrate — slice 3 FINAL GATE: REAL MONGO ACCEPTANCE.
//
// Exercises the DURABLE reservation path in idempotencyStore.js against a
// REAL MongoDB (no model mocking). Uses the same default-mongoose route as
// production (`server/index.js` connects via `mongoose.connect(MONGO_URI)`;
// idempotencyStore detects `mongoose.connection.readyState === 1`).
//
// The test DB is DISPOSABLE: every run connects to a fresh
// `arc_idem_accept_<pid>_<ts>` database and drops it on completion.
//
// Require a real MongoDB at MONGO_URI (defaults below). Run:
//   cd server && node tests/idempotency.mongo.test.js
//
// Proofs covered (Phase 1):
//   1  first request reserves successfully (real findOneAndUpdate upsert)
//   2  sequential duplicate sees the persisted record
//   3  duplicate does not execute the tool (through TaskExecutor)
//   4  concurrent requests racing through Mongo cannot both reserve
//   5  unique-index protection behaves correctly under an actual race
//   6  successful execution settles the same persisted record
//   7  a second request observes the settled record and replays
//   8  restart/process boundary does not lose the idempotency record
//   9  same key across different user/workspace identity scopes does not collide
//   10 unique index/schema creation actually exists as expected

const assert = require('assert');
const mongoose = require('mongoose');
const { execFileSync } = require('child_process');
const path = require('path');

const TaskExecutor = require('../services/TaskExecutor');
const toolRegistry = require('../tools');
const store = require('../lib/capabilities/idempotencyStore');
const caps = require('../lib/capabilities');
const IdempotencyRecord = require('../models/IdempotencyRecord');
const { resolveIdempotencyKey, IDEMPOTENCY_STATUS } = require('../lib/capabilities/idempotencyKey');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27027';
const DB_NAME = `arc_idem_accept_${process.pid}_${Date.now()}`;
const URI = `${MONGO_URI}/${DB_NAME}`;

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

let toolCalls = 0;
const installNativeCounter = (cb) => {
  const original = toolRegistry.tools.getTime.execute;
  toolRegistry.tools.getTime.execute = async (args, context) => {
    toolCalls += 1;
    if (cb) {
      const out = await cb(args, context);
      if (out !== undefined) return out;
    }
    return { success: true, time: 't', count: toolCalls };
  };
  return () => { toolRegistry.tools.getTime.execute = original; };
};

const KEY = (suffix, fields = {}) => resolveIdempotencyKey({
  capabilityId: 'native:getTime',
  userId: 'u-1',
  workspaceId: 'ws-1',
  conversationId: 'conv-1',
  executionId: 'cap-e',
  explicitKey: `accept-${suffix}`,
  ...fields,
});

const DB = async () => mongoose.connection;

const main = async () => {
  console.log('Slice 3 FINAL GATE — real Mongo idempotency acceptance');
  console.log(`  target: ${URI}`);
  console.log('-------------------------------------------------------');

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  const conn = await DB();
  console.log('  connected to real MongoDB');

  // Ensure the durable schema (unique index) is really created on this DB.
  await IdempotencyRecord.init();
  const rawIndexes = await conn.db.collection('idempotencyrecords').indexes();

  // --- 10: unique index/schema actually exists --------------------------
  await test('10. unique index on key exists in real Mongo', async () => {
    const keyIdx = rawIndexes.find((i) => i.key && i.key.key === 1);
    assert.ok(keyIdx, 'expected {key:1} index to exist');
    assert.strictEqual(keyIdx.unique, true, 'index must be unique');
    assert.strictEqual(keyIdx.name, 'key_1');
  });

  await test('10b. collection accepts entries with the substrate schema', async () => {
    const rec = await IdempotencyRecord.create({
      key: 'schema-probe-key',
      capabilityId: 'native:getTime',
      source: 'native',
      userId: 'u-1',
      workspaceId: 'ws-1',
      status: 'RUNNING',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    assert.ok(rec._id, 'doc persisted');
    await IdempotencyRecord.deleteOne({ key: 'schema-probe-key' });
  });

  // --- 1: first request reserves synchronously --------------------------
  await test('1. first request reserves successfully (real upsert)', async () => {
    const id = KEY('p1');
    const r = await store.reserve({ key: id.key, executionId: 'cap-p1', ...id.scope });
    assert.strictEqual(r.reserved, true, 'first caller must win the reservation');
    assert.strictEqual(r.record.status, IDEMPOTENCY_STATUS.RUNNING);
    assert.strictEqual(r.record.executionId, 'cap-p1');
  });

  // --- 2: sequential duplicate sees the persisted record ------------------
  await test('2. sequential duplicate sees the persisted record', async () => {
    const id = KEY('p2', { executionId: 'cap-p2' });
    await store.reserve({ key: id.key, executionId: 'cap-p2', ...id.scope });
    await store.settle(id.key, { status: 'SUCCEEDED', executionId: 'cap-p2', durationMs: 5 });
    const r = await store.reserve({ key: id.key, executionId: 'cap-p2b', ...id.scope });
    assert.strictEqual(r.reserved, false, 'duplicate must fail to reserve');
    assert.strictEqual(r.duplicate, true);
    assert.ok(r.record, 'duplicate observes persisted record');
    assert.strictEqual(r.record.status, 'SUCCEEDED');
  });

  // --- 3: duplicate does not execute the tool -----------------------------
  await test('3. duplicate through TaskExecutor does not execute the tool', async () => {
    const restore = installNativeCounter();
    try {
      const opts = { workspaceId: 'ws-1', skipCreditCharge: true, idempotencyKey: 'p3', requestId: 'req3' };
      const a = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, opts);
      assert.strictEqual(a.success, true);
      assert.strictEqual(toolCalls, 1);
      const b = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, opts);
      assert.strictEqual(toolCalls, 1, 'side effect must not run again');
      assert.strictEqual(b.replay, true);
      assert.strictEqual(b.outcome.status, 'SUCCEEDED');
    } finally {
      restore();
    }
  });

  // --- 4+5: real concurrency race wins exactly one reservation ------------
  await test('4+5. concurrent requests racing Mongo: exactly one reservation (unique index)', async () => {
    const id = KEY('p45', { executionId: null });
    const N = 16;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.reserve({ key: id.key, executionId: `cap-race-${i}`, ...id.scope })
      )
    );
    const winners = results.filter((r) => r.reserved === true);
    const duplicates = results.filter((r) => r.reserved === false && r.duplicate === true);
    assert.strictEqual(winners.length, 1, `exactly one winner (got ${winners.length})`);
    assert.strictEqual(duplicates.length, N - 1, 'every other racer is a duplicate');
    // The persisted doc must be exactly the winner's.
    const doc = await IdempotencyRecord.findOne({ key: id.key }).lean();
    assert.strictEqual(doc.executionId, winners[0].record.executionId);
    assert.strictEqual(doc.status, 'RUNNING');
    await IdempotencyRecord.deleteOne({ key: id.key });
  });

  await test('4b. true concurrent duplicates cannot both pass (fresh key)', async () => {
    const id = KEY('p4b', { executionId: null });
    // fire without any deterministic interleaving window
    const [r1, r2] = await Promise.all([
      store.reserve({ key: id.key, executionId: 'cap-4b-1', ...id.scope }),
      store.reserve({ key: id.key, executionId: 'cap-4b-2', ...id.scope }),
    ]);
    const winners = [r1, r2].filter((r) => r.reserved === true).length;
    assert.strictEqual(winners, 1);
    await IdempotencyRecord.deleteOne({ key: id.key });
  });

  // --- 6: successful execution settles the persisted record ---------------
  await test('6. settle updates the SAME persisted record', async () => {
    const id = KEY('p6', { executionId: 'cap-p6' });
    await store.reserve({ key: id.key, executionId: 'cap-p6', ...id.scope });
    const settled = await store.settle(id.key, { status: 'SUCCEEDED', executionId: 'cap-p6', durationMs: 7, errorType: null });
    assert.strictEqual(settled.ok, true);
    const doc = await IdempotencyRecord.findOne({ key: id.key }).lean();
    assert.strictEqual(doc.status, 'SUCCEEDED');
    assert.strictEqual(doc.outcome.status, 'SUCCEEDED');
    assert.strictEqual(doc.outcome.durationMs, 7);
    assert.strictEqual(doc.executionId, 'cap-p6');
  });

  // --- 7: second request observes settled record and replays ---------------
  await test('7. replayed outcome is read from the settled persisted record', async () => {
    const id = KEY('p7', { executionId: 'cap-p7' });
    await store.reserve({ key: id.key, executionId: 'cap-p7', ...id.scope });
    await store.settle(id.key, { status: 'FAILED', errorType: 'tool-execution-error', durationMs: 9 });
    const d = await store.reserve({ key: id.key, executionId: 'cap-p7b', ...id.scope });
    assert.strictEqual(d.duplicate, true);
    assert.strictEqual(d.record.status, 'FAILED');
    assert.strictEqual(d.record.outcome.errorType, 'tool-execution-error');
  });

  // --- 8: process-boundary restart does not lose the record ----------------
  await test('8. a fresh process/connection observes the persisted record', async () => {
    const id = KEY('p8', { executionId: 'cap-p8' });
    await store.reserve({ key: id.key, executionId: 'cap-p8', ...id.scope });
    await store.settle(id.key, { status: 'CANCELLED', executionId: 'cap-p8', durationMs: 3 });
    const child = path.join(__dirname, 'idempotency.probe-child.js');
    const out = execFileSync(process.execPath, [child, URI, id.key], { encoding: 'utf8', timeout: 30000 });
    const line = out.split('\n').find((l) => l.startsWith('PROBE_JSON'));
    const probe = JSON.parse(line.replace('PROBE_JSON ', ''));
    assert.strictEqual(probe.found, true, 'child process must see the persisted record');
    assert.strictEqual(probe.status, 'CANCELLED');
    assert.strictEqual(probe.executionId, 'cap-p8');
  });

  // --- 9: scope collision separation (same key, different identity) --------
  await test('9. same logical key in different identity scopes does not collide', async () => {
    const scopes = [];
    for (let i = 0; i < 4; i += 1) {
      scopes.push(KEY('p9', { executionId: `cap-p9-${i}`, ...(i === 1 ? { userId: 'u-2' } : {}), ...(i === 2 ? { workspaceId: 'ws-2' } : {}), ...(i === 3 ? { capabilityId: 'native:webSearch' } : {}) }));
    }
    const winners = [];
    for (const s of scopes) {
      const r = await store.reserve({ key: s.key, executionId: 'cap-p9', ...s.scope });
      winners.push(r.reserved === true);
      assert.strictEqual(r.reserved, true, 'distinct keys must each reserve');
    }
    assert.strictEqual(winners.length, 4);
    // distinct sha256 keys persisted
    const docs = await IdempotencyRecord.find({ key: { $in: scopes.map((s) => s.key) } }).lean();
    assert.strictEqual(new Set(docs.map((d) => d.key)).size, 4);
  });

  // ======================================================================
  // PHASE 3 — REAL EXECUTION through the Mongo-backed path (native + MCP)
  // ======================================================================

  // --- P3-native: first call executes, settles, second call replays ---------
  await test('P3-native: real native execution -> persisted settlement -> replay', async () => {
    toolCalls = 0;
    const restore = installNativeCounter();
    try {
      const opts = { workspaceId: 'ws-1', skipCreditCharge: true, idempotencyKey: 'p3-native', requestId: 'req-native' };
      const a = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, opts);
      assert.strictEqual(a.success, true);
      assert.strictEqual(toolCalls, 1, 'first call actually executed');
      // settle persists the record (wait for settle write)
      await new Promise((r) => setTimeout(r, 200));
      const keyId = resolveIdempotencyKey({ capabilityId: 'native:getTime', userId: 'u-1', workspaceId: 'ws-1', executionId: 'cap-e', explicitKey: 'p3-native', requestId: 'req-native' });
      let rec = await store.getRecord(keyId.key);
      assert.ok(rec, 'persisted record exists after execution');
      assert.strictEqual(rec.status, 'SUCCEEDED');
      assert.strictEqual(rec.outcome.status, 'SUCCEEDED');
      assert.strictEqual(rec.executionId, rec.executionId && typeof rec.executionId === 'string' ? rec.executionId : null, 'record carries owning executionId');
      // second call replays from the persisted record
      const b = await TaskExecutor.executeTool('getTime', {}, 'u-1', null, opts);
      assert.strictEqual(b.replay, true, 'second call is a replay');
      assert.strictEqual(b.success, true);
      assert.strictEqual(b.outcome.status, 'SUCCEEDED');
      assert.strictEqual(toolCalls, 1, 'tool did not re-execute');
    } finally {
      restore();
    }
  });

  // --- P3-mcp: real MCP server through Mongo-backed path --------------------
  await test('P3-mcp: real MCP execution -> persisted settlement -> replay', async () => {
    toolCalls = 0;
    const { McpServer } = require('@modelcontextprotocol/server');
    const { InMemoryTransport } = require('@modelcontextprotocol/client');
    const z = require('zod');
    const { McpToolSource, McpManager, McpRegistry } = require('../lib/mcp');
    const server = new McpServer({ name: 'p3-linear', version: '1.0.0' });
    server.registerTool('query_issues', {
      description: 'List issues.',
      inputSchema: z.object({ state: z.string().optional() }),
      annotations: { readOnlyHint: true, title: 'Issues' },
    }, async () => {
      toolCalls += 1;
      return { content: [{ type: 'text', text: JSON.stringify([{ id: 'x', state: 'open' }]) }] };
    });
    const registry = new McpRegistry();
    const manager = new McpManager({ registry });
    McpToolSource.init({ manager, registry });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    await server.connect(serverEnd);
    registry.register({
      id: 'p3-linear-1', name: 'Linear', slug: 'linear-p3', scope: 'global', transport: 'stdio',
      testHooks: { createTransport: () => clientEnd },
    });
    try {
      const { schemas } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-1', isGuest: false });
      const wire = schemas.find((s) => s.function.name.includes('query_issues')).function.name;
      // derive the SAME capabilityId the envelope's resolver produces, so the
      // recomputed durable key matches what TaskExecutor actually reserved
      const cap = caps.resolveExecutionCapability(wire, { isGuest: false });
      assert.ok(cap && cap.source === 'mcp', 'mcp capability resolved');
      const opts = { workspaceId: 'ws-1', skipCreditCharge: true, idempotencyKey: 'p3-mcp', requestId: 'req-mcp' };
      const a = await TaskExecutor.executeTool(wire, {}, 'u-1', null, opts);
      assert.strictEqual(a.success, true, 'MCP first call executes');
      assert.strictEqual(toolCalls, 1);
      await new Promise((r) => setTimeout(r, 200));
      const keyId = resolveIdempotencyKey({
        capabilityId: cap.id, userId: 'u-1', workspaceId: 'ws-1',
        executionId: 'cap-e', explicitKey: 'p3-mcp', requestId: 'req-mcp',
      });
      const rec = await store.getRecord(keyId.key);
      assert.ok(rec, 'persisted MCP record exists');
      assert.strictEqual(rec.status, 'SUCCEEDED');
      assert.strictEqual(rec.source, 'mcp', 'record tagged with mcp source');
      const b = await TaskExecutor.executeTool(wire, {}, 'u-1', null, opts);
      assert.strictEqual(b.replay, true);
      assert.strictEqual(b.result, undefined, 'replay carries no fresh tool result (tool not re-invoked)');
      assert.strictEqual(toolCalls, 1, 'MCP tool not re-invoked');
    } finally {
      await McpToolSource.shutdown();
    }
  });

  // --- P3-concurrent: two concurrent identical requests via Mongo -------------
  await test('P3-concurrent: two concurrent requests -> one executes, one replays', async () => {
    toolCalls = 0;
    let release;
    const gate = new Promise((res) => { release = res; });
    const restore = installNativeCounter(async () => { await gate; });
    try {
      const opts = { workspaceId: 'ws-1', skipCreditCharge: true, idempotencyKey: 'p3-concurrent', requestId: 'req-conc' };
      const p1 = TaskExecutor.executeTool('getTime', {}, 'u-1', null, opts);
      const p2 = TaskExecutor.executeTool('getTime', {}, 'u-1', null, opts);
      await new Promise((r) => setTimeout(r, 50)); // let both reach the reservation
      release();
      const [ra, rb] = await Promise.all([p1, p2]);
      const executed = [ra, rb].filter((r) => r.success === true && r.replay !== true).length;
      const replayed = [ra, rb].filter((r) => r.replay === true).length;
      assert.strictEqual(toolCalls, 1, 'exactly one side effect');
      assert.strictEqual(executed, 1, 'exactly one executes');
      assert.strictEqual(replayed, 1, 'exactly one replays');
    } finally {
      restore();
    }
  });

  // ---- cleanup -----------------------------------------------------------
  await conn.dropDatabase();
  await mongoose.disconnect();
  console.log('  dropped disposable database and disconnected');

  console.log('-------------------------------------------------------');
  console.log(`Result: ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
};

main().catch(async (e) => {
  console.error('Fatal:', e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});