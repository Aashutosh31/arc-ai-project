'use strict';

// JARVIS Action Substrate — slice 3: IDEMPOTENCY RECORD (durable store).
//
// One row per logical action (idempotencyKey). The unique index on `key` is
// the atomic reservation boundary: a concurrent duplicate cannot both win a
// findOneAndUpdate(..., { upsert: true }).
//
// Secret policy: stores only the hashed idempotency key (sha256) plus safe
// identity/execution metadata and a normalized terminal OUTCOME. Never stores
// credentials, auth tokens, tool arguments, tool outputs, or arbitrary
// payloads.
//
// status is substrate-internal lifecycle:
//   RUNNING | SUCCEEDED | FAILED | CANCELLED
// (deliberately distinct from the PLAN-level Execution model statuses).

const mongoose = require('mongoose');

const outcomeSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['SUCCEEDED', 'FAILED', 'CANCELLED'], default: null },
    errorType: { type: String, default: null },
    durationMs: { type: Number, default: null },
  },
  { _id: false }
);

// NOTE: timestamps are managed by the store (numeric ms in the in-memory
// fallback, Date coercion on the Mongo path) so the durable and fallback
// records share one shape.
const idempotencyRecordSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    capabilityId: { type: String, default: null },
    source: { type: String, enum: ['native', 'mcp'], default: null },
    userId: { type: String, default: null },
    workspaceId: { type: String, default: null },
    conversationId: { type: String, default: null },
    executionId: { type: String, default: null },
    status: {
      type: String,
      enum: ['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
      default: 'RUNNING'
    },
    outcome: { type: outcomeSchema, default: null },
    duplicateCount: { type: Number, default: 0 },
    createdAt: { type: mongoose.Schema.Types.Mixed, default: 0 },
    updatedAt: { type: mongoose.Schema.Types.Mixed, default: 0 },
  },
  {
    versionKey: false,
  }
);

idempotencyRecordSchema.index({ key: 1 }, { unique: true });

module.exports = mongoose.model('IdempotencyRecord', idempotencyRecordSchema);