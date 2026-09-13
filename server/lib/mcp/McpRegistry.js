'use strict';

// Canonical configuration + tool ownership registry.
//
// Every MCP server config is owned by exactly one principal:
//   scope: 'workspace' → workspaceId must be set (tools visible only there)
//   scope: 'global'    → accessible to every authenticated workspace
//
// This module is a pure in-memory data structure so it can be unit-tested
// without MongoDB. The Mongo-backed persistence model (McpServerConfig)
// feeds configs into the registry at startup / on change; tests can seed
// configs directly via the `register` / `registerMany` API.

const { sanitizeSlug } = require('./names');

class McpRegistry {
  constructor() {
    // configs: Map<id, config>
    this._configs = new Map();

    // tool ownership: canonicalName → { configId, wireName, canonicalName, serverSlug, originalToolName }
    this._tools = new Map();

    // wireName reverse lookup: wireName → ownership entry
    this._wireIndex = new Map();

    // configId → entries (kept OUTSIDE the frozen config object)
    this._entriesByConfig = new Map();

    // slug → canonical slugs in use (used for collision-suffixed slugs)
    this._slugCounts = new Map();
  }

  // ---- config lifecycle ----

  register(config = {}) {
    const id = config.id || config._id;
    if (!id) throw new Error('McpRegistry: config must have an id.');
    if (this._configs.has(id)) {
      this._clearToolsForConfig(id);
    }
    // Re-registration must NOT mint a fresh slug: identity is the config id.
    // Slugs are unique per registry, but stable across syncs of one config.
    const existing = this._configs.get(id);
    const normal = normalizeConfig(config, this._slugCounts, existing);
    this._configs.set(id, normal);
    this._reindexToolsForConfig(id);
    return normal;
  }

  registerMany(configs = []) {
    return configs.map((c) => this.register(c));
  }

  // Idempotent: if not present, no-op.
  remove(configId) {
    this._clearToolsForConfig(configId);
    this._configs.delete(configId);
  }

  get(configId) {
    return this._configs.get(configId) || null;
  }

  configForSlug(slug) {
    for (const c of this._configs.values()) {
      if (c.slug === slug) return c;
    }
    return null;
  }

  get count() {
    return this._configs.size;
  }

  // ---- tool policy (allow/deny) ----

  // Returns true if a tool wireName is allowed for this config given workspace/isGuest
  // denied always wins; allowed list restricts visibility; no allowlist = all allowed
  // originalToolName is the user-facing tool name (not wire name) for display policy checks
  toolAllowed(configId, wireName, originalToolName, workspaceId, isGuest) {
    const config = this._configs.get(String(configId));
    if (!config) return false;

    const { allowedTools, deniedTools } = config;

    // denied always wins first
    if (deniedTools && Array.isArray(deniedTools)) {
      const wireNames = Array.isArray(deniedTools) ? deniedTools : [deniedTools];
      // Check both wire names and canonical names and original tool names
      for (const pattern of wireNames) {
        const normalized = String(pattern).toLowerCase().trim();
        if (normalized === '') continue;
        // Check wire name
        if (wireName.toLowerCase().includes(normalized) || normalized.includes(wireName.toLowerCase())) return false;
        // Check canonical name pattern
        const canonical = `${'mcp'}.${config.slug}.${originalToolName || ''}`.toLowerCase();
        if (canonical.includes(normalized) || normalized.includes(canonical.toLowerCase())) return false;
        // Check original tool name
        const origLower = String(originalToolName || '').toLowerCase();
        if (normalized.includes(origLower) || origLower.includes(normalized)) return false;
      }
    }

    // allowed list: if specified and non-empty, only listed tools are
    // visible. Absent or empty = all discovered tools allowed.
    if (allowedTools && Array.isArray(allowedTools) && allowedTools.length > 0) {
      const allowedSet = new Set(allowedTools.map(t => String(t).toLowerCase().trim()));
      const wireLower = wireName.toLowerCase();
      const origLower = String(originalToolName || '').toLowerCase();
      let matches = false;
      for (const allowed of allowedSet) {
        if (allowed === '') continue;
        if (wireLower === allowed || wireLower.includes(allowed) || allowed.includes(wireLower)) {
          matches = true;
          break;
        }
        if (origLower === allowed || origLower.includes(allowed) || allowed.includes(origLower)) {
          matches = true;
          break;
        }
      }
      if (!matches) return false;
    }

    return true;
  }

