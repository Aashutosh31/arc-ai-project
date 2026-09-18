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
const oauthTx = require('../lib/mcp/oauthTransactions');
const oauthProvider = require('../lib/mcp/oauthProvider');
const secureTokens = require('../lib/mcp/secureTokens');
const mcpLogger = require('../lib/mcp/logger');

const router = express.Router();

// ---- public OAuth callback (transaction-bound, NOT session-bound) -------------
// Mounted BEFORE `protect`: the authorization server redirects the browser
// here without an ARC session cookie/header. Authorization comes from the
// single-use transaction id embedded in `state`, never from callback params.
router.get('/oauth/callback', handleOAuthCallback);

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
      return { connectionState: 'disconnected', protocolVersion: null, toolCount: 0, discoveryStatus: 'idle' };
    }
    const conn = manager.getConnection(String(configId));
    if (!conn) return { connectionState: 'disconnected', protocolVersion: null, toolCount: 0, discoveryStatus: 'idle' };
    const state = conn.connectionState || (conn.connected ? 'connected' : 'disconnected');
    return {
      connectionState: state,
      protocolVersion: conn.protocolVersion || null,
      toolCount: conn.connected && Array.isArray(conn.tools) ? conn.tools.length : 0,
      // Discovery is independent of transport: CONNECTED with failed
      // discovery is not a ready integration (see McpServerConnection).
      discoveryStatus: conn.discoveryStatus || 'unknown'
    };
  } catch {
    return { connectionState: 'disconnected', protocolVersion: null, toolCount: 0, discoveryStatus: 'unknown' };
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
      conn = await McpToolSource.manager.ensureConnected(docToConfig(doc), {
        authProvider: silentOAuthProvider(doc, req)
      });
    } catch (connectErr) {
      if (connectErr && connectErr.authRequired) {
        return res.status(401).json({
          error: 'Authorization required — reconnect',
          authRequired: true,
          category: 'mcp.auth_required',
          detail: null
        });
      }
      return res.status(502).json({
        error: 'Failed to connect to MCP server.',
        category: connectErr?.category || null,
        detail: connectErr?.message || 'connect failed'
      });
    }
    // Genuine authentication failure during discovery (e.g. tools/list 401):
    // surface the Authorize path, not a silent CONNECTED + 0 tools. Transport
    // quirks and upstream failures keep discoveryAuthRequired false and fall
    // through to the normal payload with discoveryStatus failed.
    if (conn && conn.discoveryAuthRequired) {
      return res.status(401).json({
        error: 'Authorization required — reconnect',
        authRequired: true,
        category: 'mcp.auth_required',
        detail: null
      });
    }
    res.json({
      connected: conn.connected === true,
      connectionState: conn.connectionState || 'connected',
      protocolVersion: conn.protocolVersion || null,
      serverInfo: conn.serverInfo || null,
      toolCount: Array.isArray(conn.tools) ? conn.tools.length : 0,
      toolNames: Array.isArray(conn.tools) ? conn.tools.map((t) => t?.function?.name).filter(Boolean) : [],
      discoveryStatus: conn.discoveryStatus || 'unknown'
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
    conn = await connectForRefresh(doc, req);
  } catch (connectErr) {
    // Mirror /connect: dead/stale OAuth tokens are an AUTHORIZE signal
    // (401 + authRequired), not a generic 502 — otherwise the UI shows a
    // dead-end toast with no recovery path.
    if (connectErr && connectErr.authRequired) {
      return res.status(401).json({
        error: 'Authorization required — reconnect',
        authRequired: true,
        category: 'mcp.auth_required',
        detail: null
      });
    }
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
  // Genuine discovery-time authentication failure (tools/list 401 on an
  // OAuth server): Authorize path, not a silent CONNECTED + 0 tools.
  if (conn && conn.discoveryAuthRequired) {
    return res.status(401).json({
      error: 'Authorization required — reconnect',
      authRequired: true,
      category: 'mcp.auth_required',
      detail: null
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
      policy: { allowedTools: doc.allowedTools || [], deniedTools: doc.deniedTools || [] },
      discoveryStatus: conn.discoveryStatus || 'unknown',
      discoveryAuthRequired: conn.discoveryAuthRequired === true
    })
  });
};

