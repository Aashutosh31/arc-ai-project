'use strict';

// Pure capability risk/scope mapping.
//
// The FIRST substrate slice is inventory-only: this module classifies
// capabilities by scope and risk as METADATA. It has no policy behavior —
// nothing in ARC consults it for gating, and none of the existing
// authority (native TaskExecutor, MCP policy) is consulted through it.
// Slice 4A completes the native table so EVERY registered native tool is
// classified; the classification remains metadata — the authorization
// policy layer (authorizationPolicy.js) consumes it, it does not gate here.
//
//   nativeRiskFor(name)   -> { scope, risk } | null   (declared mapping)
//   mcpRiskFor(annotations) -> { scope, risk } | null (MCP hint-derived)
//
// Unclassified capabilities return null so the registry can surface them as
// "uncategorized" rather than guessing.
//
// Classification basis (per tool implementation, not name):
//   read          -> observes/derives only; no state change outside the call
//   reversible    -> in-session/low blast radius; user can readily undo
//   consequential -> real-world external side effect, hard to undo
//   risk low/medium/high reflects blast radius; conservative where the tool
//   is inherently high-impact.

const SCOPE_READ = 'read';
const SCOPE_REVERSIBLE = 'reversible';
const SCOPE_CONSEQUENTIAL = 'consequential';

// Declared native mappings for the real tool registry (all tools loaded by
// server/tools). Pure metadata derived from each tool implementation.
// Anything not listed here stays uncategorized (null) rather than guessed.
const NATIVE_SCOPE_RISK = Object.freeze({
  // ---- read / low: pure observation or derivation, local state only ----
  getTime: Object.freeze({ scope: SCOPE_READ, risk: 'low' }),
  getWeather: Object.freeze({ scope: SCOPE_READ, risk: 'low' }),
  getTopNews: Object.freeze({ scope: SCOPE_READ, risk: 'low' }),
  webSearch: Object.freeze({ scope: SCOPE_READ, risk: 'low' }),
  scrapeWebsite: Object.freeze({ scope: SCOPE_READ, risk: 'low' }),
  checkCalendar: Object.freeze({ scope: SCOPE_READ, risk: 'low' }),
  recallMemory: Object.freeze({ scope: SCOPE_READ, risk: 'low' }),

  // ---- read / medium: read-only but heavy, network-rich, or arbitrary ----
  executeCode: Object.freeze({ scope: SCOPE_READ, risk: 'medium' }),
  deepResearchSwarm: Object.freeze({ scope: SCOPE_READ, risk: 'medium' }),

  // ---- reversible / low: user-facing, in-session, readily undone ----
  playMedia: Object.freeze({ scope: SCOPE_REVERSIBLE, risk: 'low' }),
  stopMedia: Object.freeze({ scope: SCOPE_REVERSIBLE, risk: 'low' }),
  changeTheme: Object.freeze({ scope: SCOPE_REVERSIBLE, risk: 'low' }),
  openWebsite: Object.freeze({ scope: SCOPE_REVERSIBLE, risk: 'low' }),
  copyToClipboard: Object.freeze({ scope: SCOPE_REVERSIBLE, risk: 'low' }),
  createReminder: Object.freeze({ scope: SCOPE_REVERSIBLE, risk: 'low' }),
  setReminder: Object.freeze({ scope: SCOPE_REVERSIBLE, risk: 'low' }),
  stopReminder: Object.freeze({ scope: SCOPE_REVERSIBLE, risk: 'low' }),
  memorize: Object.freeze({ scope: SCOPE_REVERSIBLE, risk: 'low' }),
  storeUserFact: Object.freeze({ scope: SCOPE_REVERSIBLE, risk: 'low' }),

  // ---- consequential / high: irreversible external side effects ----
  sendEmail: Object.freeze({ scope: SCOPE_CONSEQUENTIAL, risk: 'high' }),
  sendWhatsAppMessage: Object.freeze({ scope: SCOPE_CONSEQUENTIAL, risk: 'high' }),
  scheduleMeeting: Object.freeze({ scope: SCOPE_CONSEQUENTIAL, risk: 'high' }),
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