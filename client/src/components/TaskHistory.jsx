import React, { useMemo, useState } from 'react';
import styled from 'styled-components';
import { useExecution } from '../contexts/ExecutionContext';

// Durable plan history. Plans are persisted server-side, so this list
// survives refreshes and reconnects. Resume is explicit and only offered for
// plans that still have work left (failed/blocked/crashed/cancelled).
//
// Presentation-only: this panel never executes work itself — it asks the
// execution context, which drives the authenticated socket resume path.
const Wrap = styled.section`
  background: var(--surface);
  border: 1px solid rgba(var(--primary-rgb), 0.14);
  border-radius: 12px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
  overflow: hidden;
  min-width: 0;
  max-width: 100%;
`;

const Header = styled.button`
  appearance: none;
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--foreground);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  text-align: left;

  &:hover { background: rgba(255, 255, 255, 0.04); }
`;

const HeaderText = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Toggle = styled.span`
  color: rgba(215, 250, 255, 0.55);
  font-size: 12px;
`;

const List = styled.div`
  padding: 0 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 240px;
  overflow-y: auto;
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  min-width: 0;
`;

const RowMain = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const Title = styled.span`
  font-size: 11px;
  font-weight: 600;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Meta = styled.span`
  font-size: 10px;
  color: rgba(215, 250, 255, 0.55);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const ResumeButton = styled.button`
  appearance: none;
  flex-shrink: 0;
  border: 1px solid rgba(var(--primary-rgb), 0.35);
  background: rgba(var(--primary-rgb), 0.12);
  color: var(--foreground);
  font-size: 10px;
  font-weight: 600;
  border-radius: 7px;
  padding: 4px 8px;
  cursor: pointer;

  &:hover:not(:disabled) { background: rgba(var(--primary-rgb), 0.22); }
  &:disabled { opacity: 0.55; cursor: default; }
`;

const ScheduleButton = styled(ResumeButton)`
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.04);
`;

const ErrorText = styled.div`
  padding: 0 10px 8px;
  font-size: 10px;
  color: #ff8f8f;
`;

const statusLabel = (status) => {
  switch (String(status || '').toUpperCase()) {
    case 'RUNNING': return 'running';
    case 'COMPLETED': return 'completed';
    case 'FAILED': return 'failed';
    case 'BLOCKED': return 'blocked';
    case 'CANCELLED': return 'cancelled';
    default: return 'planned';
  }
};

const TaskHistory = () => {
  const { plans = [], resumeExecution, activeExecution } = useExecution();
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  const visible = useMemo(
    () => plans.filter((plan) => plan && plan.executionId),
    [plans]
  );

  if (!visible.length) return null;

  const resumableCount = visible.filter((plan) => plan.resumable).length;
  const headerText = resumableCount
    ? `Recent tasks · ${resumableCount} resumable`
    : `Recent tasks (${visible.length})`;

  const handleResume = async (plan) => {
    setBusyId(plan.executionId);
    setError(null);
    const result = await resumeExecution(plan);
    setBusyId(null);
    if (!result?.ok) setError(result?.error || 'Could not resume this task.');
    else setExpanded(false);
  };

  return (
    <Wrap aria-label="Recent task history">
      <Header type="button" onClick={() => setExpanded((prev) => !prev)}>
        <span aria-hidden="true">☰</span>
        <HeaderText>{headerText}</HeaderText>
        <Toggle>{expanded ? '▾' : '▸'}</Toggle>
      </Header>

      {expanded && (
        <List>
          {visible.map((plan) => {
            const isLive = activeExecution?.executionId === plan.executionId
              && String(plan.status || '').toUpperCase() === 'RUNNING';
            const canResume = Boolean(plan.resumable) && !isLive;
            const stepSummary = plan.stepCount
              ? `${plan.succeeded || 0}/${plan.stepCount} steps`
              : 'no steps';
            return (
              <Row key={plan.executionId}>
                <RowMain>
                  <Title title={plan.title}>{plan.title || 'Autonomous plan'}</Title>
                  <Meta>
                    {statusLabel(plan.status)} · {stepSummary}
                    {plan.resumeCount ? ` · resumed ${plan.resumeCount}×` : ''}
                    {plan.lastError ? ` · ${plan.lastError}` : ''}
                  </Meta>
                </RowMain>
                {canResume && (
                  <ResumeButton
                    type="button"
                    disabled={busyId === plan.executionId}
                    title="Continue this plan without re-running completed steps"
                    onClick={() => handleResume(plan)}
                  >
                    {busyId === plan.executionId ? 'Resuming…' : 'Resume'}
                  </ResumeButton>
                )}
                <ScheduleButton
                  type="button"
                  title="Schedule this plan as a durable job"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('arc:schedule-plan', {
                      detail: { executionId: plan.executionId }
                    }));
                  }}
                >
                  Schedule
                </ScheduleButton>
              </Row>
            );
          })}
        </List>
      )}

      {error && <ErrorText>{error}</ErrorText>}
    </Wrap>
  );
};

export default TaskHistory;
