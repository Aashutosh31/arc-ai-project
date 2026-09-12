'use strict';

// MCP server configuration + connection management API (Phase 2).
//
// Privileged configuration: only authenticated (non-guest) users may create,
// update, delete, connect, disconnect, or refresh. Guests may READ the subset
// of configs explicitly marked guestAllowed — and only metadata the runtime
// already exposes to them (never credentials).
//
// Secret policy: McpServerConfig documents store env-var NAMES and auth
// metadata only. Secret VALUES live in process.env server-side and are never
// persisted, logged, or returned. Every response passes through
// sanitizeConfigForClient (server/lib/mcp/configApi.js).

const express = require('express');
const mongoose = require('mongoose');
const McpServerConfig = require('../models/McpServerConfig');
const { protect } = require('../middleware/authMiddleware');
const { McpToolSource } = require('../lib/mcp');
const { docToConfig } = require('../lib/mcp/configStore');
const {
  sanitizeConfigForClient,
  validateConfigInput,
  parseNameList,
  buildToolsPayload
} = require('../lib/mcp/configApi');

const router = express.Router();

router.use(protect);

// ---- helpers ----------------------------------------------------------------

const actorId = (req) => (req.actor && req.actor.id ? String(req.actor.id) : null);
const isGuest = (req) => req.actor?.type === 'guest' || req.authType === 'guest';

const forbidGuests = (req, res) => {
  if (isGuest(req)) {
    res.status(403).json({ error: 'MCP configuration requires a signed-in account.' });
    return true;
  }
  return false;
};

const isOwner = (doc, req) => {
  const userId = actorId(req);
  return Boolean(userId && doc.owner && String(doc.owner) === userId);
};

// Visibility for READ paths. Guests see guestAllowed configs only. Owners
// see everything they own. Other authenticated users see global configs
// (workspace configs stay private to the owning workspace).
const canView = (doc, req) => {
  if (!doc) return false;
  if (isGuest(req)) return doc.guestAllowed === true;
  if (isOwner(doc, req)) return true;
  return doc.scope === 'global';
};

// Mutations + connection lifecycle require ownership (or global scope owned
// by the caller — same thing: owner check). Guests are rejected earlier.
const requireOwner = (doc, req, res) => {
  if (!isOwner(doc, req)) {
    res.status(403).json({ error: 'Not authorized to manage this MCP server.' });
    return false;
  }
  return true;
};

// A workspace-scoped server may only be assigned to a workspace the caller
// owns. Returns the workspace ObjectId string or sends an error.
const resolveWorkspaceAssignment = async (workspaceId, req, res) => {
  if (!workspaceId) return null;
  if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
    res.status(400).json({ error: 'Invalid workspace ID.' });
    return undefined;
  }
  const Workspace = require('../models/Workspace');
  const ws = await Workspace.findOne({ _id: workspaceId, owner: actorId(req) }).lean();
  if (!ws) {
    res.status(403).json({ error: 'Workspace not found or not owned by this account.' });
    return undefined;
  }
  return String(ws._id);
};

// Live (non-connecting) status snapshot. Listing/reading status must NEVER
// open a connection merely because a server is configured.
const liveStatus = (configId) => {
  try {
    const manager = McpToolSource?.manager;
    if (!manager || typeof manager.getConnection !== 'function') {
      return { connectionState: 'disconnected', protocolVersion: null, toolCount: 0 };
    }
    const conn = manager.getConnection(String(configId));
    if (!conn) return { connectionState: 'disconnected', protocolVersion: null, toolCount: 0 };
    const state = conn.connectionState || (conn.connected ? 'connected' : 'disconnected');
    return {
      connectionState: state,
      protocolVersion: conn.protocolVersion || null,
      toolCount: conn.connected && Array.isArray(conn.tools) ? conn.tools.length : 0
    };
  } catch {
    return { connectionState: 'disconnected', protocolVersion: null, toolCount: 0 };
  }
};

const withStatus = (doc) => ({ ...sanitizeConfigForClient(doc), status: liveStatus(doc._id) });

