const mongoose = require('mongoose');

// One durable occurrence of a Job.
//
// A run is written BEFORE its execution starts, so a crash leaves an honest
// RUNNING record instead of silently losing the occurrence. `occurrenceKey`
// is unique per job + scheduled instant, which is the database-level
// guarantee that a retried scheduler tick cannot launch the same occurrence
// twice. Evidence is compact by design: this is a notification/history
// surface, not a copy of the execution log.

const EvidenceSchema = new mongoose.Schema(
  {
    label: { type: String, default: '' },
    value: { type: String, default: '' }
  },
  { _id: false }
);

const JobRunSchema = new mongoose.Schema({
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    default: null
  },
  // Stable identity for one occurrence. Never derived from a client value.
  occurrenceKey: { type: String, required: true },
  scheduledFor: { type: Date, default: null },
  startedAt: { type: Date, default: Date.now },
  finishedAt: { type: Date, default: null },
  status: {
    type: String,
    enum: ['RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED', 'SKIPPED'],
    default: 'RUNNING'
  },
  trigger: {
    type: String,
    enum: ['schedule', 'manual', 'resume'],
    default: 'schedule'
  },
  executionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Execution',
    default: null
  },
  summary: { type: String, default: '' },
  error: { type: String, default: null },
  evidence: { type: [EvidenceSchema], default: [] },
  notificationRead: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

// One occurrence per job. The unique index is the idempotency guarantee.
JobRunSchema.index({ jobId: 1, occurrenceKey: 1 }, { unique: true });
JobRunSchema.index({ jobId: 1, createdAt: -1 });
JobRunSchema.index({ userId: 1, workspaceId: 1, notificationRead: 1, createdAt: -1 });

module.exports = mongoose.model('JobRun', JobRunSchema);
