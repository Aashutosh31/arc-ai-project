/* Message History Baseline Tests — run with: node tests/messageHistory.baseline.test.js
 *
 * STAGE 0 (Phase 3) regression guard for the CURRENT offset-based architecture.
 * These tests pin the existing behavior BEFORE any pagination change:
 *
 *  Part A (no DB): canonical persisted representation of user / completed /
 *                  streaming / cancelled / interrupted messages (schema level).
 *  Part B (no DB): GET /:conversationId/messages contract — limit/skip
 *                  clamping, ownership gating, sort order, lean usage,
 *                  {messages,total,hasMore} shape, conversation isolation.
 *  Part C (DB, gated): full round-trip persistence -> history retrieval ->
 *                  reload reconstruction. Runs only when MONGO_URI or
 *                  DATABASE_URL is reachable; otherwise SKIP (staging).
 *
 * A completed assistant message MUST survive reload / conversation switch.
 * If any test here fails on the clean baseline, report it — do NOT silently
 * fix implementation to make tests pass.
 */

const assert = require('assert');

let pass = 0;
let fail = 0;
let skip = 0;

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

function skipTest(label, reason) {
  skip += 1;
  console.log(`  SKIP  ${label} (${reason})`);
}

console.log('Message History Baseline Tests (Stage 0)');
console.log('========================================');

/* ------------------------------------------------------------------ */
/* Part A — canonical message state contract (schema level, no DB)     */
/* ------------------------------------------------------------------ */
console.log('\nA. Message state contract');

const mongoose = require('mongoose');
const Message = require('../models/Message');

const convId = () => new mongoose.Types.ObjectId();

async function runA() {
  // 1. user message persists: role=user, content required, streaming=false
  await check('user message shape validates', async () => {
    const m = new Message({ conversationId: convId(), role: 'user', content: 'hello' });
    await m.validate();
    assert.strictEqual(m.role, 'user');
    assert.strictEqual(m.metadata.streaming, false);
    assert.strictEqual(m.metadata.interrupted, false);
  });

  // 2. completed assistant message: streaming=false, interrupted=false.
  //    NOTE (baseline quirk): success path via findByIdAndUpdate omits
  //    partial/state, so a draft-updated doc keeps partial:true,
  //    state:'streaming'. Only Message.create (no-draft path) yields the
  //    schema default state:'final'. Pinned here so Stage 1+ cannot regress it.
  await check('completed assistant (create path) defaults to state final', async () => {
    const m = new Message({
      conversationId: convId(), role: 'ai', content: 'done',
      metadata: { tokens: { input: 1, output: 2 }, streaming: false, interrupted: false }
    });
    await m.validate();
    assert.strictEqual(m.metadata.streaming, false);
    assert.strictEqual(m.metadata.interrupted, false);
    assert.strictEqual(m.metadata.state, 'final');
  });

  // 3. streaming draft: the ONLY in-flight representation
  await check('streaming draft representation', async () => {
    const m = new Message({
      conversationId: convId(), role: 'ai', content: 'part…',
      metadata: { tokens: { input: 0, output: 0 }, streaming: true, interrupted: false, partial: true, state: 'streaming' }
    });
    await m.validate();
    assert.strictEqual(m.metadata.streaming, true);
    assert.strictEqual(m.metadata.state, 'streaming');
  });

  // 4. interrupted/cancelled: streaming=false + interrupted=true + state cancelled
  await check('cancelled message representation', async () => {
    const m = new Message({
      conversationId: convId(), role: 'ai', content: 'partial…',
      metadata: { tokens: { input: 0, output: 0 }, streaming: false, interrupted: true, partial: true, state: 'cancelled' }
    });
    await m.validate();
    assert.strictEqual(m.metadata.streaming, false);
    assert.strictEqual(m.metadata.interrupted, true);
    assert.strictEqual(m.metadata.state, 'cancelled');
  });

  // 5. role enum rejects anything but user/ai (no system/tool persisted)
  await check('role enum rejects system/tool roles', async () => {
    const m = new Message({ conversationId: convId(), role: 'system', content: 'x' });
    await assert.rejects(() => m.validate());
  });

  // 6. content is required — empty messages must not persist
  await check('content is required', async () => {
    const m = new Message({ conversationId: convId(), role: 'ai' });
    await assert.rejects(() => m.validate());
  });

  // 7. "still generating" === metadata.streaming===true OR state==='streaming';
  //    "complete" === streaming===false AND interrupted===false (state may be
  //    stale 'streaming' on the update path — see quirk pinned above).
  await check('"generating" vs "complete" discriminator fields exist', async () => {
    const g = new Message({
      conversationId: convId(), role: 'ai', content: '…',
      metadata: { streaming: true, state: 'streaming', partial: true }
    });
    const c = new Message({
      conversationId: convId(), role: 'ai', content: 'done',
      metadata: { streaming: false, interrupted: false }
    });
    assert.strictEqual(g.metadata.streaming, true);
    assert.strictEqual(c.metadata.streaming, false);
    assert.strictEqual(c.metadata.interrupted, false);
  });
}