// Refresh-path connect (single place: router + tests). MUST carry the
// silent OAuth provider like /connect and the OAuth callback do —
// ensureConnected without one sends no bearer material at all, so every
// refresh of an OAuth streamable-http server deterministically 401s right
// after refresh's own disconnect() drops the working connection. Returns
// null provider for non-OAuth configs (static path untouched).
const connectForRefresh = (doc, req) =>
  McpToolSource.manager.ensureConnected(docToConfig(doc), {
    authProvider: silentOAuthProvider(doc, req)
  });

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
      policy: { allowedTools: doc.allowedTools || [], deniedTools: doc.deniedTools || [] },
      discoveryStatus: status.discoveryStatus || 'unknown'
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

// ---- OAuth (Phase 3) ----------------------------------------------------------
// Generic authorization-code + PKCE flow for OAuth-protected remote MCP
// servers, driven by the official SDK (`auth()`, discovery, DCR/CIMD).
//
// Endpoints:
//  POST /servers/:id/oauth/start    (owner, non-guest) → { authorizationUrl }
//  GET  /oauth/callback              (public, transaction-bound) → browser redirect
//  GET  /servers/:id/oauth/status   (viewer; owner-only details)
//  POST /servers/:id/oauth/forget   (owner, non-guest) → deletes credentials
//
// Tokens, verifiers, codes, and client secrets never appear in responses,
// logs, or browser state.

// Silent provider for normal connects: stored tokens + SDK refresh, fail
// closed when interactive authorization is required. Null for non-OAuth
// configs (static auth path untouched).
const silentOAuthProvider = (doc, req) => {
  try {
    if (!doc || !doc.auth || doc.auth.type !== 'oauth') return null;
    if (doc.transport !== 'streamable-http' || !doc.url) return null;
    if (!secureTokens.isEncryptionAvailable()) return null;
    const userId = actorId(req) || (doc.owner ? String(doc.owner) : null);
    if (!userId) return null;
    return oauthProvider.createSilentProvider({ userId, config: docToConfig(doc) });
  } catch {
    return null;
  }
};

const requireOAuthConfig = (doc, res) => {
  if (!doc) {
    res.status(404).json({ error: 'MCP server configuration not found.' });
    return false;
  }
  if (!doc.auth || doc.auth.type !== 'oauth') {
    res.status(400).json({ error: 'This MCP server is not configured for OAuth.' });
    return false;
  }
  if (doc.transport !== 'streamable-http' || !doc.url) {
    res.status(400).json({ error: 'OAuth requires a streamable-http server with an endpoint URL.' });
    return false;
  }
  return true;
};

