/* Cursor Pagination Regression Tests (Stage 1) — run with: node tests/messageCursorPagination.test.js
 *
 * Pins the ADDITIVE cursor path of GET /:conversationId/messages:
 *   GET /api/conversations/:id/messages?limit=40&before=<messageId>
 *
 * Acceptance criterion (anti-revert): full backward traversal returns the
 * exact same message ID set in the exact same order as the legacy
 * skip/limit path — no missing IDs, no duplicates. Completed assistant
 * messages (including ones with stale partial/state from the success-update
 * path) must survive traversal. No filtering by streaming/state, ever.
 *
 * Uses an in-memory fake Message/Conversation collection + the REAL
 * controller code (require-cache stubbing). No DB required.
 * Legacy skip/limit behavior is pinned by messageHistory.baseline.test.js.
 */

const assert = require('assert');
const mongoose = require('mongoose');

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { pass += 1; console.log(`  PASS  ${label}`); },
        (err) => { fail += 1; process.exitCode = 1; console.error(`  FAIL  ${label}\n        ${err.message}`); }
      );
    }
    pass += 1;
    console.log(`  PASS  ${label}`);
    return null;
  } catch (err) {
    fail += 1;
    process.exitCode = 1;
    console.error(`  FAIL  ${label}\n        ${err.message}`);
    return null;
  }
}

console.log('Cursor Pagination Regression Tests (Stage 1)');
console.log('============================================');

/* ---------------- In-memory fake collection ---------------- */

const cmpVal = (a, b) => {
  const na = a instanceof Date ? a.getTime() : String(a && a.toString ? a.toString() : a);
  const nb = b instanceof Date ? b.getTime() : String(b && b.toString ? b.toString() : b);
  return na < nb ? -1 : na > nb ? 1 : 0;
};

const eqVal = (a, b) => {
  if ((a instanceof Date) || (b instanceof Date)) return new Date(a).getTime() === new Date(b).getTime();
  return String(a) === String(b);
};

function matchDoc(doc, query) {
  for (const [k, v] of Object.entries(query)) {
    if (k === '$or') {
      if (!Array.isArray(v) || !v.some((clause) => matchDoc(doc, clause))) return false;
      continue;
    }
    if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      for (const [op, ov] of Object.entries(v)) {
        const c = cmpVal(doc[k], ov);
        if (op === '$lt') { if (!(c < 0)) return false; }
        else if (op === '$lte') { if (!(c <= 0)) return false; }
        else if (op === '$gt') { if (!(c > 0)) return false; }
        else if (op === '$gte') { if (!(c >= 0)) return false; }
        else throw new Error(`unsupported operator ${op}`);
      }
      continue;
    }
    if (!eqVal(doc[k], v)) return false;
  }
  return true;
}

function applySort(docs, spec) {
  const keys = Object.entries(spec);
  return [...docs].sort((a, b) => {
    for (const [k, dir] of keys) {
      const c = cmpVal(a[k], b[k]);
      if (c !== 0) return c * dir;
    }
    return 0;
  });
}

// Fixture: 25 messages, ascending. Index 10/11 share createdAt (tie).
// Index 5 = streaming draft, 12 = cancelled, 20 = completed assistant
// written via the update path (stale partial:true/state:'streaming').
function buildFixture(conversationId) {
  const base = Date.now() - 100000;
  const docs = [];
  for (let i = 0; i < 25; i += 1) {
    const createdAt = new Date(i === 11 ? base + 10 * 1000 : base + i * 1000);
    const doc = {
      _id: new mongoose.Types.ObjectId().toHexString(),
      conversationId,
      role: i % 2 === 0 ? 'user' : 'ai',
      content: `msg-${i}`,
      metadata: { streaming: false, interrupted: false, partial: false, state: 'final' },
      createdAt
    };
    docs.push(doc);
  }
  docs[5].metadata = { streaming: true, interrupted: false, partial: true, state: 'streaming' };
  docs[5].content = 'draft-partial';
  docs[12].metadata = { streaming: false, interrupted: true, partial: true, state: 'cancelled' };
  docs[12].content = 'cancelled-partial';
  docs[20].metadata = { streaming: false, interrupted: false, partial: true, state: 'streaming' };
  docs[20].content = 'completed-but-stale-flags';
  return docs;
}

