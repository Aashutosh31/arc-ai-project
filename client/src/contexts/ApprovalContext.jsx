// client/src/contexts/ApprovalContext.jsx
//
// JARVIS Action Substrate — slice 4D: frontend approval state + transport.
//
// Owns the pending-approval map, subscribes to `agent:approval:requested`,
// and is the ONLY place that emits `agent:approval:resolve` (with the 4C
// payload shape: { approvalId, decision } — identity is derived server-side,
// never sent). The server ack is authoritative: no approved/denied witness is
// fabricated client-side. Presentation-only cards consume this context; this
// provider never drives execution and never auto-approves.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { SocketContext } from './SocketContext';
import {
  applyExpiryTick,
  ackOfError,
  listApprovals,
  normalizeAckArgs,
  normalizeApprovalRequest,
  pendingCount,
  reconcileAck,
  requestAdd,
  resolveStart,
  UI_STATES,
} from '../lib/approvalUi';

const ACK_TIMEOUT_MS = 6000;

const ApprovalContext = createContext(null);

export const ApprovalProvider = ({ children }) => {
  const { socket } = useContext(SocketContext) || {};
  const [approvalsById, setApprovalsById] = useState({});
  const [now, setNow] = useState(() => Date.now());

  // Mirrors consulted inside async callbacks so they never read stale state.
  const approvalsRef = useRef(approvalsById);
  approvalsRef.current = approvalsById;

  // One-second tick drives the display-only expiry (pending → expired UI) and
  // the live countdown. The server's lazy TTL remains the enforcement authority.
  useEffect(() => {
    const tick = () => {
      const at = Date.now();
      setNow(at);
      setApprovalsById((prev) => applyExpiryTick(prev, at));
    };
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  // Register the approval-requested transport. Direct registration on the
  // socket (like ExecutionContext) so the useSocket ref-counted teardown
  // scope (SOCKET_EVENTS) can never strip this listener from other consumers.
  useEffect(() => {
    if (!socket) return undefined;
    const onRequested = (data) => {
      const record = normalizeApprovalRequest(data);
      if (!record) return;
      setApprovalsById((prev) => requestAdd(prev, record));
    };
    socket.on('agent:approval:requested', onRequested);
    return () => {
      try { socket.off('agent:approval:requested', onRequested); } catch { /* teardown */ }
    };
  }, [socket]);

  const resolveApproval = useCallback((approvalId, decision) => {
    if (!socket) return;
    const record = approvalsRef.current[approvalId];
    if (!record || record.uiState !== UI_STATES.PENDING) return;
    if (record.expiresAtMs != null && Date.now() >= record.expiresAtMs) return;

    setApprovalsById((prev) => resolveStart(prev, approvalId, decision));

    let settled = false;
    let ackTimer;
    const settle = (ack) => {
      if (settled) return;
      settled = true;
      if (ackTimer) clearTimeout(ackTimer);
      setApprovalsById((prev) => reconcileAck(prev, approvalId, ack));
    };

    try {
      // 4C contract: no userId, no executionId — identity is socket-bound.
      socket.emit('agent:approval:resolve', { approvalId, decision }, (...args) => {
        settle(normalizeAckArgs(args));
      });
      // Never leave a card stuck in "Sending…": a lost ack reverts to a
      // retryable pending state (a later resolve self-heals via the server's
      // already_resolved result).
      ackTimer = setTimeout(() => settle(ackOfError()), ACK_TIMEOUT_MS);
    } catch {
      settle(ackOfError());
    }
  }, [socket]);

  const value = useMemo(() => {
    const approvals = listApprovals(approvalsById, now);
    return {
      approvals,
      pending: pendingCount(approvalsById, now),
      now,
      resolveApproval,
    };
  }, [approvalsById, now, resolveApproval]);

  return <ApprovalContext.Provider value={value}>{children}</ApprovalContext.Provider>;
};

export const useApprovals = () => useContext(ApprovalContext) || {
  approvals: [],
  pending: 0,
  now: Date.now(),
  resolveApproval: () => {},
};