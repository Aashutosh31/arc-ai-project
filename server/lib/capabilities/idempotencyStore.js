'use strict';

// JARVIS Action Substrate — slice 3: IDEMPOTENCY STORE (persistence + atomic
// reservation). The substrate's single, bounded persistence surface.
//
// Durable path: Mongoose model IdempotencyRecord. The unique index on `key`
// plus findOneAndUpdate(..., { upsert: true }) gives an ATOMIC reservation: a
// concurrent duplicate cannot both pass the boundary (one upsert wins, the
// other observes the existing RUNNING record — a real synchronization
// mechanism, not a best-effort Map check).
//
// In-memory fallback: tests and any environment without a live Mongo
// connection land here (mirrors lib/mcp/configStore.js). It still enforces
// exclusive reservation per key via a process-local promise-chain mutex, so
// concurrent duplicates are deterministic even without Mongo.
//
// Stored fields (Phase D) — nothing sensitive:
//   key, capabilityId, source, userId, workspaceId, conversationId,
//   executionId, status, createdAt, updatedAt,
//   outcome { status, errorType, durationMs }  (normalized terminal metadata)
//   duplicateCount
//
// NEVER persisted: tool args, tool outputs, credentials, auth tokens.

const { IDEMPOTENCY_STATUS } = require('./idempotencyKey');
const observability = require('./observability');

let IdempotencyRecord;

const getModel = () => {
  if (!IdempotencyRecord) {
    IdempotencyRecord = require('../../models/IdempotencyRecord');
  }
  return IdempotencyRecord;
};

const mongoConnected = () => {
  try {
    const mongoose = require('mongoose');
    return Boolean(mongoose && mongoose.connection && mongoose.connection.readyState === 1);
  } catch {
    return false;
  }
};

// ---- in-memory fallback with per-key mutex --------------------------

const mem = new Map(); // key -> record object
const memLocks = new Map(); // key -> Promise chain (mutex tail)

// Serializes reservations for the same key. Each acquire waits on the
// previous one, so exactly one caller can be "first" per key at any time.
const withKeyLock = (key, fn) => {
  const prev = memLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn).catch((e) => {
    observability.log('capability.idempotency.reservationError', { });
    throw e;
  });
  memLocks.set(key, next.catch(() => {}));
  return next;
};

// ---- shared helpers -------------------------------------------------

const now = () => Date.now();

const toStoredRecord = ({ key, capabilityId, source, userId, workspaceId, conversationId, executionId }) => ({
  key,
  capabilityId: capabilityId || null,
  source: source || null,
  userId: userId || null,
  workspaceId: workspaceId || null,
  conversationId: conversationId || null,
  executionId: executionId || null,
  status: IDEMPOTENCY_STATUS.RUNNING,
  createdAt: now(),
  updatedAt: now(),
  outcome: null,
  duplicateCount: 0,
});

// Atomic reserve. Returns:
//   { reserved: true,  record }                     -> this caller may execute
//   { reserved: false, record, duplicate: true }    -> duplicate (running or terminal)
//   { reserved: false, error }                      -> store failure (fail-open)
const reserve = async (fields) => {
  const { key } = fields;
  if (!key) return { reserved: false, error: 'reservation requires a key' };

  if (mongoConnected()) {
    try {
      const Model = getModel();
      // includeResultMetadata (NOT rawResult — mongoose 8.x silently ignores
      // rawResult on findOneAndUpdate) returns { lastErrorObject, value, ok }.
      // lastErrorObject.updatedExisting === false  => this call INSERTED, so
      // this caller is the reservation winner. Anything else => duplicate.
      const record = await Model.findOneAndUpdate(
        { key },
        { $setOnInsert: toStoredRecord(fields) },
        { upsert: true, new: true, includeResultMetadata: true },
      ).lean();
      const created = record && record.lastErrorObject
        ? record.lastErrorObject.updatedExisting === false
        : false;
      const stored = (record && record.value) || null;
      if (created) {
        return {
          reserved: true,
          record: normalizeRecord(stored),
        };
      }
      return {
        reserved: false,
        duplicate: true,
        record: normalizeRecord(stored),
      };
    } catch (err) {
      // Unique-index race: two upserts can collide on the key before the
      // filter matches. E11000 means another writer won — that is a
      // DUPLICATE, not a store failure. (Mongo retries this internally when
      // the filter contains the unique field; handle it regardless so a race
      // can never be mistaken for fail-open.)
      if (err && err.code === 11000) {
        try {
          const Model = getModel();
          const existing = await Model.findOne({ key }).lean();
          if (existing) {
            return { reserved: false, duplicate: true, record: normalizeRecord(existing) };
          }
        } catch {
          // fall through to fail-open below
        }
      }
      return { reserved: false, error: err && err.message };
    }
  }

  // In-memory exclusive reservation via per-key mutex.
  return withKeyLock(key, async () => {
    const existing = mem.get(key);
    if (existing) {
      existing.duplicateCount = (existing.duplicateCount || 0) + 1;
      existing.updatedAt = now();
      return {
        reserved: false,
        duplicate: true,
        record: { ...existing },
      };
    }
    const record = toStoredRecord(fields);
    mem.set(key, record);
    return { reserved: true, record: { ...record } };
  });
};

// Settle a reserved record to a terminal state after execution.
const settle = async (key, { status, errorType = null, durationMs = null, executionId = null }) => {
  if (!key) return { ok: false, error: 'settle requires a key' };
  const outcome = { status, errorType, durationMs };

  if (mongoConnected()) {
    try {
      const Model = getModel();
      const search = executionId ? { key, executionId } : { key };
      await Model.updateOne(search, {
        $set: {
          status,
          outcome: outcome.status ? outcome : null,
          updatedAt: now(),
        },
      }).lean();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
  }

  const cur = mem.get(key);
  if (cur) {
    cur.status = status;
    cur.outcome = outcome.status ? outcome : null;
    cur.updatedAt = now();
  }
  return { ok: true };
};

const getRecord = async (key) => {
  if (!key) return null;
  if (mongoConnected()) {
    try {
      const Model = getModel();
      return normalizeRecord(await Model.findOne({ key }).lean());
    } catch {
      return null;
    }
  }
  const cur = mem.get(key);
  return cur ? { ...cur } : null;
};

const normalizeRecord = (r) => {
  if (!r) return null;
  return {
    key: r.key,
    capabilityId: r.capabilityId || null,
    source: r.source || null,
    userId: r.userId || null,
    workspaceId: r.workspaceId || null,
    conversationId: r.conversationId || null,
    executionId: r.executionId || null,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    outcome: r.outcome || null,
    duplicateCount: r.duplicateCount || 0,
  };
};

// Test-only: clear in-memory state so suites are hermetic. Never called in
// production paths.
const _reset = () => {
  mem.clear();
  memLocks.clear();
};

module.exports = {
  IDEMPOTENCY_STATUS,
  reserve,
  settle,
  getRecord,
  _reset,
  _memory: mem,
  mongoConnected,
};