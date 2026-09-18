import React, { useEffect, useMemo, useState } from 'react';
import styled, { keyframes } from 'styled-components';
import { useExecution } from '../contexts/ExecutionContext';

// Compact, non-blocking execution status.
//
// Presentation-only by contract: this panel NEVER drives execution. It
// renders socket status into a small collapsible strip beside the chat —
// it never overlays the composer/messages in a blocking way, never steals
// focus, never prevents scrolling or typing, and hiding/collapsing/closing
// it never cancels or interrupts the underlying request (the Stop control
// lives in the chat input, not here).
//
// Normal state: a one-line strip ("Using tools…" / "Completed · N tools").
// The detailed step trace is opt-in via click-to-expand.

const dotPulse = keyframes`
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
`;

const Strip = styled.section`
  background: var(--surface);
  border: 1px solid rgba(var(--primary-rgb), 0.14);
  border-radius: 12px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
  overflow: hidden;
  min-width: 0;
  max-width: 100%;
`;

const StripHeader = styled.button`
  appearance: none;
  width: 100%;
  border: 0;
  padding: 8px 10px;
  background: transparent;
  color: var(--foreground);
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
  line-height: 1.4;

  &:focus-visible {
    outline: 1px solid rgba(var(--primary-rgb), 0.5);
    outline-offset: -1px;
  }
`;

const Dot = styled.span`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: ${({ $state }) => ($state === 'FAILED' ? 'var(--destructive)' : $state === 'BLOCKED' ? 'var(--warning)' : $state === 'COMPLETED' ? 'var(--success)' : 'var(--primary-hex)')};
  animation: ${({ $state }) => ($state === 'RUNNING' || $state === 'PLANNED' ? dotPulse : 'none')} 1.6s ease-in-out infinite;
`;

const StripText = styled.span`
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(215, 250, 255, 0.85);
`;

const StripToggle = styled.span`
  color: rgba(215, 250, 255, 0.6);
  font-size: 11px;
  flex-shrink: 0;
`;

const DismissButton = styled.button`
  appearance: none;
  border: 0;
  background: transparent;
  color: rgba(215, 250, 255, 0.55);
  font-size: 13px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 6px;
  cursor: pointer;
  flex-shrink: 0;

  &:hover { color: var(--foreground); background: rgba(255,255,255,0.06); }
`;

const Details = styled.div`
  padding: 0 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
`;

const StepRow = styled.div`
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.07);
  font-size: 11px;
  min-width: 0;
`;

const StepName = styled.span`
  font-weight: 600;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const StepStatus = styled.span`
  margin-left: auto;
  flex-shrink: 0;
  color: rgba(215, 250, 255, 0.65);
  text-transform: lowercase;
`;

const ExecutionPanel = () => {
  const { activeExecution, presence } = useExecution();
  // Collapsed by default: details are opt-in. Dismissed hides the strip
  // entirely until the NEXT execution arrives. Both are local UI state —
  // neither touches execution, planner state, or the MCP runtime.
  const [isExpanded, setIsExpanded] = useState(false);
  const [dismissedId, setDismissedId] = useState(null);

  const executionId = activeExecution?.executionId || null;
  const steps = activeExecution?.steps || [];
  const state = String(activeExecution?.status || 'PLANNED').toUpperCase();
  const isRunning = state === 'RUNNING' || state === 'PLANNED';

  // A new execution un-dismisses the strip (still collapsed — opt-in).
  useEffect(() => {
    if (executionId) setDismissedId((prev) => (prev === executionId ? prev : null));
  }, [executionId]);

  const summary = useMemo(() => {
    if (!activeExecution) return 'No active execution';
    if (isRunning) {
      const tool = steps.find((s) => String(s.status || '').toUpperCase() === 'RUNNING')?.tool;
      return tool ? `Using ${tool}…` : 'Using tools…';
    }
    const n = steps.length;
    const label = state === 'FAILED' ? 'Failed' : state === 'BLOCKED' ? 'Blocked' : state === 'CANCELLED' ? 'Cancelled' : 'Completed';
    return n ? `${label} · ${n} tool${n === 1 ? '' : 's'}` : label;
  }, [activeExecution, isRunning, steps, state]);

  if (!activeExecution || dismissedId === executionId) return null;

  return (
    <Strip aria-live="polite" aria-label="Tool execution status">
      <StripHeader
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        title={isExpanded ? 'Collapse execution details' : 'Expand execution details'}
      >
        <Dot $state={state} />
        <StripText>{summary}</StripText>
        <StripToggle>{isExpanded ? '▾' : '▸'}</StripToggle>
        <DismissButton
          type="button"
          aria-label="Hide execution status"
          title="Hide (does not stop execution)"
          onClick={(e) => {
            // Local hide only — presentation state, never execution state.
            e.stopPropagation();
            setDismissedId(executionId);
            setIsExpanded(false);
          }}
        >
          ×
        </DismissButton>
      </StripHeader>

      {isExpanded && (
        <Details>
          <div style={{ fontSize: 11, color: 'rgba(215,250,255,0.6)' }}>
            {presence} • {steps.length} step{steps.length === 1 ? '' : 's'}
          </div>
          {(steps.length > 0 ? steps : [{ id: 'empty', tool: 'Waiting for plan', status: 'PENDING' }]).map((step, index) => (
            <StepRow key={step.id || index}>
              <StepName>{step.tool || 'Step'}</StepName>
              <StepStatus>{String(step.status || 'PENDING').toLowerCase()}</StepStatus>
            </StepRow>
          ))}
        </Details>
      )}
    </Strip>
  );
};

export default ExecutionPanel;
