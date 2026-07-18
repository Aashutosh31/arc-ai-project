import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { SocketContext } from './SocketContext';

export interface Workspace {
  _id: string;
  name: string;
  description?: string;
  visibility?: string;
  [key: string]: unknown;
}

interface WorkspaceContextType {
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  activeWorkspaceId: string | null;
  workspaceRevision: number;
  loadingWorkspaces: boolean;
  switchingWorkspace: boolean;
  workspaceError: string;
  refreshWorkspaces: (options?: { preferredWorkspaceId?: string | null }) => Promise<Workspace | null>;
  switchWorkspace: (workspaceId: string) => Promise<string | null>;
  createWorkspace: (options: { name: string; description?: string; visibility?: string }) => Promise<Workspace | null>;
  renameWorkspace: (workspaceId: string, updates?: Record<string, unknown>) => Promise<Workspace | null>;
  deleteWorkspace: (workspaceId: string) => Promise<boolean>;
  setActiveWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
const ACTIVE_WORKSPACE_STORAGE_KEY = 'arc.activeWorkspaceId';

const WorkspaceContext = createContext<WorkspaceContextType | null>(null);

const normalizeWorkspace = (workspace: Record<string, unknown> | null | undefined): Workspace | null => {
  if (!workspace) return null;
  return {
    ...workspace,
    _id: String(workspace._id || workspace.id || workspace.workspaceId || ''),
  } as Workspace;
};

export const useWorkspace = () => {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return ctx;
};

export const WorkspaceProvider = ({ children }: { children: ReactNode }) => {
  const socketContext = useContext(SocketContext);
  const socket = socketContext?.socket;
  // Note: authInfo is no longer in SocketContext based on SocketContext.tsx types.
  // The token is pulled from localStorage directly.
  
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState<boolean>(false);
  const [switchingWorkspace, setSwitchingWorkspace] = useState<boolean>(false);
  const [workspaceError, setWorkspaceError] = useState<string>('');
  const [workspaceRevision, setWorkspaceRevision] = useState<number>(0);
  const activeWorkspaceIdRef = useRef<string | null>(null);

  const authToken = localStorage.getItem('token');
  const userId = localStorage.getItem('userId');
  const authReady = Boolean(authToken && userId);

  const getAuthHeaders = useCallback(() => ({
    Authorization: `Bearer ${authToken || localStorage.getItem('token')}`
  }), [authToken]);

  const syncActiveWorkspace = useCallback((workspace: Record<string, unknown> | null, { bumpRevision = true } = {}) => {
    const normalized = normalizeWorkspace(workspace);
    if (!normalized?._id) return null;

    setWorkspaces((prev) => {
      const next = prev.filter((item) => item._id !== normalized._id);
      next.unshift({ ...normalized });
      return next;
    });

    activeWorkspaceIdRef.current = normalized._id;
    setActiveWorkspaceId((previous) => {
      if (previous !== normalized._id && bumpRevision) {
        setWorkspaceRevision((value) => value + 1);
      }
      return normalized._id;
    });

    localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, normalized._id);
    setWorkspaceError('');
    return normalized;
  }, []);

  const fetchWorkspaceById = useCallback(async (workspaceId: string) => {
    if (!workspaceId) return null;
    const response = await fetch(`${API_URL}/api/workspaces/${workspaceId}`, {
      headers: getAuthHeaders()
    });
    if (!response.ok) return null;
    const data = await response.json();
    return normalizeWorkspace(data?.workspace || null);
  }, [getAuthHeaders]);

