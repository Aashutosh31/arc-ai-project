'use strict';

// JARVIS Action Substrate — slice 4A: server-authoritative authorization
// policy.
//
// Pure, deterministic, capability-keyed verdict engine. It consumes an
// authoritative capability (the Slice-1 substrate shape) plus an execution
// context plus an operator policy configuration, and returns a normalized
// authorization verdict. It NEVER executes anything, never touches the
// provider/model, never consults Jev, and imposes no pending approval state:
// "approval required" is a VERDICT ONLY in this slice.
//
// Verdict model (transitional, slice 4A default):
//   UNSPECIFIED       -> preserve existing behavior (allowed immediately).
//   AUTO              -> allowed immediately (low-risk / operator-override).
//   APPROVAL_REQUIRED -> requiresApproval=true AND allowed=true (provisional):
//                        NOT treated as denied while the approval transport
//                        (slice 4B) does not exist. Approval-required is a
//                        verdict; ARC must not silently block these actions.
//   DENIED            -> execution authorization fails.
//
//   mode 'enforce' (future, once the approval transport exists) turns
//   APPROVAL_REQUIRED into allowed=false, still gated by a real approval.
//
// MCP remains authoritative: an MCP capability is denied unless the caller
// supplies the already-authorized MCP projection (mcpAuthorized === true).
// A denied MCP capability can NEVER become allowed here. For MCP capabilities
// whose authorization is not confirmed, this engine fails safe (denies).
//
// Jev remains advisory. This engine never invokes or reads the decision
// layer; it decides from capability metadata + context + policy only.

const {
  SOURCE_NATIVE,
  SOURCE_MCP,
  SCOPE_READ,
  SCOPE_REVERSIBLE,
  SCOPE_CONSEQUENTIAL,
  SCOPES,
  RISKS,
} = require('./capabilityTypes');

const MODE_TRANSITIONAL = 'transitional';
const MODE_ENFORCE = 'enforce';

const MODES = Object.freeze([MODE_TRANSITIONAL, MODE_ENFORCE]);

const VERDICT_STATE = Object.freeze({
  AUTO: 'auto',
  APPROVAL_REQUIRED: 'approval_required',
  DENIED: 'denied',
  UNSPECIFIED: 'unspecified',
  MALFORMED: 'malformed',
});

const POLICY_SOURCE = Object.freeze({
  CAPABILITY: 'capability',
  POLICY_CONFIG: 'policy-config',
  MCP_AUTHORITY: 'mcp-authority',
  UNSPECIFIED: 'unspecified',
});

const REASON = Object.freeze({
  AUTO_READ: 'auto-read',
  AUTO_REVERSIBLE: 'reversible-default',
  APPROVAL_CONSEQUENTIAL: 'consequential-default',
  APPROVAL_POLICY: 'approval-policy',
  POLICY_DENY: 'policy-deny',
  MCP_DENIED: 'mcp-denied',
  MCP_UNCONFIRMED: 'mcp-policy-unconfirmed',
  UNSPECIFIED: 'unspecified',
  MALFORMED: 'malformed-capability',
  IDENTITY_MISMATCH: 'identity-mismatch',
  GUEST_DENIED: 'guest-denied',
  WORKSPACE_DENIED: 'workspace-restricted',
});

// Transitional 4A default: an empty operator table. With no entries every
// capability follows the scope/risk-derived default, so existing behavior is
// preserved.
const DEFAULT_POLICY = Object.freeze({
  // [{ id?: string, source?: 'native'|'mcp', name?: string,
  //    action: 'auto'|'approval_required'|'deny'|'unspecified',
  //    reason?: string }]
  entries: Object.freeze([]),
  // Capability IDs denied for guest actors.
  guestDenied: Object.freeze([]),
  // [{ id?: string|null (null = all), workspaceIds: string[] }]
  workspaceRestricted: Object.freeze([]),
});

// ---- pure helpers -----------------------------------------------------------

