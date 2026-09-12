'use strict';

// Public MCP facade consumed by the rest of ARC.
//
//   McpToolSource.schemasForRequest({ workspaceId, isGuest })
//     → { schemas, metadata }  for toolSelection's `options.mcpSchemas`
//
//   McpToolSource.resolveTool(wireName, opts)   → TaskExecutor MCP fallback
//   McpToolSource.isMcpToolName(name)
//
// MCP metadata rides each schema as a NON-ENUMERABLE property so that
// JSON.stringify-based token estimation (contextBudget) and provider payloads
// (JSON deep clones by Mistral, object slices by Groq) never serialize it and
// never leak server identity into the model's token stream.

const { McpManager } = require('./McpManager');
const McpRegistry = require('./McpRegistry');
const { isMcpWireName, isMcpCanonicalName } = require('./names');
const limits = require('./limits');

const METADATA_KEY = 'mcpMetadata';

// ---- production wiring (lazy, Mongo-backed when connected) ----

const createProductionCore = () => {
  const registry = new McpRegistry();
  const manager = new McpManager({ registry });
  const core = {
    manager,
    registry,
    _loaded: false,
    _loading: null,

    async refreshConfigs() {
      if (this._loaded) return;
      if (this._loading) return this._loading;
      this._loading = this._load();
      try { await this._loading; } finally { this._loading = null; }
    },

    async _load() {
      const { seedRegistryFromMongo } = require('./configStore');
      await seedRegistryFromMongo(registry);
      this._loaded = true;
    }
  };
  return core;
};

// ---- metadata attachment ----

// The adapter freezes schemas; metadata is attached to a shallow overlay so
// the original frozen object stays immutable.
const withMetadata = (schema, metadata) => {
  const overlay = Object.assign({}, schema);
  Object.defineProperty(overlay, METADATA_KEY, {
    value: Object.freeze(metadata),
    enumerable: false,
    writable: false,
    configurable: false
  });
  return overlay;
};

