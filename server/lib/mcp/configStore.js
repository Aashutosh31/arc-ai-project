'use strict';

// Mongo-backed config store. Feeds McpRegistry from McpServerConfig documents.
//
// Guard: tests never hit Mongo. We short-circuit whenever mongoose is not
// connected so the entire MCP pipeline can run against an in-memory
// registry. Production uses this module to hydrate configs lazily at first
// `schemasForRequest` call after process start.

let McpServerConfig;

const getModel = () => {
  if (!McpServerConfig) {
    McpServerConfig = require('../../models/McpServerConfig');
  }
  return McpServerConfig;
};

const seedRegistryFromMongo = async (registry) => {
  let mongoose;
  try {
    mongoose = require('mongoose');
  } catch {
    return; // mongoose not installed in this environment
  }
  if (!mongoose || !mongoose.connection || mongoose.connection.readyState !== 1) {
    return; // not connected — skip; tests land here
  }
  const Model = getModel();
  let docs;
  try {
    // Deterministic registration order (creation order) so slug-collision
    // suffixing in the registry — a last resort now that slugs are unique
    // at save time — is at least stable across processes and restarts.
    docs = await Model.find({ enabled: true }).sort({ _id: 1 }).lean().exec();
  } catch {
    return; // query failure must not crash the server
  }
  if (!Array.isArray(docs) || !docs.length) return;
  for (const doc of docs) {
    try {
      registry.register(docToConfig(doc));
    } catch {
      // Malformed doc must not break other configs.
    }
  }
};

// McpServerConfig schema:
//  - owner: ObjectId (ref User)
//  - scope: 'workspace' | 'global'
//  - workspaceId: ObjectId (ref Workspace, required when scope=workspace)
//  - name, slug
//  - transport: 'stdio' | 'streamable-http'
//  - command, args (stdio)
//  - url (streamable-http)
//  - envVarNames: [String] (names referencing process.env — NEVER secret values)
//  - auth: { type: 'none'|'header', envVar: String, headerName: String }
//  - enabled, guestAllowed
//  - timestamps

const docToConfig = (doc) => ({
  id: String(doc._id),
  name: doc.name || doc.slug || String(doc._id),
  slug: doc.slug || undefined,
  ownerUserId: doc.owner ? String(doc.owner) : null,
  scope: doc.scope || 'workspace',
  workspaceId: doc.workspace ? String(doc.workspace) : null,
  transport: doc.transport || 'stdio',
  command: doc.command || null,
  args: doc.args || [],
  url: doc.url || null,
  envVarNames: doc.envVarNames || [],
  auth: doc.auth || { type: 'none' },
  enabled: doc.enabled !== false,
  disabled: doc.enabled === false,
  guestAllowed: doc.guestAllowed === true,
  allowlistEnv: doc.allowlistEnv || null,
  allowedTools: Array.isArray(doc.allowedTools) ? doc.allowedTools.map((t) => String(t)) : [],
  deniedTools: Array.isArray(doc.deniedTools) ? doc.deniedTools.map((t) => String(t)) : [],
  tools: [] // tools populated by connection discovery
});

module.exports = { seedRegistryFromMongo, docToConfig, getModel };