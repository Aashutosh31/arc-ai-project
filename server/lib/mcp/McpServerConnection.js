'use strict';

// One ARC↔MCP-server connection.
//
// Responsibilities:
//  - wrap `@modelcontextprotocol/client` Client
//  - negotiate protocol version (mode: 'auto' — try 2026-07-28 first, fall back)
//  - discover server capabilities + tool list
//  - callTool
//  - register list-changed handler
//  - abort in-flight calls when caller provides an AbortSignal
//  - clean teardown (close + transport cleanup)
//
// State machine: DISCONNECTED → CONNECTING → CONNECTED → CLOSED
// Every public method validates the caller is in the right state.
//
// Secrets never reach this class: auth tokens are resolved by the transport
// factory at construction time and passed via requestInit headers or child-
// process env (references only, never logged).

const { Client } = require('@modelcontextprotocol/client');
const { createStdioTransport, createStreamableHTTPTransport } = require('./transports');
const { toMcpToolError, CATEGORIES } = require('./errors');
const limits = require('./limits');
const logger = require('./logger');
const adapter = require('./McpToolAdapter');
const { fitWireName, canonicalName, wireName, sanitizeToolSegment, uniqueName } = require('./names');

const STATES = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  CLOSED: 'closed'
});

class McpServerConnection {
  constructor(config, { onListChanged } = {}) {
    this.config = config;
    this.state = STATES.DISCONNECTED;
    this._client = null;
    this._transport = null;
    this._serverInfo = null;
    this._capabilities = null;
    this._instructions = null;
    this._tools = [];
    this._toolEntries = new Map();   // originalName → { wireName, canonicalName, arcSchema, configId, entry: { ... } }
    this._wireTaken = new Set();
    this._canonicalTaken = new Set();
    this._connectingPromise = null;
    this._onListChanged = typeof onListChanged === 'function' ? onListChanged : null;
    this._connectStartAt = 0;
    // Discovery state (independent of transport state — see below).
    this._discoveryStatus = 'pending'; // pending | ok | failed | idle
    this._lastDiscoveryError = null;   // truncated safe message, never bodies
    this._discoveryAuthRequired = false;
  }

  // --- public API ------------------------------------------------------------

  async connect({ signal = null, timeoutMs = limits.CONNECT_TIMEOUT_MS, authProvider = null } = {}) {
    if (this.state === STATES.CONNECTED) return this;
    if (this.state === STATES.CLOSED) throw toMcpToolError(new Error('Connection is permanently closed.'), { category: CATEGORIES.NOT_CONNECTED });

    if (this._connectingPromise) return this._connectingPromise;

    this._connectingPromise = this._doConnect({ signal, timeoutMs, authProvider });
    try {
      await this._connectingPromise;
      return this;
    } catch (err) {
      // Allow retrying on failure.
      if (this.state !== STATES.CLOSED) {
        this.state = STATES.DISCONNECTED;
        this._cleanupClient();
      }
      throw err;
    } finally {
      this._connectingPromise = null;
    }
  }

  async disconnect() {
    this.state = STATES.CLOSED;
    this._cleanupClient();
    logger.log(logger.LOG_EVENTS.CONNECTION_CLOSED, { configId: this.config.id, slug: this.config.slug });
  }

  get connected() { return this.state === STATES.CONNECTED; }
  get connectionState() { return this.state; }
  get protocolVersion() {
    try {
      return this._client?.getNegotiatedProtocolVersion?.() || null;
    } catch {
      return null;
    }
  }
  get serverInfo() { return this._serverInfo; }
  get capabilities() { return this._capabilities; }
  get tools() { return this._tools; }
  get toolEntries() { return this._toolEntries; }
  // Discovery state: transport CONNECTED does not imply usable tools.
  // 'pending' (never attempted) | 'ok' | 'failed' | 'idle' (torn down).
  get discoveryStatus() { return this._discoveryStatus; }
  // Truncated failure message for operator diagnostics (no bodies/tokens).
  get lastDiscoveryError() { return this._lastDiscoveryError; }
  // True when discovery itself failed with an auth-flavored error (401 /
  // UnauthorizedError / OAuth). Only genuine authentication failures set
  // this — transport quirks and upstream failures leave it false so retry
  // never triggers a spurious authorize-again loop.
  get discoveryAuthRequired() { return this._discoveryAuthRequired === true; }
  get wireTaken() { return this._wireTaken; }
  get canonicalTaken() { return this._canonicalTaken; }

  getToolEntry(originalName) { return this._toolEntries.get(originalName) || null; }