const McpToolSource = {
  _instance: null,

  init(options = {}) {
    if (options.manager && options.registry) {
      this._instance = {
        manager: options.manager,
        registry: options.registry,
        refreshConfigs: async () => {}
      };
    } else if (!this._instance) {
      this._instance = createProductionCore();
    }
    return this._instance.manager;
  },

  _core() {
    if (!this._instance) this.init();
    return this._instance;
  },

  get manager() { return this._core().manager; },
  get registry() { return this._core().registry; },

  isMcpToolName(name) {
    return isMcpWireName(name) || isMcpCanonicalName(name);
  },

  // ---- schema supply for intent selection ----

  async schemasForRequest({ workspaceId = null, isGuest = false } = {}) {
    const core = this._core();
    await core.refreshConfigs();

    let configs;
    try {
      configs = core.registry.configsForWorkspace({ workspaceId, isGuest });
    } catch {
      configs = [];
    }
    if (!configs.length) return { schemas: [], metadata: new Map(), failures: [], blocked: [] };

    const schemas = [];
    const metadata = new Map();
    const failures = [];
    // Policy-removed tool schemas, SERVER-SIDE ONLY. Never attached to a
    // provider request: they let tool selection detect "request targets a
    // blocked capability" so no unrelated tool is substituted (the model
    // then responds naturally that the capability is unavailable).
    const blocked = [];

    for (const config of configs) {
      if (schemas.length >= limits.MAX_TOOLS_PER_SERVER) break;
      let conn;
      try {
        conn = await core.manager.ensureConnected(config);
      } catch (err) {
        // Degradation: an unreachable MCP server never blocks the request.
        failures.push({ configId: config.id, reason: err && err.message ? err.message : 'connect failed' });
        continue;
      }
      // Collect raw tool entries, then filter by allow/deny policy
      const rawTools = [];
      const toolEntryWires = [];
      const toolEntryNames = [];
      for (const toolEntry of conn.toolEntries.values()) {
        rawTools.push(toolEntry.entry);
        toolEntryWires.push(toolEntry.entry.wireName);
        toolEntryNames.push(toolEntry.entry.originalToolName);
      }
      // Apply allow/deny policy
      const permittedEntries = core.registry.filterToolsByPolicy(
        config.id,
        toolEntryWires,
        toolEntryNames,
        workspaceId,
        isGuest
      );

      const permittedWireSet = new Set(permittedEntries.map(e => e.wireName));
      const permittedNameSet = new Set(permittedEntries.map(e => e.originalToolName));

      for (const toolEntry of conn.toolEntries.values()) {
        if (schemas.length >= limits.MAX_TOOLS_PER_SERVER) break;
        const entry = toolEntry.entry;
        // Skip tools filtered out by the allow/deny policy (kept server-side
        // for no-substitution detection; never exposed to the model).
        if (!permittedWireSet.has(entry.wireName) && !permittedNameSet.has(entry.originalToolName)) {
          blocked.push(toolEntry.arcSchema);
          continue;
        }
        schemas.push(withMetadata(toolEntry.arcSchema, {
          serverId: entry.configId,
          wireName: entry.wireName,
          canonicalName: entry.canonicalName,
          originalToolName: entry.originalToolName
        }));
        metadata.set(entry.wireName, {
          serverId: entry.configId,
          configName: config.name,
          slug: config.slug,
          wireName: entry.wireName,
          canonicalName: entry.canonicalName,
          originalToolName: entry.originalToolName
        });
      }
    }

    return { schemas, metadata, failures, blocked };
  },

  // ---- continuation support ----

  // Schemas for tools that are already active in the running thread, so
  // continuation selection keeps them mandatory. Resolves each wire name
  // against the connection that currently publishes it.
  async schemasForContinuation(activeWireNames = [], opts = {}) {
    if (!Array.isArray(activeWireNames) || !activeWireNames.length) return [];
    const core = this._core();
    await core.refreshConfigs();
    const { workspaceId = null, isGuest = false } = opts || {};
    const out = [];
    for (const wireName of activeWireNames) {
      const entry = core.registry.toolByWireName(wireName);
      if (!entry) continue;
      const config = core.registry.get(entry.configId);
      if (!config || config.disabled) continue;
      // SECURITY: continuation must not bypass the tool policy. A denied
      // (or allowlisted-out) tool stays out even if it was active before.
      if (typeof core.registry.toolAllowed === 'function' &&
          !core.registry.toolAllowed(config.id, entry.wireName, entry.originalToolName, workspaceId, isGuest)) {
        continue;
      }
      let conn;
      try {
        conn = await core.manager.ensureConnected(config);
      } catch {
        continue;
      }
      const toolEntry = conn.getToolEntry(entry.originalToolName);
      if (!toolEntry) continue;
      out.push(withMetadata(toolEntry.arcSchema, {
        serverId: entry.configId,
        wireName: entry.wireName,
        canonicalName: entry.canonicalName,
        originalToolName: entry.originalToolName
      }));
    }
    return out;
  },

  // ---- execution fallback ----

  async resolveTool(wireName, opts = {}) {
    if (!this.isMcpToolName(wireName)) return null;
    const core = this._core();
    await core.refreshConfigs();
    return core.manager.resolveTool(wireName, opts);
  },

  // ---- config administration (used by future Settings UI / tests) ----

  registerConfig(config) {
    return this._core().registry.register(config);
  },

  unregisterConfig(configId) {
    this._core().registry.remove(configId);
  },

  async disconnect(configId) {
    return this._core().manager.disconnect(configId);
  },

  async shutdown() {
    if (this._instance && this._instance.manager) {
      await this._instance.manager.shutdown();
    }
    this._instance = null;
  }
};

module.exports = {
  McpToolSource,
  isMcpToolName: (name) => McpToolSource.isMcpToolName(name),
  McpManager,
  McpRegistry,
  METADATA_KEY,
  names: require('./names'),
  adapter: require('./McpToolAdapter'),
  errors: require('./errors'),
  logger: require('./logger'),
  limits
};