const messageModelPath = require.resolve('../models/Message');
const conversationModelPath = require.resolve('../models/Conversation');

function installController({ docsByConv = {}, ownedConvs = new Set() } = {}) {
  const calls = [];
  const chainFor = (filtered) => {
    const state = { result: filtered, sort: null, skip: 0, limit: null, lean: false };
    const chain = {
      sort(arg) { state.sort = arg; calls.push({ op: 'sort', arg }); return chain; },
      skip(n) { state.skip = n; calls.push({ op: 'skip', arg: n }); return chain; },
      limit(n) { state.limit = n; calls.push({ op: 'limit', arg: n }); return chain; },
      lean() {
        state.lean = true;
        let out = state.sort ? applySort(state.result, state.sort) : state.result;
        if (state.skip) out = out.slice(state.skip);
        if (state.limit != null) out = out.slice(0, state.limit);
        return Promise.resolve(out);
      }
    };
    return chain;
  };
  const allDocs = () => Object.values(docsByConv).flat();
  const FakeMessage = {
    find(query) {
      calls.push({ op: 'find', query });
      return chainFor(allDocs().filter((d) => matchDoc(d, query)));
    },
    findOne(query) {
      calls.push({ op: 'findOne', query });
      return { lean: () => Promise.resolve(allDocs().find((d) => matchDoc(d, query)) || null) };
    },
    countDocuments(query) {
      calls.push({ op: 'count', query });
      return Promise.resolve(allDocs().filter((d) => matchDoc(d, query)).length);
    }
  };
  const FakeConversation = {
    findOne(query) {
      // Ownership-by-actor is pinned by the baseline suite; here any
      // registered conversation resolves (lets guest-path tests proceed
      // to the message query, where workspace scoping is asserted).
      const ok = ownedConvs.has(String(query._id));
      return Promise.resolve(ok ? { _id: query._id, userId: query.userId } : null);
    }
  };
  require.cache[messageModelPath] = { id: messageModelPath, filename: messageModelPath, loaded: true, exports: FakeMessage };
  require.cache[conversationModelPath] = { id: conversationModelPath, filename: conversationModelPath, loaded: true, exports: FakeConversation };
  delete require.cache[require.resolve('../controllers/conversationController')];
  return { controller: require('../controllers/conversationController'), calls };
}

const mkRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const reqFor = (cid, query = {}, actor = { type: 'user', id: 'user_123' }) => ({
  actor, params: { conversationId: cid }, query, body: {}
});

const CID = new mongoose.Types.ObjectId().toHexString();
const CID_OTHER = new mongoose.Types.ObjectId().toHexString();

function setup() {
  const docs = buildFixture(CID);
  const other = buildFixture(CID_OTHER);
  const { controller, calls } = installController({
    docsByConv: { [CID]: docs, [CID_OTHER]: other },
    ownedConvs: new Set([CID, CID_OTHER])
  });
  return { controller, calls, docs, other };
}

async function legacyFull(controller, cid) {
  const res = mkRes();
  await controller.getMessages(reqFor(cid, { limit: '500', skip: '0' }), res);
  assert.strictEqual(res.statusCode, 200);
  return res.body.messages;
}

