'use strict';

// JARVIS Action Substrate — slice 4E item 2: MONGO-BACKED OPERATOR POLICY +
// BOUNDED RUNTIME REFRESH + /api/policy OPERATOR ROUTES.
//
// Proves:
//   A. The real OperatorPolicy model schema enforces ONE-authority invariants:
//      unique `key`, action enum, subdoc shapes, POLICY_KEY constant.
//   B. Startup hydration upserts THE ONE default document (guest-deny seeds)
//      when nothing is persisted; an E11000 insert race re-reads instead of
//      failing; a second hydrate does not duplicate the authority.
//   C. The bounded refresh timer keeps the in-process policy fresh; a GET is
//      served entirely from cache (zero Mongo reads); guests / non-operators /
//      unauthenticated callers are rejected; operators are recognized from
//      role AND from OPERATOR_EMAILS / OPERATOR_USER_IDS; a PUT applies and
//      persists immediately; malformed bodies and Mongo-operator injection are
//      rejected before any write; a malformed PERSISTED document is never
//      applied and never overwritten; a disconnected store fails fast and
//      preserves last-known-good.
//   D. Through the real TaskExecutor boundary: executions never hit Mongo
//      (per-request reads are zero), and an operator PUT changes the NEXT
//      authorization verdict.
//   E. Concurrent refreshes are single-flight (one store read) and concurrent
//      operator PUTs serialize with last-writer-wins.
//
// Run: cd server && node tests/operatorPolicySource.test.js

const assert = require('assert');
const http = require('http');
const express = require('express');

// ---- stub the credit service before TaskExecutor loads ----------------------
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

// ---- A) assert the REAL model schema BEFORE any cache swap ------------------
const RealOperatorPolicy = (() => {
  const m = require('../models/OperatorPolicy');
  return m;
})();

// ---- B) swap the model with an in-memory fake BEFORE the source loads -------
const fakeCollection = {
  doc: null,
  failOnce: null,
  insertConflictOnce: false,
  counters: { findOne: 0, findOneAndUpdate: 0 },
};

const OP_KEY = 'operator-policy';

const makeDoc = (filter, setOnInsert, set) => {
  const seeded = {
    guestDenied: [...(global.__policySource ? global.__policySource.defaultPolicyDocument().guestDenied : [])],
    workspaceRestricted: [],
    entries: [],
  };
  const base = setOnInsert && typeof setOnInsert.guestDenied !== 'undefined' ? { ...setOnInsert } : seeded;
  return {
    _id: 'op-1',
    key: (filter && filter.key) || OP_KEY,
    ...base,
    ...(set || {}),
    updatedAt: (set && set.updatedAt) || new Date(),
    __v: 0,
  };
};

const FakeOperatorPolicy = {
  POLICY_KEY: OP_KEY,
  db: { readyState: 1 },
  // NOTE: NOT async — the source chains `.lean()` off the returned value, so
  // the fake must hand back the `{ lean }` object synchronously (same shape
  // as the slice4e Workspace fake). Throws inside these are caught by the
  // source's await wrapper in runRefresh/persistAtomic.
  findOne: (filter) => {
    fakeCollection.counters.findOne += 1;
    if (fakeCollection.failOnce) {
      const e = fakeCollection.failOnce;
      fakeCollection.failOnce = null;
      throw e;
    }
    return { lean: async () => (fakeCollection.doc ? { ...fakeCollection.doc } : null) };
  },
  findOneAndUpdate: (filter, update, opts) => {
    fakeCollection.counters.findOneAndUpdate += 1;
    if (fakeCollection.failOnce) {
      const e = fakeCollection.failOnce;
      fakeCollection.failOnce = null;
      throw e;
    }
    const $set = (update && update.$set) || {};
    const $setOnInsert = (update && update.$setOnInsert) || {};
    if (fakeCollection.insertConflictOnce) {
      // Simulate a concurrent inserter that won the unique-key race: create
      // THE doc, then fail THIS call with E11000. The source re-reads/updates.
      fakeCollection.insertConflictOnce = false;
      if (!fakeCollection.doc) fakeCollection.doc = makeDoc(filter, $setOnInsert, $set);
      const err = new Error('E11000 duplicate key error collection: operatorpolicies index: key_1');
      err.code = 11000;
      err.name = 'MongoServerError';
      throw err;
    }
    if (!fakeCollection.doc) {
      if (!opts || !opts.upsert) return { lean: async () => null };
      fakeCollection.doc = makeDoc(filter, $setOnInsert, $set);
    } else {
      fakeCollection.doc = {
        ...fakeCollection.doc,
        ...$set,
        updatedAt: $set.updatedAt || fakeCollection.doc.updatedAt,
      };
    }
    return { lean: async () => ({ ...fakeCollection.doc }) };
  },
};