  // Low-level call returning the SDK's RAW result; the tool adapter owns ARC
  // result conversion (normalize + limit), so it always sees the raw shape.
  async callTool(originalToolName, args, { signal = null, timeoutMs = limits.REQUEST_TIMEOUT_MS } = {}) {
    if (!this.connected) throw toMcpToolError(new Error(`MCP server not connected: ${this.config.name}`), { category: CATEGORIES.NOT_CONNECTED });
    const requestOptions = { timeout: timeoutMs };
    if (signal) requestOptions.signal = signal;
    try {
      const result = await this._client.callTool({ name: originalToolName, arguments: args || {} }, requestOptions);
      return result;
    } catch (raw) {
      const err = raw instanceof Error ? raw : new Error(String(raw));
      const isCancelled = signal?.aborted === true || err.name === 'AbortError';
      const category = isCancelled ? CATEGORIES.CANCELLED : undefined;
      throw toMcpToolError(err, {
        category,
        serverId: this.config.id,
        toolName: originalToolName,
        retryable: isCancelled ? false : (category === CATEGORIES.CANCELLED ? false : undefined),
        isCancelled
      });
    }
  }

  // --- internals -------------------------------------------------------------

  async _doConnect({ signal, timeoutMs, authProvider }) {
    this.state = STATES.CONNECTING;
    this._connectStartAt = Date.now();
    logger.log(logger.LOG_EVENTS.CONNECTION_STARTED, {
      configId: this.config.id,
      serverName: this.config.name,
      transport: this.config.transport,
      slug: this.config.slug
    });

    try {
      const opts = { versionNegotiation: { mode: 'auto' } };
      this._client = new Client({ name: `arc-mcp-client`, version: '1.0.0' }, opts);
      this._transport = createTransportForConfig(this.config, { authProvider });

      // Allow the ARC abort signal to cancel the connect handshake.
      await this._client.connect(this._transport, { timeout: timeoutMs, signal });

      this._serverInfo = this._client.getServerVersion() || null;
      this._capabilities = this._client.getServerCapabilities() || {};
      this._instructions = this._client.getInstructions() || null;
      this.state = STATES.CONNECTED;

      logger.log(logger.LOG_EVENTS.CONNECTION_READY, {
        configId: this.config.id,
        slug: this.config.slug,
        protocolVersion: this._client.getNegotiatedProtocolVersion?.() || null
      });

      await this._discoverTools();
      this._registerListChangedHandler();
    } catch (raw) {
      const durationMs = Date.now() - this._connectStartAt;
      const err = toMcpToolError(raw, {
        serverId: this.config.id,
        isCancelled: signal?.aborted === true || raw?.name === 'AbortError'
      });
      // OAuth (Phase 3): surface an explicit auth-required signal for
      // oauth-mode configs so routes/UI can offer [Authorize] instead of a
      // bare 401. Error CATEGORY mapping is unchanged (regression-safe).
      try {
        const { isOAuthAuthorizationRequired } = require('./oauthProvider');
        if ((this.config.auth && this.config.auth.type === 'oauth') &&
            (isOAuthAuthorizationRequired(raw) || isOAuthAuthorizationRequired(err))) {
          err.authRequired = true;
        }
      } catch { /* flagging must never break error mapping */ }
      logger.log(logger.LOG_EVENTS.CONNECTION_FAILED, {
        configId: this.config.id,
        slug: this.config.slug,
        category: err.category,
        durationMs,
        reason: err.message
      });
      throw err;
    }
  }

