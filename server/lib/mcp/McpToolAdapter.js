'use strict';

// MCP tool adapter: the single translation boundary between MCP and ARC.
//
// Every conversion is a pure function. None of these touch I/O or transport.
//
//   • toArcSchema(mcpTool, wireName, config)  — definition the model sees
//   • toMcpArgs(args)                         — passthrough with loose stringify guard
//   • toArcResult(callToolResult, { tool, durationMs }) — ARC tool-result shape
//   • normalizeResultContent(content)         — size-limited text assembly
//   • createExecAdapter(connection, tool)     — the `execute(args, context, socket)` function
//   • toExecutionError(rawError, opts)        — structured MCP failure for TaskExecutor
//
// All content is assumed to come from an untrusted external MCP server.
// Base64 blobs, images, audio, and resource data are NEVER forwarded raw.

const { toWellFormedUnicode } = require('../llm/utils');
const { CATEGORIES, toMcpToolError, McpToolError } = require('./errors');
const { isMcpWireName } = require('./names');
const limits = require('./limits');

// --- definition translation -------------------------------------------------

const toArcSchema = (mcpTool, wireName, config) => {
  const name = wireName;
  const description = typeof mcpTool.description === 'string'
    ? toWellFormedUnicode(mcpTool.description).slice(0, 2048)
    : '';
  const input = mcpTool.inputSchema || { type: 'object', properties: {}, required: [] };
  return Object.freeze({
    type: 'function',
    function: Object.freeze({
      name,
      description,
      parameters: sanitizeParameters(input)
    })
  });
};

const sanitizeParameters = (schema) => {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {}, required: [] };
  const out = { type: schema.type || 'object' };
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      out.properties[key] = sanitizeProperty(val);
    }
  }
  if (Array.isArray(schema.required)) {
    out.required = schema.required.filter((r) => typeof r === 'string');
  }
  if (schema.additionalProperties !== undefined) out.additionalProperties = schema.additionalProperties;
  return out;
};

const sanitizeProperty = (prop) => {
  if (!prop || typeof prop !== 'object') return { type: 'string' };
  const s = { type: prop.type || 'string' };
  if (prop.description) s.description = toWellFormedUnicode(String(prop.description));
  if (prop.enum) s.enum = prop.enum;
  if (prop.default !== undefined) s.default = prop.default;
  if (prop.minimum !== undefined) s.minimum = prop.minimum;
  if (prop.maximum !== undefined) s.maximum = prop.maximum;
  if (prop.type === 'object' && prop.properties) {
    s.properties = {};
    for (const [key, val] of Object.entries(prop.properties)) s.properties[key] = sanitizeProperty(val);
    if (Array.isArray(prop.required)) s.required = prop.required.filter((r) => typeof r === 'string');
  }
  if (prop.type === 'array' && prop.items) {
    s.items = sanitizeProperty(prop.items);
  }
  return s;
};

// --- result translation -----------------------------------------------------

const toArcResult = (callToolResult, opts = {}) => {
  const { tool = null, durationMs = 0 } = opts;
  const isError = Boolean(callToolResult?.isError);
  const rawContent = Array.isArray(callToolResult?.content) ? callToolResult.content : [];
  const compacted = normalizeResultContent(rawContent);

  if (isError) {
    return {
      success: false,
      error: compacted.text || 'MCP tool returned an error.',
      errorType: 'MCP_TOOL_ERROR',
      tool: tool?.wireName || null,
      durationMs,
      truncated: compacted.truncated,
      resultSize: compacted.totalChars,
      mcp: Object.freeze({
        serverId: tool?.configId || null,
        wireName: tool?.wireName || null,
        originalToolName: tool?.originalToolName || null,
        canonicalName: tool?.canonicalName || null,
        durationMs
      })
    };
  }
  return {
    success: true,
    tool: tool?.wireName || null,
    result: compacted.text || '',
    truncated: compacted.truncated,
    resultSize: compacted.totalChars,
    mcp: Object.freeze({
      serverId: tool?.configId || null,
      wireName: tool?.wireName || null,
      originalToolName: tool?.originalToolName || null,
      canonicalName: tool?.canonicalName || null,
      durationMs
    })
  };
};

// --- content normalization ---------------------------------------------------

