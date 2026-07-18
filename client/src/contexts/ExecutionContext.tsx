import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode, MutableRefObject } from 'react';
import { SocketContext } from './SocketContext';
import { useWorkspace } from './WorkspaceContext';

export interface ExecutionStep {
  id: string;
  tool: string;
  status: string;
  startedAt?: number;
  finishedAt?: number;
  result?: string;
  error?: string;
}

export interface Execution {
  executionId: string;
  title: string;
  status: string;
  steps: ExecutionStep[];
  createdAt: number;
  updatedAt: number;
  [key: string]: unknown;
}

export interface ExecutionBucket {
  executions: Execution[];
  activeExecutionId: string | null;
  presence: string;
}

interface ExecutionContextType {
  activeExecution: Execution | null;
  activeExecutionId: string | null;
  executions: Execution[];
  presence: string;
  cancelActiveExecution: () => void;
  setActiveExecutionId: (executionId: string | null) => void;
}

const ExecutionContext = createContext<ExecutionContextType | null>(null);

const presenceFromStatus = (status: unknown): string => {
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

const initialExecution: Execution | null = null;

const emptyBucket = (): ExecutionBucket => ({
  executions: [],
  activeExecutionId: null,
  presence: 'Thinking...'
});

const resolveWorkspaceId = (payloadWorkspaceId: unknown, executionId: string, executionWorkspaceMapRef: MutableRefObject<Map<string, string>>, fallbackWorkspaceId: string | null): string => {
  if (payloadWorkspaceId) return String(payloadWorkspaceId);
  if (executionId && executionWorkspaceMapRef.current.has(executionId)) {
    return executionWorkspaceMapRef.current.get(executionId);
  }
  return fallbackWorkspaceId ? String(fallbackWorkspaceId) : 'global';
};

export const ExecutionProvider = ({ children }: { children: ReactNode }) => {
  const socketContext = useContext(SocketContext);
  const socket = socketContext?.socket;
  const { activeWorkspaceId, workspaceRevision } = useWorkspace();
  const [executionBuckets, setExecutionBuckets] = useState<Record<string, ExecutionBucket>>({});
  const executionWorkspaceMapRef = useRef<Map<string, string>>(new Map());

  const updateBucket = useCallback((workspaceId: string | null, updater: (bucket: ExecutionBucket) => ExecutionBucket) => {
    const key = workspaceId ? String(workspaceId) : 'global';
    setExecutionBuckets((prev) => {
      const current = prev[key] || emptyBucket();
      const nextBucket = updater(current);
      return {
        ...prev,
        [key]: nextBucket
      };
    });
  }, []);

  const setBucketPresence = useCallback((workspaceId: string | null, nextPresence: string) => {
    const key = workspaceId ? String(workspaceId) : 'global';
    setExecutionBuckets((prev) => {
      const current = prev[key] || emptyBucket();
      return {
        ...prev,
        [key]: {
          ...current,
          presence: nextPresence
        }
      };
    });
  }, []);

  const setBucketActiveExecutionId = useCallback((workspaceId: string | null, executionId: string | null) => {
    const key = workspaceId ? String(workspaceId) : 'global';
    setExecutionBuckets((prev) => {
      const current = prev[key] || emptyBucket();
      return {
        ...prev,
        [key]: {
          ...current,
          activeExecutionId: executionId || null
        }
      };
    });
  }, []);

  const upsertExecution = useCallback((workspaceId: string | null, executionId: string, patch: Partial<Execution> & { presence?: string }) => {
    if (!executionId) return;
    const key = workspaceId ? String(workspaceId) : 'global';
    setExecutionBuckets((prev) => {
      const current = prev[key] || emptyBucket();
      const nextExecutions = [...current.executions];
      const index = nextExecutions.findIndex((item) => item.executionId === executionId);
      const existing = index >= 0
        ? nextExecutions[index]
        : { executionId, title: 'Untitled execution', status: 'PLANNED', steps: [], createdAt: Date.now(), updatedAt: Date.now() };
      const merged = {
        ...existing,
        ...patch,
        steps: patch.steps || existing.steps || [],
        updatedAt: Date.now()
      };
      if (index >= 0) nextExecutions[index] = merged;
      else nextExecutions.unshift(merged);
      return {
        ...prev,
        [key]: {
          ...current,
          executions: nextExecutions.slice(0, 12),
          activeExecutionId: current.activeExecutionId || executionId,
          presence: patch.presence || current.presence || 'Thinking...'
        }
      };
    });
  }, []);

  const bucket = executionBuckets[String(activeWorkspaceId || 'global')] || emptyBucket();
  const executions = bucket.executions;
  const activeExecutionId = bucket.activeExecutionId;
  const presence = bucket.presence || 'Thinking...';

  useEffect(() => {
    if (!socket) return;

    const onCreated = (data: Record<string, unknown>) => {
      const executionId = (data?.executionId || data?._id || data?.id) as string;
      if (!executionId) return;
      const workspaceId = resolveWorkspaceId(data?.workspaceId, executionId, executionWorkspaceMapRef, activeWorkspaceId);
      executionWorkspaceMapRef.current.set(executionId, workspaceId);
      upsertExecution(workspaceId, executionId, {
        executionId,
        title: (data?.title as string) || 'Autonomous plan',
        status: 'PLANNED',
        steps: (data?.steps as ExecutionStep[]) || []
      });
      setBucketActiveExecutionId(workspaceId, executionId);
      setBucketPresence(workspaceId, 'Planning...');
    };

    const onStarted = (data: Record<string, unknown>) => {
      const executionId = (data?.executionId || data?._id || data?.id) as string;
      if (!executionId) return;
      const workspaceId = resolveWorkspaceId(data?.workspaceId, executionId, executionWorkspaceMapRef, activeWorkspaceId);
      executionWorkspaceMapRef.current.set(executionId, workspaceId);
      setBucketActiveExecutionId(workspaceId, executionId);
      upsertExecution(workspaceId, executionId, { status: (data?.status as string) || 'RUNNING' });
      setBucketPresence(workspaceId, presenceFromStatus(data?.status || 'running'));
    };

    const onStepStarted = (data: Record<string, unknown>) => {
      const executionId = data?.executionId as string;
      const stepId = data?.stepId as string;
      if (!executionId || !stepId) return;
      const workspaceId = resolveWorkspaceId(data?.workspaceId, executionId, executionWorkspaceMapRef, activeWorkspaceId);
      if (!executionWorkspaceMapRef.current.has(executionId)) {
        executionWorkspaceMapRef.current.set(executionId, workspaceId);
      }
      setBucketActiveExecutionId(workspaceId, executionId);
      setBucketPresence(workspaceId, `Executing ${data?.tool || 'step'}...`);
      updateBucket(workspaceId, (current) => {
        const nextSteps = (current.executions.find((execution) => execution.executionId === executionId)?.steps || []).map((step) => step.id === stepId ? { ...step, status: 'RUNNING', startedAt: step.startedAt || Date.now(), tool: (data?.tool as string) || step.tool } : step);
        return {
          ...current,
          executions: current.executions.map((execution) => execution.executionId === executionId ? { ...execution, status: 'RUNNING', steps: nextSteps, updatedAt: Date.now() } : execution)
        };
      });
    };

    const onStepCompleted = (data: Record<string, unknown>) => {
      const executionId = data?.executionId as string;
      const stepId = data?.stepId as string;
      if (!executionId || !stepId) return;
      const normalizedStatus = String(data?.status || '').toUpperCase();
      const workspaceId = resolveWorkspaceId(data?.workspaceId, executionId, executionWorkspaceMapRef, activeWorkspaceId);
      if (!executionWorkspaceMapRef.current.has(executionId)) {
        executionWorkspaceMapRef.current.set(executionId, workspaceId);
      }
      updateBucket(workspaceId, (current) => ({
        ...current,
        executions: current.executions.map((execution) => {
          if (execution.executionId !== executionId) return execution;
          const nextSteps = (execution.steps || []).map((step) => step.id === stepId ? { ...step, status: normalizedStatus || 'COMPLETED', result: (data?.result as string) || step.result, finishedAt: Date.now() } : step);
          return { ...execution, status: normalizedStatus === 'FAILED' ? 'FAILED' : normalizedStatus === 'BLOCKED' ? 'BLOCKED' : execution.status, steps: nextSteps, updatedAt: Date.now() };
        })
      }));
      setBucketPresence(workspaceId, normalizedStatus === 'FAILED' ? 'Failed' : normalizedStatus === 'BLOCKED' ? 'Blocked — insufficient credits' : 'Synthesizing...');
    };

    const onStepFailed = (data: Record<string, unknown>) => {
      const executionId = data?.executionId as string;
      const stepId = data?.stepId as string;
      if (!executionId || !stepId) return;
      const workspaceId = resolveWorkspaceId(data?.workspaceId, executionId, executionWorkspaceMapRef, activeWorkspaceId);
      updateBucket(workspaceId, (current) => ({
        ...current,
        executions: current.executions.map((execution) => {
          if (execution.executionId !== executionId) return execution;
          const nextSteps = (execution.steps || []).map((step) => step.id === stepId ? { ...step, status: 'FAILED', error: (data?.error as string) || 'Step failed', finishedAt: Date.now() } : step);
          return { ...execution, status: 'FAILED', steps: nextSteps, updatedAt: Date.now() };
        })
      }));
      setBucketPresence(workspaceId, 'Failed');
    };

    const onCompleted = (data: Record<string, unknown>) => {
      const executionId = data?.executionId as string;
      if (!executionId) return;
      const normalizedStatus = String(data?.status || 'COMPLETED').toUpperCase();
      const workspaceId = resolveWorkspaceId(data?.workspaceId, executionId, executionWorkspaceMapRef, activeWorkspaceId);
      updateBucket(workspaceId, (current) => ({
        ...current,
        executions: current.executions.map((execution) => execution.executionId === executionId ? { ...execution, status: normalizedStatus, updatedAt: Date.now() } : execution)
      }));
      setBucketPresence(workspaceId, normalizedStatus === 'BLOCKED' ? 'Blocked — insufficient credits' : 'Completed');
    };

    const onFailed = (data: Record<string, unknown>) => {
      const executionId = data?.executionId as string;
      if (!executionId) return;
      const workspaceId = resolveWorkspaceId(data?.workspaceId, executionId, executionWorkspaceMapRef, activeWorkspaceId);
      updateBucket(workspaceId, (current) => ({
        ...current,
        executions: current.executions.map((execution) => execution.executionId === executionId ? { ...execution, status: 'FAILED', updatedAt: Date.now() } : execution)
      }));
      setBucketPresence(workspaceId, 'Failed');
    };

    const onBlocked = (data: Record<string, unknown>) => {
      const executionId = data?.executionId as string;
      if (!executionId) return;
      const workspaceId = resolveWorkspaceId(data?.workspaceId, executionId, executionWorkspaceMapRef, activeWorkspaceId);
      updateBucket(workspaceId, (current) => ({
        ...current,
        executions: current.executions.map((execution) => execution.executionId === executionId ? { ...execution, status: 'BLOCKED', updatedAt: Date.now() } : execution)
      }));
      setBucketPresence(workspaceId, 'Blocked — insufficient credits');
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
  }, [socket, activeWorkspaceId, workspaceRevision, upsertExecution, setBucketActiveExecutionId, setBucketPresence, updateBucket]);

  useEffect(() => {
    if (!socket) return;
    const onAgentStatus = (data: Record<string, unknown>) => {
      if (data?.status) setBucketPresence(String(activeWorkspaceId || 'global'), String(data.status));
    };
    socket.on('ai:agent:status', onAgentStatus);
    return () => { socket.off('ai:agent:status', onAgentStatus); };
  }, [socket, activeWorkspaceId, setBucketPresence]);

  const activeExecution = useMemo(
    () => executions.find((execution) => execution.executionId === activeExecutionId) || executions[0] || initialExecution,
    [executions, activeExecutionId]
  );

  const cancelActiveExecution = () => {
    if (!socket) return;
    socket.emit('ai:stream:stop');
    const workspaceId = String(activeWorkspaceId || 'global');
    setBucketPresence(workspaceId, 'Cancelled');
    updateBucket(workspaceId, (current) => ({
      ...current,
      executions: current.executions.map((execution) => execution.executionId === activeExecutionId ? { ...execution, status: 'CANCELLED', updatedAt: Date.now() } : execution)
    }));
  };

  const value = useMemo(() => ({
    activeExecution,
    activeExecutionId,
    executions,
    presence,
    cancelActiveExecution,
    setActiveExecutionId: (executionId: string | null) => setBucketActiveExecutionId(activeWorkspaceId, executionId)
  }), [activeExecution, activeExecutionId, executions, presence, activeWorkspaceId, setBucketActiveExecutionId]);

  return <ExecutionContext.Provider value={value}>{children}</ExecutionContext.Provider>;
};

export const useExecution = (): Partial<ExecutionContextType> => useContext(ExecutionContext) || {};
