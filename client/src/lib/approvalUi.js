// client/src/lib/approvalUi.js
//
// JARVIS Action Substrate — slice 4D: pure UI-state model for the
// server-authoritative approval flow.
//
// The client's single source of truth is a per-approval record that mirrors
// the 4C transport payload (safe preview metadata only — never args,
// credentials, auth data or tool outputs). Terminal status is decided by the
// SERVER ack (`agent:approval:resolve` result): APPROVED / DENIED / EXPIRED /
// CANCELLED are never fabricated locally. Local expiry is a display concern
// only — the server's lazy TTL is the enforcement authority and any late
// approve is rejected by the store.
//
// This module is intentionally pure (no React, no socket, no timers) so the
// whole state machine is unit-testable like the other client suites
// (`tests/*.test.mjs`, plain node).

export const SERVER_STATES = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  DENIED: 'DENIED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
});

export const UI_STATES = Object.freeze({
  PENDING: 'pending',
  BUSY: 'busy',
  APPROVED: 'approved',
  DENIED: 'denied',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  ERROR: 'error',
});

const TERMINAL_UI = new Set([
  UI_STATES.APPROVED,
  UI_STATES.DENIED,
  UI_STATES.EXPIRED,
  UI_STATES.CANCELLED,
]);

// The ONLY fields that survive into UI state. Anything else the transport
// might ever carry (tool args, credentials, auth data, outputs, nested
// payloads) is dropped here so no secret can reach markup.
const ALLOWED_FIELDS = [
  'approvalId',
  'executionId',
  'capabilityId',
  'toolName',
  'source',
  'risk',
  'scope',
  'reason',
  'expiresAt',
  'state',
];

const parseExpiryMs = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
};

// Validate + whitelist an incoming `agent:approval:requested` payload.
// Returns a minimal record, or null when it is not a usable approval request
// (missing approvalId). Unknown/unsafe fields never survive.
export const normalizeApprovalRequest = (payload) => {
  const src = payload && typeof payload === 'object' ? payload : {};
  const approvalId = typeof src.approvalId === 'string' && src.approvalId ? src.approvalId : null;
  if (!approvalId) return null;
  const record = {
    approvalId,
    receivedAt: Date.now(),
    uiState: UI_STATES.PENDING,
    pendingDecision: null,
    resolvedAt: null,
    error: null,
  };
  for (const field of ALLOWED_FIELDS) {
    if (field === 'approvalId') continue;
    const value = src[field];
    if (value === undefined || value === null) continue;
    if (field === 'expiresAt') {
      record.expiresAtMs = parseExpiryMs(value);
      continue;
    }
    record[field] = String(value);
  }
  return record;
};

const serverStateToUi = (state) => {
  switch (String(state || '').toUpperCase()) {
    case SERVER_STATES.APPROVED: return UI_STATES.APPROVED;
    case SERVER_STATES.DENIED: return UI_STATES.DENIED;
    case SERVER_STATES.EXPIRED: return UI_STATES.EXPIRED;
    case SERVER_STATES.CANCELLED: return UI_STATES.CANCELLED;
    case SERVER_STATES.PENDING: return UI_STATES.PENDING;
    default: return null;
  }
};

export const isTerminalStatus = (status) => TERMINAL_UI.has(status);

// Upsert a (normalized) request into the pending map. Duplicate events for
// the same approval id refresh the preview metadata; a card that is already
// terminal is never resurrected by a stale repeat.
export const requestAdd = (map, record) => {
  if (!record || !record.approvalId) return map;
  const existing = map[record.approvalId];
  return {
    ...map,
    [record.approvalId]: {
      ...record,
      receivedAt: existing ? existing.receivedAt : record.receivedAt || Date.now(),
      uiState: existing ? existing.uiState : UI_STATES.PENDING,
      pendingDecision: existing ? existing.pendingDecision : null,
      resolvedAt: existing ? existing.resolvedAt : null,
      error: existing ? existing.error : null,
    },
  };
};

// Mark a decision as in flight. The card disables while BUSY; only a pending
// card can start a resolve (double-approve race guard on the client; the
// server CAS is the real authority).
export const resolveStart = (map, approvalId, decision) => {
  const record = map[approvalId];
  if (!record) return map;
  const normalizedDecision = decision === 'approve' || decision === 'deny' ? decision : null;
  if (!normalizedDecision) return map;
  if (record.uiState !== UI_STATES.PENDING) return map;
  return {
    ...map,
    [approvalId]: {
      ...record,
      uiState: UI_STATES.BUSY,
      pendingDecision: normalizedDecision,
    },
  };
};

const applyServerState = (map, approvalId, state, note) => {
  const record = map[approvalId];
  const ui = serverStateToUi(state);
  if (!ui) return map;
  return {
    ...map,
    [approvalId]: {
      ...record,
      uiState: ui,
      state,
      pendingDecision: null,
      resolvedAt: Date.now(),
      error: note || null,
    },
  };
};

