'use strict';

// JARVIS Action Substrate — slice 4E item 2: THE authoritative operator policy
// document. Exactly one document lives in this collection (uniqueness on
// `key`), so there is exactly one policy authority in the database.
//
// Shape mirrors the in-process operator policy (operatorPolicy.js /
// authorizationPolicy.js DEFAULT_POLICY) so hydration is a direct lift:
//   { guestDenied, workspaceRestricted, entries, updatedAt }
//
// The pure verdict engine (authorizationPolicy.js) never sees this model.
// operatorPolicySource.js is the only module that reads/writes it, and it
// hydrates the process-local operatorPolicy accessor that TaskExecutor
// already consumes.

const mongoose = require('mongoose');

const POLICY_KEY = 'operator-policy';

// One rule: { id: string|null (null = all), workspaceIds: string[] }
const WorkspaceRestrictedRuleSchema = new mongoose.Schema(
  {
    id: { type: String, default: null },
    workspaceIds: { type: [String], default: [] },
  },
  { _id: false }
);

// One operator entry: { id?, source?, name?, action, reason? }
// `action` mirrors the pure engine's entry actions exactly.
const PolicyEntrySchema = new mongoose.Schema(
  {
    id: { type: String, default: null },
    source: { type: String, default: null },
    name: { type: String, default: null },
    action: {
      type: String,
      enum: ['auto', 'approval_required', 'deny', 'unspecified'],
      required: true,
    },
    reason: { type: String, default: null },
  },
  { _id: false }
);

const OperatorPolicySchema = new mongoose.Schema(
  {
    // Single-document guard: the unique index makes a second authority
    // impossible even under a concurrent startup race.
    key: { type: String, required: true, default: POLICY_KEY, unique: true },
    guestDenied: { type: [String], default: [] },
    workspaceRestricted: { type: [WorkspaceRestrictedRuleSchema], default: [] },
    entries: { type: [PolicyEntrySchema], default: [] },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

OperatorPolicySchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// mongoose.models guard: index.js and tests may both require this module in
// one process; recompiling the same model name throws OverwriteModelError.
const OperatorPolicy =
  mongoose.models.OperatorPolicy ||
  mongoose.model('OperatorPolicy', OperatorPolicySchema);

OperatorPolicy.POLICY_KEY = POLICY_KEY;

module.exports = OperatorPolicy;
