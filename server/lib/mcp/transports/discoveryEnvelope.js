'use strict';

// Generic JSON-RPC envelope tolerance for MCP discovery reads.
//
// Some providers answer discovery requests (tools/list) with a non-2xx HTTP
// status while the body is a VALID JSON-RPC success envelope for that exact
// request. The SDK transport throws on any non-2xx before the MCP parser can
// run, so discovery collapses to zero tools even though the tools are right
// there in the body.
//
// This layer wraps the transport fetch and rewrites ONLY responses where ALL
// hold (otherwise the original response passes through untouched):
//   1. the request is a single tools/list JSON-RPC request (never executions)
//   2. the body parses as JSON with jsonrpc '2.0'
//   3. the response id matches the request id
//   4. the envelope is a success envelope (result object, no error member)
//   5. result.tools is an array of entries with non-empty string names
//
// Accepted envelopes are presented as HTTP 200 with content-type
// application/json (the verified body is single-message JSON); the upstream
// status is recorded as diagnostic metadata only (status number + tool
// count — bodies, tokens, and headers are never logged).
//
// Generic protocol rule: no server names, URLs, status codes, or tool names.

const logger = require('../logger');

// Discovery/read-style methods eligible for envelope tolerance. Executions
// (tools/call and everything else) are NEVER rewritten — they keep the
// normal authentication/error/recovery pipeline.
const ENVELOPE_METHODS = new Set(['tools/list']);

const parseRequestMessage = (body) => {
  try {
    if (typeof body !== 'string' || !body) return null;
    const msg = JSON.parse(body);
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
    if (typeof msg.method !== 'string' || !ENVELOPE_METHODS.has(msg.method)) return null;
    return { method: msg.method, id: msg.id };
  } catch {
    return null;
  }
};

const isValidDiscoveryEnvelope = (parsed, requestId) => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (parsed.jsonrpc !== '2.0') return false;
  if (parsed.id === undefined || parsed.id === null) return false;
  if (parsed.id !== requestId) return false;
  if (parsed.error !== undefined) return false;
  const result = parsed.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const tools = result.tools;
  if (!Array.isArray(tools)) return false;
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false;
    if (typeof tool.name !== 'string' || !tool.name) return false;
  }
  return true;
};

const rebuildResponse = (response, text, { status = null, json = false } = {}) => {
  const headers = new Headers(response.headers);
  if (json) headers.set('content-type', 'application/json');
  return new Response(text, {
    status: status === null ? response.status : status,
    statusText: status === null ? response.statusText : 'OK',
    headers
  });
};

const defaultOnTolerated = ({ configId = null, slug = null, upstreamStatus = null, toolCount = 0 } = {}) => {
  logger.warn(logger.LOG_EVENTS.DISCOVERY_ENVELOPE_TOLERATED, {
    configId: configId === null ? undefined : String(configId),
    slug: slug || undefined,
    reason: `tools/list upstream HTTP ${upstreamStatus} carried a valid JSON-RPC result (${toolCount} tools); accepted as discovery`
  });
};

// Wraps a fetch implementation with envelope tolerance. Pure transport
// behavior — no credentials, no OAuth, no tool semantics.
const createEnvelopeTolerantFetch = ({ fetchFn = null, configId = null, slug = null, onTolerated = null } = {}) => {
  const inner = typeof fetchFn === 'function' ? fetchFn : fetch;
  const notify = typeof onTolerated === 'function' ? onTolerated : defaultOnTolerated;
  return async (url, init = {}) => {
    const response = await inner(url, init);
    try {
      if (response.ok) return response;
      const request = parseRequestMessage(init && init.body);
      if (!request) return response;
      let text = null;
      try {
        text = await response.text();
      } catch {
        return response;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        return rebuildResponse(response, text);
      }
      if (!isValidDiscoveryEnvelope(parsed, request.id)) {
        return rebuildResponse(response, text);
      }
      const upstreamStatus = response.status;
      try {
        notify({ configId, slug, upstreamStatus, toolCount: parsed.result.tools.length });
      } catch {
        // Diagnostics must never break the transport.
      }
      return rebuildResponse(response, text, { status: 200, json: true });
    } catch {
      return response;
    }
  };
};

module.exports = {
  ENVELOPE_METHODS,
  parseRequestMessage,
  isValidDiscoveryEnvelope,
  createEnvelopeTolerantFetch
};