// Reconcile the server ack after `agent:approval:resolve`. The server is
// authoritative: ok:true carries the terminal state; ok:false with a state
// (already_resolved / expired) also lands the served status. A network
// failure returns the card to pending so the user can retry — a later resolve
// self-heals through the server's already_resolved result. Anything else
// (unknown id, invalid decision, user mismatch, store error) is surfaced as
// an ERROR without claiming a result.
export const reconcileAck = (map, approvalId, ack) => {
  const record = map[approvalId];
  if (!record) return map;
  const ackState = ack && typeof ack.state === 'string' ? ack.state.toUpperCase() : null;
  const ok = ack && ack.ok === true;

  if (ok && ackState) return applyServerState(map, approvalId, ackState, null);
  if (!ok && ackState) return applyServerState(map, approvalId, ackState, ack.reason || null);
  if (!ok && ack && (ack.reason === 'network' || ack.reason === 'no-ack')) {
    return {
      ...map,
      [approvalId]: {
        ...record,
        uiState: UI_STATES.PENDING,
        pendingDecision: null,
        error: 'Could not confirm with the server — please retry.',
      },
    };
  }
  return {
    ...map,
    [approvalId]: {
      ...record,
      uiState: UI_STATES.ERROR,
      pendingDecision: null,
      error: ack && ack.reason ? `Approval failed: ${ack.reason}.` : 'Approval could not be sent.',
    },
  };
};

// Display-only local expiry: a PENDING card past its expiresAt flips to
// EXPIRED in the UI. The server remains the authority (it lazily expires and
// rejects any late approve); nothing here claims the action was or was not run.
export const applyExpiryTick = (map, now) => {
  let changed = false;
  const next = {};
  for (const id of Object.keys(map)) {
    const record = map[id];
    if (record.uiState === UI_STATES.PENDING && record.expiresAtMs != null && now >= record.expiresAtMs) {
      next[id] = {
        ...record,
        uiState: UI_STATES.EXPIRED,
        resolvedAt: record.resolvedAt || now,
      };
      changed = true;
    } else {
      next[id] = record;
    }
  }
  return changed ? next : map;
};

export const displayStatus = (record, now) => {
  if (!record) return null;
  const status = record.uiState || UI_STATES.PENDING;
  if (status === UI_STATES.PENDING && record.expiresAtMs != null && now >= record.expiresAtMs) {
    return UI_STATES.EXPIRED;
  }
  return status;
};

export const canDecide = (record, now) => {
  if (!record) return false;
  if ((record.uiState || UI_STATES.PENDING) !== UI_STATES.PENDING) return false;
  if (record.expiresAtMs != null && now >= record.expiresAtMs) return false;
  return true;
};

export const formatExpiry = (record, now) => {
  if (!record) return null;
  if (displayStatus(record, now) === UI_STATES.EXPIRED) return 'Expired';
  if (record.expiresAtMs == null) return null;
  const seconds = Math.max(0, Math.ceil((record.expiresAtMs - now) / 1000));
  if (seconds <= 0) return 'Expiring';
  return `Expires in ${seconds}s`;
};

export const riskTone = (risk) => {
  const normalized = String(risk || '').toLowerCase();
  if (normalized === 'high') return 'destructive';
  if (normalized === 'medium') return 'warning';
  return 'default';
};

export const riskLabel = (risk) => {
  const normalized = String(risk || '').toLowerCase();
  if (normalized === 'high') return 'High risk';
  if (normalized === 'medium') return 'Moderate risk';
  if (normalized === 'low') return 'Low risk';
  return 'Risk unknown';
};

export const scopeLabel = (scope) => {
  const normalized = String(scope || '').toLowerCase();
  if (normalized === 'read') return 'Reads data only';
  if (normalized === 'reversible') return 'Reversible action';
  if (normalized === 'consequential') return 'Has lasting external effects';
  return null;
};

export const sourceLabel = (source) => {
  const normalized = String(source || '').toLowerCase();
  if (normalized === 'native') return 'Native tool';
  if (normalized === 'mcp') return 'MCP tool';
  return source || null;
};

// Sorted newest-first (by arrival) with the resolved display status attached.
export const listApprovals = (map, now) =>
  Object.keys(map || {})
    .map((id) => ({ ...map[id], status: displayStatus(map[id], now) }))
    .sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0) || a.approvalId.localeCompare(b.approvalId));

export const pendingCount = (map, now) =>
  Object.keys(map || {}).reduce(
    (count, id) => (displayStatus(map[id], now) === UI_STATES.PENDING ? count + 1 : count),
    0
  );

// Socket.IO ack normalizers (pure).
export const ackOfError = (err) => ({
  ok: false,
  reason: err ? 'network' : 'no-ack',
});

export const ackOfResponse = (resp) => {
  if (resp && typeof resp === 'object' && typeof resp.ok === 'boolean') {
    return { ok: resp.ok, reason: resp.reason || null, state: resp.state || null };
  }
  return ackOfError();
};

// Normalize the raw socket.io client ack callback args to the {ok, reason,
// state} ack consumed by reconcileAck. The server acks a single object
// (`ack(result)`), so whatever object-shaped arg arrives is authoritative; any
// other outcome (no args, non-object) is treated as a missing ack so the card
// can revert to a retryable pending state instead of hanging in BUSY.
export const normalizeAckArgs = (args) => {
  const list = Array.isArray(args) ? args : [args];
  for (const arg of list) {
    if (arg && typeof arg === 'object' && typeof arg.ok === 'boolean') {
      return ackOfResponse(arg);
    }
  }
  return ackOfError();
};