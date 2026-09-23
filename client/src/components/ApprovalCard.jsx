// client/src/components/ApprovalCard.jsx
//
// JARVIS Action Substrate — slice 4D: conversation-first approval card.
//
// Presentation-only by contract: it renders one approval record into the
// conversation flow and calls `onResolve(approvalId, decision)` when the user
// acts. It never auto-approves, never fabricates a result, never renders
// arguments/credentials/outputs (the record already whitelists them), never
// blocks the composer, never steals focus, and never drives execution.
//
// Wording contract: the card asks for permission to run the tool; it never
// claims the action was or will be performed until the server says so.
import React from 'react';
import styled from 'styled-components';
import { Badge, Button as UiButton } from './ui';
import {
  canDecide,
  displayStatus,
  formatExpiry,
  isTerminalStatus,
  riskLabel,
  riskTone,
  scopeLabel,
  sourceLabel,
  UI_STATES,
} from '../lib/approvalUi';

// Visually distinct from assistant/streaming output: a tinted region with a
// left accent edge plus a labeled status footer. The accent is duplicated by
// text (risk label, status text) so meaning is never color-only.
const Region = styled.section`
  width: 100%;
  border-radius: 12px;
  border: 1px solid rgba(var(--warning-rgb), 0.18);
  background: rgba(var(--warning-rgb), 0.05);
  border-left: 3px solid rgba(var(--warning-rgb), 0.6);
  overflow: hidden;

  &[data-risk='destructive'] {
    border-color: rgba(var(--destructive-rgb), 0.2);
    background: rgba(var(--destructive-rgb), 0.05);
    border-left-color: rgba(var(--destructive-rgb), 0.65);
  }
  &[data-risk='default'] {
    border-color: rgba(var(--primary-rgb), 0.18);
    background: rgba(var(--primary-rgb), 0.04);
    border-left-color: rgba(var(--primary-rgb), 0.55);
  }
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 12px 6px;
`;

const Title = styled.h3`
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--foreground);
`;

const Source = styled.span`
  font-size: 11px;
  color: var(--foreground-subtle);
  margin-left: auto;
`;

const Body = styled.div`
  padding: 4px 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--foreground-muted);
`;

const Why = styled.p`
  margin: 0;
  color: var(--foreground);
`;

const MetaRow = styled.div`
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
`;

const Note = styled.p`
  margin: 0;
  font-size: 11.5px;
  color: var(--foreground-subtle);
`;

const Actions = styled.div`
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 0 12px 10px;
  flex-wrap: wrap;
`;

const Footer = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 12px;
  background: rgba(0, 0, 0, 0.12);
`;

const StatusDot = styled.span`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: ${({ $tone }) => {
    if ($tone === 'success') return 'var(--success)';
    if ($tone === 'destructive') return 'var(--destructive)';
    if ($tone === 'warning') return 'var(--warning)';
    return 'var(--foreground-subtle)';
  }};
`;

const NoteIcon = styled.span`
  font-size: 11px;
  flex-shrink: 0;
`;

const CANCELLED = UI_STATES.CANCELLED;
const EXPIRED = UI_STATES.EXPIRED;

const termsFor = (approval, status) => {
  const terms = { tone: 'default', text: 'Awaiting decision' };
  if (status === UI_STATES.BUSY) {
    terms.text = approval.pendingDecision === 'deny' ? 'Sending decision…' : 'Sending decision…';
    terms.tone = 'warning';
  } else if (status === UI_STATES.APPROVED) {
    terms.text = 'Approved · ARC may now proceed';
    terms.tone = 'success';
  } else if (status === UI_STATES.DENIED) {
    terms.text = 'Denied · the tool will not run';
    terms.tone = 'destructive';
  } else if (status === EXPIRED) {
    terms.text = 'Expired · no decision was received';
    terms.tone = 'warning';
  } else if (status === CANCELLED) {
    terms.text = 'Cancelled · no decision was received';
    terms.tone = 'warning';
  } else if (status === UI_STATES.ERROR) {
    terms.text = approval.error || 'Something went wrong while contacting the server.';
    terms.tone = 'destructive';
  }
  return terms;
};

const ApprovalCard = ({ approval, now, onResolve }) => {
  const status = displayStatus(approval, now);
  const terminal = isTerminalStatus(status);
  const decided = status === UI_STATES.APPROVED || status === UI_STATES.DENIED;
  const busy = status === UI_STATES.BUSY;
  const actionable = canDecide(approval, now);
  const scope = scopeLabel(approval.scope);
  const source = sourceLabel(approval.source);
  const expiry = formatExpiry(approval, now);
  const tone = riskTone(approval.risk);
  const terms = termsFor(approval, status);

  return (
    <Region data-risk={tone} aria-label={`Permission requested for ${approval.toolName || 'tool'}`}>
      <Header>
        <Title>Permission requested</Title>
        <Badge tone={tone} outline>{riskLabel(approval.risk)}</Badge>
        {scope && <Badge tone="default" outline>{scope}</Badge>}
        {source && <Source>{source}</Source>}
      </Header>

      <Body>
        <Why>ARC is requesting permission to use <strong>{approval.toolName || 'a tool'}</strong>.</Why>
        {approval.reason && <MetaRow>Why: {approval.reason}</MetaRow>}
        {expiry && !decided && <MetaRow>Expiry: {expiry}</MetaRow>}
        {!decided && !terminal && (
          <Note>Approving lets ARC run this action. Nothing runs before you decide.</Note>
        )}
      </Body>

      {!terminal && (
        <Actions>
          <UiButton
            variant="primary"
            size="sm"
            disabled={!actionable}
            onClick={() => onResolve?.(approval.approvalId, 'approve')}
          >
            {busy && approval.pendingDecision === 'approve' ? 'Sending…' : 'Approve'}
          </UiButton>
          <UiButton
            variant="danger-outline"
            size="sm"
            disabled={!actionable}
            onClick={() => onResolve?.(approval.approvalId, 'deny')}
          >
            {busy && approval.pendingDecision === 'deny' ? 'Sending…' : 'Deny'}
          </UiButton>
        </Actions>
      )}

      <Footer aria-live="polite" role="status">
        <NoteIcon>ⓘ</NoteIcon>
        <StatusDot $tone={terms.tone} />
        <span>{terms.text}</span>
      </Footer>
    </Region>
  );
};

export default ApprovalCard;