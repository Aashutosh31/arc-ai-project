'use strict';

// MCP safety limits. All values are tunable via env with deterministic
// defaults; every cap is enforced somewhere in the MCP pipeline.
//
// The result-size cap is the core guard: MCP servers are untrusted and can
// return arbitrarily large payloads. We compact before the payload ever
// reaches the LLM context so the 7K context budget cannot be bypassed by an
// MCP tool result.

const num = (envValue, fallback) => {
  const n = Number(envValue);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

const MAX_RESULT_TEXT_CHARS = num(process.env.MCP_RESULT_MAX_CHARS, 8000);
const MAX_RESULT_CONTENT_BLOCKS = num(process.env.MCP_RESULT_MAX_BLOCKS, 32);
const MAX_TOOLS_PER_SERVER = num(process.env.MCP_MAX_TOOLS_PER_SERVER, 64);
const CONNECT_TIMEOUT_MS = num(process.env.MCP_CONNECT_TIMEOUT_MS, 8000);
const REQUEST_TIMEOUT_MS = num(process.env.MCP_REQUEST_TIMEOUT_MS, 30000);
const DISCOVERY_TIMEOUT_MS = num(process.env.MCP_DISCOVERY_TIMEOUT_MS, REQUEST_TIMEOUT_MS);
const MAX_CONNECTED_SERVERS_PER_WORKSPACE = num(process.env.MCP_MAX_SERVERS_PER_WORKSPACE, 32);
const TOTAL_OUTPUT_HARD_CAP = num(process.env.MCP_TOTAL_OUTPUT_HARD_CAP, 200000);

module.exports = {
  MAX_RESULT_TEXT_CHARS,
  MAX_RESULT_CONTENT_BLOCKS,
  MAX_TOOLS_PER_SERVER,
  CONNECT_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  MAX_CONNECTED_SERVERS_PER_WORKSPACE,
  TOTAL_OUTPUT_HARD_CAP
};