// ---- POST /api/mcp/servers/:id/oauth/start -----------------------------------
// Begins (or resumes, via stored refresh) authorization. Creates a short-lived
// single-use transaction bound to the caller, then runs the SDK discovery +
// first-leg flow. Responds with the browser authorization URL, or with
// { authorized: true } when stored tokens are still valid.
router.post('/servers/:id/oauth/start', async (req, res) => {
  try {
    if (forbidGuests(req, res)) return;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid server ID.' });
    }
    const doc = await McpServerConfig.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'MCP server configuration not found.' });
    if (!requireOwner(doc, req, res)) return;
    if (!requireOAuthConfig(doc, res)) return;
    if (doc.enabled === false) return res.status(400).json({ error: 'Server is disabled. Enable it before authorizing.' });
    if (!secureTokens.isEncryptionAvailable()) {
      return res.status(500).json({ error: 'OAuth credential storage is not configured on this server.' });
    }

    const config = docToConfig(doc);
    const userId = actorId(req);
    const tx = oauthTx.createTransaction({
      userId,
      configId: String(doc._id),
      workspaceId: doc.workspace ? String(doc.workspace) : null,
      scope: doc.oauthScope || null
    });

    let authorizationUrl = null;
    const provider = oauthProvider.createInteractiveProvider({
      userId,
      config,
      transaction: tx,
      onRedirect: async (url) => { authorizationUrl = url; }
    });

    try {
      const { auth: sdkAuth } = require('@modelcontextprotocol/client');
      const result = await sdkAuth(provider, {
        serverUrl: config.url,
        ...(config.oauthScope ? { scope: config.oauthScope } : {})
      });
      if (result === 'AUTHORIZED') {
        // Stored tokens (possibly refreshed) are valid — no browser needed.
        oauthTx.deleteTransaction(tx.txId);
        let conn = null;
        try {
          conn = await McpToolSource.manager.ensureConnected(config, {
            authProvider: silentOAuthProvider(doc, req)
          });
        } catch (connectErr) {
          if (connectErr && connectErr.authRequired) {
            return res.status(401).json({ error: 'Authorization required — reconnect', authRequired: true });
          }
          throw connectErr;
        }
        mcpLogger.log(mcpLogger.LOG_EVENTS.OAUTH_AUTHORIZED, { configId: String(doc._id) });
        return res.json({
          authorized: true,
          connected: conn ? conn.connected === true : false,
          toolCount: conn && Array.isArray(conn.tools) ? conn.tools.length : 0
        });
      }
      if (!authorizationUrl) {
        oauthTx.deleteTransaction(tx.txId);
        return res.status(502).json({ error: 'Authorization server did not return an authorization URL.' });
      }
      mcpLogger.log(mcpLogger.LOG_EVENTS.OAUTH_STARTED, { configId: String(doc._id) });
      return res.json({
        authorized: false,
        authRequired: true,
        authorizationUrl,
        transactionId: tx.txId,
        expiresAt: tx.expiresAt
      });
    } catch (flowErr) {
      oauthTx.deleteTransaction(tx.txId);
      mcpLogger.log(mcpLogger.LOG_EVENTS.OAUTH_FAILED, { configId: String(doc._id), reason: 'start_failed' });
      // Pre-registered material problems fail clearly (messages are safe by
      // construction — they never embed identifiers or secrets).
      if (flowErr && flowErr.name === 'OAuthRegistrationError') {
        return res.status(502).json({
          error: flowErr.message || 'OAuth client registration is not available for this server.',
          category: 'mcp.registration_unavailable',
          detail: null
        });
      }
      // Generic registration-availability failure: the SDK throws its
      // incompatible-auth-server error when neither CIMD nor DCR is usable.
      // Re-resolve against the AS metadata captured in the transaction so the
      // user gets a configuration error instead of a mystery 502. Generic —
      // no vendor names or URL checks.
      try {
        const asMetadata = tx.discoveryState?.authorizationServerMetadata || null;
        if (asMetadata && /dynamic client registration|incompatible auth server/i.test(flowErr?.message || '')) {
          const mode = oauthProvider.resolveRegistrationMode({
            strategy: config.registrationStrategy || null,
            asMetadata,
            clientMetadataUrl: provider.clientMetadataUrl,
            hasPreRegistered: oauthProvider.hasPreRegisteredCredentials(config)
          });
          if (!mode) {
            return res.status(502).json({
              error: oauthProvider.registrationUnavailableReason({
                strategy: config.registrationStrategy || null,
                hasPreRegistered: oauthProvider.hasPreRegisteredCredentials(config)
              }),
              category: 'mcp.registration_unavailable',
              detail: null
            });
          }
        }
      } catch { /* fall through to the generic failure below */ }
      return res.status(502).json({
        error: 'Failed to start OAuth authorization.',
        category: flowErr?.category || flowErr?.code || null,
        detail: null
      });
    }
  } catch (err) {
    console.error('[MCP] oauth start failed:', err);
    res.status(500).json({ error: 'Failed to start OAuth authorization.' });
  }
});