  // Filter tool entries by allow/deny policy for a workspace
  // Returns only tools that pass the policy
  filterToolsByPolicy(configId, wireNames, originalToolNames, workspaceId, isGuest) {
    const entries = [];
    const config = this._configs.get(String(configId));
    if (!config) return entries;

    const { allowedTools, deniedTools } = config;

    for (let i = 0; i < wireNames.length; i++) {
      const wireName = wireNames[i];
      const origToolName = originalToolNames[i] || '';

      // denied always wins
      let denied = false;
      if (deniedTools && Array.isArray(deniedTools)) {
        for (const pattern of deniedTools) {
          const normalized = String(pattern).toLowerCase().trim();
          if (normalized === '') continue;
          if (wireName.toLowerCase().includes(normalized) || normalized.includes(wireName.toLowerCase())) {
            denied = true;
            break;
          }
          if (origToolName.toLowerCase().includes(normalized) || normalized.includes(origToolName.toLowerCase())) {
            denied = true;
            break;
          }
        }
      }

      if (denied) continue;

      // allowed list: non-empty only. Absent or empty = all allowed.
      if (allowedTools && Array.isArray(allowedTools) && allowedTools.length > 0) {
        const allowedSet = new Set(allowedTools.map(t => String(t).toLowerCase().trim()));
        const wireLower = wireName.toLowerCase();
        let matches = false;
        for (const allowed of allowedSet) {
          if (allowed === '') continue;
          if (wireLower === allowed || wireLower.includes(allowed) || allowed.includes(wireLower)) {
            matches = true;
            break;
          }
          if (origToolName.toLowerCase().includes(allowed) || allowed.includes(origToolName.toLowerCase())) {
            matches = true;
            break;
          }
        }
        if (!matches) continue;
      }

      entries.push({
        wireName,
        originalToolName: origToolName,
        configId: String(config.id)
      });
    }

    return entries;
  }

  // ---- workspace queries ----

  configsForWorkspace({ workspaceId = null, isGuest = false } = {}) {
    const results = [];
    for (const c of this._configs.values()) {
      if (c.disabled) continue;
      // Guest access is opt-in: guests only see explicitly guestAllowed
      // configs. Authenticated users are never blocked by guestAllowed.
      if (isGuest && !c.guestAllowed) continue;
      if (c.scope === 'global') { results.push(c); continue; }
      if (c.scope === 'workspace' && String(c.workspaceId) === String(workspaceId)) {
        results.push(c);
      }
    }
    return results;
  }

  // ---- tool map ----

  toolByCanonicalName(canonicalName) {
    return this._tools.get(canonicalName) || null;
  }

  toolByWireName(wireName) {
    return this._wireIndex.get(wireName) || null;
  }

  toolByOriginalToolName(originalName, serverSlug) {
    for (const entry of this._tools.values()) {
      if (entry.originalToolName === originalName && entry.serverSlug === serverSlug) return entry;
    }
    return null;
  }

  // For contextBudget or test introspection: total unique wire-name tools visible to a workspace.
  countToolsVisibleToWorkspace(workspaceId, isGuest = false) {
    const configs = this.configsForWorkspace({ workspaceId, isGuest });
    return configs.reduce((sum, c) => sum + this.toolCount(c.id), 0);
  }

  // ---- internal helpers ----

  _clearToolsForConfig(configId) {
    const entries = this._entriesByConfig.get(configId) || [];
    for (const entry of entries) {
      this._tools.delete(entry.canonicalName);
      this._wireIndex.delete(entry.wireName);
    }
    this._entriesByConfig.delete(configId);
  }

  _reindexToolsForConfig(configId) {
    const config = this._configs.get(configId);
    if (!config || !Array.isArray(config.tools)) return;
    const entries = [];
    const takenWire = new Set();
    const takenCanonical = new Set();
    for (const tool of config.tools) {
      const entry = buildToolEntry(config, tool, takenCanonical, takenWire);
      entries.push(entry);
      this._tools.set(entry.canonicalName, entry);
      this._wireIndex.set(entry.wireName, entry);
    }
    this._entriesByConfig.set(configId, entries);
  }

  toolCount(configId) {
    const entries = this._entriesByConfig.get(configId);
    return entries ? entries.length : 0;
  }
}

// ---- pure helpers (tested via names.js constraints) ----

const { canonicalName, wireName, fitWireName, sanitizeToolSegment, uniqueName } = require('./names');