require.cache[require.resolve('../models/OperatorPolicy')] = {
  id: require.resolve('../models/OperatorPolicy'),
  filename: require.resolve('../models/OperatorPolicy'),
  loaded: true,
  exports: FakeOperatorPolicy,
};

// ---- C) fake auth middleware BEFORE the policy route loads ------------------
const fakeProtect = async (req, res, next) => {
  const raw = req.headers['x-test-user'];
  if (!raw) return res.status(401).json({ error: 'Not authorized, no token', code: 'NO_TOKEN' });
  let u;
  try { u = JSON.parse(raw); } catch (_) { u = null; }
  if (!u || !u.id) return res.status(401).json({ error: 'Not authorized, token failed', code: 'NO_TOKEN' });
  const type = u.type === 'guest' ? 'guest' : 'user';
  req.actor = { type, id: String(u.id) };
  req.authType = type;
  req.user = { id: String(u.id), userId: String(u.id), email: u.email, role: u.role };
  next();
};
require.cache[require.resolve('../middleware/authMiddleware.js')] = {
  id: require.resolve('../middleware/authMiddleware.js'),
  filename: require.resolve('../middleware/authMiddleware.js'),
  loaded: true,
  exports: { protect: fakeProtect },
};

// ---- load the modules under test --------------------------------------------
const caps = require('../lib/capabilities');
const source = require('../lib/capabilities/operatorPolicySource');
global.__policySource = source; // makeDoc reads defaults from LIVE source
const TaskExecutor = require('../services/TaskExecutor');

const opUser = () => JSON.stringify({ type: 'user', id: 'op-user-1', email: 'op1@corp.test', role: 'operator' });
const adminUser = () => JSON.stringify({ type: 'user', id: 'op-user-2', email: 'op2@corp.test', role: 'admin' });
const plainUser = () => JSON.stringify({ type: 'user', id: 'user-1', email: 'user1@corp.test', role: 'user' });
const guestUser = () => JSON.stringify({ type: 'guest', id: 'guest_1', email: null, role: 'guest' });

// ---- express app + ephemeral HTTP server -------------------------------------
const app = express();
app.use(express.json());
app.use('/api/policy', require('../routes/policy.js'));
const httpServer = http.createServer(app);
let base = null;

const start = () => new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
const stop = async () => {
  if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
  await new Promise((r) => httpServer.close(r));
};

const req = async (method, url, body, user) => {
  const headers = { connection: 'close', ...(user ? { 'x-test-user': user } : {}) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* non-JSON */ }
  return { status: res.status, body: json };
};

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

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const goodPolicy = (over = {}) => ({
  guestDenied: ['native:webSearch'],
  workspaceRestricted: [],
  entries: [{ id: 'native:getTime', action: 'auto', reason: 'test' }],
  ...over,
});

const resetStore = () => {
  toolCalls = 0;
  fakeCollection.doc = null;
  fakeCollection.failOnce = null;
  fakeCollection.insertConflictOnce = false;
  fakeCollection.counters.findOne = 0;
  fakeCollection.counters.findOneAndUpdate = 0;
  FakeOperatorPolicy.db.readyState = 1;
  source.stopRefreshTimer();
  caps.operatorPolicy.resetOperatorPolicy();
};

const resetHydrated = async () => {
  resetStore();
  const out = await source.hydrate();
  assert.strictEqual(out.ok, true, 'hydrate must succeed on an empty store');
  return out;
};

