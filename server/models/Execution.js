const mongoose = require('mongoose');

const StepSchema = new mongoose.Schema({
  id: { type: String, required: true },
  toolCallId: { type: String },
  tool: { type: String, required: true },
  args: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED'], default: 'PENDING' },
  retryCount: { type: Number, default: 0 },
  // Durable-execution telemetry. `attempts` counts plan-level executions of
  // this step (a fresh run plus each explicit resume); provider-level retries
  // stay inside ToolRecoveryManager and are reflected by `retryCount`.
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 3 },
  lastAttemptAt: { type: Date, default: null },
  // Stable logical identity for this step so a re-run after a crash/reconnect
  // is deduplicated by the capability idempotency substrate instead of
  // duplicating side effects. Deliberate retries get a fresh key.
  idempotencyKey: { type: String, default: null },
  failureReason: { type: String, default: null },
  recovered: { type: Boolean, default: false },
  recoveryStrategy: { type: String, default: null },
  result: { type: mongoose.Schema.Types.Mixed },
  startedAt: { type: Date },
  finishedAt: { type: Date }
});

const ExecutionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null },
  title: { type: String, required: true },
  prompt: { type: String },
  status: { type: String, enum: ['PLANNED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'], default: 'PLANNED' },
  steps: { type: [StepSchema], default: [] },
  // Durable plan state: survives chat reloads/process restarts and lets a
  // client resume from where execution stopped instead of rebuilding it.
  resumeCount: { type: Number, default: 0 },
  lastError: { type: String, default: null },
  completedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Plan history is queried per owner, newest first.
ExecutionSchema.index({ userId: 1, updatedAt: -1 });

ExecutionSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Execution', ExecutionSchema);