  const refreshWorkspaces = useCallback(async ({ preferredWorkspaceId = null }: { preferredWorkspaceId?: string | null } = {}) => {
    if (!authReady) return null;

    setLoadingWorkspaces(true);
    setWorkspaceError('');

    try {
      const ensureResponse = await fetch(`${API_URL}/api/workspaces/active${preferredWorkspaceId ? `?workspaceId=${encodeURIComponent(preferredWorkspaceId)}` : ''}`, {
        headers: getAuthHeaders()
      });
      const ensuredWorkspace = ensureResponse.ok ? normalizeWorkspace((await ensureResponse.json())?.workspace || null) : null;

      const listResponse = await fetch(`${API_URL}/api/workspaces`, {
        headers: getAuthHeaders()
      });
      const listData = listResponse.ok ? await listResponse.json() : { workspaces: [] };
      const nextWorkspaces = Array.isArray(listData?.workspaces) ? listData.workspaces.map(normalizeWorkspace).filter(Boolean) : [];

      const storedWorkspaceId = preferredWorkspaceId || localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
      const selectedWorkspace =
        nextWorkspaces.find((workspace) => workspace._id === storedWorkspaceId) ||
        ensuredWorkspace ||
        nextWorkspaces[0] ||
        null;

      setWorkspaces(nextWorkspaces.length > 0 ? nextWorkspaces : ensuredWorkspace ? [ensuredWorkspace] : []);

      if (selectedWorkspace?._id) {
        activeWorkspaceIdRef.current = selectedWorkspace._id;
        setActiveWorkspaceId(selectedWorkspace._id);
        localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, selectedWorkspace._id);
      } else {
        activeWorkspaceIdRef.current = null;
        setActiveWorkspaceId(null);
      }

      return selectedWorkspace;
    } catch (error: unknown) {
      setWorkspaceError((error as Error)?.message || 'Failed to load workspaces');
      return null;
    } finally {
      setLoadingWorkspaces(false);
    }
  }, [authReady, getAuthHeaders]);

  const createWorkspace = useCallback(async ({ name, description = '', visibility = 'private' }: { name: string; description?: string; visibility?: string }) => {
    const response = await fetch(`${API_URL}/api/workspaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ name, description, visibility })
    });

    if (!response.ok) {
      throw new Error('Failed to create workspace');
    }

    const data = await response.json();
    const workspace = normalizeWorkspace(data?.workspace || null);
    if (workspace?._id) {
      syncActiveWorkspace(workspace, { bumpRevision: true });
      if (socket?.connected) {
        socket.emit('workspace:switch', { workspaceId: workspace._id });
      }
    }
    return workspace;
  }, [getAuthHeaders, socket, syncActiveWorkspace]);

  const renameWorkspace = useCallback(async (workspaceId: string, updates: Record<string, unknown> = {}) => {
    const response = await fetch(`${API_URL}/api/workspaces/${workspaceId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify(updates)
    });

    if (!response.ok) {
      throw new Error('Failed to update workspace');
    }

    const data = await response.json();
    const workspace = normalizeWorkspace(data?.workspace || null);
    if (workspace?._id) syncActiveWorkspace(workspace, { bumpRevision: false });
    return workspace;
  }, [getAuthHeaders, syncActiveWorkspace]);

  const deleteWorkspace = useCallback(async (workspaceId: string) => {
    const response = await fetch(`${API_URL}/api/workspaces/${workspaceId}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });

    if (!response.ok) {
      throw new Error('Failed to delete workspace');
    }

    setWorkspaces((prev) => prev.filter((workspace) => workspace._id !== workspaceId));

    const nextWorkspace = workspaces.find((workspace) => workspace._id !== workspaceId) || null;
    if (nextWorkspace?._id) {
      syncActiveWorkspace(nextWorkspace, { bumpRevision: true });
      if (socket?.connected) {
        socket.emit('workspace:switch', { workspaceId: nextWorkspace._id });
      }
    } else {
      setActiveWorkspaceId(null);
      activeWorkspaceIdRef.current = null;
    }

    return true;
  }, [getAuthHeaders, socket, syncActiveWorkspace, workspaces]);

  const switchWorkspace = useCallback(async (workspaceId: string) => {
    if (!workspaceId || workspaceId === activeWorkspaceIdRef.current) return activeWorkspaceIdRef.current;

    setSwitchingWorkspace(true);
    setWorkspaceError('');

    try {
      const workspace = workspaces.find((item) => item._id === workspaceId) || await fetchWorkspaceById(workspaceId);
      if (!workspace?._id) throw new Error('Workspace not found');

      syncActiveWorkspace(workspace, { bumpRevision: true });
      if (socket?.connected) {
        socket.emit('workspace:switch', { workspaceId: workspace._id });
      }
      return workspace._id;
    } catch (error: unknown) {
      setWorkspaceError((error as Error)?.message || 'Failed to switch workspace');
      throw error;
    } finally {
      setSwitchingWorkspace(false);
    }
  }, [fetchWorkspaceById, socket, syncActiveWorkspace, workspaces]);

  useEffect(() => {
    if (!authReady) return;
    refreshWorkspaces().catch((error) => {
      console.error('[WorkspaceContext] bootstrap failed:', error);
    });
  }, [authReady, refreshWorkspaces]);

  useEffect(() => {
    if (!socket) return undefined;

    const handleWorkspaceSwitched = (data: Record<string, unknown>) => {
      const workspaceId = data?.workspaceId ? String(data.workspaceId) : null;
      if (!workspaceId) return;
      const workspace = normalizeWorkspace({
        _id: workspaceId,
        name: data?.name || 'Workspace',
        vectorNamespace: data?.vectorNamespace || `workspace_${workspaceId}`
      });
      syncActiveWorkspace(workspace, { bumpRevision: false });
    };

    socket.on('workspace:switched', handleWorkspaceSwitched);
    return () => { socket.off('workspace:switched', handleWorkspaceSwitched); };
  }, [socket, syncActiveWorkspace]);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace._id === activeWorkspaceId) || null,
    [workspaces, activeWorkspaceId]
  );

  const value = useMemo(() => ({
    workspaces,
    activeWorkspace,
    activeWorkspaceId,
    workspaceRevision,
    loadingWorkspaces,
    switchingWorkspace,
    workspaceError,
    refreshWorkspaces,
    switchWorkspace,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    setActiveWorkspaceId
  }), [
    activeWorkspace,
    activeWorkspaceId,
    createWorkspace,
    deleteWorkspace,
    loadingWorkspaces,
    refreshWorkspaces,
    renameWorkspace,
    switchingWorkspace,
    switchWorkspace,
    workspaces,
    workspaceError,
    workspaceRevision
  ]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
};
