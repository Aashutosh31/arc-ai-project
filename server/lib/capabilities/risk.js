'use strict';

// Pure capability risk/scope mapping.
//
// The FIRST substrate slice is inventory-only: this module classifies
// capabilities by scope and risk as METADATA. It has no policy behavior —
// nothing in ARC consults it for gating, and none of the existing
// authority (native TaskExecutor, MCP policy) is consulted through it.
//
//   nativeRiskFor(name)   -> { scope, risk } | null   (declared mapping only)
//   mcpRiskFor(name)      -> { scope, risk } | null   (annotation-derived)
//
// Unclassified capabilities return null so the registry can surface them as
// "uncategorized" rather than guessing.

const SCOPE_READ = 'read';
const SCOPE_REVERSIBLE = 'reversible';
const SCOPE_CONSEQUENTIAL = 'consequential';

// Declared native mappings for the initial representative tools. Pure
// metadata only. Anything not listed here stays uncategorized (null) until
// a future classification pass.
const NATIVE_SCOPE_RISK = Object.freeze({
  webSearch: Object.freeze({ scope: SCOPE_READ, risk: 'low' }),
  checkCalendar: Object.freeze({ scope: SCOPE_READ, risk: 'low' }),
  playMedia: Object.freeze({ scope: SCOPE_REVERSIBLE, risk: 'low' }),
  changeTheme: Object.freeze({ scope: SCOPE_REVERSIBLE, risk: 'low' }),
});

// MCP tools carry MCP behavior hints (sanitized in McpToolAdapter):
// readOnlyHint / destructiveHint / idempotentHint / openWorldHint / title.
// These generic hints describe the TOOL, not the vendor — this mapping
// reads them without any tool-name knowledge.
const mcpRiskFor = (annotations) => {
  if (!annotations || typeof annotations !== 'object') return null;
  if (annotations.readOnlyHint === true) {
    return { scope: SCOPE_READ, risk: 'low' };
  }
  if (annotations.destructiveHint === true) {
    return { scope: SCOPE_CONSEQUENTIAL, risk: 'high' };
  }
  if (annotations.openWorldHint === true) {
    return { scope: SCOPE_CONSEQUENTIAL, risk: 'medium' };
  }
  if (annotations.idempotentHint === true) {
    return { scope: SCOPE_REVERSIBLE, risk: 'medium' };
  }
  return null;
};

const nativeRiskFor = (name) => {
  if (!name || typeof name !== 'string') return null;
  const mapped = NATIVE_SCOPE_RISK[name];
  if (!mapped) return null;
  return { scope: mapped.scope, risk: mapped.risk };
};

module.exports = {
  NATIVE_SCOPE_RISK,
  SCOPE_READ,
  SCOPE_REVERSIBLE,
  SCOPE_CONSEQUENTIAL,
  nativeRiskFor,
  mcpRiskFor,
};