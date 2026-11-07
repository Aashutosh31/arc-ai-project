const mongoose = require('mongoose');

// JARVIS Phase 4 — proactive autonomy.
//
// A Job is a durable, user-approved schedule/trigger definition. It is
// deliberately separate from chat messages and from Execution documents:
//
//   Job       -> what should happen, when, and under which permission scope
//   Execution -> one concrete run of that definition (TaskPlanner)
//   JobRun    -> durable history/evidence for that occurrence
//
// The definition clones its steps from a plan the user already ran (or is
// given explicitly through the API), so a job never depends on the chat
// stream staying alive. Execution-time policy still runs through the Phase 1
// capability substrate; this model only records the scope the user approved.

const TriggerSchema = new mongoose.Schema(
  {
    // 'schedule' = recurring cron; 'once' = single run at runAt.
    type: { type: String, enum: ['schedule', 'once'], default: 'schedule' },
    cron: { type: String, default: null },
    runAt: { type: Date, default: null },
    timezone: { type: String, default: 'UTC' }
  },
  { _id: false }
);

const JobStepSchema = new mongoose.Schema(
  {
    tool: { type: String, required: true },
    args: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { _id: false }
);

const ActionSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['plan'], default: 'plan' },
    prompt: { type: String, default: '' },
    steps: { type: [JobStepSchema], default: [] },
    // Provenance only: the plan this definition was cloned from. A job keeps
    // working even if that Execution is later pruned.
    sourceExecutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Execution', default: null }
  },
  { _id: false }
);

const JobSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // null = the global workspace. Never "all workspaces".
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    default: null
  },
  title: { type: String, required: true, trim: true },
  prompt: { type: String, default: '' },
  trigger: { type: TriggerSchema, default: () => ({}) },
  action: { type: ActionSchema, default: () => ({}) },
  status: {
    type: String,
    enum: ['ACTIVE', 'PAUSED', 'CANCELLED', 'COMPLETED', 'FAILED'],
    default: 'ACTIVE'
  },
  // Highest capability scope this job may execute without a human in the
  // loop. Phase 4's first slice only permits read/reversible work; anything
  // consequential must stay interactive so a scheduled job can never
  // silently approve an external side effect.
  riskCeiling: {
    type: String,
    enum: ['read', 'reversible'],
    default: 'reversible'
  },
  notifyOn: {
    success: { type: Boolean, default: true },
    failure: { type: Boolean, default: true }
  },
  nextRunAt: { type: Date, default: null },
  lastRunAt: { type: Date, default: null },
  lastRunStatus: { type: String, default: null },
  lastError: { type: String, default: null },
  runCount: { type: Number, default: 0 },
  consecutiveFailures: { type: Number, default: 0 },
  pausedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  // Single-node scheduler lease. The persisted lease is what stops a second
  // tick (or a redeploy race) from running the same occurrence twice.
  lockedAt: { type: Date, default: null },
  lockedBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Owner + workspace listing, and the scheduler's due-job scan.
JobSchema.index({ userId: 1, workspaceId: 1, updatedAt: -1 });
JobSchema.index({ status: 1, nextRunAt: 1 });

JobSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Job', JobSchema);
