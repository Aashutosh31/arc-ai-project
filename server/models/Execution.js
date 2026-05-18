const mongoose = require('mongoose');

const StepSchema = new mongoose.Schema({
  id: { type: String, required: true },
  toolCallId: { type: String },
  tool: { type: String, required: true },
  args: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'], default: 'PENDING' },
  retryCount: { type: Number, default: 0 },
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
  status: { type: String, enum: ['PLANNED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'], default: 'PLANNED' },
  steps: { type: [StepSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

ExecutionSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Execution', ExecutionSchema);
