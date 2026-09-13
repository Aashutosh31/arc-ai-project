'use strict';

// Connection lifecycle manager.
//
// Owns McpServerConnection instances scoped to a config (configId), tracks
// which workspace(s) may reach them, caps concurrent connections, and
// provides the tool-resolution path used by TaskExecutor's MCP fallback.
//
// The manager is transport-, registry-, and subscriber-free at construction;
// wiring happens via constructor deps so tests can inject in-memory
// substitutes (configStore, logger, registry) and run with zero network.

const { McpServerConnection } = require('./McpServerConnection');
const McpRegistry = require('./McpRegistry');
const { toMcpToolError, CATEGORIES } = require('./errors');
const { decodeWireName } = require('./names');
const limits = require('./limits');
const logger = require('./logger');

class McpManager {
  constructor({ configStore, registry, logger: loggerImpl } = {}) {
    this._configStore = configStore || new McpRegistry();
    this._registry = registry || this._configStore;
    this._logger = loggerImpl || logger;
    this._connections = new Map(); // configId → McpServerConnection (may be in any state)
    this._disconnectSignals = new Map(); // configId → AbortController for connect interception
  }

  // ---- wiring / lookup ----

  getConnection(configId) {
    return this._connections.get(configId) || null;
  }

  listConnections() {
    return [...this._connections.values()];
  }

  countConnections() { return this._connections.size; }

  // ---- connect ----

  // Returns the connection for a config, connecting-on-first-use, reusing
  // an already-connected instance. Never blocks on another workspace's
  // in-flight connect (per-config single-flight).
  async ensureConnected(config, { signal = null } = {}) {
    if (!config) throw toMcpToolError(new Error('Missing MCP server config.'), { category: CATEGORIES.PROTOCOL_ERROR });
    const configId = String(config.id);

    let conn = this._connections.get(configId);
    if (!conn) {
      conn = new McpServerConnection(config, {
        onListChanged: () => this._handleListChanged(config)
      });
      this._connections.set(configId, conn);
    }

    if (conn.connected) return conn;
    if (conn.state === 'closed') {
      // A closed connection is permanent — replace it.
      conn = new McpServerConnection(config, {
        onListChanged: () => this._handleListChanged(config)
      });
      this._connections.set(configId, conn);
    }

    if (this.countConnections() >= limits.MAX_CONNECTED_SERVERS_PER_WORKSPACE) {
      throw toMcpToolError(new Error('MCP server cap reached for this workspace.'), {
        category: CATEGORIES.PROTOCOL_ERROR,
        serverId: configId
      });
    }

    await conn.connect({ signal });
    // Publish the freshly discovered tool set to the registry so wire-name
    // resolution works for this connection immediately.
    this._syncRegistryTools(config);
    return conn;
  }

  // ---- tool resolution (TaskExecutor fallback entry point) ----

