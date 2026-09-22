'use strict';

// Read-only capability discovery over the EXISTING authoritative sources.
//
//   discoverNative()                        -> native capabilities
//   discoverMcp({ workspaceId, isGuest })   -> MCP capabilities (registered configs)
//   discoverAll(opts)                       -> combined array
//
// This module never creates a second native or MCP registry: it reads the
// live tool registry (`require('../../tools')`) and the live MCP source
// (`McpToolSource.registry`). No execution, no connection, no policy.

const toolRegistry = require('../../tools');
const { McpToolSource } = require('../mcp');
const names = require('../mcp/names');
const McpToolAdapter = require('../mcp/McpToolAdapter');
const {
  SOURCE_NATIVE,
  SOURCE_MCP,
} = require('./capabilityTypes');
const { nativeRiskFor, mcpRiskFor } = require('./risk');

// ---- native -----------------------------------------------------------------

const buildNativeCapability = (tool) => {
  const schemaFn = tool && tool.schema && tool.schema.function;
  const name = schemaFn && schemaFn.name ? schemaFn.name : null;
  if (!name) return null;
  const classified = nativeRiskFor(name) || { scope: null, risk: null };
  return {
    id: `native:${name}`,
    source: SOURCE_NATIVE,
    name,
    wireName: name,
    serverSlug: null,
    description: (schemaFn.description || '').slice(0, 500),
    scope: classified.scope,
    risk: classified.risk,
    inputSchema:
      schemaFn.parameters || { type: 'object', properties: {} },
    annotations: null,
    metadata: {
      workspaceId: null,
      isGuest: false,
      serverId: null,
      configName: null,
      configScope: null,
    },
    timeoutMs: null,
    cancellation: 'cooperative',
    idempotency: 'safe',
    observability: 'line',
  };
};

const discoverNative = () => {
  const out = [];
  for (const key of Object.keys(toolRegistry.tools || {}).sort()) {
    const cap = buildNativeCapability(toolRegistry.tools[key]);
    if (cap) out.push(cap);
  }
  return out;
};

// ---- mcp --------------------------------------------------------------------

// Deterministic identity mirroring McpRegistry.buildToolEntry: unique wire/
// canonical names per config, in registered tool order. Pure helper; the
// live registry remains the only authority — this only names for the view.
const mcpToolIdentities = (config) => {
  const slug = config.slug;
  const takenCanonical = new Set();
  const takenWire = new Set();
  const identities = [];
  for (const rawTool of config.tools || []) {
    const toolNameRaw = names.sanitizeToolSegment(
      rawTool.name || rawTool.originalToolName || 'tool',
    );
    let rawCanonical = names.canonicalName(slug, toolNameRaw);
    let rawWire = names.wireName(slug, toolNameRaw);
    const finalWire = names.fitWireName(names.uniqueName(rawWire, takenWire));
    const finalCanonical = names.uniqueName(rawCanonical, takenCanonical);
    takenCanonical.add(finalCanonical);
    takenWire.add(finalWire);
    identities.push({
      originalToolName: rawTool.name || rawTool.originalToolName,
      canonicalName: finalCanonical,
      wireName: finalWire,
    });
  }
  return identities;
};

// Resolve the raw registered tool object matching a computed identity, so
// each capability carries ITS OWN description/inputSchema/annotations.
const rawToolFor = (config, identity) => {
  for (const t of config.tools || []) {
    if ((t.name || t.originalToolName) === identity.originalToolName) return t;
  }
  return null;
};

const buildMcpCapability = (config, identity, isGuest) => {
  const rawTool = rawToolFor(config, identity);
  const classified = mcpRiskFor(rawTool && rawTool.annotations) || {
    scope: null,
    risk: null,
  };
  return {
    id: identity.canonicalName,
    source: SOURCE_MCP,
    name: identity.originalToolName,
    wireName: identity.wireName,
    serverSlug: config.slug || null,
    description: ((rawTool && rawTool.description) || '').slice(0, 500),
    scope: classified.scope,
    risk: classified.risk,
    inputSchema:
      (rawTool && rawTool.inputSchema) || { type: 'object', properties: {} },
    annotations: Object.freeze(
      McpToolAdapter.sanitizeAnnotations(rawTool && rawTool.annotations),
    ),
    metadata: {
      workspaceId: config.workspaceId || null,
      isGuest,
      serverId: config.id || null,
      configName: config.name || null,
      configScope: config.scope || null,
    },
    timeoutMs: null,
    cancellation: 'cooperative',
    idempotency: 'safe',
    observability: 'line',
  };
};

const discoverMcp = async ({ workspaceId = null, isGuest = false } = {}) => {
  let registry;
  try {
    registry = McpToolSource.registry;
  } catch {
    return [];
  }
  if (!registry || typeof registry.configsForWorkspace !== 'function') {
    return [];
  }
  let configs;
  try {
    configs = registry.configsForWorkspace({ workspaceId, isGuest });
  } catch {
    configs = [];
  }
  const out = [];
  for (const config of configs || []) {
    const identities = mcpToolIdentities(config);
    for (const identity of identities) {
      const cap = buildMcpCapability(config, identity, isGuest);
      if (cap) out.push(cap);
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

// ---- combined ----------------------------------------------------------------

const discoverAll = async ({ workspaceId = null, isGuest = false } = {}) => {
  const native = discoverNative();
  const mcp = await discoverMcp({ workspaceId, isGuest });
  return [...native, ...mcp].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

module.exports = {
  buildNativeCapability,
  buildMcpCapability,
  mcpToolIdentities,
  discoverNative,
  discoverMcp,
  discoverAll,
};