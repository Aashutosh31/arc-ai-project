import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { SocketContext } from './SocketContext';

const ExecutionContext = createContext(null);

const presenceFromStatus = (status) => {
  switch (String(status || '').toLowerCase()) {
    case 'running':
      return 'Executing...';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'blocked':
    case 'insufficient_credits':
      return 'Blocked — insufficient credits';
    case 'cancelled':
      return 'Cancelled';
    case 'planning':
      return 'Planning...';
    default:
      return 'Thinking...';
  }
};

const initialExecution = null;

export const ExecutionProvider = ({ children }) => {
  const { socket } = useContext(SocketContext) || {};
  const [executions, setExecutions] = useState([]);
  const [activeExecutionId, setActiveExecutionId] = useState(null);
  const [presence, setPresence] = useState('Thinking...');

  useEffect(() => {
    if (!socket) return;

    const upsertExecution = (executionId, patch) => {
      if (!executionId) return;
      setExecutions((prev) => {
        const next = [...prev];
        const index = next.findIndex((item) => item.executionId === executionId);
        const existing = index >= 0 ? next[index] : { executionId, title: 'Untitled execution', status: 'PLANNED', steps: [], createdAt: Date.now(), updatedAt: Date.now() };
        const merged = {
          ...existing,
          ...patch,
          steps: patch.steps || existing.steps || [],
          updatedAt: Date.now()
        };
        if (index >= 0) next[index] = merged;
        else next.unshift(merged);
        return next.slice(0, 12);
      });
    };

    const onCreated = (data) => {
      const executionId = data?.executionId || data?._id || data?.id;
      if (!executionId) return;
      upsertExecution(executionId, {
        executionId,
        title: data?.title || 'Autonomous plan',
        status: 'PLANNED',
        steps: data?.steps || []
      });
      setActiveExecutionId(executionId);
      setPresence('Planning...');
    };

    const onStarted = (data) => {
      const executionId = data?.executionId || data?._id || data?.id;
      if (!executionId) return;
      setActiveExecutionId(executionId);
      upsertExecution(executionId, { status: data?.status || 'RUNNING' });
      setPresence(presenceFromStatus(data?.status || 'running'));
    };

    const onStepStarted = (data) => {
      const executionId = data?.executionId;
      const stepId = data?.stepId;
      if (!executionId || !stepId) return;
      setActiveExecutionId(executionId);
      setPresence(`Executing ${data?.tool || 'step'}...`);
      setExecutions((prev) => prev.map((execution) => {
        if (execution.executionId !== executionId) return execution;
        const nextSteps = (execution.steps || []).map((step) => step.id === stepId ? { ...step, status: 'RUNNING', startedAt: step.startedAt || Date.now(), tool: data?.tool || step.tool } : step);
        return { ...execution, status: 'RUNNING', steps: nextSteps, updatedAt: Date.now() };
      }));
    };

    const onStepCompleted = (data) => {
      const executionId = data?.executionId;
      const stepId = data?.stepId;
      if (!executionId || !stepId) return;
      const normalizedStatus = String(data?.status || '').toUpperCase();
      setExecutions((prev) => prev.map((execution) => {
        if (execution.executionId !== executionId) return execution;
        const nextSteps = (execution.steps || []).map((step) => step.id === stepId ? { ...step, status: normalizedStatus || 'COMPLETED', result: data?.result || step.result, finishedAt: Date.now() } : step);
        return { ...execution, status: normalizedStatus === 'FAILED' ? 'FAILED' : normalizedStatus === 'BLOCKED' ? 'BLOCKED' : execution.status, steps: nextSteps, updatedAt: Date.now() };
      }));
      setPresence(normalizedStatus === 'FAILED' ? 'Failed' : normalizedStatus === 'BLOCKED' ? 'Blocked — insufficient credits' : 'Synthesizing...');
    };

    const onStepFailed = (data) => {
      const executionId = data?.executionId;
      const stepId = data?.stepId;
      if (!executionId || !stepId) return;
      setExecutions((prev) => prev.map((execution) => {
        if (execution.executionId !== executionId) return execution;
        const nextSteps = (execution.steps || []).map((step) => step.id === stepId ? { ...step, status: 'FAILED', error: data?.error || 'Step failed', finishedAt: Date.now() } : step);
        return { ...execution, status: 'FAILED', steps: nextSteps, updatedAt: Date.now() };
      }));
      setPresence('Failed');
    };

    const onCompleted = (data) => {
      const executionId = data?.executionId;
      if (!executionId) return;
      const normalizedStatus = String(data?.status || 'COMPLETED').toUpperCase();
      setExecutions((prev) => prev.map((execution) => execution.executionId === executionId ? { ...execution, status: normalizedStatus, updatedAt: Date.now() } : execution));
      setPresence(normalizedStatus === 'BLOCKED' ? 'Blocked — insufficient credits' : 'Completed');
    };

    const onFailed = (data) => {
      const executionId = data?.executionId;
      if (!executionId) return;
      setExecutions((prev) => prev.map((execution) => execution.executionId === executionId ? { ...execution, status: 'FAILED', updatedAt: Date.now() } : execution));
      setPresence('Failed');
    };

    const onBlocked = (data) => {
      const executionId = data?.executionId;
      if (!executionId) return;
      setExecutions((prev) => prev.map((execution) => execution.executionId === executionId ? { ...execution, status: 'BLOCKED', updatedAt: Date.now() } : execution));
      setPresence('Blocked — insufficient credits');
    };

    socket.on('execution.created', onCreated);
    socket.on('execution.started', onStarted);
    socket.on('execution.step.started', onStepStarted);
    socket.on('execution.step.completed', onStepCompleted);
    socket.on('execution.step.failed', onStepFailed);
    socket.on('execution.blocked', onBlocked);
    socket.on('execution.completed', onCompleted);
    socket.on('execution.failed', onFailed);

    return () => {
      socket.off('execution.created', onCreated);
      socket.off('execution.started', onStarted);
      socket.off('execution.step.started', onStepStarted);
      socket.off('execution.step.completed', onStepCompleted);
      socket.off('execution.step.failed', onStepFailed);
      socket.off('execution.blocked', onBlocked);
      socket.off('execution.completed', onCompleted);
      socket.off('execution.failed', onFailed);
    };
  }, [socket]);

  useEffect(() => {
    if (!socket) return;
    const onAgentStatus = (data) => {
      if (data?.status) setPresence(String(data.status));
    };
    socket.on('ai:agent:status', onAgentStatus);
    return () => socket.off('ai:agent:status', onAgentStatus);
  }, [socket]);

  const activeExecution = useMemo(
    () => executions.find((execution) => execution.executionId === activeExecutionId) || executions[0] || initialExecution,
    [executions, activeExecutionId]
  );

  const cancelActiveExecution = () => {
    if (!socket) return;
    socket.emit('ai:stream:stop');
    setPresence('Cancelled');
    setExecutions((prev) => prev.map((execution) => execution.executionId === activeExecutionId ? { ...execution, status: 'CANCELLED', updatedAt: Date.now() } : execution));
  };

  const value = useMemo(() => ({
    activeExecution,
    activeExecutionId,
    executions,
    presence,
    cancelActiveExecution,
    setActiveExecutionId
  }), [activeExecution, activeExecutionId, executions, presence]);

  return <ExecutionContext.Provider value={value}>{children}</ExecutionContext.Provider>;
};

export const useExecution = () => useContext(ExecutionContext) || {};
