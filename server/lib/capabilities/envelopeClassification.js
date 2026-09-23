'use strict';

// Conservative execution-outcome classification for the capability envelope.
//
// Turns an existing execution result shape into normalized terminal metadata
// WITHOUT hiding or rewriting the underlying result. The caller always keeps
// the original result object; classification only feeds the envelope/logs.
//
// Normalized error types (subset intentionally small and stable):
//   blocked | validation | authorization | timeout | cancelled |
//   provider | tool | unknown
//
// Mapping follows the existing project conventions (McpToolAdapter categories,
// credit BLOCKED status, AbortSignal) and never guesses on an ambiguous or
// unexplained failure.

const ERROR_TYPES = Object.freeze({
  BLOCKED: 'blocked',
  VALIDATION: 'validation',
  AUTHORIZATION: 'authorization',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  PROVIDER: 'provider',
  TOOL: 'tool',
  UNKNOWN: 'unknown',
});

const STATUS = Object.freeze({
  STARTED: 'started',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const TERMINAL_STATUS = Object.freeze([STATUS.SUCCEEDED, STATUS.FAILED, STATUS.CANCELLED]);

const isTerminal = (status) => TERMINAL_STATUS.includes(status);

// Existing MCP categories -> conservative envelope errorType.
const classifyMcpErrorType = (errorType) => {
  if (typeof errorType !== 'string' || !errorType.startsWith('mcp.')) {
    return ERROR_TYPES.UNKNOWN;
  }
  switch (errorType) {
    case 'mcp.invalid_arguments':
      return ERROR_TYPES.VALIDATION;
    case 'mcp.not_authorized':
    case 'mcp.auth_required':
    case 'mcp.authentication_failed':
      return ERROR_TYPES.AUTHORIZATION;
    case 'mcp.connection_timeout':
      return ERROR_TYPES.TIMEOUT;
    case 'mcp.cancelled':
      return ERROR_TYPES.CANCELLED;
    case 'mcp.tool_not_found':
    case 'mcp.tool_execution_error':
    case 'mcp.output_too_large':
      return ERROR_TYPES.TOOL;
    case 'mcp.server_unavailable':
    case 'mcp.protocol_error':
    case 'mcp.not_connected':
      return ERROR_TYPES.PROVIDER;
    default:
      return ERROR_TYPES.PROVIDER;
  }
};

// Classify a result object (or an aborted signal) into terminal metadata.
// Inputs may be:
//   - a success result   ({ success: true, ... })
//   - a failure result   ({ success: false, error?, errorType?, cancelled?, blocked? })
//   - null / undefined   (treated as unexplained failure)
//
// Returns { status, errorType }.
const classifyOutcome = (result, { signalAborted = false } = {}) => {
  if (signalAborted || (result && result.cancelled === true)) {
    return { status: STATUS.CANCELLED, errorType: ERROR_TYPES.CANCELLED };
  }

  if (result == null || result.success === false) {
    // Explicit block (credit policy) wins over generic tool failure.
    if (result && (result.blocked === true || result.status === 'BLOCKED')) {
      return { status: STATUS.FAILED, errorType: ERROR_TYPES.BLOCKED };
    }
    // Prefer the structured MCP category when present.
    if (result && typeof result.errorType === 'string') {
      // Slice 4B: execution-time authorization denial.
      if (result.errorType === 'execution.not_authorized') {
        return { status: STATUS.FAILED, errorType: ERROR_TYPES.AUTHORIZATION };
      }
      return { status: STATUS.FAILED, errorType: classifyMcpErrorType(result.errorType) };
    }
    return {
      status: STATUS.FAILED,
      errorType: result == null ? ERROR_TYPES.UNKNOWN : ERROR_TYPES.TOOL,
    };
  }

  return { status: STATUS.SUCCEEDED, errorType: null };
};

// Maps an envelope status to the matching observability event name.
const terminalEventFor = (status) => {
  switch (status) {
    case STATUS.SUCCEEDED:
      return 'capability.execution.succeeded';
    case STATUS.FAILED:
      return 'capability.execution.failed';
    case STATUS.CANCELLED:
      return 'capability.execution.cancelled';
    default:
      return null;
  }
};

module.exports = {
  ERROR_TYPES,
  STATUS,
  TERMINAL_STATUS,
  isTerminal,
  classifyMcpErrorType,
  classifyOutcome,
  terminalEventFor,
};