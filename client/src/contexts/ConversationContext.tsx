import React, { createContext, useState, useContext, useCallback, useEffect, ReactNode } from 'react';
import { SocketContext } from './SocketContext';
import { useWorkspace } from './WorkspaceContext';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

export interface Conversation {
  _id: string;
  title: string;
  [key: string]: unknown;
}

export interface ConversationContextType {
  conversations: Conversation[];
  activeConversationId: string | null;
  activeConversationRevision: number;
  focusedMessageId: string | null;
  setFocusedMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  loadingConversations: boolean;
  conversationError: string | null;
  fetchConversations: () => Promise<void>;
  createNewConversation: (title?: string) => Promise<Conversation>;
  ensureConversationReady: (title?: string) => Promise<string | null>;
  switchConversation: (conversationId: string | null) => void;
  updateConversation: (conversationId: string, updates: Record<string, unknown>) => Promise<Conversation>;
  deleteConversation: (conversationId: string) => Promise<void>;
  fetchConversationMessages: (conversationId: string | null, options?: { limit?: number; skip?: number }) => Promise<Record<string, unknown>[]>;
  addConversationFromSocket: (conversation: Conversation) => void;
  updateConversationTitle: (conversationId: string, title: string, workspaceId?: string | null) => void;
  searchWorkspace: (query: string, options?: { limit?: number; signal?: AbortSignal }) => Promise<Record<string, unknown>>;
  fetchMemoryDashboard: () => Promise<Record<string, unknown>>;
  updateMemoryPreferences: (memoryLearningEnabled: boolean) => Promise<Record<string, unknown>>;
  updateMemoryFact: (memoryId: string, updates: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deleteMemoryFact: (memoryId: string) => Promise<Record<string, unknown>>;
  updateSemanticMemory: (memoryId: string, updates: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deleteSemanticMemory: (memoryId: string) => Promise<Record<string, unknown>>;
  isFirstMessageSendingRef: React.MutableRefObject<boolean>;
}

const ConversationContext = createContext<ConversationContextType | null>(null);

export const useConversation = () => {
  const ctx = useContext(ConversationContext);
  if (!ctx) throw new Error('useConversation must be used inside ConversationProvider');
  return ctx;
};

export const ConversationProvider = ({ children }: { children: ReactNode }) => {
  const socketContext = useContext(SocketContext);
  const socket = socketContext?.socket;
  const { activeWorkspaceId, workspaceRevision } = useWorkspace();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeConversationRevision, setActiveConversationRevision] = useState<number>(0);
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const [loadingConversations, setLoadingConversations] = useState<boolean>(false);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const activeConversationIdRef = React.useRef<string | null>(null);
  const isFirstMessageSendingRef = React.useRef<boolean>(false);

  const getAuthHeaders = () => ({
    Authorization: `Bearer ${localStorage.getItem('token')}`
  });

  const getWorkspaceParam = useCallback((workspaceId: string | null = activeWorkspaceId) => {
    if (!workspaceId) return '';
    return `workspaceId=${encodeURIComponent(workspaceId)}`;
  }, [activeWorkspaceId]);

  // Fetch conversations from API
  const fetchConversations = useCallback(async () => {
    setLoadingConversations(true);
    setConversationError(null);
    try {
      const workspaceQuery = getWorkspaceParam();
      const response = await fetch(`${API_URL}/api/conversations${workspaceQuery ? `?${workspaceQuery}` : ''}`, {
        headers: getAuthHeaders()
      });
      if (!response.ok) throw new Error('Failed to fetch conversations');
      const data = await response.json();
      setConversations(Array.isArray(data) ? data : []);
      if (!activeConversationIdRef.current && Array.isArray(data) && data.length > 0) {
        setActiveConversationId(data[0]._id);
        activeConversationIdRef.current = data[0]._id;
      }
    } catch (err: unknown) {
      console.error('Error fetching conversations:', err);
      setConversationError((err as Error).message);
    } finally {
      setLoadingConversations(false);
    }
  }, [getWorkspaceParam, activeWorkspaceId]);

  // Create new conversation
  const createNewConversation = useCallback(async (title: string = 'New Conversation') => {
    try {
      const response = await fetch(`${API_URL}/api/conversations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({ title, workspaceId: activeWorkspaceId })
      });
      if (!response.ok) throw new Error('Failed to create conversation');
      const newConv = await response.json();
      setConversations((prev) => [newConv, ...prev.filter((conv) => conv._id !== newConv._id)]);
      setActiveConversationId(newConv._id);
      activeConversationIdRef.current = newConv._id;
      setActiveConversationRevision((value) => value + 1);
      return newConv;
    } catch (err: unknown) {
      console.error('Error creating conversation:', err);
      setConversationError((err as Error).message);
      throw err;
    }
  }, [activeWorkspaceId]);

  const ensureConversationReady = useCallback(async (title: string = 'New Conversation') => {
    if (activeConversationId) {
      return activeConversationId;
    }

    isFirstMessageSendingRef.current = true;
    const newConversation = await createNewConversation(title);
    return newConversation?._id || null;
  }, [activeConversationId, createNewConversation]);

  // Switch to a conversation
  const switchConversation = useCallback((conversationId: string | null) => {
    console.log('[ConversationContext] switchConversation', {
      from: activeConversationId,
      to: conversationId
    });
    setActiveConversationId(conversationId);
    activeConversationIdRef.current = conversationId;
    setActiveConversationRevision((value) => value + 1);
    setFocusedMessageId(null);
  }, [activeConversationId]);

  // Update conversation (title, pinned status)
  const updateConversation = useCallback(async (conversationId: string, updates: Record<string, unknown>) => {
    try {
      const response = await fetch(`${API_URL}/api/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({ ...updates, workspaceId: activeWorkspaceId })
      });
      if (!response.ok) throw new Error('Failed to update conversation');
      const updated = await response.json();
      setConversations((prev) =>
        prev.map((conv) => (conv._id === conversationId ? updated : conv))
      );
      return updated;
    } catch (err: unknown) {
      console.error('Error updating conversation:', err);
      setConversationError((err as Error).message);
      throw err;
    }
  }, [activeWorkspaceId]);

