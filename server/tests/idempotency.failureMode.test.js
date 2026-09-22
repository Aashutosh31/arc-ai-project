'use strict';

// JARVIS Action Substrate — slice 3 FINAL GATE: FAILURE-MODE VERIFICATION.
//
// Deterministically proves the behavior when the idempotency store is
// UNAVAILABLE (reservation throws). The substrate's documented contract is
// FAIL-OPEN: a substrate-side persistence failure must not invent a duplicate
// or freeze the request path — the execution proceeds as if no dedup was
// requested, and capability.idempotency.reservationError is logged.
//
// This is an EXPLICIT, DELIBERATE architectural trade-off (availability over
// strict-once). Consequence, proven below:
//   - execution proceeds            -> request path is never blocked (good)
//   - a duplicate CAN re-execute     -> during a store outage, two requests
//                                       with the same logical key may BOTH run
//                                       the side effect (documented window)
//   - no retry/backoff is attempted  -> not a retry system
//
// Fail-open is NOT differentiated by capability risk/scope: a read tool and a
// state-changing tool behave identically when the store is down. This slice
// does NOT introduce risk-tiered fail-open/closed policy (that would be an
// architectural decision, not part of this slice — see docs note).
//
// Run:  cd server && node tests/idempotency.failureMode.test.js

const assert = require('assert');

const TaskExecutor = require('../services/TaskExecutor');
const toolRegistry = require('../tools');
const store = require('../lib/capabilities/idempotencyStore');
const caps = require('../lib/capabilities');
const observability = require('../lib/capabilities/observability');

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
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return lines;
};
const capLines = (lines) => lines.filter((l) => String(l.args && l.args[0]).includes('[Capability]'));
const capMeta = (line) => JSON.stringify(line.args && line.args[1] || {});

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

const failStore = async (fields) => ({ reserved: false, error: 'simulated: store unreachable (ECONNREFUSED)' });
const failStoreThrow = async () => { throw new Error('simulated: store pool exhausted'); };