  // Resolves a wire tool name used by the model back to an executable
  // ({ schema, execute }) OR null when it is a native tool or unknown.
  async resolveTool(wireName, { workspaceId = null, isGuest = false, signal = null } = {}) {
    let entry = this._registry.toolByWireName(wireName);
    if (!entry) {
      // Fallback: the registry may lag a live connection (late connect or
      // list_changed race). Scan open connections directly.
      for (const conn of this._connections.values()) {
        for (const te of conn.toolEntries.values()) {
          if (te.entry.wireName === wireName) { entry = te.entry; break; }
        }
        if (entry) break;
      }
    }
    if (!entry) {
      // No prior discovery in this process: decode the wire name and connect
      // the owning config on demand so the tool resolves like a native one.
      const decoded = decodeWireName(wireName);
      if (decoded && decoded.slug) {
        try {
          const cfg = this._registry.configForSlug(decoded.slug);
          if (cfg && cfg.enabled !== false && this._configVisibleTo(cfg, { workspaceId, isGuest })) {
            await this.ensureConnected(cfg, { signal });
          }
        } catch {
          // Discovery failed — leave entry null; the caller degrades gracefully.
        }
      }
      entry = this._registry.toolByWireName(wireName);
    }
    if (!entry) return null; // native tool or unknown — leave to native registry

    const config = this._registry.get(entry.configId);
    if (!config) return null;
    if (config.disabled) return null;


    // Authorization gate: workspace + guest visibility + tool allow/deny policy.
    if (!this._configVisibleTo(config, { workspaceId, isGuest })) {
      this._logger.log(logger.LOG_EVENTS.TOOL_DENIED, {
        configId: config.id, slug: config.slug, wireName,
        workspaceId, reason: 'not_authorized'
      });
      const err = toMcpToolError(new Error(`MCP tool ${wireName} is not available in this workspace.`), {
        category: CATEGORIES.NOT_AUTHORIZED,
        serverId: config.id,
        toolName: effectiveWireName
      });
      return { schema: null, execute: async () => ({ success: false, error: err.message, errorType: err.category, tool: wireName }) };
    }

    // Allow/deny policy check
    const allowTools = config.allowedTools;
    const denyTools = config.deniedTools;
    const effectiveWireName = entry.wireName;
    const origToolName = entry.originalToolName;

    // denied always wins
    if (denyTools && Array.isArray(denyTools)) {
      for (const pattern of denyTools) {
        const normalized = String(pattern).toLowerCase().trim();
        if (normalized === '') continue;
        if (effectiveWireName.toLowerCase().includes(normalized) ||
            normalized.includes(effectiveWireName.toLowerCase()) ||
            (origToolName && origToolName.toLowerCase().includes(normalized))) {
          this._logger.log(logger.LOG_EVENTS.TOOL_DENIED, {
            configId: config.id, slug: config.slug, wireName: effectiveWireName,
            workspaceId, reason: 'denied_by_policy'
          });
          const err = toMcpToolError(new Error(`MCP tool ${wireName} is denied by policy.`), {
            category: CATEGORIES.NOT_AUTHORIZED,
            serverId: config.id,
            toolName: effectiveWireName
          });
return { schema: null, execute: async () => ({ success: false, error: err.message, errorType: err.category, tool: effectiveWireName }) };
        }
      }
    }

    // allowed list: non-empty only. Absent or empty = all allowed.
    if (allowTools && Array.isArray(allowTools) && allowTools.length > 0) {
      const allowedSet = new Set(allowTools.map(t => String(t).toLowerCase().trim()));
      const effectiveWireLower = effectiveWireName.toLowerCase();
      const origLower = origToolName ? origToolName.toLowerCase() : '';
      let matches = false;
      for (const allowed of allowedSet) {
        if (allowed === '') continue;
        if (effectiveWireLower === allowed || effectiveWireLower.includes(allowed) || allowed.includes(effectiveWireLower)) {
          matches = true;
          break;
        }
        if (origLower === allowed || origLower.includes(allowed) || allowed.includes(origLower)) {
          matches = true;
          break;
        }
      }
      if (!matches) {
        this._logger.log(logger.LOG_EVENTS.TOOL_DENIED, {
          configId: config.id, slug: config.slug, wireName: effectiveWireName,
          workspaceId, reason: 'not_allowed_by_policy'
        });
        const err = toMcpToolError(new Error(`MCP tool ${effectiveWireName} is not in the allowed list.`), {
          category: CATEGORIES.NOT_AUTHORIZED,
          serverId: config.id,
          toolName: effectiveWireName
        });
        return { schema: null, execute: async () => ({ success: false, error: err.message, errorType: err.category, tool: wireName }) };
      }
    }

    const conn = await this.ensureConnected(config, { signal });
    const toolEntry = conn.getToolEntry(entry.originalToolName);
    if (!toolEntry) return null;

    return {
      schema: toolEntry.arcSchema,
      execute: async (args, context, socket) => {
        const start = Date.now();
        this._logger.log(logger.LOG_EVENTS.TOOL_STARTED, {
          configId: config.id, slug: config.slug, wireName, workspaceId: context?.workspaceId || workspaceId
        });
        const result = await this._execute(conn, toolEntry, args, context, socket, { start });
        return result;
      }
    };
  }

  async _execute(conn, toolEntry, args, context, socket, { start }) {
    const { wireName, configId } = toolEntry.entry;
    try {
      const result = await toolEntry.execute(args, context, socket);
      const durationMs = Date.now() - start;
      if (result && result.success === false && result.errorType === 'mcp.cancelled') {
        this._logger.log(logger.LOG_EVENTS.TOOL_CANCELLED, { configId, wireName, durationMs });
        return result;
      }
      if (result && result.success === false) {
        this._logger.log(logger.LOG_EVENTS.TOOL_FAILED, {
          configId, wireName, durationMs,
          category: result.errorType,
          retryable: result.retryable
        });
        return result;
      }
      this._logger.log(logger.LOG_EVENTS.TOOL_COMPLETED, {
        configId,
        wireName,
        durationMs,
        resultSize: result && typeof result === 'object' ? result.resultSize : undefined,
        truncated: result && typeof result === 'object' ? result.truncated : undefined
      });
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      const wrapped = err?.category ? err : toMcpToolError(err, { serverId: configId, toolName: effectiveWireName });
      this._logger.log(logger.LOG_EVENTS.TOOL_FAILED, { configId, wireName, durationMs, category: wrapped.category });
      return {
        success: false,
        error: wrapped.message,
        errorType: wrapped.category,
        retryable: wrapped.retryable,
        cancelled: wrapped.category === CATEGORIES.CANCELLED,
        tool: wireName,
        durationMs
      };
    }
  }