const PLAIN_OPTS = {
  workspaceId: 'ws-policy',
  skipCreditCharge: true,
  conversationId: 'conv-policy',
};

let toolCalls = 0;
const installNativeCounter = (name) => {
  const tool = require('../tools').tools[name];
  const original = tool.execute;
  tool.execute = async () => { toolCalls += 1; return { success: true, name, count: toolCalls }; };
  return () => { tool.execute = original; };
};

const main = async () => {
  await start();
  base = `http://127.0.0.1:${httpServer.address().port}`;
  delete process.env.OPERATOR_EMAILS;
  delete process.env.OPERATOR_USER_IDS;

  // ---- A) real model schema ---------------------------------------------------

  await test('real OperatorPolicy model enforces the ONE-authority schema', () => {
    assert.strictEqual(RealOperatorPolicy.POLICY_KEY, 'operator-policy');
    const keyPath = RealOperatorPolicy.schema.paths.key;
    assert.strictEqual(keyPath.options.unique, true, 'key is unique (single authority)');
    assert.strictEqual(keyPath.options.default, 'operator-policy');
    assert.ok(RealOperatorPolicy.schema.paths.guestDenied, 'guestDenied path exists');
    const entriesSchema = RealOperatorPolicy.schema.paths.entries.schema;
    assert.ok(entriesSchema, 'entries is an embedded subdoc array');
    assert.deepStrictEqual(
      [...entriesSchema.paths.action.enumValues],
      ['auto', 'approval_required', 'deny', 'unspecified'],
      'action enum matches the pure engine exactly'
    );
    assert.ok(entriesSchema.paths.id && entriesSchema.paths.source && entriesSchema.paths.name && entriesSchema.paths.reason);
    const wrSchema = RealOperatorPolicy.schema.paths.workspaceRestricted.schema;
    assert.ok(wrSchema.paths.id && wrSchema.paths.workspaceIds, 'workspaceRestricted subdoc paths exist');
  });

  // ---- B) hydration / single authority ----------------------------------------

  await test('hydrate on an empty store upserts THE ONE document from defaults', async () => {
    const out = await resetHydrated();
    assert.strictEqual(out.createdDefault, true, 'the default document was created');
    assert.ok(fakeCollection.doc, 'a persisted document exists');
    assert.strictEqual(fakeCollection.doc.key, 'operator-policy');
    assert.deepStrictEqual(
      [...fakeCollection.doc.guestDenied],
      [...caps.operatorPolicy.GUEST_DENY_DEFAULTS],
      'default document preserves the guest-deny seed order'
    );
    assert.strictEqual(source.getMeta().source, 'mongo');
    assert.strictEqual(source.getMeta().lastError, null);
    assert.deepStrictEqual(
      source.getSafeRepresentation().policy.guestDenied,
      [...caps.operatorPolicy.GUEST_DENY_DEFAULTS],
      'in-process policy hydrated from the store in seed order'
    );
  });

  await test('a second hydrate does not duplicate the authority', async () => {
    const first = await resetHydrated();
    const readsBefore = fakeCollection.counters.findOne;
    const second = await source.hydrate();
    assert.strictEqual(first.createdDefault, true);
    assert.strictEqual(second.createdDefault, false, 'second hydrate reuses the existing doc');
    assert.strictEqual(fakeCollection.counters.findOne, readsBefore + 1);
  });

  await test('E11000 insert race is retried as a re-read: one authority survives', async () => {
    resetStore();
    fakeCollection.insertConflictOnce = true; // a concurrent inserter wins
    const out = await source.refresh('race');
    assert.strictEqual(out.ok, true);
    assert.ok(fakeCollection.doc, 'exactly one document exists after the race');
    assert.strictEqual(fakeCollection.doc.key, 'operator-policy');
    assert.strictEqual(source.getMeta().lastError, null);
  });

  // ---- C) refresh, routes, failures -------------------------------------------

  await test('bounded interval refreshes the in-process policy', async () => {
    await resetHydrated();
    fakeCollection.doc = { ...fakeCollection.doc, guestDenied: [...fakeCollection.doc.guestDenied, 'native:xyz'] };
    fakeCollection.counters.findOne = 0;
    source.startRefreshTimer({ intervalMs: 15 });
    try {
      await tick(120);
      assert.ok(fakeCollection.counters.findOne > 0, 'interval drove store reads');
      const served = source.getSafeRepresentation().policy.guestDenied;
      assert.ok(served.includes('native:xyz'), 'interval-refreshed policy picked up the stored change');
      assert.ok(source.getMeta().nextRefreshAt !== null, 'meta advertises nextRefreshAt while the timer runs');
    } finally {
      source.stopRefreshTimer();
    }
  });

  await test('GET serves the cached policy to an operator with zero Mongo reads', async () => {
    await resetHydrated();
    await source.replacePolicy(goodPolicy());
    const reads = fakeCollection.counters.findOne + fakeCollection.counters.findOneAndUpdate;
    const r = await req('GET', '/api/policy', undefined, opUser());
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.policy.guestDenied, ['native:webSearch']);
    assert.deepStrictEqual(r.body.policy.entries[0].action, 'auto');
    for (const secret of ['_id', 'key', '__v', 'updatedAt']) {
      assert.ok(!(secret in r.body.policy), `GET must not leak ${secret}`);
    }
    assert.strictEqual(r.body.meta.source, 'mongo');
    assert.ok(Number.isInteger(r.body.meta.revision));
    assert.strictEqual(fakeCollection.counters.findOne + fakeCollection.counters.findOneAndUpdate, reads,
      'a GET never touches Mongo');
  });

  await test('GET rejects a signed-in non-operator', async () => {
    const r = await req('GET', '/api/policy', undefined, plainUser());
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'GATE.OPERATOR');
  });

  await test('GET rejects an admin as an operator', async () => {
    const r = await req('GET', '/api/policy', undefined, adminUser());
    assert.strictEqual(r.status, 200, 'admin role is treated as an operator');
  });

  await test('GET rejects guests hard', async () => {
    const r = await req('GET', '/api/policy', undefined, guestUser());
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'GATE.GUEST');
  });

  await test('GET rejects an unauthenticated request', async () => {
    const r = await req('GET', '/api/policy');
    assert.strictEqual(r.status, 401);
  });

  await test('OPERATOR_EMAILS grants operator even when role is user', async () => {
    process.env.OPERATOR_EMAILS = 'ops@corp.test';
    try {
      const r = await req('GET', '/api/policy', undefined,
        JSON.stringify({ type: 'user', id: 'user-9', email: 'ops@corp.test', role: 'user' }));
      assert.strictEqual(r.status, 200, 'email allowlist overrides non-operator role');
    } finally {
      delete process.env.OPERATOR_EMAILS;
    }
  });

  await test('OPERATOR_USER_IDS grants operator by actor id', async () => {
    process.env.OPERATOR_USER_IDS = 'user-42';
    try {
      const r = await req('GET', '/api/policy', undefined,
        JSON.stringify({ type: 'user', id: 'user-42', email: null, role: 'user' }));
      assert.strictEqual(r.status, 200, 'actor-id allowlist grants operator');
    } finally {
      delete process.env.OPERATOR_USER_IDS;
    }
  });

  await test('PUT applies immediately and persists THE ONE document', async () => {
    await resetHydrated();
    fakeCollection.counters.findOneAndUpdate = 0;
    const input = goodPolicy();
    const r = await req('PUT', '/api/policy', input, opUser());
    assert.strictEqual(r.status, 200);
    assert.strictEqual(fakeCollection.counters.findOneAndUpdate, 1, 'a PUT is one atomic upsert-write');
    assert.deepStrictEqual(fakeCollection.doc.entries[0].id, 'native:getTime');
    const served = await req('GET', '/api/policy', undefined, opUser());
    assert.strictEqual(served.status, 200);
    assert.deepStrictEqual(served.body.policy.entries[0].action, 'auto');
  });

  await test('PUT accepts the { policy } envelope', async () => {
    await resetHydrated();
    const r = await req('PUT', '/api/policy', { policy: goodPolicy({ entries: [{ id: 'native:getTime', action: 'deny' }] }) }, opUser());
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.policy.entries[0].action, 'deny');
  });

  await test('PUT rejects a body over the 64 KB cap with 413', async () => {
    await resetHydrated();
    const before = fakeCollection.counters.findOneAndUpdate;
    const oversized = goodPolicy({ entries: [{ id: 'native:getTime', action: 'auto', reason: 'x'.repeat(70 * 1024) }] });
    const r = await req('PUT', '/api/policy', oversized, opUser());
    assert.strictEqual(r.status, 413);
    assert.strictEqual(r.body.code, 'POLICY.TOO_LARGE');
    assert.strictEqual(fakeCollection.counters.findOneAndUpdate, before, 'no write for an oversized body');
  });

  await test('PUT rejects a malformed body before any write', async () => {
    await resetHydrated();
    const before = fakeCollection.counters.findOneAndUpdate;
    const revBefore = source.getMeta().revision;
    const r = await req('PUT', '/api/policy', goodPolicy({ entries: [{ source: 'native', name: 'getTime', action: 'explode' }] }), opUser());
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, 'POLICY.MALFORMED');
    assert.strictEqual(fakeCollection.counters.findOneAndUpdate, before, 'no store write for a malformed body');
    assert.strictEqual(source.getMeta().revision, revBefore, 'in-process policy untouched');
  });

  await test('PUT rejects Mongo-operator injection (dollar keys) in any position', async () => {
    await resetHydrated();
    const before = fakeCollection.counters.findOneAndUpdate;
    let r = await req('PUT', '/api/policy', { ...goodPolicy(), $set: { guestDenied: [] } }, opUser());
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, 'POLICY.MALFORMED');
    r = await req('PUT', '/api/policy', goodPolicy({ workspaceRestricted: [{ id: '$or', workspaceIds: ['ws-1'] }] }), opUser());
    assert.strictEqual(r.status, 400);
    assert.strictEqual(fakeCollection.counters.findOneAndUpdate, before, 'no write reached the store');
    assert.throws(() => source.validatePolicyShape({ ...goodPolicy(), $where: 'x' }, { fromStore: false }),
      (e) => e && e.code === 'MALFORMED_POLICY');
  });

  await test('malformed PERSISTED document is never applied and never overwritten', async () => {
    await resetHydrated();
    await source.replacePolicy(goodPolicy());              // last-known-good
    fakeCollection.doc = { key: 'operator-policy', entries: [{ action: 'bogus' }] };
    fakeCollection.counters.findOneAndUpdate = 0;
    const out = await source.refresh('corrupt-check');
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'malformed-persisted');
    assert.strictEqual(fakeCollection.counters.findOneAndUpdate, 0, 'the bad document is NOT repaired by refresh');
    const policy = source.getSafeRepresentation().policy;
    assert.strictEqual(policy.entries[0].action, 'auto', 'last-known-good in-process policy preserved');
    assert.strictEqual(source.getMeta().lastError, 'malformed-persisted');
  });

  await test('Mongo unavailable during refresh preserves last-known-good', async () => {
    await resetHydrated();
    await source.replacePolicy(goodPolicy());
    fakeCollection.failOnce = Object.assign(new Error('server selection heartbeat failed'), { name: 'MongoNetworkError' });
    const out = await source.refresh('outage');
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'mongo-unavailable');
    assert.strictEqual(out.preserved, true);
    assert.strictEqual(source.getSafeRepresentation().policy.entries[0].action, 'auto');
    assert.strictEqual(source.getMeta().lastError, 'mongo-unavailable');
  });

  await test('disconnected store fails fast without issuing a query', async () => {
    await resetHydrated();
    FakeOperatorPolicy.db.readyState = 0;
    fakeCollection.counters.findOne = 0;
    try {
      const out = await source.refresh('disconnected');
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.reason, 'mongo-unavailable');
      assert.strictEqual(fakeCollection.counters.findOne, 0, 'no buffered query while disconnected');
    } finally {
      FakeOperatorPolicy.db.readyState = 1;
    }
  });

  await test('PUT while the store is disconnected returns 503, policy untouched', async () => {
    await resetHydrated();
    await source.replacePolicy(goodPolicy());
    const revBefore = source.getMeta().revision;
    FakeOperatorPolicy.db.readyState = 0;
    try {
      const r = await req('PUT', '/api/policy', goodPolicy({ guestDenied: ['native:zzz'] }), opUser());
      assert.strictEqual(r.status, 503);
      assert.strictEqual(r.body.code, 'POLICY_STORE_UNAVAILABLE');
      assert.strictEqual(source.getMeta().revision, revBefore, 'failed persist leaves in-process policy untouched');
    } finally {
      FakeOperatorPolicy.db.readyState = 1;
    }
  });

  // ---- D) execution boundary through the real TaskExecutor ---------------------

  await test('executions make zero per-request Mongo queries', async () => {
    await resetHydrated();
    await source.replacePolicy(goodPolicy());
    const restore = installNativeCounter('getTime');
    try {
      fakeCollection.counters.findOne = 0;
      fakeCollection.counters.findOneAndUpdate = 0;
      for (let i = 0; i < 3; i += 1) {
        const r = await TaskExecutor.executeTool('getTime', {}, 'u-policy', null, PLAIN_OPTS);
        assert.strictEqual(r.success, true);
      }
      assert.strictEqual(fakeCollection.counters.findOne, 0, 'no store reads across executions');
      assert.strictEqual(fakeCollection.counters.findOneAndUpdate, 0, 'no store writes across executions');
      assert.strictEqual(toolCalls, 3);
    } finally { restore(); }
  });

  await test('an operator PUT changes the NEXT authorization verdict through the real executor', async () => {
    await resetHydrated();
    const restore = installNativeCounter('getTime');
    try {
      await source.replacePolicy(goodPolicy({ entries: [{ id: 'native:getTime', action: 'deny', reason: 'operator-says-no' }] }));
      const denied = await TaskExecutor.executeTool('getTime', {}, 'u-policy', null, PLAIN_OPTS);
      assert.strictEqual(denied.success, false);
      assert.strictEqual(denied.authorization.reason, 'operator-says-no');
      assert.strictEqual(toolCalls, 0, 'denied capability never reaches the tool body');

      await source.replacePolicy(goodPolicy({ entries: [{ id: 'native:getTime', action: 'auto' }] }));
      const allowed = await TaskExecutor.executeTool('getTime', {}, 'u-policy', null, PLAIN_OPTS);
      assert.strictEqual(allowed.success, true);
      assert.strictEqual(toolCalls, 1, 'an auto verdict after PUT executes immediately');
    } finally { restore(); }
  });

  // ---- E) concurrency ----------------------------------------------------------

  await test('concurrent refreshes are single-flight: exactly one store read', async () => {
    await resetHydrated();
    fakeCollection.counters.findOne = 0;
    const a = source.refresh('a');
    const b = source.refresh('b');
    const [ra, rb] = await Promise.all([a, b]);
    assert.strictEqual(ra.ok, true);
    assert.strictEqual(rb.ok, true);
    assert.strictEqual(fakeCollection.counters.findOne, 1, 'one read for two concurrent refreshes');
  });

  await test('concurrent PUTs serialize with last-writer-wins in store AND memory', async () => {
    await resetHydrated();
    const first = goodPolicy({ entries: [{ id: 'native:getTime', action: 'auto', reason: 'first' }] });
    const second = goodPolicy({ entries: [{ id: 'native:getTime', action: 'deny', reason: 'second' }] });
    const p1 = source.replacePolicy(first);
    const p2 = source.replacePolicy(second);
    await Promise.all([p1, p2]);
    assert.strictEqual(fakeCollection.doc.entries[0].reason, 'second', 'persisted doc reflects the last writer');
    assert.strictEqual(source.getSafeRepresentation().policy.entries[0].reason, 'second', 'in-process policy reflects the last writer');
    const r = await req('GET', '/api/policy', undefined, opUser());
    assert.strictEqual(r.body.policy.entries[0].reason, 'second');
  });

  await stop();
  console.log(`\n${pass + fail} tests, ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
};

main().catch(async (err) => {
  await stop().catch(() => {});
  console.error(err);
  process.exitCode = 1;
});