const buildToolEntry = (config, tool, takenCanonical, takenWire) => {
  const toolNameRaw = sanitizeToolSegment(tool.name || tool.originalToolName || 'tool');
  const slug = config.slug;
  let rawCanonical = canonicalName(slug, toolNameRaw);
  let rawWire = wireName(slug, toolNameRaw);

  // No two tools in the entire system can share a wire name (because the
  // model sees the wire name and calls the tool by it).
  const finalWire = fitWireName(uniqueName(rawWire, takenWire));
  const finalCanonical = uniqueName(rawCanonical, takenCanonical);
  takenCanonical.add(finalCanonical);
  takenWire.add(finalWire);

  return Object.freeze({
    configId: String(config.id),
    canonicalName: finalCanonical,
    wireName: finalWire,
    serverSlug: slug,
    originalToolName: tool.name || tool.originalToolName,
    description: tool.description || '',
    inputSchema: tool.inputSchema || { type: 'object', properties: {}, required: [] },
    keywords: Array.isArray(tool.keywords) ? tool.keywords : []
  });
};

const normalizeConfig = (raw, slugCounts, existing) => {
  const id = String(raw.id || raw._id);
  const name = String(raw.name || '').trim() || `mcp-${id}`;
  // Re-registration keeps the existing slug unless an intentional rename
  // (different slug) is provided.
  const slug = existing
    ? (raw.slug && raw.slug !== existing.slug
        ? resolveUniqueSlug(raw.slug, id, slugCounts)
        : existing.slug)
    : (raw.slug
        ? resolveUniqueSlug(raw.slug, id, slugCounts)
        : resolveUniqueSlug(name, id, slugCounts));
  return Object.freeze({
    id,
    name,
    slug,
    ownerUserId: raw.ownerUserId || raw.owner || null,
    scope: raw.scope === 'workspace' ? 'workspace' : (raw.scope === 'global' ? 'global' : 'workspace'),
    workspaceId: raw.workspaceId || null,
    transport: raw.transport === 'stdio' ? 'stdio' : (raw.transport === 'streamable-http' ? 'streamable-http' : 'stdio'),
    command: raw.command || null,
    args: Array.isArray(raw.args) ? raw.args : (typeof raw.args === 'string' ? [raw.args] : []),
    url: raw.url || null,
    envVarNames: Array.isArray(raw.envVarNames) ? [...raw.envVarNames] : [],
    enabled: raw.enabled !== false,
    disabled: raw.disabled === true || raw.enabled === false,
    // Test-only hook: lets the suite inject an in-memory transport into the
    // real pipeline. Never persisted by the Mongo model, never set there.
    testHooks: raw.testHooks && typeof raw.testHooks === 'object' ? raw.testHooks : null,
    guestAllowed: raw.guestAllowed === true,
    allowlistEnv: raw.allowlistEnv || null,
    // Per-server tool policy (Phase 2). Denied always wins over allowed.
    // Matched against wire/canonical/original tool identity, never display names.
    // SECURITY: a re-registration that omits policy fields (e.g. discovery
    // sync) must NOT wipe the existing policy — otherwise blocked tools are
    // silently re-exposed. Explicit updates always carry the fields.
    allowedTools: Array.isArray(raw.allowedTools)
      ? raw.allowedTools.map((t) => String(t))
      : (existing && Array.isArray(existing.allowedTools) ? [...existing.allowedTools] : []),
    deniedTools: Array.isArray(raw.deniedTools)
      ? raw.deniedTools.map((t) => String(t))
      : (existing && Array.isArray(existing.deniedTools) ? [...existing.deniedTools] : []),
    auth: normalizeAuth(raw.auth),
    createdAt: raw.createdAt || new Date(),
    updatedAt: raw.updatedAt || new Date(),
    tools: Array.isArray(raw.tools) ? raw.tools : []
  });
};

const resolveUniqueSlug = (raw, id, slugCounts) => {
  let base = sanitizeSlug(raw);
  if (!base) base = `mcp_${id.slice(0, 8)}`;
  const count = slugCounts.get(base) || 0;
  slugCounts.set(base, count + 1);
  return count === 0 ? base : `${base}_${count + 1}`;
};

const normalizeAuth = (auth) => {
  if (!auth || typeof auth !== 'object') return { type: 'none' };
  return {
    type: auth.type === 'header' ? 'header' : 'none',
    envVar: auth.envVar || auth.envVarName || null
  };
};

module.exports = McpRegistry;