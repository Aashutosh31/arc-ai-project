'use strict';

// Structured MCP error categories. MCP failures must never be flattened into
// a generic "internal error": the agent needs to distinguish provisioning vs
// protocol vs tool-level problems so it can respond / retry correctly.

const PREFIX = 'mcp.';

const CATEGORIES = Object.freeze({
  SERVER_UNAVAILABLE: `${PREFIX}server_unavailable`,
  CONNECTION_TIMEOUT: `${PREFIX}connection_timeout`,
  AUTHENTICATION_FAILED: `${PREFIX}authentication_failed`,
  TOOL_NOT_FOUND: `${PREFIX}tool_not_found`,
  INVALID_ARGUMENTS: `${PREFIX}invalid_arguments`,
  PROTOCOL_ERROR: `${PREFIX}protocol_error`,
  TOOL_EXECUTION_ERROR: `${PREFIX}tool_execution_error`,
  OUTPUT_TOO_LARGE: `${PREFIX}output_too_large`,
  CANCELLED: `${PREFIX}cancelled`,
  NOT_AUTHORIZED: `${PREFIX}not_authorized`,
  NOT_CONNECTED: `${PREFIX}not_connected`
});

class McpToolError extends Error {
  constructor(category, message, options = {}) {
    super(message);
    this.name = 'McpToolError';
    this.category = category || CATEGORIES.PROTOCOL_ERROR;
    this.retryable = Boolean(options.retryable);
    this.serverId = options.serverId || null;
    this.toolName = options.toolName || null;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

// Deterministic classification of MCP SDK errors by code / class.
const classifySdkError = (error, options = {}) => {
  if (!error) return CATEGORIES.PROTOCOL_ERROR;
  if (options.isCancelled || error?.name === 'AbortError') return CATEGORIES.CANCELLED;

  const code = error?.code || error?.category || null;
  const status = error?.status ?? error?.statusCode;

  // HTTP auth / authorization failures (Streamable HTTP, OAuth, bearer).
  if (error?.name === 'UnauthorizedError' ||
      code === 'CLIENT_HTTP_AUTHENTICATION' ||
      status === 401 || status === 403) {
    return CATEGORIES.AUTHENTICATION_FAILED;
  }

  // Connection-level problems — server unreachable or dropped mid-request.
  if (code === 'CONNECTION_CLOSED' ||
      code === 'NOT_CONNECTED' ||
      code === 'SEND_FAILED' ||
      (status >= 500 && status <= 599) ||
      (status === 0 && code === null)) {
    return CATEGORIES.SERVER_UNAVAILABLE;
  }

  if (code === 'REQUEST_TIMEOUT' || /(timeout|timed out)/i.test(error?.message || '')) {
    return CATEGORIES.CONNECTION_TIMEOUT;
  }

  // Protocol- or config-level errors that should NOT be blindly retried.
  if (code === 'NOT_INITIALIZED' ||
      code === 'ALREADY_CONNECTED' ||
      code === 'METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION' ||
      code === 'ERA_NEGOTIATION_FAILED' ||
      code === 'INVALID_RESULT' ||
      code === 'CLIENT_HTTP_UNEXPECTED_CONTENT' ||
      code === 'CLIENT_HTTP_FAILED_TO_OPEN_STREAM') {
    return CATEGORIES.PROTOCOL_ERROR;
  }

  if (code === 'INVALID_PARAMS' || error?.name === 'InvalidParamsError') {
    return CATEGORIES.INVALID_ARGUMENTS;
  }

  return CATEGORIES.PROTOCOL_ERROR;
};

// Maps a raw SDK error into a McpToolError. Never called with secrets.
const toMcpToolError = (raw, options = {}) => {
  const message = raw instanceof Error ? raw.message : String(raw || 'MCP call failed.');
  const category = options.category || classifySdkError(raw, options);
  return new McpToolError(category, message, {
    retryable: Boolean(options.retryable || (category === CATEGORIES.SERVER_UNAVAILABLE)),
    serverId: options.serverId || raw?.serverId || null,
    toolName: options.toolName || raw?.toolName || null,
    cause: raw
  });
};

module.exports = {
  PREFIX,
  CATEGORIES,
  McpToolError,
  classifySdkError,
  toMcpToolError
};