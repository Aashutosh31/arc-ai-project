import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { SocketContext } from './SocketContext';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
const ACTIVE_WORKSPACE_STORAGE_KEY = 'arc.activeWorkspaceId';

const WorkspaceContext = createContext(null);

const normalizeWorkspace = (workspace) => {
  if (!workspace) return null;
  return {
    ...workspace,
    _id: String(workspace._id || workspace.id || workspace.workspaceId || ''),
  };
};

export const useWorkspace = () => {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return ctx;
};

export const WorkspaceProvider = ({ children }) => {
  const { socket, authInfo } = useContext(SocketContext) || {};
  const [workspaces, setWorkspaces] = useState([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(null);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const activeWorkspaceIdRef = useRef(null);

  const authToken = authInfo?.token || localStorage.getItem('token');
  const userId = authInfo?.userId || localStorage.getItem('userId');
  const authReady = Boolean(authInfo?.ready || (authToken && userId));

  const getAuthHeaders = useCallback(() => ({
    Authorization: `Bearer ${authToken || localStorage.getItem('token')}`
  }), [authToken]);

  const syncActiveWorkspace = useCallback((workspace, { bumpRevision = true } = {}) => {
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

  const fetchWorkspaceById = useCallback(async (workspaceId) => {
    if (!workspaceId) return null;
    const response = await fetch(`${API_URL}/api/workspaces/${workspaceId}`, {
      headers: getAuthHeaders()
    });
    if (!response.ok) return null;
    const data = await response.json();
    return normalizeWorkspace(data?.workspace || null);
  }, [getAuthHeaders]);

  const refreshWorkspaces = useCallback(async ({ preferredWorkspaceId = null } = {}) => {
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
    } catch (error) {
      setWorkspaceError(error?.message || 'Failed to load workspaces');
      return null;
    } finally {
      setLoadingWorkspaces(false);
    }
  }, [authReady, getAuthHeaders]);

  const createWorkspace = useCallback(async ({ name, description = '', visibility = 'private' }) => {
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

  const renameWorkspace = useCallback(async (workspaceId, updates = {}) => {
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

  const deleteWorkspace = useCallback(async (workspaceId) => {
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

  const switchWorkspace = useCallback(async (workspaceId) => {
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
    } catch (error) {
      setWorkspaceError(error?.message || 'Failed to switch workspace');
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

    const handleWorkspaceSwitched = (data) => {
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
    return () => socket.off('workspace:switched', handleWorkspaceSwitched);
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
