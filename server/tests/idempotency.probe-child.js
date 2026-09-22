'use strict';

// Disposable child probe used by idempotency.mongo.test.js (proof: restart/
// process boundary). Connects a FRESH mongoose connection in a separate OS
// process and reads the persisted IdempotencyRecord for a given key.
//
// Usage: node idempotency.probe-child.js <MONGODB_URI> <idempotencyKey>
// Prints a single line: `PROBE_JSON <json>` where json = probe result or error.

const mongoose = require('mongoose');

const uri = process.argv[2];
const key = process.argv[3];

(async () => {
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15000,
    autoIndex: true,
  });
  const IdempotencyRecord = require('../models/IdempotencyRecord');
  const doc = await IdempotencyRecord.findOne({ key }).lean();
  const probe = doc
    ? { found: true, status: doc.status, executionId: doc.executionId, outcome: doc.outcome || null }
    : { found: false };
  console.log(`PROBE_JSON ${JSON.stringify(probe)}`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error(`PROBE_JSON ${JSON.stringify({ found: false, error: String(e && e.message || e) })}`);
  process.exit(1);
});