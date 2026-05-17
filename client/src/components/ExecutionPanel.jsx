import React, { useMemo, useState } from 'react';
import styled, { keyframes } from 'styled-components';
import { useExecution } from '../contexts/ExecutionContext';

const pulse = keyframes`
  0%, 100% { opacity: 0.55; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.02); }
`;

const Panel = styled.section`
  background: linear-gradient(180deg, rgba(10, 10, 28, 0.98), rgba(7, 7, 20, 0.96));
  border: 1px solid rgba(0, 255, 255, 0.18);
  border-radius: 16px;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
  overflow: hidden;
  min-width: 0;
`;

const Header = styled.button`
  appearance: none;
  width: 100%;
  border: 0;
  padding: 14px 14px 12px;
  background: linear-gradient(135deg, rgba(0, 255, 255, 0.08), rgba(138, 43, 226, 0.08));
  color: #d7faff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
  text-align: left;
`;

const TitleGroup = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const Eyebrow = styled.span`
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: rgba(215, 250, 255, 0.65);
`;

const Title = styled.h3`
  margin: 0;
  font-size: 13px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #7df7ff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Meta = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
`;

const StatusPill = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid rgba(125, 247, 255, 0.24);
  color: ${({ $status }) => ($status === 'FAILED' ? '#ff7070' : $status === 'COMPLETED' ? '#4dffb0' : '#d7faff')};
  background: ${({ $status }) => ($status === 'FAILED' ? 'rgba(255, 80, 80, 0.1)' : $status === 'COMPLETED' ? 'rgba(0, 255, 120, 0.08)' : 'rgba(255,255,255,0.04)')};
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
`;

const ToggleArrow = styled.span`
  color: rgba(215, 250, 255, 0.8);
  font-size: 12px;
`;

const Body = styled.div`
  padding: 0 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

const LiveLine = styled.div`
  padding: 12px;
  border-radius: 12px;
  border: 1px solid rgba(0, 255, 255, 0.12);
  background: rgba(2, 12, 24, 0.74);
  color: #d7faff;
  font-size: 13px;
  line-height: 1.5;
  animation: ${pulse} 2.4s ease-in-out infinite;
`;

const ProgressBar = styled.div`
  height: 6px;
  border-radius: 999px;
  background: rgba(255,255,255,0.06);
  overflow: hidden;

  &::before {
    content: '';
    display: block;
    height: 100%;
    width: ${({ $progress }) => `${Math.max(6, Math.min(100, $progress || 0))}%`};
    border-radius: inherit;
    background: linear-gradient(90deg, #00ffff, #8a2be2, #ff00ff);
    transition: width 180ms ease;
  }
`;

const StepList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
`;

const StepItem = styled.div`
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255,255,255,0.03);
  border: 1px solid ${({ $state }) => ($state === 'FAILED' ? 'rgba(255,112,112,0.32)' : $state === 'COMPLETED' ? 'rgba(77,255,176,0.28)' : $state === 'RUNNING' ? 'rgba(0,255,255,0.3)' : 'rgba(255,255,255,0.08)')};
`;

const Dot = styled.span`
  width: 10px;
  height: 10px;
  margin-top: 4px;
  border-radius: 50%;
  background: ${({ $state }) => ($state === 'FAILED' ? '#ff7070' : $state === 'COMPLETED' ? '#4dffb0' : $state === 'RUNNING' ? '#00ffff' : 'rgba(255,255,255,0.4)')};
  box-shadow: ${({ $state }) => ($state === 'RUNNING' ? '0 0 12px rgba(0,255,255,0.5)' : 'none')};
`;

const StepMain = styled.div`
  min-width: 0;
`;

const StepTitle = styled.div`
  font-size: 12px;
  font-weight: 700;
  color: #f7fbff;
  text-transform: none;
`;

const StepMeta = styled.div`
  margin-top: 4px;
  font-size: 11px;
  color: rgba(215, 250, 255, 0.68);
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
`;

const ResultPreview = styled.pre`
  margin: 0;
  max-width: 100%;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11px;
  color: rgba(199, 244, 255, 0.84);
  background: rgba(0,0,0,0.22);
  border-radius: 10px;
  padding: 8px 10px;
  border: 1px solid rgba(255,255,255,0.06);