  // ---- list_changed ----

  // Refresh discovered tools for this config and reflect the change in the
  // registry (for tool-selection / budget on the next turn). If the config
  // vanished from the registry meanwhile, drop the connection.
  async _handleListChanged(config) {
    const configId = String(config.id);
    const current = this._registry.get(configId);
    if (!current) {
      await this.disconnect(configId);
      return;
    }
    // Sync registry's tool table with what the live connection now exposes.
    this._syncRegistryTools(current);
  }

  _syncRegistryTools(config) {
    const conn = this._connections.get(String(config.id));
    if (!conn) return;
    const entries = [];
    const takenCanonical = new Set();
    const takenWire = new Set();
    for (const toolEntry of conn.toolEntries.values()) {
      const e = toolEntry.entry;
      const wireCandidate = e.wireName;
      const canonicalCandidate = e.canonicalName;
      const wireFinal = this._unique(e.wireName, takenWire);
      const canonicalFinal = this._unique(e.canonicalName, takenCanonical);
      takenWire.add(wireFinal);
      takenCanonical.add(canonicalFinal);
      entries.push({ ...e, wireName: wireFinal, canonicalName: canonicalFinal });
    }
    this._registry.register({
      ...currentConfigToPlain(config),
      tools: entries.map((e) => ({
        name: e.originalToolName,
        description: e.description,
        inputSchema: e.inputSchema,
        wireName: e.wireName,
        canonicalName: e.canonicalName
      }))
    });
  }

  _unique(name, set) {
    if (!set.has(name)) return name;
    let n = 2;
    while (set.has(`${name}_${n}`)) n += 1;
    const out = `${name}_${n}`;
    return out;
  }

  // ---- teardown ----

  // Close a single connection. Idempotent.
  async disconnect(configId) {
    const key = String(configId);
    const conn = this._connections.get(key);
    if (!conn) return;
    this._connections.delete(key);
    try { await conn.disconnect(); } catch { /* best effort */ }
  }

  // Close everything. Idempotent; safe to call on shutdown.
  async shutdown() {
    const conns = [...this._connections.values()];
    this._connections.clear();
    await Promise.allSettled(conns.map((c) => c.disconnect()));
  }

  // ---- config visibility (guards) ----

  _configVisibleTo(config, { workspaceId = null, isGuest = false } = {}) {
    if (config.disabled) return false;
    // Guest access is opt-in; authenticated users are never blocked by it.
    if (isGuest && !config.guestAllowed) return false;
    if (config.scope === 'global') {
      return true;
    }
    if (config.scope === 'workspace') {
      return String(config.workspaceId) === String(workspaceId);
    }
    return false;
  }
}

// Registry configs are frozen values; hand the re-register a plain copy.
const currentConfigToPlain = (config) => ({
  id: config.id,
  name: config.name,
  slug: config.slug,
  ownerUserId: config.ownerUserId,
  scope: config.scope,
  workspaceId: config.workspaceId,
  transport: config.transport,
  command: config.command,
  args: config.args,
  url: config.url,
  envVarNames: config.envVarNames,
  enabled: config.enabled,
  disabled: config.disabled,
  guestAllowed: config.guestAllowed,
  allowlistEnv: config.allowlistEnv || null,
  // SECURITY: tool policy must survive discovery re-registration. Omitting
  // these fields here used to wipe allowed/denied lists from the in-memory
  // registry on every connect, silently re-exposing blocked tools to the
  // model and the execution path.
  allowedTools: Array.isArray(config.allowedTools) ? [...config.allowedTools] : [],
  deniedTools: Array.isArray(config.deniedTools) ? [...config.deniedTools] : [],
  auth: config.auth,
  testHooks: config.testHooks || null
});

module.exports = { McpManager };