'use strict';

// Disposable child probe used by idempotency.mongo.test.js (proof: restart /
// process boundary). Connects a FRESH mongoose connection in a separate OS
// process and reads the persisted IdempotencyRecord for a given key.
//
// MONGO TEST SAFETY
//   The Mongo URI is NEVER passed through process.argv — argv is visible to
//   every process on the host. The parent supplies the disposable target through
//   the environment instead (see disposableMongo.buildChildEnv), including the
//   runId and generated database name, so this process reuses the parent's
//   database instead of inventing one.
//
//   The target is validated by the same shared guard: explicit opt-in only,
//   host allowlist, `^arc_ai_test_` database name, no MONGO_URI / DATABASE_URL
//   fallback. The run-ownership marker must match, so this probe can only read a
//   database owned by this run. It performs no writes and no deletes.
//
// Usage: node idempotency.probe-child.js <idempotencyKey>
// Prints a single line: `PROBE_JSON <json>` where json = probe result or error.

const key = process.argv[2];
const mongoSafety = require('./helpers/disposableMongo');

const emit = (payload) => {
  console.log(`PROBE_JSON ${JSON.stringify(payload)}`);
  process.exit(0);
};

(async () => {
  if (!key) {
    emit({ found: false, error: 'missing <idempotencyKey> argument' });
  }
  // Read-only attach: connects to the run's own disposable database and
  // refuses if the ownership marker does not match this run.
  const ctx = await mongoSafety.attachDisposableMongo({
    allowCollections: [mongoSafety.ANY_RUN_COLLECTION],
    connectOptions: { serverSelectionTimeoutMS: 15000 },
  });
  // The raw collection is used (not the model) so this process cannot create
  // indexes or otherwise write.
  const doc = await ctx.db.collection('idempotencyrecords').findOne({ key });
  await mongoSafety.closeDisposableMongo(ctx);
  emit(doc
    ? { found: true, status: doc.status, executionId: doc.executionId, outcome: doc.outcome || null }
    : { found: false });
})().catch((e) => {
  console.error(`PROBE_JSON ${JSON.stringify({ found: false, error: String(e && e.message || e) })}`);
  process.exit(1);
});