// ---- GET /api/mcp/servers ----------------------------------------------------
// List configs visible to the caller (sanitized + live status, no connects).
router.get('/servers', async (req, res) => {
  try {
    const all = await McpServerConfig.find({}).lean();
    const visible = all.filter((doc) => canView(doc, req)).map(withStatus);
    res.json({ servers: visible });
  } catch (err) {
    console.error('[MCP] list servers failed:', err);
    res.status(500).json({ error: 'Failed to fetch MCP servers.' });
  }
});

// ---- POST /api/mcp/servers ---------------------------------------------------
// Create a server config. Guests forbidden. Workspace assignment verified.
router.post('/servers', async (req, res) => {
  try {
    if (forbidGuests(req, res)) return;
    const { ok, error, data } = validateConfigInput(req.body || {}, { isUpdate: false });
    if (!ok) return res.status(400).json({ error });

    let workspace = null;
    if ((data.scope || 'workspace') === 'workspace') {
      if (!req.body.workspace) {
        return res.status(400).json({ error: 'Workspace-scoped servers require a workspace assignment.' });
      }
      workspace = await resolveWorkspaceAssignment(req.body.workspace, req, res);
      if (workspace === undefined) return;
    }

    const doc = new McpServerConfig({
      ...data,
      owner: actorId(req),
      workspace,
      envVarNames: data.envVarNames || [],
      allowlistEnv: data.allowlistEnv || [],
      allowedTools: data.allowedTools || [],
      deniedTools: data.deniedTools || []
    });
    await doc.save();
    // Publish to the live registry so the new server (and its policy) take
    // effect without a process restart. Next refreshConfigs reseeds anyway.
    try {
      McpToolSource?.registry?.register(docToConfig(doc.toObject()));
    } catch { /* best effort */ }
    res.status(201).json({ server: withStatus(doc.toObject()) });
  } catch (err) {
    console.error('[MCP] create server failed:', err);
    if (err && err.code === 11000) {
      return res.status(409).json({ error: 'A server with that name already exists in this workspace.' });
    }
    res.status(500).json({ error: 'Failed to create MCP server configuration.' });
  }
});

// ---- GET /api/mcp/servers/:id -------------------------------------------------
router.get('/servers/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid server ID.' });
    }
    const doc = await McpServerConfig.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'MCP server configuration not found.' });
    if (!canView(doc, req)) return res.status(403).json({ error: 'Not authorized to view this MCP server.' });
    res.json({ server: withStatus(doc) });
  } catch (err) {
    console.error('[MCP] get server failed:', err);
    res.status(500).json({ error: 'Failed to fetch MCP server configuration.' });
  }
});

// ---- PATCH /api/mcp/servers/:id ----------------------------------------------
// Partial update. Owner only. Transport-aware: command/url/env updates
// validate against the effective (post-update) transport.
router.patch('/servers/:id', async (req, res) => {
  try {
    if (forbidGuests(req, res)) return;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid server ID.' });
    }
    const existing = await McpServerConfig.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'MCP server configuration not found.' });
    if (!requireOwner(existing, req, res)) return;

    const body = { ...(req.body || {}) };
    body._effectiveTransport = body.transport || existing.transport;
    const { ok, error, data } = validateConfigInput(body, { isUpdate: true });
    if (!ok) return res.status(400).json({ error });

    const nextScope = data.scope || existing.scope;
    if (data.scope !== undefined || data.workspace !== undefined) {
      if (nextScope === 'workspace') {
        const wsId = data.workspace !== undefined ? data.workspace : (existing.workspace ? String(existing.workspace) : null);
        if (!wsId) return res.status(400).json({ error: 'Workspace-scoped servers require a workspace assignment.' });
        const resolved = await resolveWorkspaceAssignment(wsId, req, res);
        if (resolved === undefined) return;
        data.workspace = resolved;
      } else {
        data.workspace = null;
      }
    }
    delete data._effectiveTransport;

    Object.assign(existing, data);
    // Policy/transport/identity edits must take effect WITHOUT a server
    // restart: drop the live connection so the next request reconnects under
    // the new config. Pure metadata edits (name/description) keep it.
    const RUNTIME_KEYS = new Set([
      'transport', 'command', 'args', 'url', 'envVarNames', 'allowlistEnv',
      'allowedTools', 'deniedTools', 'auth', 'enabled', 'scope', 'workspace', 'slug'
    ]);
    const runtimeChanged = existing.modifiedPaths().some((p) => RUNTIME_KEYS.has(String(p).split('.')[0]));
    await existing.save();

    // Refresh the in-memory registry copy so policy/transport edits apply
    // without a process restart (best effort; next refreshConfigs reseeds).
    try {
      McpToolSource?.registry?.register(docToConfig(existing.toObject()));
      if (runtimeChanged) {
        await McpToolSource?.manager?.disconnect(String(existing._id));
      }
    } catch { /* best effort */ }

    res.json({ server: withStatus(existing.toObject()) });
  } catch (err) {
    console.error('[MCP] update server failed:', err);
    if (err && err.code === 11000) {
      return res.status(409).json({ error: 'A server with that name already exists in this workspace.' });
    }
    res.status(500).json({ error: 'Failed to update MCP server configuration.' });
  }
});