// Deterministic identity guard: rejects substituted/forged capability
// objects before any verdict is produced. Returns null when valid, else the
// failure REASON.
const validateCapabilityIdentity = (capability) => {
  if (!capability || typeof capability !== 'object') return REASON.MALFORMED;
  if (typeof capability.id !== 'string' || !capability.id) return REASON.MALFORMED;
  if (capability.source !== SOURCE_NATIVE && capability.source !== SOURCE_MCP) {
    return REASON.MALFORMED;
  }
  if (typeof capability.name !== 'string' || !capability.name) return REASON.MALFORMED;
  if (typeof capability.wireName !== 'string' || !capability.wireName) {
    return REASON.MALFORMED;
  }
  if (capability.scope !== null && capability.scope !== undefined && !SCOPES.includes(capability.scope)) {
    return REASON.MALFORMED;
  }
  if (capability.risk !== null && capability.risk !== undefined && !RISKS.includes(capability.risk)) {
    return REASON.MALFORMED;
  }
  // Capability ID/source substitution: the id must be derivable from the
  // declared identity, and the wire form must match the source namespace.
  if (capability.source === SOURCE_NATIVE) {
    if (capability.id !== `native:${capability.name}`) return REASON.IDENTITY_MISMATCH;
    if (capability.wireName !== capability.name) return REASON.IDENTITY_MISMATCH;
  } else {
    if (typeof capability.serverSlug !== 'string' || !capability.serverSlug) {
      return REASON.IDENTITY_MISMATCH;
    }
    if (!String(capability.wireName).startsWith('mcp_')) return REASON.IDENTITY_MISMATCH;
  }
  return null;
};

// First match by exact capability id, then (if no id hit) by source+name.
// Deterministic: input order is respected.
const matchPolicyEntry = (capability, policy) => {
  const entries = Array.isArray(policy && policy.entries) ? policy.entries : [];
  for (const entry of entries) {
    if (entry && entry.id === capability.id) return entry;
  }
  for (const entry of entries) {
    if (entry && entry.source === capability.source && entry.name === capability.name) {
      return entry;
    }
  }
  return null;
};

const buildAuto = ({ capability, reason, policySource }) => ({
  allowed: true,
  requiresApproval: false,
  state: VERDICT_STATE.AUTO,
  reason,
  policySource,
  risk: capability.risk,
  scope: capability.scope,
});

const buildApproval = ({ capability, reason, policySource, mode }) => ({
  allowed: mode === MODE_TRANSITIONAL,
  requiresApproval: true,
  state: VERDICT_STATE.APPROVAL_REQUIRED,
  reason,
  policySource,
  risk: capability.risk,
  scope: capability.scope,
});

const buildDenied = ({ capability, reason, policySource, state }) => ({
  allowed: false,
  requiresApproval: false,
  state: state || VERDICT_STATE.DENIED,
  reason,
  policySource,
  risk: capability ? capability.risk : null,
  scope: capability ? capability.scope : null,
});

// ---- main entry -------------------------------------------------------------