// ---- GET /api/mcp/servers/:id/oauth/status ------------------------------------
// Safe metadata only: authorization state, issuers, scopes, expiry flags.
// Owner sees their own status; anyone else (including guests on guestAllowed
// configs) sees { authorized: false } so one user can never inspect or reuse
// another user's authorization.
router.get('/servers/:id/oauth/status', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid server ID.' });
    }
    const doc = await McpServerConfig.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'MCP server configuration not found.' });
    if (!canView(doc, req)) return res.status(403).json({ error: 'Not authorized to view this MCP server.' });
    if (!doc.auth || doc.auth.type !== 'oauth') {
      return res.json({ oauth: false, authType: doc?.auth?.type || 'none' });
    }
    if (!isOwner(doc, req)) {
      return res.json({ oauth: true, authorized: false, reason: 'not_owner' });
    }
    const status = await oauthProvider.credentialStatus(actorId(req), String(doc._id));
    const live = liveStatus(doc._id);
    res.json({ oauth: true, ...status, connectionState: live.connectionState, toolCount: live.toolCount });
  } catch (err) {
    console.error('[MCP] oauth status failed:', err);
    res.status(500).json({ error: 'Failed to fetch OAuth status.' });
  }
});

// ---- POST /api/mcp/servers/:id/oauth/forget ------------------------------------
// Explicit "Forget authorization": removes stored credentials for the caller
// (optionally per-issuer) and drops the live connection. Disconnect alone
// does NOT delete credentials.
router.post('/servers/:id/oauth/forget', async (req, res) => {
  try {
    if (forbidGuests(req, res)) return;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid server ID.' });
    }
    const doc = await McpServerConfig.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'MCP server configuration not found.' });
    if (!requireOwner(doc, req, res)) return;
    const issuer = typeof req.body?.issuer === 'string' && req.body.issuer ? req.body.issuer : null;
    let removed = 0;
    try {
      removed = await oauthProvider.deleteCredentials(actorId(req), String(doc._id), issuer);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to remove stored OAuth credentials.' });
    }
    try { await McpToolSource.manager.disconnect(String(doc._id)); } catch { /* best effort */ }
    mcpLogger.log(mcpLogger.LOG_EVENTS.OAUTH_TOKENS_FORGOTTEN, { configId: String(doc._id) });
    res.json({ forgotten: true, removed });
  } catch (err) {
    console.error('[MCP] oauth forget failed:', err);
    res.status(500).json({ error: 'Failed to remove stored OAuth credentials.' });
  }
});