/* ------------------------------------------------------------------ */
/* Part B — GET /:id/messages contract (mocked models, no DB)          */
/* ------------------------------------------------------------------ */
console.log('\nB. History endpoint contract');

const messageModelPath = require.resolve('../models/Message');
const conversationModelPath = require.resolve('../models/Conversation');

function installFakes({ owned = true, docs = [], total = 0 } = {}) {
  const calls = { find: null, sort: null, skip: null, limit: null, lean: false, count: null, findOne: [] };
  const chain = {
    sort(arg) { calls.sort = arg; return chain; },
    skip(arg) { calls.skip = arg; return chain; },
    limit(arg) { calls.limit = arg; return chain; },
    lean() { calls.lean = true; return Promise.resolve(docs); }
  };
  const FakeMessage = {
    find(query) { calls.find = query; return chain; },
    countDocuments(query) { calls.count = query; return Promise.resolve(total); }
  };
  const FakeConversation = {
    findOne(query) { calls.findOne.push(query); return Promise.resolve(owned ? { _id: query._id, userId: query.userId } : null); }
  };
  require.cache[messageModelPath] = { id: messageModelPath, filename: messageModelPath, loaded: true, exports: FakeMessage };
  require.cache[conversationModelPath] = { id: conversationModelPath, filename: conversationModelPath, loaded: true, exports: FakeConversation };
  let controller;
  try {
    delete require.cache[require.resolve('../controllers/conversationController')];
    controller = require('../controllers/conversationController');
  } catch (err) {
    return { controllerError: err, calls };
  }
  return { controller, calls };
}

const mkRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const userReq = (params = {}, query = {}) => ({
  actor: { type: 'user', id: 'user_123' },
  params, query, body: {}
});

async function runB() {
  const cid = new mongoose.Types.ObjectId().toHexString();

  await check('default limit 50 / skip 0, asc sort, lean, shape', async () => {
    const { controller, calls, controllerError } = installFakes({ docs: [{ role: 'user' }], total: 1 });
    if (controllerError) throw controllerError;
    const res = mkRes();
    await controller.getMessages(userReq({ conversationId: cid }, {}), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['hasMore', 'messages', 'total']);
    assert.strictEqual(calls.sort && calls.sort.createdAt, 1);
    assert.strictEqual(calls.skip, 0);
    assert.strictEqual(calls.limit, 50);
    assert.strictEqual(calls.lean, true);
  });

  await check('limit clamped to 500, floor 1; skip floor 0', async () => {
    const a = installFakes({ docs: [], total: 0 });
    if (a.controllerError) throw a.controllerError;
    await a.controller.getMessages(userReq({ conversationId: cid }, { limit: '9999' }), mkRes());
    assert.strictEqual(a.calls.limit, 500);
    const b = installFakes({ docs: [], total: 0 });
    await b.controller.getMessages(userReq({ conversationId: cid }, { limit: '0', skip: '-5' }), mkRes());
    assert.strictEqual(b.calls.limit, 50);
    assert.strictEqual(b.calls.skip, 0);
  });

  await check('hasMore = skip+limit < total', async () => {
    const a = installFakes({ docs: [], total: 100 });
    if (a.controllerError) throw a.controllerError;
    const ra = mkRes();
    await a.controller.getMessages(userReq({ conversationId: cid }, { limit: '50', skip: '0' }), ra);
    assert.strictEqual(ra.body.total, 100);
    assert.strictEqual(ra.body.hasMore, true);
    const b = installFakes({ docs: [], total: 100 });
    const rb = mkRes();
    await b.controller.getMessages(userReq({ conversationId: cid }, { limit: '50', skip: '50' }), rb);
    assert.strictEqual(rb.body.hasMore, false);
  });

  await check('unowned conversation -> 404, no messages leaked', async () => {
    const { controller, controllerError } = installFakes({ owned: false });
    if (controllerError) throw controllerError;
    const res = mkRes();
    await controller.getMessages(userReq({ conversationId: cid }, {}), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.code, 'CONVERSATION_NOT_FOUND');
  });

  await check('unauthenticated -> 401', async () => {
    const { controller, controllerError } = installFakes({});
    if (controllerError) throw controllerError;
    const res = mkRes();
    await controller.getMessages({ params: { conversationId: cid }, query: {}, body: {} }, res);
    assert.strictEqual(res.statusCode, 401);
  });

  await check('conversation isolation: query scoped per conversation', async () => {
    const a = installFakes({ docs: [], total: 0 });
    if (a.controllerError) throw a.controllerError;
    const cid2 = new mongoose.Types.ObjectId().toHexString();
    await a.controller.getMessages(userReq({ conversationId: cid }, {}), mkRes());
    await a.controller.getMessages(userReq({ conversationId: cid2 }, {}), mkRes());
    assert.strictEqual(a.calls.find.conversationId, cid2);
    assert.notStrictEqual(cid, cid2);
  });

  await check('guest workspace filter ignored (treated as null)', async () => {
    const { controller, calls, controllerError } = installFakes({ docs: [], total: 0 });
    if (controllerError) throw controllerError;
    const ws = new mongoose.Types.ObjectId().toHexString();
    const res = mkRes();
    await controller.getMessages(
      { actor: { type: 'guest', id: 'guest_abc' }, params: { conversationId: cid }, query: { workspaceId: ws }, body: {} },
      res
    );
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!('workspaceId' in calls.find), 'guest msgQuery must not carry workspaceId');
  });
}