const main = async () => {
  console.log('Slice 3 FINAL GATE — idempotency failure-mode verification (fail-open)');
  console.log('-------------------------------------------------------');

  const opts = { workspaceId: 'ws-fm', skipCreditCharge: true, idempotencyKey: 'fm-action', requestId: 'req-fm' };

  // --- execution proceeds when reservation returns an error --------------
  await test('store unavailable (reservation error) -> execution proceeds', async () => {
    store._reset();
    toolCalls = 0;
    const restore = installNativeCounter();
    const orig = store.reserve;
    store.reserve = failStore;
    try {
      const r = await TaskExecutor.executeTool('getTime', {}, 'u-fm', null, opts);
      assert.strictEqual(r.success, true, 'request must NOT be blocked by a store outage');
      assert.strictEqual(r.replay, undefined, 'not treated as duplicate');
      assert.strictEqual(toolCalls, 1, 'side effect ran');
    } finally {
      store.reserve = orig;
      restore();
    }
  });

  // --- execution proceeds when reservation THROWS ------------------------
  await test('store unavailable (reservation throws) -> execution proceeds', async () => {
    store._reset();
    toolCalls = 0;
    const restore = installNativeCounter();
    const orig = store.reserve;
    store.reserve = failStoreThrow;
    try {
      const r = await TaskExecutor.executeTool('getTime', {}, 'u-fm', null, opts);
      assert.strictEqual(r.success, true, 'thrown store error must not block the path');
      assert.strictEqual(toolCalls, 1);
    } finally {
      store.reserve = orig;
      restore();
    }
  });

  // --- observability: reservationError emitted ---------------------------
  await test('reservationError event emitted (fail-open is observable)', async () => {
    store._reset();
    toolCalls = 0;
    const restore = installNativeCounter();
    const orig = store.reserve;
    store.reserve = failStore;
    try {
      const lines = await captureLogs(async () => {
        await TaskExecutor.executeTool('getTime', {}, 'u-fm', null, opts);
      });
      const errLine = capLines(lines).find((l) => l.args[0].includes('reservationError'));
      assert.ok(errLine, 'reservationError event must be emitted');
      const errMeta = capMeta(errLine);
      assert.ok(!errMeta.includes('fm-action'), 'raw logical key never logged on failure either');
    } finally {
      store.reserve = orig;
      restore();
    }
  });

  // --- THE DOCUMENTED CONSEQUENCE: duplicate side effect during outage ----
  await test('CONSEQUENCE: store outage CAN permit duplicate side effects (fail-open window)', async () => {
    store._reset();
    toolCalls = 0;
    const restore = installNativeCounter();
    const orig = store.reserve;
    store.reserve = failStore;
    try {
      const a = await TaskExecutor.executeTool('getTime', {}, 'u-fm', null, opts);
      const b = await TaskExecutor.executeTool('getTime', {}, 'u-fm', null, opts);
      assert.strictEqual(a.success, true);
      assert.strictEqual(b.success, true, 'second request also executes (no dedup during outage)');
      assert.strictEqual(toolCalls, 2, 'DUPLICATE side effect permitted during store outage — this is the documented fail-open trade-off');
      assert.strictEqual(b.replay, undefined, 'not a replay — genuinely re-executed');
    } finally {
      store.reserve = orig;
      restore();
    }
  });

  // --- concurrent duplicates during outage: both can execute -------------
  await test('CONSEQUENCE: concurrent duplicates during outage can both execute', async () => {
    store._reset();
    toolCalls = 0;
    let release;
    const gate = new Promise((res) => { release = res; });
    const restore = installNativeCounter(async () => { await gate; });
    const orig = store.reserve;
    store.reserve = failStore;
    try {
      const p1 = TaskExecutor.executeTool('getTime', {}, 'u-fm', null, opts);
      const p2 = TaskExecutor.executeTool('getTime', {}, 'u-fm', null, opts);
      await new Promise((r) => setTimeout(r, 15));
      release();
      const [ra, rb] = await Promise.all([p1, p2]);
      assert.strictEqual(ra.success, true);
      assert.strictEqual(rb.success, true);
      assert.strictEqual(toolCalls, 2, 'both concurrent duplicates ran (fail-open, no reservation boundary)');
    } finally {
      store.reserve = orig;
      restore();
    }
  });

  // --- fail-open is NOT risk/scope differentiated (current semantics) ----
  await test('semantics NOT differentiated by capability risk/scope (both fail-open identically)', async () => {
    store._reset();
    toolCalls = 0;
    const restore = installNativeCounter();
    const orig = store.reserve;
    store.reserve = failStore;
    try {
      // read-class tool (getTime: risk low) and any state-changing class both
      // take the SAME fail-open path — no tiered policy exists today.
      const r1 = await TaskExecutor.executeTool('getTime', {}, 'u-fm', null, opts);
      assert.strictEqual(r1.success, true, 'read-class fail-open');
      // inspect the orchestrator contract: preflight has no risk/scope branch
      const src = require('fs').readFileSync(require('path').join(__dirname, '../lib/capabilities/idempotency.js'), 'utf8');
      assert.ok(!/risk\s*===|scope\s*===\s*'high'|failClosed/i.test(src), 'no risk-tiered fail-open/closed policy present in slice 3');
      assert.ok(src.includes('FAIL-OPEN'), 'fail-open remains the documented, intentional semantic');
    } finally {
      store.reserve = orig;
      restore();
    }
  });

  // --- recovery: once the store returns, dedup resumes -------------------
  await test('after store recovery, dedup resumes on the same key', async () => {
    store._reset();
    toolCalls = 0;
    const restore = installNativeCounter();
    const orig = store.reserve;
    store.reserve = failStore;
    try {
      await TaskExecutor.executeTool('getTime', {}, 'u-fm', null, opts); // outage: executes
      assert.strictEqual(toolCalls, 1);
      // store recovers — but the key was never reserved (fail-open skipped it),
      // so the first post-recovery request reserves + executes: no stale phantom.
      store.reserve = orig;
      const r = await TaskExecutor.executeTool('getTime', {}, 'u-fm', null, opts);
      assert.strictEqual(r.success, true);
      assert.strictEqual(toolCalls, 2, 'first post-recovery request executes (nothing reserved during outage)');
      // and now dedup holds again
      const d = await TaskExecutor.executeTool('getTime', {}, 'u-fm', null, opts);
      assert.strictEqual(d.replay, true, 'dedup re-engaged after recovery');
      assert.strictEqual(toolCalls, 2, 'no further execution once store is healthy');
    } finally {
      store.reserve = orig;
      restore();
    }
  });

  // --- settle failure also fails open (never blocks post-execution) ------
  await test('settle failure fails open (post-execution never throws)', async () => {
    store._reset();
    toolCalls = 0;
    const restore = installNativeCounter();
    const origSettle = store.settle;
    store.settle = async () => ({ ok: false, error: 'simulated: settle write failed' });
    try {
      const r = await TaskExecutor.executeTool('getTime', {}, 'u-fm', null, opts);
      assert.strictEqual(r.success, true, 'settle failure must not fail the execution');
      assert.strictEqual(toolCalls, 1);
    } finally {
      store.settle = origSettle;
      restore();
    }
  });

  console.log('-------------------------------------------------------');
  console.log(`Result: ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
};

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });