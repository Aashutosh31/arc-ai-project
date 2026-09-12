'use strict';

// Mongoose model for MCP server configuration.
//
// Owner: the User who created this entry.
// scope: 'workspace' — tools visible only to workspaceId; 'global' — available
//        to every authenticated (non-guest) workspace.
// workspaceId: required when scope = 'workspace'.
//
// Secret policy: envVarNames stores environment-variable NAMES, never values.
// auth.envVar stores the env-var name holding a bearer/header secret.
// Values are read from process.env at connection time only and never stored
// or logged.
//
// Phase 1: read-only model; Settings UI (CRUD in admin) is Phase 2.

const mongoose = require('mongoose');
const { sanitizeSlug } = require('../lib/mcp/names');

const authSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['none', 'header'], default: 'none' },
    headerName: { type: String, default: 'Authorization' },
    envVar: { type: String }
  },
  { _id: false }
);

const mcpServerConfigSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 128 },
    slug: { type: String, trim: true, maxlength: 128, lowercase: true },
    scope: { type: String, enum: ['workspace', 'global'], default: 'workspace' },
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      default: null
    },
    transport: {
      type: String,
      enum: ['stdio', 'streamable-http'],
      default: 'stdio'
    },
    command: { type: String, default: null },
    args: [{ type: String }],
    url: { type: String, default: null },
    envVarNames: [{ type: String, trim: true }],
    allowlistEnv: [{ type: String, trim: true }],
    allowedTools: [{ type: String }],
    deniedTools: [{ type: String }],
    auth: { type: authSchema, default: () => ({ type: 'none' }) },
    enabled: { type: Boolean, default: true },
    guestAllowed: { type: Boolean, default: false }
  },
  {
    timestamps: true,
    toJSON: { virtuals: false, versionKey: false },
    toObject: { virtuals: false, versionKey: false }
  }
);

// Workspace-scoped uniqueness: two configs may not share the same name within
// a workspace. Global configs are unique by owner + name.
mcpServerConfigSchema.index(
  { owner: 1, name: 1, workspace: 1 },
  { unique: true, partialFilterExpression: { enabled: { $ne: false } } }
);

// Slug auto-generation + GLOBAL uniqueness (persisted, deterministic).
//
// SECURITY: MCP wire names derive from the slug (`mcp_<slug>_<tool>`), and
// the in-memory registry suffixes duplicate slugs in registration order —
// an order that is not stable across processes. Two same-named servers could
// therefore publish different wire names in different processes, silently
// desynchronizing hand-authored allow/deny patterns from the real tool
// identity (fail-open). Persisting a globally-unique slug at save time makes
// wire names stable, so policy always addresses the tools it names.
mcpServerConfigSchema.pre('validate', async function () {
  const base = this.slug && String(this.slug).trim()
    ? sanitizeSlug(this.slug)
    : sanitizeSlug(this.name || this._id?.toHexString?.() || Date.now().toString());
  this.slug = base;
  let Model;
  try {
    Model = mongoose.model('McpServerConfig');
  } catch {
    return;
  }
  if (mongoose.connection?.readyState !== 1) return;
  let candidate = base;
  let n = 1;
  for (;;) {
    let clash = null;
    try {
      clash = await Model.findOne({
        slug: candidate,
        _id: { $ne: this._id }
      }).select('_id').lean();
    } catch {
      return; // lookup failure must never block the save
    }
    if (!clash) break;
    n += 1;
    candidate = `${base}_${n}`;
    if (n > 999) break;
  }
  this.slug = candidate;
});

// Mongoose connection guard: the model is usable even when mongoose is not
// connected (schema-only); queries are short-circuited in configStore.js.
let _Model;
try {
  const modelName = 'McpServerConfig';
  _Model = mongoose.models[modelName] || mongoose.model(modelName, mcpServerConfigSchema);
} catch {
  _Model = null;
}

module.exports = _Model;