/* ------------------------------------------------------------------ */
/* Part C — DB round-trip (gated: requires reachable MONGO_URI)        */
/* ------------------------------------------------------------------ */
async function runC() {
  console.log('\nC. Persistence round-trip (DB-gated)');
  const uri = process.env.MONGO_URI || process.env.DATABASE_URL;
  if (!uri || uri.includes('your_mongodb')) {
    skipTest('persistence round-trip', 'no MONGO_URI — requires staging');
    skipTest('reload reconstruction', 'no MONGO_URI — requires staging');
    skipTest('switch-conversation isolation', 'no MONGO_URI — requires staging');
    return;
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  } catch (err) {
    skipTest('persistence round-trip', `DB unreachable (${err.message}) — requires staging`);
    skipTest('reload reconstruction', 'DB unreachable — requires staging');
    skipTest('switch-conversation isolation', 'DB unreachable — requires staging');
    return;
  }
  // NOTE: reuse the real model captured at the top of this file (Part A).
  // Part B only swapped require.cache entries for the controller; the
  // top-level binding still points at the compiled model. Re-requiring
  // here would throw OverwriteModelError on a live DB run.
  const RealMessage = Message;

  const cA = new mongoose.Types.ObjectId();
  const cB = new mongoose.Types.ObjectId();
  try {
    await check('user + completed assistant persist and history returns both in order', async () => {
      const u = await RealMessage.create({ conversationId: cA, role: 'user', content: 'baseline q' });
      const a = await RealMessage.create({
        conversationId: cA, role: 'ai', content: 'baseline a',
        metadata: { tokens: { input: 1, output: 2 }, streaming: false, interrupted: false }
      });
      const found = await RealMessage.find({ conversationId: cA }).sort({ createdAt: 1 }).lean();
      assert.ok(found.length >= 2);
      const ids = found.map((m) => String(m._id));
      assert.ok(ids.includes(String(u._id)), 'user message survives');
      assert.ok(ids.includes(String(a._id)), 'completed assistant survives');
      assert.ok(ids.indexOf(String(u._id)) < ids.indexOf(String(a._id)), 'ordering preserved');
    });

    await check('reload reconstruction returns identical set', async () => {
      const first = await RealMessage.find({ conversationId: cA }).sort({ createdAt: 1 }).lean();
      const second = await RealMessage.find({ conversationId: cA }).sort({ createdAt: 1 }).lean();
      assert.deepStrictEqual(
        second.map((m) => String(m._id)),
        first.map((m) => String(m._id))
      );
    });

    await check('switching conversations does not mix histories', async () => {
      await RealMessage.create({ conversationId: cB, role: 'user', content: 'other conv' });
      const aMsgs = await RealMessage.find({ conversationId: cA }).lean();
      const bMsgs = await RealMessage.find({ conversationId: cB }).lean();
      assert.ok(aMsgs.every((m) => String(m.conversationId) === String(cA)));
      assert.ok(bMsgs.every((m) => String(m.conversationId) === String(cB)));
    });
  } finally {
    await RealMessage.deleteMany({ conversationId: { $in: [cA, cB] } });
    await mongoose.connection.close();
  }
}

(async () => {
  await runA();
  await runB();
  await runC();
  console.log(`\nResult: ${pass} pass, ${fail} fail, ${skip} skip`);
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  process.exit(process.exitCode || 0);
})().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
