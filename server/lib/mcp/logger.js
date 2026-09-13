'use strict';

// Safe structured MCP observability. Log events are keyword-stable for
// grepping; payloads are deliberately small metadata only.
//
// HARD RULE: never log credentials, tool inputs, or tool outputs. Callers
// pass only the structured fields they want surfaced (server id/name, wire
// tool name, workspace id where safe, durations, sizes, status). If a field
// is accidentally missing here it simply is not logged — no secret-sniffing
// heuristics, no fallbacks.

const LOG_EVENTS = Object.freeze({
  CONNECTION_STARTED: 'mcp.connection.started',
  CONNECTION_READY: 'mcp.connection.ready',
  CONNECTION_FAILED: 'mcp.connection.failed',
  CONNECTION_CLOSED: 'mcp.connection.closed',
  TOOLS_DISCOVERED: 'mcp.tools.discovered',
  TOOL_STARTED: 'mcp.tool.started',
  TOOL_COMPLETED: 'mcp.tool.completed',
  TOOL_FAILED: 'mcp.tool.failed',
  TOOL_CANCELLED: 'mcp.tool.cancelled',
  CONFIG_REJECTED: 'mcp.config.rejected',
  TOOL_DENIED: 'mcp.tool.denied'
});

const enqueueMicrotask = (fn) => {
  try {
    Promise.resolve().then(fn);
  } catch {
    // Observability must never throw into the caller.
  }
};

// Payload shape is pruned to a whitelist of safe scalar fields.
const SAFE_FIELDS = new Set([
  'serverId', 'serverName', 'transport', 'tool', 'workspaceId',
  'scope', 'status', 'category', 'durationMs', 'resultSize',
  'resultBlocks', 'truncated', 'toolCount', 'toolNames', 'reason',
  'protocolVersion', 'provider', 'retryable', 'configId', 'slug'
]);

const prune = (fields) => {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (!SAFE_FIELDS.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') {
      if (Array.isArray(value)) {
        out[key] = value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
      }
      continue;
    }
    out[key] = value;
  }
  return out;
};

const log = (event, fields) => {
  let meta = {};
  try {
    meta = prune(fields);
  } catch {
    meta = {};
  }
  // Logger failure must never break the request path.
  enqueueMicrotask(() => {
    console.log(`[Mcp] ${event}`, meta);
  });
};

const warn = (event, fields) => {
  let meta = {};
  try {
    meta = prune(fields);
  } catch {
    meta = {};
  }
  enqueueMicrotask(() => {
    console.warn(`[Mcp] ${event}`, meta);
  });
};

module.exports = {
  LOG_EVENTS,
  log,
  warn,
  _prune: prune
};