  const searchWorkspace = useCallback(async (query: string, options: { limit?: number; signal?: AbortSignal } = {}) => {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return { query: '', items: [], grouped: { conversations: [], messages: [], memories: [] }, stats: { total: 0, conversations: 0, messages: 0, memories: 0 } };
    }

    const controller = options.signal ? null : new AbortController();
    const signal = options.signal || controller?.signal;
    const response = await fetch(`${API_URL}/api/search?q=${encodeURIComponent(normalizedQuery)}&limit=${Number(options.limit || 10)}${activeWorkspaceId ? `&workspaceId=${encodeURIComponent(activeWorkspaceId)}` : ''}`, {
      headers: getAuthHeaders(),
      signal
    });

    if (!response.ok) throw new Error('Failed to search workspace');
    return response.json();
  }, [activeWorkspaceId]);

  const fetchMemoryDashboard = useCallback(async () => {
    const response = await fetch(`${API_URL}/api/memory${activeWorkspaceId ? `?workspaceId=${encodeURIComponent(activeWorkspaceId)}` : ''}`, {
      headers: getAuthHeaders()
    });

    if (!response.ok) throw new Error('Failed to load memory dashboard');
    return response.json();
  }, [activeWorkspaceId]);

  const updateMemoryPreferences = useCallback(async (memoryLearningEnabled: boolean) => {
    const response = await fetch(`${API_URL}/api/memory/preferences`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ memoryLearningEnabled, workspaceId: activeWorkspaceId })
    });

    if (!response.ok) throw new Error('Failed to update memory preferences');
    return response.json();
  }, [activeWorkspaceId]);

  const updateMemoryFact = useCallback(async (memoryId: string, updates: Record<string, unknown>) => {
    const response = await fetch(`${API_URL}/api/memory/facts/${memoryId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ ...updates, workspaceId: activeWorkspaceId })
    });

    if (!response.ok) throw new Error('Failed to update memory fact');
    return response.json();
  }, [activeWorkspaceId]);

  const deleteMemoryFact = useCallback(async (memoryId: string) => {
    const response = await fetch(`${API_URL}/api/memory/facts/${memoryId}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });

    if (!response.ok) throw new Error('Failed to delete memory fact');
    return response.json();
  }, [activeWorkspaceId]);

  const updateSemanticMemory = useCallback(async (memoryId: string, updates: Record<string, unknown>) => {
    const response = await fetch(`${API_URL}/api/memory/semantic/${memoryId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ ...updates, workspaceId: activeWorkspaceId })
    });

    if (!response.ok) throw new Error('Failed to update semantic memory');
    return response.json();
  }, [activeWorkspaceId]);

  const deleteSemanticMemory = useCallback(async (memoryId: string) => {
    const response = await fetch(`${API_URL}/api/memory/semantic/${memoryId}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });

    if (!response.ok) throw new Error('Failed to delete semantic memory');
    return response.json();
  }, []);

  // Delete conversation
  const deleteConversation = useCallback(async (conversationId: string) => {
    try {
      const response = await fetch(`${API_URL}/api/conversations/${conversationId}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      if (!response.ok) throw new Error('Failed to delete conversation');
      setConversations((prev) => {
        const next = prev.filter((conv) => conv._id !== conversationId);
        if (activeConversationId === conversationId) {
          setActiveConversationId(next.length > 0 ? next[0]._id : null);
          activeConversationIdRef.current = next.length > 0 ? next[0]._id : null;
          setActiveConversationRevision((value) => value + 1);
        }
        return next;
      });
    } catch (err: unknown) {
      console.error('Error deleting conversation:', err);
      setConversationError((err as Error).message);
      throw err;
    }
  }, [activeConversationId, activeWorkspaceId]);

  const fetchConversationMessages = useCallback(async (conversationId: string | null, options: { limit?: number; skip?: number } = {}) => {
    if (!conversationId) return [];
    const limit = Number(options.limit || 200);
    const skip = Number(options.skip || 0);
    const useWorkspaceFilter = Boolean(activeWorkspaceId);

    console.log('[ConversationContext] fetchConversationMessages:start', {
      conversationId,
      limit,
      skip
    });

    const loadMessages = async (workspaceId: string | null) => {
      const response = await fetch(
        `${API_URL}/api/conversations/${conversationId}/messages?limit=${limit}&skip=${skip}${workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : ''}`,
        { headers: getAuthHeaders() }
      );

      if (!response.ok) throw new Error('Failed to fetch conversation messages');
      return response.json();
    };

    let data = await loadMessages(useWorkspaceFilter ? activeWorkspaceId : null);
    if (useWorkspaceFilter && Array.isArray(data?.messages) && data.messages.length === 0) {
      try {
        const legacyData = await loadMessages(null);
        if (Array.isArray(legacyData?.messages) && legacyData.messages.length > 0) {
          data = legacyData;
        }
      } catch (legacyErr: unknown) {
        console.warn('[ConversationContext] legacy fallback failed:', (legacyErr as Error)?.message || legacyErr);
      }
    }

    console.log('[ConversationContext] fetchConversationMessages:done', {
      conversationId,
      count: Array.isArray(data?.messages) ? data.messages.length : 0,
      statuses: Array.isArray(data?.messages)
        ? data.messages.map((message: { role?: string, metadata?: Record<string, unknown>, content?: string }) => ({
            role: message?.role,
            interrupted: Boolean(message?.metadata?.interrupted),
            streaming: Boolean(message?.metadata?.streaming),
            partial: Boolean(message?.metadata?.partial),
            state: message?.metadata?.state || null,
            contentLength: String(message?.content || '').length
          }))
        : []
    });
    return Array.isArray(data?.messages) ? data.messages : [];
  }, [activeWorkspaceId]);

  // Register new conversation from socket event
  const addConversationFromSocket = useCallback((conversation: Conversation) => {
    if (!conversation?._id) return;
    if (conversation?.workspaceId && activeWorkspaceId && String(conversation.workspaceId) !== String(activeWorkspaceId)) return;
    setConversations((prev) => [conversation, ...prev.filter((conv) => conv._id !== conversation._id)]);
    setActiveConversationId(conversation._id);
    setActiveConversationRevision((value) => value + 1);
  }, [activeWorkspaceId]);

  // Update conversation title from auto-generation
  const updateConversationTitle = useCallback((conversationId: string, title: string, workspaceId: string | null = null) => {
    console.log('[ConversationContext] updateConversationTitle', { conversationId, title });
    if (workspaceId && activeWorkspaceId && String(workspaceId) !== String(activeWorkspaceId)) return;
    setConversations((prev) =>
      prev.map((conv) =>
        conv._id === conversationId ? { ...conv, title } : conv
      )
    );
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!socket) return;

    const handleConversationTitle = (data: Record<string, unknown>) => {
      if (!data?.conversationId || !data?.title) return;
      updateConversationTitle(data.conversationId as string, data.title as string, (data.workspaceId as string) || null);
      console.log('[ConversationContext] title event received', {
        conversationId: data.conversationId,
        title: data.title,
        workspaceId: data.workspaceId || null
      });
      fetchConversations().catch(() => {});
    };

    socket.on('ai:conversation:title', handleConversationTitle);
    return () => { socket.off('ai:conversation:title', handleConversationTitle); };
  }, [socket, updateConversationTitle, fetchConversations]);

  // Reset and reload whenever the active workspace changes.
  useEffect(() => {
    setConversations([]);
    setActiveConversationId(null);
    activeConversationIdRef.current = null;
    setFocusedMessageId(null);
    setActiveConversationRevision((value) => value + 1);
    fetchConversations();
  }, [activeWorkspaceId, workspaceRevision]);

  const value: ConversationContextType = {
    conversations,
    activeConversationId,
    activeConversationRevision,
    focusedMessageId,
    setFocusedMessageId,
    loadingConversations,
    conversationError,
    fetchConversations,
    createNewConversation,
    ensureConversationReady,
    switchConversation,
    updateConversation,
    deleteConversation,
    fetchConversationMessages,
    addConversationFromSocket,
    updateConversationTitle,
    searchWorkspace,
    fetchMemoryDashboard,
    updateMemoryPreferences,
    updateMemoryFact,
    deleteMemoryFact,
    updateSemanticMemory,
    deleteSemanticMemory,
    isFirstMessageSendingRef
  };

  return (
    <ConversationContext.Provider value={value}>
      {children}
    </ConversationContext.Provider>
  );
};