// ---- GET /api/mcp/oauth/callback (public, transaction-bound) -------------------
async function handleOAuthCallback(req, res) {
  const frontendBase = oauthProvider.publicFrontendBase();
  const failRedirect = (serverId, reason) => {
    const params = new URLSearchParams({ mcp_oauth: 'error', reason });
    if (serverId) params.set('server', String(serverId));
    return res.redirect(302, `${frontendBase}/dashboard?${params.toString()}`);
  };
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    const iss = typeof req.query.iss === 'string' ? req.query.iss : null;
    const providerError = typeof req.query.error === 'string' ? req.query.error : null;

    // Resolve the transaction WITHOUT trusting callback params for identity.
    const txId = oauthTx.txIdFromState(state);
    const tx = txId ? oauthTx.getTransaction(txId) : null;
    if (!tx) {
      return failRedirect(null, 'invalid_or_expired_transaction');
    }
    // Constant-time state comparison (CSRF protection).
    if (!oauthTx.statesEqual(state, tx.state)) {
      oauthTx.deleteTransaction(tx.txId);
      return failRedirect(tx.configId, 'invalid_state');
    }
    if (providerError) {
      oauthTx.deleteTransaction(tx.txId);
      return failRedirect(tx.configId, 'provider_error');
    }
    if (!code) {
      oauthTx.deleteTransaction(tx.txId);
      return failRedirect(tx.configId, 'missing_code');
    }
    // RFC 9207 issuer check BEFORE redeeming the code.
    if (!oauthTx.issuerMatches(tx, iss)) {
      oauthTx.deleteTransaction(tx.txId);
      mcpLogger.log(mcpLogger.LOG_EVENTS.OAUTH_FAILED, { configId: tx.configId, reason: 'issuer_mismatch' });
      return failRedirect(tx.configId, 'issuer_mismatch');
    }

    const doc = await McpServerConfig.findById(tx.configId).lean();
    if (!doc || doc.enabled === false) {
      oauthTx.deleteTransaction(tx.txId);
      return failRedirect(tx.configId, 'server_unavailable');
    }
    // The transaction owner must still own the config (prevents cross-user
    // completion if ownership changed mid-flow).
    if (!doc.owner || String(doc.owner) !== String(tx.userId)) {
      oauthTx.deleteTransaction(tx.txId);
      return failRedirect(tx.configId, 'not_owner');
    }
    if (!doc.auth || doc.auth.type !== 'oauth' || doc.transport !== 'streamable-http' || !doc.url) {
      oauthTx.deleteTransaction(tx.txId);
      return failRedirect(tx.configId, 'not_oauth');
    }

    // Single-use: consume BEFORE the exchange (codes are single-use anyway).
    const consumed = oauthTx.consumeTransaction(tx.txId);
    if (!consumed) {
      return failRedirect(tx.configId, 'invalid_or_expired_transaction');
    }

    const config = docToConfig(doc);
    const provider = oauthProvider.createInteractiveProvider({
      userId: tx.userId,
      config,
      transaction: consumed,
      onRedirect: null
    });

    try {
      const { auth: sdkAuth } = require('@modelcontextprotocol/client');
      const result = await sdkAuth(provider, {
        serverUrl: config.url,
        authorizationCode: code,
        ...(iss ? { iss } : {}),
        ...(config.oauthScope ? { scope: config.oauthScope } : {})
      });
      if (result !== 'AUTHORIZED') {
        mcpLogger.log(mcpLogger.LOG_EVENTS.OAUTH_FAILED, { configId: tx.configId, reason: 'not_authorized' });
        return failRedirect(tx.configId, 'exchange_failed');
      }
    } catch (exchangeErr) {
      // SDK throws AuthorizationServerMismatchError on AS mix-up; every
      // other failure is a failed exchange. Never render raw error text.
      const reason = exchangeErr && exchangeErr.name === 'AuthorizationServerMismatchError'
        ? 'issuer_mismatch'
        : 'exchange_failed';
      mcpLogger.log(mcpLogger.LOG_EVENTS.OAUTH_FAILED, { configId: tx.configId, reason });
      return failRedirect(tx.configId, reason);
    }

    // Reconnect with the silent provider (stored tokens) + discover tools.
    // Authorization and discovery are independent outcomes: the credential
    // may be valid while discovery fails (transport quirk, upstream
    // failure). The dashboard banner distinguishes the two — retry (Refresh)
    // reuses the stored credential and never relaunches browser OAuth.
    let toolCount = 0;
    let discoveryFailed = false;
    try {
      try { await McpToolSource.manager.disconnect(String(doc._id)); } catch { /* best effort */ }
      const conn = await McpToolSource.manager.ensureConnected(config, {
        authProvider: oauthProvider.createSilentProvider({ userId: tx.userId, config })
      });
      toolCount = Array.isArray(conn.tools) ? conn.tools.length : 0;
      discoveryFailed = (conn.discoveryStatus || 'ok') === 'failed';
    } catch (connectErr) {
      mcpLogger.log(mcpLogger.LOG_EVENTS.OAUTH_FAILED, { configId: tx.configId, reason: 'reconnect_failed' });
      return failRedirect(tx.configId, 'reconnect_failed');
    }

    mcpLogger.log(mcpLogger.LOG_EVENTS.OAUTH_AUTHORIZED, { configId: tx.configId });
    const params = new URLSearchParams({
      mcp_oauth: 'success',
      server: String(doc._id),
      tools: String(toolCount)
    });
    if (discoveryFailed) params.set('discovery', 'failed');
    return res.redirect(302, `${frontendBase}/dashboard?${params.toString()}`);
  } catch (err) {
    console.error('[MCP] oauth callback failed:', err);
    try {
      const frontendBase2 = oauthProvider.publicFrontendBase();
      return res.redirect(302, `${frontendBase2}/dashboard?mcp_oauth=error&reason=callback_failed`);
    } catch {
      return res.status(500).json({ error: 'OAuth callback failed.' });
    }
  }
}

module.exports = router;
// Exported for the refresh regression test (route needs Mongo; the helper
// does not). Not part of the HTTP surface.
module.exports.connectForRefresh = connectForRefresh;
