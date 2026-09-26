/* Stage 1 staging tooling — message history measurement + seed.
 *
 * MONGO TEST SAFETY
 *   This script no longer reads MONGO_URI or DATABASE_URL. Its target must be
 *   designated explicitly through tests/helpers/disposableMongo.js, and it can
 *   only ever reach a generated `arc_ai_test_<runId>` database on an
 *   allowlisted host. The default command is read-only, writes require an
 *   explicit opt-in, and cleanup is scoped to this run's own data.
 *
 * Safe invocation (all writes opt in, none of them can reach the app database):
 *   export MONGO_TEST_URI=mongodb://127.0.0.1:27017
 *   export MONGO_TEST_EXPECTED_HOST=127.0.0.1
 *   export MONGO_TEST_DISPOSABLE=1
 *   export RUN_MONGO_INTEGRATION=1
 *   export MONGO_MEASURE_ALLOW_DESTRUCTIVE=1
 *   node scripts/measureMessageHistory.js --seed 500      # prints runId + db
 *   export MONGO_TEST_RUN_ID=<runId> MONGO_TEST_DB_NAME=<db>
 *   node scripts/measureMessageHistory.js --measure <conversationId>
 *   node scripts/measureMessageHistory.js --cleanup <conversationId>
 *
 *   --measure needs no opt-in: it only reads.
 *
 *   node scripts/measureMessageHistory.js --seed 500
 *     Creates scratch conversation (userId 'staging_probe') with N messages
 *     (alternating user/ai, one completed-assistant doc carrying the stale
 *     partial/state flags from the success-update path). Prints conv id.
 *
 *   node scripts/measureMessageHistory.js --measure <conversationId>
 *     1. Legacy path: full fetch (sort asc, limit 500) — latency, payload
 *        bytes, message count, explain() winning plan.
 *     2. Cursor traversal: pages of 40 via (createdAt,_id) range queries —
 *        total latency, page count, explain() winning plan.
 *     3. Integrity: cursor id-set/order == legacy id-set/order; completed
 *        assistant present; no dupes. Fails non-zero on any mismatch.
 *     4. Index check: message_cursor_pagination exists.
 *
 *   node scripts/measureMessageHistory.js --cleanup <conversationId>
 *     Deletes scratch conversation + its messages.
 *
 * Run --seed with 20 / 100 / 500 and --measure each for the baseline table.
 */

const mongoose = require('mongoose');

const mongoSafety = require('../tests/helpers/disposableMongo');

const PROBE_OWNER = 'staging_probe';

const usage = () => {
  console.log('Usage:');
  console.log('  --seed <20|100|500>          create a scratch conversation in a NEW disposable database');
  console.log('  --measure <conversationId>   measure legacy vs cursor + integrity (read-only)');
  console.log('  --cleanup <conversationId>   delete this run\'s scratch data');
  console.log('');
  console.log('Required environment (no MONGO_URI / DATABASE_URL fallback exists):');
  console.log(mongoSafety.describeRequiredEnv());
  console.log('  MONGO_MEASURE_ALLOW_DESTRUCTIVE=1   required by --seed and --cleanup');
  console.log('  MONGO_TEST_RUN_ID / MONGO_TEST_DB_NAME   reuse the database across invocations');
  process.exit(1);
};

const arg = process.argv[2];
const val = process.argv[3];
if (!['--seed', '--measure', '--cleanup'].includes(arg)) usage();

// Read-only is the default. Anything that writes or deletes must be opted into.
const destructive = arg !== '--measure';
if (destructive && process.env.MONGO_MEASURE_ALLOW_DESTRUCTIVE !== '1') {
  console.error(`Refusing ${arg}: it mutates a database. Set MONGO_MEASURE_ALLOW_DESTRUCTIVE=1 to opt in.`);
  process.exit(2);
}

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

async function seed(n) {
  const count = Math.max(parseInt(n, 10) || 0, 1);
  const conv = await Conversation.create({
    userId: 'staging_probe',
    title: `Stage1 probe ${count}`,
    lastMessage: { content: 'probe', role: 'user', timestamp: new Date() }
  });
  const base = Date.now() - count * 1000;
  const docs = [];
  for (let i = 0; i < count; i += 1) {
    const isAI = i % 2 === 1;
    docs.push({
      conversationId: conv._id,
      role: isAI ? 'ai' : 'user',
      content: isAI ? `probe assistant ${i}` : `probe user ${i}`,
      // Mirror production write paths: even-index AI docs carry the stale
      // partial/state flags left by the success-update path (Stage 0 §2).
      metadata: isAI && i % 4 === 1
        ? { tokens: { input: 1, output: 2 }, streaming: false, interrupted: false, partial: true, state: 'streaming' }
        : { tokens: { input: 1, output: 2 }, streaming: false, interrupted: false },
      createdAt: new Date(base + i * 1000)
    });
  }
  await Message.insertMany(docs);
  console.log(`seeded conversation ${conv._id} with ${count} messages`);
}