(async () => {
  await check('legacy path unchanged when cursor code present (no page key)', async () => {
    const { controller, docs } = setup();
    const res = mkRes();
    await controller.getMessages(reqFor(CID, { limit: '10', skip: '5' }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!('page' in res.body), 'legacy response must not gain a page key');
    assert.strictEqual(res.body.messages.length, 10);
    // Fixture renames docs[5] to the streaming draft content — assert by id.
    assert.deepStrictEqual(res.body.messages.map((m) => m._id), docs.slice(5, 15).map((d) => d._id));
    assert.strictEqual(res.body.total, 25);
    assert.strictEqual(res.body.hasMore, true);
  });

  await check('cursor page returns strictly-older messages, ascending in page', async () => {
    const { controller, docs } = setup();
    const newest = docs[docs.length - 1]._id;
    const res = mkRes();
    await controller.getMessages(reqFor(CID, { limit: '5', before: newest }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.messages.length, 5);
    // Newest-first scan of 24 older docs, limit 5 -> docs[19..23] ascending.
    assert.deepStrictEqual(res.body.messages.map((m) => m.content),
      ['msg-19', 'completed-but-stale-flags', 'msg-21', 'msg-22', 'msg-23']);
    assert.strictEqual(res.body.hasMore, true);
    assert.strictEqual(res.body.page.nextBefore, res.body.messages[0]._id);
    assert.strictEqual(res.body.total, 25);
  });

  await check('ACCEPTANCE: full traversal == legacy full fetch (ids, order, no dupes)', async () => {
    const { controller, docs } = setup();
    const ref = await legacyFull(controller, CID);
    assert.strictEqual(ref.length, 25);
    // Walk backward from newest; collect every page; newest anchor included
    // by seeding the walk with the tail message itself.
    const collected = [];
    let before = docs[docs.length - 1]._id;
    let tailIncluded = [docs[docs.length - 1]];
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 50) throw new Error('traversal did not terminate');
      const res = mkRes();
      await controller.getMessages(reqFor(CID, { limit: '7', before }), res);
      assert.strictEqual(res.statusCode, 200);
      collected.unshift(...res.body.messages);
      if (!res.body.hasMore) break;
      before = res.body.page.nextBefore;
    }
    const full = [...collected, ...tailIncluded];
    assert.deepStrictEqual(full.map((m) => m._id), ref.map((m) => m._id));
    assert.strictEqual(new Set(full.map((m) => m._id)).size, 25, 'no duplicates');
  });

  await check('completed assistant (stale flags) + draft + cancelled survive traversal', async () => {
    const { controller } = setup();
    const ref = await legacyFull(controller, CID);
    const contents = ref.map((m) => m.content);
    assert.ok(contents.includes('completed-but-stale-flags'), 'completed assistant survives');
    assert.ok(contents.includes('draft-partial'), 'streaming draft not filtered');
    assert.ok(contents.includes('cancelled-partial'), 'cancelled message not filtered');
    // Same via cursor walk
    const res = mkRes();
    await controller.getMessages(reqFor(CID, { limit: '100', before: ref[ref.length - 1]._id }), res);
    const pageContents = res.body.messages.map((m) => m.content);
    assert.ok(pageContents.includes('completed-but-stale-flags'));
    assert.ok(pageContents.includes('draft-partial'));
    assert.ok(pageContents.includes('cancelled-partial'));
  });

  await check('terminal page: before=oldest -> empty, hasMore false, nextBefore null', async () => {
    const { controller, docs } = setup();
    const res = mkRes();
    await controller.getMessages(reqFor(CID, { limit: '10', before: docs[0]._id }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.messages, []);
    assert.strictEqual(res.body.hasMore, false);
    assert.strictEqual(res.body.page.nextBefore, null);
  });

  await check('cursor limit: default 40, clamp 1..100', async () => {
    const { docs } = setup();
    const newest = docs[docs.length - 1]._id;
    const { controller: c2, calls } = installController({
      docsByConv: { [CID]: docs },
      ownedConvs: new Set([CID])
    });
    const r1 = mkRes();
    await c2.getMessages(reqFor(CID, { before: newest }), r1);
    const limitCall1 = calls.filter((c) => c.op === 'limit').pop();
    assert.strictEqual(limitCall1.arg, 41, 'default 40 +1 probe');
    const r2 = mkRes();
    await c2.getMessages(reqFor(CID, { limit: '500', before: newest }), r2);
    const limitCall2 = calls.filter((c) => c.op === 'limit').pop();
    assert.strictEqual(limitCall2.arg, 101, 'clamped to 100 +1 probe');
    assert.strictEqual(r2.body.messages.length, 24);
  });

  await check('invalid before -> 400 INVALID_CURSOR (never 500)', async () => {
    const { controller } = setup();
    for (const bad of ['not-an-id', '123', '']) {
      if (bad === '') continue; // empty = legacy path
      const res = mkRes();
      await controller.getMessages(reqFor(CID, { before: bad }), res);
      assert.strictEqual(res.statusCode, 400, `before=${bad}`);
      assert.strictEqual(res.body.code, 'INVALID_CURSOR');
    }
  });

  await check('unknown before -> 404 CURSOR_NOT_FOUND', async () => {
    const { controller } = setup();
    const res = mkRes();
    await controller.getMessages(
      reqFor(CID, { before: new mongoose.Types.ObjectId().toHexString() }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.code, 'CURSOR_NOT_FOUND');
  });

  await check('cross-conversation cursor -> 404 (no leak)', async () => {
    const { controller, other } = setup();
    const res = mkRes();
    await controller.getMessages(reqFor(CID, { before: other[other.length - 1]._id }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.code, 'CURSOR_NOT_FOUND');
  });

  await check('auth parity on cursor path: 401 unauth, 404 unowned', async () => {
    const { controller, docs } = setup();
    const newest = docs[docs.length - 1]._id;
    const r1 = mkRes();
    await controller.getMessages(
      { params: { conversationId: CID }, query: { before: newest }, body: {} }, r1);
    assert.strictEqual(r1.statusCode, 401);
    const { controller: c2 } = installController({ docsByConv: {}, ownedConvs: new Set() });
    const r2 = mkRes();
    await c2.getMessages(reqFor(CID, { before: newest }), r2);
    assert.strictEqual(r2.statusCode, 404);
    assert.strictEqual(r2.body.code, 'CONVERSATION_NOT_FOUND');
  });

  await check('skip is ignored when before is present', async () => {
    const { controller, docs } = setup();
    const newest = docs[docs.length - 1]._id;
    const a = mkRes();
    await controller.getMessages(reqFor(CID, { limit: '5', skip: '20', before: newest }), a);
    const b = mkRes();
    await controller.getMessages(reqFor(CID, { limit: '5', skip: '0', before: newest }), b);
    assert.deepStrictEqual(a.body.messages.map((m) => m._id), b.body.messages.map((m) => m._id));
  });

  await check('guest workspace filter ignored on cursor path', async () => {
    const { controller, docs } = setup();
    const newest = docs[docs.length - 1]._id;
    const res = mkRes();
    await controller.getMessages(
      reqFor(CID, {
        limit: '5',
        before: newest,
        workspaceId: new mongoose.Types.ObjectId().toHexString()
      }, { type: 'guest', id: 'guest_abc' }),
      res
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.messages.length, 5);
  });

  await check('createdAt tie resolved by _id (no gap, no dupe at tie)', async () => {
    const { controller, docs } = setup();
    // docs[10] and docs[11] share createdAt. Page across the tie with limit 1.
    const idx11 = docs.findIndex((d) => d.content === 'msg-11');
    const res = mkRes();
    await controller.getMessages(reqFor(CID, { limit: '1', before: docs[idx11]._id }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.messages.length, 1);
    assert.strictEqual(res.body.messages[0].content, 'msg-10');
    assert.strictEqual(res.body.hasMore, true);
  });

  console.log(`\nResult: ${pass} pass, ${fail} fail`);
})().catch((err) => {
  console.error('Harness error:', err);
  process.exitCode = 1;
});