// ---- DELETE /api/mcp/servers/:id ----------------------------------------------
router.delete('/servers/:id', async (req, res) => {
  try {
    if (forbidGuests(req, res)) return;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid server ID.' });
    }
    const doc = await McpServerConfig.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'MCP server configuration not found.' });
    if (!requireOwner(doc, req, res)) return;

    await McpServerConfig.findByIdAndDelete(req.params.id);
    try {
      McpToolSource?.registry?.remove(String(req.params.id));
      await McpToolSource?.manager?.disconnect(String(req.params.id));
    } catch { /* best effort cleanup */ }

    res.json({ success: true });
  } catch (err) {
    console.error('[MCP] delete server failed:', err);
    res.status(500).json({ error: 'Failed to delete MCP server configuration.' });
  }
});

// ---- POST /api/mcp/servers/:id/connect -----------------------------------------
router.post('/servers/:id/connect', async (req, res) => {
  try {
    if (forbidGuests(req, res)) return;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid server ID.' });
    }
    const doc = await McpServerConfig.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'MCP server configuration not found.' });
    if (!requireOwner(doc, req, res)) return;
    if (doc.enabled === false) return res.status(400).json({ error: 'Server is disabled. Enable it before connecting.' });

    let conn;
    try {
      conn = await McpToolSource.manager.ensureConnected(docToConfig(doc));
    } catch (connectErr) {
      return res.status(502).json({
        error: 'Failed to connect to MCP server.',
        category: connectErr?.category || null,
        detail: connectErr?.message || 'connect failed'
      });
    }
    res.json({
      connected: conn.connected === true,
      connectionState: conn.connectionState || 'connected',
      protocolVersion: conn.protocolVersion || null,
      serverInfo: conn.serverInfo || null,
      toolCount: Array.isArray(conn.tools) ? conn.tools.length : 0,
      toolNames: Array.isArray(conn.tools) ? conn.tools.map((t) => t?.function?.name).filter(Boolean) : []
    });
  } catch (err) {
    console.error('[MCP] connect failed:', err);
    res.status(500).json({ error: 'Failed to connect to MCP server.' });
  }
});

// ---- POST /api/mcp/servers/:id/disconnect --------------------------------------
router.post('/servers/:id/disconnect', async (req, res) => {
  try {
    if (forbidGuests(req, res)) return;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid server ID.' });
    }
    const doc = await McpServerConfig.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'MCP server configuration not found.' });
    if (!requireOwner(doc, req, res)) return;

    await McpToolSource.manager.disconnect(String(req.params.id));
    res.json({ disconnected: true, connectionState: 'disconnected' });
  } catch (err) {
    console.error('[MCP] disconnect failed:', err);
    res.status(500).json({ error: 'Failed to disconnect from MCP server.' });
  }
});