// authorizeCapability(capability, context?, options?)
//
//   capability  — authoritative Slice-1 capability object (see discover.js).
//   context     — { userId?, workspaceId?, isGuest? } (smallest authorization
//                 context; no second identity abstraction is created).
//   options     — {
//                   mode: 'transitional' (default) | 'enforce',
//                   policy: DEFAULT_POLICY | operator config,
//                   mcpAuthorized: true|false|undefined — MCP policy projection
//                     from the authoritative MCP pipeline (required for MCP
//                     capabilities; native ignores it).
//                 }
const authorizeCapability = (capability, context = {}, options = {}) => {
  const normalizedContext = context && typeof context === 'object' ? context : {};
  const normalizedOptions = options && typeof options === 'object' ? options : {};

  const identityError = validateCapabilityIdentity(capability);
  if (identityError) {
    return buildDenied({
      capability,
      reason: identityError,
      policySource: POLICY_SOURCE.CAPABILITY,
      state:
        identityError === REASON.MALFORMED
          ? VERDICT_STATE.MALFORMED
          : VERDICT_STATE.DENIED,
    });
  }

  const mode = MODES.includes(normalizedOptions.mode)
    ? normalizedOptions.mode
    : MODE_TRANSITIONAL;
  const policy =
    normalizedOptions.policy && typeof normalizedOptions.policy === 'object'
      ? normalizedOptions.policy
      : DEFAULT_POLICY;
  const isGuest = normalizedContext.isGuest === true;
  const workspaceId = normalizedContext.workspaceId;

  // 1. MCP authority is NOT overridable. An MCP capability needs its already-
  // authorized projection confirmed; anything else fails safe (denied).
  if (capability.source === SOURCE_MCP) {
    if (normalizedOptions.mcpAuthorized !== true) {
      const reason =
        normalizedOptions.mcpAuthorized === false
          ? REASON.MCP_DENIED
          : REASON.MCP_UNCONFIRMED;
      return buildDenied({
        capability,
        reason,
        policySource: POLICY_SOURCE.MCP_AUTHORITY,
      });
    }
  }

  // 2. Workspace restriction (operator-configured only; empty by default).
  const restricted = Array.isArray(policy.workspaceRestricted)
    ? policy.workspaceRestricted
    : [];
  for (const rule of restricted) {
    if (!rule || !Array.isArray(rule.workspaceIds)) continue;
    const applies = rule.id === null || rule.id === undefined || rule.id === capability.id;
    if (applies && !rule.workspaceIds.includes(workspaceId)) {
      return buildDenied({
        capability,
        reason: REASON.WORKSPACE_DENIED,
        policySource: POLICY_SOURCE.POLICY_CONFIG,
      });
    }
  }

  // 3. Guest restriction (operator-configured only; empty by default).
  const guestDenied = Array.isArray(policy.guestDenied) ? policy.guestDenied : [];
  if (isGuest && guestDenied.includes(capability.id)) {
    return buildDenied({
      capability,
      reason: REASON.GUEST_DENIED,
      policySource: POLICY_SOURCE.POLICY_CONFIG,
    });
  }

  // 4. Explicit operator entry (exact-id match, else source+name match).
  const entry = matchPolicyEntry(capability, policy);
  if (entry) {
    if (entry.action === 'deny') {
      return buildDenied({
        capability,
        reason: entry.reason || REASON.POLICY_DENY,
        policySource: POLICY_SOURCE.POLICY_CONFIG,
      });
    }
    if (entry.action === 'auto') {
      return buildAuto({
        capability,
        reason: entry.reason || 'policy-auto',
        policySource: POLICY_SOURCE.POLICY_CONFIG,
      });
    }
    if (entry.action === 'approval_required') {
      return buildApproval({
        capability,
        reason: entry.reason || REASON.APPROVAL_POLICY,
        policySource: POLICY_SOURCE.POLICY_CONFIG,
        mode,
      });
    }
    if (entry.action === 'unspecified') {
      return {
        allowed: true,
        requiresApproval: false,
        state: VERDICT_STATE.UNSPECIFIED,
        reason: REASON.UNSPECIFIED,
        policySource: POLICY_SOURCE.UNSPECIFIED,
        risk: capability.risk,
        scope: capability.scope,
      };
    }
  }

  // 5. Scope-derived default (the Slice-1 classification).
  if (capability.scope === SCOPE_READ) {
    return buildAuto({
      capability,
      reason: REASON.AUTO_READ,
      policySource: POLICY_SOURCE.CAPABILITY,
    });
  }
  if (capability.scope === SCOPE_REVERSIBLE) {
    return buildAuto({
      capability,
      reason: REASON.AUTO_REVERSIBLE,
      policySource: POLICY_SOURCE.CAPABILITY,
    });
  }
  if (capability.scope === SCOPE_CONSEQUENTIAL) {
    return buildApproval({
      capability,
      reason: REASON.APPROVAL_CONSEQUENTIAL,
      policySource: POLICY_SOURCE.CAPABILITY,
      mode,
    });
  }
  // Unspecified (scope/risk null) -> legacy-compatible: allowed immediately.
  return {
    allowed: true,
    requiresApproval: false,
    state: VERDICT_STATE.UNSPECIFIED,
    reason: REASON.UNSPECIFIED,
    policySource: POLICY_SOURCE.UNSPECIFIED,
    risk: capability.risk,
    scope: capability.scope,
  };
};

// Convenience predicate: the verdict grants immediate execution without any
// approval step.
const isAuthorized = (verdict) =>
  Boolean(verdict && verdict.allowed === true && verdict.requiresApproval !== true);

module.exports = {
  MODE_TRANSITIONAL,
  MODE_ENFORCE,
  MODES,
  VERDICT_STATE,
  POLICY_SOURCE,
  REASON,
  DEFAULT_POLICY,
  validateCapabilityIdentity,
  matchPolicyEntry,
  authorizeCapability,
  isAuthorized,
};