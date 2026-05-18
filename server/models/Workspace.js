const mongoose = require('mongoose');

const WorkspaceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  visibility: { type: String, enum: ['private', 'org', 'public'], default: 'private' },
  settings: { type: mongoose.Schema.Types.Mixed, default: {} },
  activeProject: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
  vectorNamespace: { type: String, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

WorkspaceSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Workspace', WorkspaceSchema);
