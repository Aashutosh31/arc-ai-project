import React, { createContext, useState, useContext, useCallback, useEffect } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

const ConversationContext = createContext();

export const useConversation = () => {
  const ctx = useContext(ConversationContext);
  if (!ctx) throw new Error('useConversation must be used inside ConversationProvider');
  return ctx;
};

export const ConversationProvider = ({ children }) => {
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [focusedMessageId, setFocusedMessageId] = useState(null);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [conversationError, setConversationError] = useState(null);

  const getAuthHeaders = () => ({
    Authorization: `Bearer ${localStorage.getItem('token')}`
  });

  // Fetch conversations from API
  const fetchConversations = useCallback(async () => {
    setLoadingConversations(true);
    setConversationError(null);
    try {
      const response = await fetch(`${API_URL}/api/conversations`, {
        headers: getAuthHeaders()
      });
      if (!response.ok) throw new Error('Failed to fetch conversations');
      const data = await response.json();
      setConversations(Array.isArray(data) ? data : []);
      if (!activeConversationId && Array.isArray(data) && data.length > 0) {
        setActiveConversationId(data[0]._id);
      }
    } catch (err) {
      console.error('Error fetching conversations:', err);
      setConversationError(err.message);
    } finally {
      setLoadingConversations(false);
    }
  }, [activeConversationId]);

  // Create new conversation
  const createNewConversation = useCallback(async (title = 'New Conversation') => {
    try {
      const response = await fetch(`${API_URL}/api/conversations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({ title })
      });
      if (!response.ok) throw new Error('Failed to create conversation');
      const newConv = await response.json();
      setConversations((prev) => [newConv, ...prev.filter((conv) => conv._id !== newConv._id)]);
      setActiveConversationId(newConv._id);
      return newConv;
    } catch (err) {
      console.error('Error creating conversation:', err);
      setConversationError(err.message);
      throw err;
    }
  }, []);

  // Switch to a conversation
  const switchConversation = useCallback((conversationId) => {
    setActiveConversationId(conversationId);
  }, []);

  // Update conversation (title, pinned status)
  const updateConversation = useCallback(async (conversationId, updates) => {
    try {
      const response = await fetch(`${API_URL}/api/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify(updates)
      });
      if (!response.ok) throw new Error('Failed to update conversation');
      const updated = await response.json();
      setConversations((prev) =>
        prev.map((conv) => (conv._id === conversationId ? updated : conv))
      );
      return updated;
    } catch (err) {
      console.error('Error updating conversation:', err);
      setConversationError(err.message);
      throw err;
    }
  }, []);

  const searchWorkspace = useCallback(async (query, options = {}) => {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return { query: '', items: [], grouped: { conversations: [], messages: [], memories: [] }, stats: { total: 0, conversations: 0, messages: 0, memories: 0 } };
    }

    const controller = options.signal ? null : new AbortController();
    const signal = options.signal || controller?.signal;
    const response = await fetch(`${API_URL}/api/search?q=${encodeURIComponent(normalizedQuery)}&limit=${Number(options.limit || 10)}`, {
      headers: getAuthHeaders(),
      signal
    });

    if (!response.ok) throw new Error('Failed to search workspace');
    return response.json();
  }, []);

  const fetchMemoryDashboard = useCallback(async () => {
    const response = await fetch(`${API_URL}/api/memory`, {
      headers: getAuthHeaders()
    });

    if (!response.ok) throw new Error('Failed to load memory dashboard');
    return response.json();
  }, []);

  const updateMemoryPreferences = useCallback(async (memoryLearningEnabled) => {
    const response = await fetch(`${API_URL}/api/memory/preferences`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ memoryLearningEnabled })
    });

    if (!response.ok) throw new Error('Failed to update memory preferences');
    return response.json();
  }, []);

  const updateMemoryFact = useCallback(async (memoryId, updates) => {
    const response = await fetch(`${API_URL}/api/memory/facts/${memoryId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify(updates)
    });

    if (!response.ok) throw new Error('Failed to update memory fact');
    return response.json();
  }, []);

  const deleteMemoryFact = useCallback(async (memoryId) => {
    const response = await fetch(`${API_URL}/api/memory/facts/${memoryId}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });

    if (!response.ok) throw new Error('Failed to delete memory fact');
    return response.json();
  }, []);

  const updateSemanticMemory = useCallback(async (memoryId, updates) => {
    const response = await fetch(`${API_URL}/api/memory/semantic/${memoryId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify(updates)
    });

    if (!response.ok) throw new Error('Failed to update semantic memory');
    return response.json();
  }, []);

  const deleteSemanticMemory = useCallback(async (memoryId) => {
    const response = await fetch(`${API_URL}/api/memory/semantic/${memoryId}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });

    if (!response.ok) throw new Error('Failed to delete semantic memory');
    return response.json();
  }, []);

  // Delete conversation
  const deleteConversation = useCallback(async (conversationId) => {
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
        }
        return next;
      });
    } catch (err) {
      console.error('Error deleting conversation:', err);
      setConversationError(err.message);
      throw err;
    }
  }, [activeConversationId]);

  const fetchConversationMessages = useCallback(async (conversationId, options = {}) => {
    if (!conversationId) return [];
    const limit = Number(options.limit || 200);
    const skip = Number(options.skip || 0);

    const response = await fetch(
      `${API_URL}/api/conversations/${conversationId}/messages?limit=${limit}&skip=${skip}`,
      { headers: getAuthHeaders() }
    );

    if (!response.ok) throw new Error('Failed to fetch conversation messages');
    const data = await response.json();
    return Array.isArray(data?.messages) ? data.messages : [];
  }, []);

  // Register new conversation from socket event
  const addConversationFromSocket = useCallback((conversation) => {
    if (!conversation?._id) return;
    setConversations((prev) => [conversation, ...prev.filter((conv) => conv._id !== conversation._id)]);
    setActiveConversationId(conversation._id);
  }, []);

  // Update conversation title from auto-generation
  const updateConversationTitle = useCallback((conversationId, title) => {
    setConversations((prev) =>
      prev.map((conv) =>
        conv._id === conversationId ? { ...conv, title } : conv
      )
    );
  }, []);

  // Load conversations on mount
  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const value = {
    conversations,
    activeConversationId,
    focusedMessageId,
    setFocusedMessageId,
    loadingConversations,
    conversationError,
    fetchConversations,
    createNewConversation,
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
    deleteSemanticMemory
  };

  return (
    <ConversationContext.Provider value={value}>
      {children}
    </ConversationContext.Provider>
  );
};