`;

const CancelButton = styled.button`
  border: 1px solid rgba(255, 80, 80, 0.42);
  background: rgba(255, 80, 80, 0.12);
  color: #ffb0b0;
  border-radius: 999px;
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
  transition: transform 160ms ease, background 160ms ease;

  &:hover { transform: translateY(-1px); background: rgba(255, 80, 80, 0.2); }
`;

const formatDuration = (startedAt, finishedAt) => {
  if (!startedAt) return 'pending';
  const end = finishedAt || Date.now();
  const diff = Math.max(0, Math.round((new Date(end).getTime() - new Date(startedAt).getTime()) / 1000));
  return diff < 60 ? `${diff}s` : `${Math.floor(diff / 60)}m ${diff % 60}s`;
};

const buildPreview = (result) => {
  if (!result) return '';
  if (typeof result === 'string') return result.slice(0, 140);
  if (result.error) return String(result.error).slice(0, 140);
  if (result.message) return String(result.message).slice(0, 140);
  if (result.data) return String(result.data).slice(0, 140);
  return JSON.stringify(result).slice(0, 140);
};

const ExecutionPanel = () => {
  const { activeExecution, presence, cancelActiveExecution, executions } = useExecution();
  const [isCollapsed, setIsCollapsed] = useState(false);

  const progress = useMemo(() => {
    const steps = activeExecution?.steps || [];
    if (!steps.length) return 0;
    const completed = steps.filter((step) => step.status === 'COMPLETED').length;
    const failed = steps.filter((step) => step.status === 'FAILED').length;
    return Math.round(((completed + failed * 0.5) / steps.length) * 100);
  }, [activeExecution]);

  const totalExecutions = executions?.length || 0;
  const activeSteps = activeExecution?.steps || [];
  const currentState = String(activeExecution?.status || 'PLANNED');

  return (
    <Panel>
      <Header type="button" onClick={() => setIsCollapsed((prev) => !prev)}>
        <TitleGroup>
          <Eyebrow>Realtime Execution</Eyebrow>
          <Title>{activeExecution?.title || 'No active execution'}</Title>
        </TitleGroup>
        <Meta>
          <StatusPill $status={currentState}>{presence}</StatusPill>
          <ToggleArrow>{isCollapsed ? '▸' : '▾'}</ToggleArrow>
        </Meta>
      </Header>

      {!isCollapsed && (
        <Body>
          <LiveLine>
            {activeExecution ? (
              <>
                {presence} <span style={{ opacity: 0.8 }}>•</span> {activeSteps.length} step{activeSteps.length === 1 ? '' : 's'} in this run
              </>
            ) : (
              'Awaiting a multi-step request.'
            )}
          </LiveLine>

          <ProgressBar $progress={progress} />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ fontSize: 11, color: 'rgba(215,250,255,0.72)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              {totalExecutions} execution{totalExecutions === 1 ? '' : 's'} tracked
            </div>
            {activeExecution?.status === 'RUNNING' ? (
              <CancelButton type="button" onClick={cancelActiveExecution}>
                Cancel Execution
              </CancelButton>
            ) : null}
          </div>

          <StepList>
            {(activeSteps.length > 0 ? activeSteps : [{ id: 'empty', tool: 'Waiting for plan', status: 'PENDING' }]).map((step, index) => (
              <StepItem key={step.id || index} $state={step.status || 'PENDING'}>
                <Dot $state={step.status || 'PENDING'} />
                <StepMain>
                  <StepTitle>{step.tool || 'Step'}</StepTitle>
                  <StepMeta>
                    <span>{String(step.status || 'PENDING').toLowerCase()}</span>
                    <span>{formatDuration(step.startedAt, step.finishedAt)}</span>
                  </StepMeta>
                  {buildPreview(step.result) ? <ResultPreview>{buildPreview(step.result)}</ResultPreview> : null}
                </StepMain>
                <StatusPill $status={step.status || 'PENDING'}>{step.status || 'PENDING'}</StatusPill>
              </StepItem>
            ))}
          </StepList>
        </Body>
      )}
    </Panel>
  );
};

export default ExecutionPanel;