  async _discoverTools() {
    const toolList = [];
    try {
      const { tools = [] } = await this._client.listTools({ timeout: limits.DISCOVERY_TIMEOUT_MS });
      toolList.push(...tools);
    } catch (raw) {
      const err = toMcpToolError(raw, { serverId: this.config.id });
      // Discovery failure is recorded as STATE, not swallowed silently:
      // transport may be CONNECTED while no usable tools exist. Only genuine
      // authentication failures flag discoveryAuthRequired (retry must not
      // launch spurious authorize-again loops for transport/upstream quirks).
      this._discoveryStatus = 'failed';
      this._lastDiscoveryError = String(err?.message || raw?.message || raw || 'discovery failed').slice(0, 300);
      try {
        const { isOAuthAuthorizationRequired } = require('./oauthProvider');
        this._discoveryAuthRequired =
          (this.config.auth && this.config.auth.type === 'oauth') &&
          (isOAuthAuthorizationRequired(raw) || isOAuthAuthorizationRequired(err));
      } catch {
        this._discoveryAuthRequired = false;
      }
      logger.warn(logger.LOG_EVENTS.CONNECTION_FAILED, {
        configId: this.config.id,
        slug: this.config.slug,
        reason: `Tool discovery failed: ${this._lastDiscoveryError}`
      });
      return;
    }

    const config = this.config;
    const tools = [];
    const entries = new Map();
    const wireTaken = new Set();
    const canonicalTaken = new Set();

    for (const mcpTool of toolList) {
      if (!mcpTool || typeof mcpTool.name !== 'string' || !mcpTool.name) continue;
      if (tools.length >= limits.MAX_TOOLS_PER_SERVER) break;

      const toolNameRaw = sanitizeToolSegment(mcpTool.name);
      let rawWire = wireName(config.slug, toolNameRaw);
      rawWire = fitWireName(uniqueName(rawWire, wireTaken));
      wireTaken.add(rawWire);

      let rawCanonical = canonicalName(config.slug, toolNameRaw);
      rawCanonical = uniqueName(rawCanonical, canonicalTaken);
      canonicalTaken.add(rawCanonical);

      const entry = Object.freeze({
        configId: config.id,
        canonicalName: rawCanonical,
        wireName: rawWire,
        serverSlug: config.slug,
        originalToolName: mcpTool.name,
        description: mcpTool.description || '',
        inputSchema: mcpTool.inputSchema || { type: 'object', properties: {}, required: [] },
        // MCP behavior hints (readOnlyHint/destructiveHint/...) travel with
        // the entry so capability planning can read them generically. The
        // ARC schema sent to providers never carries them (see withMetadata).
        annotations: adapter.sanitizeAnnotations(mcpTool.annotations),
        keywords: extractKeywords(mcpTool)
      });

      const arcSchema = adapter.toArcSchema(mcpTool, rawWire, { id: config.id });
      const execFn = adapter.createExecAdapter(this, entry);

      entries.set(mcpTool.name, Object.freeze({
        entry,
        arcSchema,
        execute: execFn,
        mcpSchema: mcpTool
      }));
      tools.push(arcSchema);
    }

    this._tools = tools;
    this._toolEntries = entries;
    this._wireTaken = wireTaken;
    this._canonicalTaken = canonicalTaken;
    this._discoveryStatus = 'ok';
    this._lastDiscoveryError = null;
    this._discoveryAuthRequired = false;

    logger.log(logger.LOG_EVENTS.TOOLS_DISCOVERED, {
      configId: config.id,
      slug: config.slug,
      toolCount: tools.length,
      toolNames: tools.map((t) => t?.function?.name).filter(Boolean)
    });
    // Truncation visibility: when the per-server cap bites, record exactly
    // which tools were dropped — a silently decimated pool is otherwise
    // indistinguishable from a server that never exposed the tool.
    try {
      const dropped = toolList
        .filter((t) => t && typeof t.name === 'string' && t.name)
        .slice(tools.length)
        .map((t) => t.name);
      if (dropped.length) {
        logger.warn(logger.LOG_EVENTS.TOOLS_DISCOVERED, {
          configId: config.id,
          slug: config.slug,
          truncated: dropped.length,
          droppedToolNames: dropped
        });
      }
    } catch { /* diagnostics only */ }
  }

  _registerListChangedHandler() {
    if (!this._client) return;
    const hasListChanged = Boolean(this._capabilities?.tools?.listChanged);
    if (!hasListChanged) return;
    try {
      this._client.setNotificationHandler('notifications/tools/list_changed', async () => {
        const previousTools = [...this._tools];
        await this._discoverTools();
        if (this._onListChanged) {
          this._onListChanged(this.config, previousTools, this._tools);
        }
      });
    } catch {
      // list_changed handler failure must never break the connection.
    }
  }

  _cleanupClient() {
    if (this._client) {
      try { this._client.close(); } catch { /* best effort */ }
      this._client = null;
    }
    this._transport = null;
    this._tools = [];
    this._toolEntries.clear();
    this._wireTaken.clear();
    this._canonicalTaken.clear();
    this._discoveryStatus = 'idle';
    this._lastDiscoveryError = null;
    this._discoveryAuthRequired = false;
  }
}

// --- transport factory dispatch ---------------------------------------------

function createTransportForConfig(config, { authProvider = null } = {}) {
  // Test/embedded hook: lets the suite inject an InMemoryTransport client end
  // into the REAL connection pipeline (discovery, listChanged, cancellation,
  // adapter) without spawning a child process. Never present in production
  // configs from Mongo (the model has no testHooks field).
  if (config.testHooks && typeof config.testHooks.createTransport === 'function') {
    return config.testHooks.createTransport();
  }
  if (config.transport === 'stdio') {
    return createStdioTransport(config);
  }
  if (config.transport === 'streamable-http') {
    return createStreamableHTTPTransport(config, { authProvider });
  }
  throw toMcpToolError(new Error(`Unknown transport: ${config.transport}`), {
    category: CATEGORIES.PROTOCOL_ERROR,
    serverId: config.id
  });
}

// Cheap keyword extraction from MCP tool description + name.
const extractKeywords = (mcpTool) => {
  const text = `${mcpTool.name || ''} ${mcpTool.description || ''}`.toLowerCase();
  return text.match(/[a-z][a-z0-9]{2,}/g) || [];
};

module.exports = { McpServerConnection, STATES };
module.exports.McpServerConnection = McpServerConnection;
module.exports.STATES = STATES;