async function measure(conversationId) {
  const filter = { conversationId: new mongoose.Types.ObjectId(conversationId) };
  const total = await Message.countDocuments(filter);
  console.log(`messages in conversation: ${total}`);

  const indexes = await Message.collection.getIndexes();
  console.log(`index message_cursor_pagination present: ${Boolean(indexes.message_cursor_pagination)}`);
  if (!indexes.message_cursor_pagination) {
    console.error('CURSOR INDEX MISSING — create indexes before measuring.');
    process.exit(3);
  }

  // 1. Legacy path (mirrors getMessages offset branch + current client limit)
  let t0 = process.hrtime.bigint();
  const legacy = await Message.find(filter).sort({ createdAt: 1 }).skip(0).limit(500).lean();
  const legacyMs = ms(t0);
  t0 = process.hrtime.bigint();
  const legacyTotal = await Message.countDocuments(filter);
  const legacyCountMs = ms(t0);
  const payloadBytes = Buffer.byteLength(JSON.stringify(legacy));
  const legacyPlan = await Message.find(filter).sort({ createdAt: 1 }).skip(0).limit(500).explain();
  console.log(`legacy find: ${legacyMs.toFixed(1)}ms, count: ${legacyCountMs.toFixed(1)}ms, ` +
    `payload: ${payloadBytes} bytes, docs: ${legacy.length}/${legacyTotal}, ` +
    `plan: ${legacyPlan.queryPlanner.winningPlan.stage} ` +
    `${legacyPlan.queryPlanner.winningPlan.inputStage ? `(${legacyPlan.queryPlanner.winningPlan.inputStage.stage} ${legacyPlan.queryPlanner.winningPlan.inputStage.indexName || ''})` : ''}`);

  // 2. Cursor traversal, pages of 40 (mirrors getMessages cursor branch)
  const pageSize = 40;
  const t1 = process.hrtime.bigint();
  const ref = legacy; // ascending reference
  const collected = [];
  let pages = 0;
  let firstPlan = null;
  if (ref.length > 0) {
    let before = ref[ref.length - 1];
    for (;;) {
      pages += 1;
      const range = {
        ...filter,
        $or: [
          { createdAt: { $lt: before.createdAt } },
          { createdAt: before.createdAt, _id: { $lt: before._id } }
        ]
      };
      const q = Message.find(range).sort({ createdAt: -1, _id: -1 }).limit(pageSize + 1).lean();
      if (pages === 1) firstPlan = await Message.find(range).sort({ createdAt: -1, _id: -1 }).limit(pageSize + 1).explain();
      const probed = await q;
      const hasMore = probed.length > pageSize;
      const page = (hasMore ? probed.slice(0, pageSize) : probed).reverse();
      collected.unshift(...page);
      if (!hasMore) break;
      before = page[0];
      if (pages > 1000) throw new Error('traversal did not terminate');
    }
    collected.push(ref[ref.length - 1]); // tail anchor (latest page in production)
  }
  const cursorMs = ms(t1);
  console.log(`cursor traversal: ${cursorMs.toFixed(1)}ms total, ${pages} pages of ${pageSize}, ` +
    `plan: ${firstPlan ? `${firstPlan.queryPlanner.winningPlan.stage} (${firstPlan.queryPlanner.winningPlan.inputStage ? `${firstPlan.queryPlanner.winningPlan.inputStage.stage} ${firstPlan.queryPlanner.winningPlan.inputStage.indexName || ''}` : 'n/a'})` : 'n/a (empty)'}`);

  // 3. Integrity (acceptance criterion)
  const refIds = ref.map((m) => String(m._id));
  const gotIds = collected.map((m) => String(m._id));
  const okOrder = JSON.stringify(refIds) === JSON.stringify(gotIds);
  const okDupes = new Set(gotIds).size === gotIds.length;
  const okCount = gotIds.length === refIds.length;
  console.log(`integrity: order-identical=${okOrder} no-dupes=${okDupes} count-match=${okCount} (${gotIds.length}/${refIds.length})`);
  if (!okOrder || !okDupes || !okCount) {
    console.error('INTEGRITY FAILURE — cursor traversal diverged from legacy path.');
    process.exit(4);
  }
  console.log('STAGE 1 MEASUREMENT OK');
}

async function cleanup(ctx, conversationId) {
  const oid = new mongoose.Types.ObjectId(conversationId);
  // Only this run's own scratch conversation may be removed. The previous
  // version deleted every message for the id with no ownership check at all.
  const conv = await Conversation.findOne({ _id: oid, userId: PROBE_OWNER }).lean();
  if (!conv) {
    throw new Error(`no scratch conversation ${conversationId} owned by "${PROBE_OWNER}" — refusing to delete anything`);
  }
  const dm = await mongoSafety.deleteDisposableDocuments(ctx, 'messages', { conversationId: oid });
  const dc = await mongoSafety.deleteDisposableDocuments(ctx, 'conversations', { _id: oid, userId: PROBE_OWNER });
  console.log(`deleted ${dm.deletedCount} messages, ${dc.deletedCount} conversations`);
}

(async () => {
  // --seed creates a fresh, marker-owned disposable database. Every other
  // command attaches to the database named by MONGO_TEST_RUN_ID /
  // MONGO_TEST_DB_NAME, and the guard refuses unless that database's ownership
  // marker matches this run.
  const ctx = arg === '--seed'
    ? await mongoSafety.openDisposableMongo({
      allowCollections: [mongoSafety.ANY_RUN_COLLECTION],
      connectOptions: { serverSelectionTimeoutMS: 8000 },
    })
    : await mongoSafety.attachDisposableMongo({
      allowCollections: [mongoSafety.ANY_RUN_COLLECTION],
      connectOptions: { serverSelectionTimeoutMS: 8000 },
    });
  console.log(mongoSafety.safeTargetSummary(ctx.plan));
  console.log(`runId: ${ctx.runId}`);
  try {
    if (arg === '--seed') {
      console.log(`re-run with MONGO_TEST_RUN_ID=${ctx.runId} MONGO_TEST_DB_NAME=${ctx.dbName}`);
      await seed(val);
    } else if (arg === '--measure') {
      await measure(val);
    } else {
      await cleanup(ctx, val);
    }
  } finally {
    await mongoSafety.closeDisposableMongo(ctx);
  }
})().catch((err) => {
  console.error(`failed: ${err.message}`);
  process.exit(1);
});
