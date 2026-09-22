'use strict';

// Normalized ARC capability contract + validation.
//
// The substrate treats every executable surface (native tool, MCP tool) as a
// CAPABILITY with a single normalized shape. This module defines that shape
// and validates it. It is pure metadata — no execution, no policy.

const SOURCE_NATIVE = 'native';
const SOURCE_MCP = 'mcp';

const SCOPE_READ = 'read';
const SCOPE_REVERSIBLE = 'reversible';
const SCOPE_CONSEQUENTIAL = 'consequential';

const RISK_LOW = 'low';
const RISK_MEDIUM = 'medium';
const RISK_HIGH = 'high';

const SOURCES = Object.freeze([SOURCE_NATIVE, SOURCE_MCP]);
const SCOPES = Object.freeze([SCOPE_READ, SCOPE_REVERSIBLE, SCOPE_CONSEQUENTIAL]);
const RISKS = Object.freeze([RISK_LOW, RISK_MEDIUM, RISK_HIGH]);

// Full capability contract. The execution envelope (timeoutMs, cancellation,
// idempotency, observability) arrives in a later slice; those fields are
// present now as null / defaults so the shape is stable.
//
// {
//   id: string,                  // stable unique: "native:<tool>" | canonical "mcp.<slug>.<tool>"
//   source: 'native' | 'mcp',
//   name: string,                // tool name (native) / originalToolName (mcp)
//   wireName: string,            // what the model calls (native name | mcp wire)
//   serverSlug: string | null,   // mcp only
//   description: string,
//   scope: 'read'|'reversible'|'consequential' | null,   // null = uncategorized
//   risk: 'low'|'medium'|'high' | null,                  // null = uncategorized
//   inputSchema: object,
//   annotations: object | null,  // sanitized MCP hints
//   metadata: {                  // preserved source provenance
//     workspaceId: string | null,
//     isGuest: boolean,
//     serverId: string | null,
//     configName: string | null,
//     configScope: string | null,
//   },
//   // Execution-envelope fields (NOT active in this slice):
//   timeoutMs: null,
//   cancellation: 'cooperative',
//   idempotency: 'safe',
//   observability: 'line',
// }

const validateSource = (value) => {
  if (!SOURCES.includes(value)) return `source must be one of ${SOURCES.join(', ')}; got ${JSON.stringify(value)}`;
  return null;
};

const validateScope = (value) => {
  if (value === null || value === undefined) return null; // uncategorized
  if (!SCOPES.includes(value)) return `scope must be one of ${SCOPES.join(', ')}; got ${JSON.stringify(value)}`;
  return null;
};

const validateRisk = (value) => {
  if (value === null || value === undefined) return null; // uncategorized
  if (!RISKS.includes(value)) return `risk must be one of ${RISKS.join(', ')}; got ${JSON.stringify(value)}`;
  return null;
};

// Returns array of validation error strings (empty = valid).
const validateCapability = (cap) => {
  const errors = [];
  if (!cap || typeof cap !== 'object') return ['capability must be an object'];
  if (typeof cap.id !== 'string' || !cap.id) errors.push('id is required (non-empty string)');
  const srcErr = validateSource(cap.source);
  if (srcErr) errors.push(srcErr);
  if (typeof cap.name !== 'string' || !cap.name) errors.push('name is required (non-empty string)');
  if (typeof cap.wireName !== 'string' || !cap.wireName) errors.push('wireName is required (non-empty string)');
  const scopeErr = validateScope(cap.scope);
  if (scopeErr) errors.push(scopeErr);
  const riskErr = validateRisk(cap.risk);
  if (riskErr) errors.push(riskErr);
  if (!cap.inputSchema || typeof cap.inputSchema !== 'object') {
    errors.push('inputSchema is required (object)');
  }
  if (cap.metadata === null || cap.metadata === undefined || typeof cap.metadata !== 'object') {
    errors.push('metadata is required (object)');
  }
  return errors;
};

// True shape guard: severe mismatches that would break downstream consumers.
const isCapability = (cap) =>
  validateCapability(cap).length === 0 &&
  (cap.source === SOURCE_NATIVE || cap.source === SOURCE_MCP);

module.exports = {
  SOURCE_NATIVE,
  SOURCE_MCP,
  SCOPE_READ,
  SCOPE_REVERSIBLE,
  SCOPE_CONSEQUENTIAL,
  RISK_LOW,
  RISK_MEDIUM,
  RISK_HIGH,
  SOURCES,
  SCOPES,
  RISKS,
  validateSource,
  validateScope,
  validateRisk,
  validateCapability,
  isCapability,
};