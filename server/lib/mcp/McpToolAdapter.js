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
const { validateArgsAgainstSchema, formatValidationErrors } = require('./schemaValidate');
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
  const clean = sanitizeCompositional(schema, 0);
  if (!clean) return { type: 'object', properties: {}, required: [] };
  // Top level stays object-shaped (legacy contract) unless the server
  // declared a composition there.
  if (!clean.type && !clean.anyOf && !clean.oneOf && !clean.allOf) clean.type = 'object';
  return clean;
};

// Compositional schema sanitizer (generic JSON Schema subset). Preserves
// anyOf/oneOf/allOf branches RECURSIVELY — a typeless composition (e.g. a
// position that is {object A} OR {object B}) must never collapse to a
// defaulted 'string': that mistranslation makes the provider schema lie and
// the model generate shapes the live server rejects. Sibling keywords
// (type/properties/required/enum/...) are preserved alongside compositions.
// Unknown keywords fail open (dropped, never fatal). Depth-bounded so a
// hostile server cannot blow up context via nesting.
const SANITIZE_MAX_DEPTH = 8;

const sanitizeCompositional = (node, depth) => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  if (depth > SANITIZE_MAX_DEPTH) return null;
  const out = {};
  if (typeof node.type === 'string' && node.type) out.type = node.type;
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(node[key]) && node[key].length) {
      const branches = [];
      for (const branch of node[key].slice(0, 16)) {
        const clean = sanitizeCompositional(branch, depth + 1);
        if (clean) branches.push(clean);
      }
      if (branches.length) out[key] = branches;
    }
  }
  if (node.properties && typeof node.properties === 'object') {
    out.properties = {};
    for (const [key, val] of Object.entries(node.properties)) {
      const clean = sanitizeCompositional(val, depth + 1);
      out.properties[key] = clean || { type: 'string' };
    }
  }
  if (Array.isArray(node.required)) {
    out.required = node.required.filter((r) => typeof r === 'string');
  }
  if (node.items && typeof node.items === 'object') {
    const clean = sanitizeCompositional(node.items, depth + 1);
    if (clean) out.items = clean;
  }
  if (Array.isArray(node.enum)) out.enum = node.enum;
  if (node.default !== undefined) out.default = node.default;
  if (typeof node.description === 'string' && node.description) {
    out.description = toWellFormedUnicode(node.description);
  }
  if (typeof node.minimum === 'number') out.minimum = node.minimum;
  if (typeof node.maximum === 'number') out.maximum = node.maximum;
  if (typeof node.additionalProperties === 'boolean') out.additionalProperties = node.additionalProperties;
  // No type AND no compositional content: fail open with the legacy string
  // default so schemaless properties keep today's pass-through behavior.
  if (!out.type && !out.anyOf && !out.oneOf && !out.allOf && !out.properties && !out.items && !out.enum) {
    out.type = 'string';
  }
  return out;
};

const sanitizeProperty = (prop) => {
  return sanitizeCompositional(prop, 0) || { type: 'string' };
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
    const mcpMeta = () => Object.freeze({
      serverId: configId,
      wireName,
      canonicalName: tool.canonicalName,
      originalToolName,
      durationMs: Date.now() - startMs
    });
    try {
      const mcpArgs = toMcpArgs(args);
      // Pre-execution schema validation (generic invariant): arguments must
      // conform to the selected tool's actual inputSchema BEFORE any network
      // call. A model-hallucinated shape (object where the schema declares
      // a string) fails HERE with a structured, replan-able error instead of
      // burning a provider round-trip or a server 400. No coercion, no
      // invented defaults — mismatches are reported, never rewritten. The
      // validator fails open on schema shapes it cannot interpret, so tools
      // with exotic schemas keep today's pass-through behavior.
      const validation = validateArgsAgainstSchema(mcpArgs, tool.inputSchema);
      if (!validation.ok) {
        const durationMs = Date.now() - startMs;
        const detail = formatValidationErrors(validation.errors);
        return {
          success: false,
          error: `MCP argument validation failed for ${wireName}: ${detail}. Call was not executed.`,
          errorType: CATEGORIES.INVALID_ARGUMENTS,
          retryable: false,
          cancelled: false,
          tool: wireName,
          durationMs,
          validationErrors: validation.errors,
          mcp: mcpMeta()
        };
      }
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

// --- MCP annotation passthrough (generic, spec-shaped) ----------------------
// MCP tool definitions may carry `annotations` behavior hints
// (readOnlyHint, destructiveHint, idempotentHint, openWorldHint, title).
// They describe the TOOL, not the vendor: capability planning reads them
// without any tool-name knowledge. Only JSON-safe primitives are kept;
// anything else is dropped so a hostile server cannot smuggle payloads.
// Returns a frozen object or null when no usable hints exist. Pure.
const sanitizeAnnotations = (annotations) => {
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) return null;
  const out = {};
  for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
    if (typeof annotations[key] === 'boolean') out[key] = annotations[key];
  }
  if (typeof annotations.title === 'string' && annotations.title) {
    out.title = annotations.title.slice(0, 200);
  }
  return Object.keys(out).length > 0 ? Object.freeze(out) : null;
};

module.exports = {
  toArcSchema,
  toArcResult,
  toMcpArgs,
  normalizeResultContent,
  createExecAdapter,
  wrapAsToolEntry,
  sanitizeParameters,
  sanitizeProperty,
  sanitizeAnnotations,
};