// ---- POST /api/mcp/servers/:id/refresh ------------------------------------------
// Reconnect + rediscover. Returns the read-only discovery payload.
router.post('/servers/:id/refresh', async (req, res) => {
  try {
    if (forbidGuests(req, res)) return;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid server ID.' });
    }
    const doc = await McpServerConfig.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'MCP server configuration not found.' });
    if (!requireOwner(doc, req, res)) return;
    if (doc.enabled === false) return res.status(400).json({ error: 'Server is disabled. Enable it before refreshing.' });

    // Drop the cached connection so discovery reruns against live state.
    try { await McpToolSource.manager.disconnect(String(doc._id)); } catch { /* best effort */ }
    return refreshTools(doc, req, res);
  } catch (err) {
    console.error('[MCP] refresh failed:', err);
    res.status(500).json({ error: 'Failed to refresh MCP server tools.' });
  }
});

const refreshTools = async (doc, req, res) => {
  let conn;
  const failures = [];
  try {
    conn = await McpToolSource.manager.ensureConnected(docToConfig(doc));
  } catch (connectErr) {
    failures.push({ reason: connectErr?.message || 'connect failed', category: connectErr?.category || null });
    return res.status(502).json({
      error: 'Failed to refresh tools from MCP server.',
      ...buildToolsPayload({
        config: doc,
        connectionState: 'disconnected',
        protocolVersion: null,
        serverInfo: null,
        tools: [],
        failures,
        policy: { allowedTools: doc.allowedTools || [], deniedTools: doc.deniedTools || [] }
      })
    });
  }
  return res.json({
    refreshed: true,
    ...buildToolsPayload({
      config: doc,
      connectionState: conn.connectionState || 'connected',
      protocolVersion: conn.protocolVersion || null,
      serverInfo: conn.serverInfo || null,
      tools: toolsForClient(conn, doc),
      failures,
      policy: { allowedTools: doc.allowedTools || [], deniedTools: doc.deniedTools || [] }
    })
  });
};

// ---- GET /api/mcp/servers/:id/tools ----------------------------------------------
// Read-only discovery snapshot. Guests may call this for guestAllowed configs
// they can already see. Never connects on its own — reports live state only.
router.get('/servers/:id/tools', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid server ID.' });
    }
    const doc = await McpServerConfig.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'MCP server configuration not found.' });
    if (!canView(doc, req)) return res.status(403).json({ error: 'Not authorized to view this MCP server.' });

    const status = liveStatus(doc._id);
    let tools = [];
    let serverInfo = null;
    let protocolVersion = status.protocolVersion;
    try {
      const conn = McpToolSource?.manager?.getConnection?.(String(doc._id));
      if (conn && conn.connected) {
        serverInfo = conn.serverInfo || null;
        protocolVersion = conn.protocolVersion || null;
        tools = toolsForClient(conn, doc);
      }
    } catch { /* snapshot must never throw */ }

    res.json(buildToolsPayload({
      config: doc,
      connectionState: status.connectionState,
      protocolVersion,
      serverInfo,
      tools,
      failures: [],
      policy: { allowedTools: doc.allowedTools || [], deniedTools: doc.deniedTools || [] }
    }));
  } catch (err) {
    console.error('[MCP] tools snapshot failed:', err);
    res.status(500).json({ error: 'Failed to fetch MCP server tools.' });
  }
});

// Tools for the browser: wire name + description + policy flag. Schemas and
// executors stay server-side; the UI never calls MCP tools directly.
const toolsForClient = (conn, doc) => {
  const allowed = parseNameList(doc.allowedTools || []);
  const denied = parseNameList(doc.deniedTools || []);
  const matches = (name, patterns) => {
    const lower = String(name || '').toLowerCase();
    return patterns.some((p) => {
      const n = String(p).toLowerCase();
      return lower === n || lower.includes(n) || n.includes(lower);
    });
  };
  const out = [];
  try {
    for (const toolEntry of conn.toolEntries.values()) {
      const entry = toolEntry?.entry;
      if (!entry) continue;
      const isDenied = matches(entry.wireName, denied) || matches(entry.originalToolName, denied);
      const inAllowlist = allowed.length === 0 ||
        matches(entry.wireName, allowed) || matches(entry.originalToolName, allowed);
      out.push({
        name: entry.wireName,
        originalName: entry.originalToolName,
        description: entry.description || toolEntry?.arcSchema?.function?.description || '',
        allowed: !isDenied && inAllowlist
      });
    }
  } catch { /* snapshot must never throw */ }
  return out;
};

module.exports = router;