const normalizeResultContent = (content = []) => {
  if (!Array.isArray(content) || content.length === 0) return { text: '', truncated: false, totalChars: 0, blocks: 0 };

  const maxBlocks = Math.max(1, Math.min(content.length, limits.MAX_RESULT_CONTENT_BLOCKS));
  const maxText = Math.max(0, limits.MAX_RESULT_TEXT_CHARS);
  let remaining = maxText;
  let truncated = content.length > maxBlocks;
  const parts = [];

  for (let i = 0; i < maxBlocks; i++) {
    const block = content[i];
    if (!block || typeof block !== 'object') continue;

    const kind = String(block.type || '').toLowerCase();

    if (kind === 'text') {
      const raw = safeString(block.text);
      const allowed = raw.length > remaining ? raw.slice(0, remaining) : raw;
      if (allowed.length < raw.length) truncated = true;
      parts.push(allowed);
      remaining -= allowed.length;
    } else if (kind === 'resource') {
      const resText = block.resource?.text
        || block.resource?.blob || '';
      const raw = safeString(resText);
      const allowed = raw.length > remaining ? raw.slice(0, remaining) : raw;
      if (allowed.length < raw.length) truncated = true;
      parts.push(allowed);
      remaining -= allowed.length;
    } else if (kind === 'resource_link') {
      parts.push(`[resource: ${safeString(block.uri || 'unknown')}]`);
      remaining -= parts[parts.length - 1].length;
    } else if (kind === 'image') {
      const summary = `[image: ${safeString(block.mimeType || 'unknown')}, ${(base64Size(block.data || ''))} bytes (omitted)]`;
      parts.push(summary);
      remaining -= summary.length;
    } else if (kind === 'audio') {
      const summary = `[audio: ${safeString(block.mimeType || 'unknown')}, ${(base64Size(block.data || ''))} bytes (omitted)]`;
      parts.push(summary);
      remaining -= summary.length;
    }
    if (remaining <= 0) { truncated = true; break; }
  }

  const text = parts.join('\n');
  if (text.length < maxText && !truncated && content.length > maxBlocks) {
    truncated = true;
  }
  return {
    text: toWellFormedUnicode(text),
    truncated,
    totalChars: text.length,
    blocks: parts.length
  };
};

const safeString = (v) => String(v == null ? '' : v);
const base64Size = (b64) => Math.ceil((b64.length * 3) / 4);

// --- execution adapter factory ----------------------------------------------

const createExecAdapter = (connection, tool) => {
  return async function mcpToolExec(args, context, socket) {
    const { wireName, configId, originalToolName } = tool;
    const startMs = Date.now();
    try {
      const mcpArgs = toMcpArgs(args);
      const signal = context?.signal || null;
      const timeoutMs = context?.timeoutMs || limits.REQUEST_TIMEOUT_MS;
      const result = await connection.callTool(originalToolName, mcpArgs, { signal, timeoutMs });
      const durationMs = Date.now() - startMs;
      const arcResult = toArcResult(result, { tool, durationMs });
      return arcResult;
    } catch (raw) {
      const durationMs = Date.now() - startMs;
      const err = raw instanceof McpToolError ? raw : toMcpToolError(raw, {
        serverId: configId,
        toolName: wireName,
        isCancelled: context?.signal?.aborted === true
      });
      return {
        success: false,
        error: err.message,
        errorType: err.category,
        retryable: err.retryable,
        cancelled: err.category === CATEGORIES.CANCELLED,
        tool: wireName,
        durationMs,
        mcp: Object.freeze({
          serverId: configId,
          wireName,
          canonicalName: tool.canonicalName,
          originalToolName,
          durationMs
        })
      };
    }
  };
};

// The model sometimes stringifies argument objects on the wire.
const toMcpArgs = (args) => {
  if (args && typeof args === 'object') return args;
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      return {};
    }
  }
  return {};
};

// --- adapter shape for TaskExecutor -----------------------------------------

const wrapAsToolEntry = (arcSchema, execFn) => ({
  schema: arcSchema,
  execute: execFn
});

module.exports = {
  toArcSchema,
  toArcResult,
  toMcpArgs,
  normalizeResultContent,
  createExecAdapter,
  wrapAsToolEntry,
  sanitizeParameters,
  sanitizeProperty
};