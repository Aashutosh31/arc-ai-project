import React, { createContext, useCallback, useEffect, useMemo, useRef, useState, useContext } from 'react';
import { useWorkspace } from './WorkspaceContext';

const ChatContext = createContext();

export const useChat = () => useContext(ChatContext);

// Exportable sanitizer for display-time normalization.
// Markdown-structure-safe: newlines, fences, tables, and emphasis syntax
// MUST survive this pass or MarkdownRenderer receives broken source.
// (A previous version collapsed \s{2,} which joined every line and
// destroyed tables, lists, code blocks, and paragraphs.)
export const sanitizeForDisplay = (text) => {
  if (!text || typeof text !== 'string') return text;
  let t = String(text);
  t = t.replace(/\r\n|\r/g, '\n');
  t = t.replace(/[ \t]+$/gm, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
};

export const ChatProvider = ({ children }) => {
  const { activeWorkspaceId, workspaceRevision } = useWorkspace();
  const [messages, setMessages] = useState([]);
  const [isProcessing, setIsProcessingState] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isVoiceListening, setIsVoiceListening] = useState(false);
  const [isInterrupted, setIsInterrupted] = useState(false);
  const [agentStatus, setAgentStatus] = useState(null);
  const [providerInfo, setProviderInfo] = useState(null);

  // 🚀 NEW: State to hold the currently playing YouTube video
  const [mediaData, setMediaData] = useState(null);
  const liveVisionCaptureRef = useRef(() => null);

  const isInterruptedRef = useRef(false);

  const setIsProcessing = useCallback((nextValue) => {
    const resolvedValue = typeof nextValue === 'function' ? nextValue(isProcessing) : nextValue;
    const nextBoolean = Boolean(resolvedValue);
    setIsProcessingState(nextBoolean);
    setIsStreaming(nextBoolean);
  }, [isProcessing]);

  const addMessage = useCallback((message) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const replaceMessages = useCallback((nextMessages = []) => {
    setMessages(Array.isArray(nextMessages) ? nextMessages : []);
    setIsProcessing(false);
    setIsStreaming(false);
  }, []);

  // Prepend an older history page ahead of the current list (Stage 2 cursor
  // pagination). Deduplicates by database id — never by text/timestamp/index.
  // Live (id-less) messages are always preserved. Functional update so a
  // streaming append landing mid-prepend cannot produce duplicates.
  const prependMessages = useCallback((olderMessages = []) => {
    if (!Array.isArray(olderMessages) || olderMessages.length === 0) return;
    setMessages((prev) => {
      const known = new Set();
      for (const m of prev) {
        if (m && m.id !== null && m.id !== undefined) known.add(String(m.id));
      }
      const novel = olderMessages.filter((m) => {
        if (!m || typeof m !== 'object') return false;
        if (m.id === null || m.id === undefined) return true;
        return !known.has(String(m.id));
      });
      if (novel.length === 0) return prev;
      return [...novel, ...prev];
    });
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setIsProcessing(false);
    setIsStreaming(false);
  }, []);

  const appendBotChunk = useCallback((chunk) => {
    // Append-only streaming: do not sanitize, normalize, or mutate previous content.
    // This ensures stable rendering with no layout shifts while streaming.
    setMessages((prev) => {
      const lastMsg = prev[prev.length - 1];
      if (lastMsg && lastMsg.sender === 'ai' && lastMsg.isStreaming) {
        const updated = [...prev];
        updated[updated.length - 1] = { ...lastMsg, text: (lastMsg.text || '') + (chunk || '') };
        return updated;
      } else {
        return [...prev, { sender: 'ai', text: chunk || '', isStreaming: true }];
      }
    });
  }, []);

  const finishBotStream = useCallback(() => {
    // Final normalization pass: use shared sanitizer (exported below)
    const normalizeFinalText = (text) => sanitizeForDisplay(text);

    setMessages((prev) => {
      const updated = [...prev];
      const lastMsg = updated[updated.length - 1];
      if (lastMsg && lastMsg.sender === 'ai') {
        lastMsg.text = normalizeFinalText(lastMsg.text || '');
        lastMsg.isStreaming = false;
      }
      return updated;
    });
    setIsProcessing(false);
    setIsStreaming(false);
    setIsInterrupted(false);
  }, []);

  const markBotInterrupted = useCallback(() => {
    setMessages((prev) => {
      const updated = [...prev];
      const lastMsg = updated[updated.length - 1];
      if (lastMsg && lastMsg.sender === 'ai') {
        lastMsg.isStreaming = false;
        lastMsg.isInterrupted = true;
      }
      return updated;
    });
    setIsProcessing(false);
    setIsStreaming(false);
    setIsInterrupted(true);
  }, []);

  

  const setLiveVisionCapture = useCallback((captureFn) => {
    liveVisionCaptureRef.current = typeof captureFn === 'function' ? captureFn : () => null;
  }, []);

  const getLiveVisionFrame = useCallback(() => {
    try {
      return liveVisionCaptureRef.current?.() || null;
    } catch {
      return null;
    }
  }, []);

  const loadedWorkspaceCountRef = useRef(0);

  useEffect(() => {
    if (activeWorkspaceId) {
      loadedWorkspaceCountRef.current += 1;
    }

    // Skip clearing messages on the initial workspace bootstrap load
    if (loadedWorkspaceCountRef.current <= 1) {
      return;
    }

    clearMessages();
    setAgentStatus(null);
    setProviderInfo(null);
    setMediaData(null);
    setIsInterrupted(false);
    isInterruptedRef.current = false;
  }, [activeWorkspaceId, workspaceRevision]);

  const value = useMemo(() => ({
      messages,
      addMessage,
      replaceMessages,
      prependMessages,
      clearMessages,
      appendBotChunk,
      finishBotStream,
      markBotInterrupted,
      isProcessing,
      setIsProcessing,
      isStreaming,
      setIsStreaming,
      isSpeaking,
      setIsSpeaking,
      isVoiceListening,
      setIsVoiceListening,
      isInterrupted,
      setIsInterrupted,
      agentStatus,
      setAgentStatus,
      providerInfo,
      setProviderInfo,
      isInterruptedRef,
      mediaData,
      setMediaData,
      setLiveVisionCapture,
      getLiveVisionFrame
  }), [
      messages,
      addMessage,
      replaceMessages,
      prependMessages,
      clearMessages,
      appendBotChunk,
      finishBotStream,
      markBotInterrupted,
      isProcessing,
      setIsProcessing,
      isStreaming,
      isSpeaking,
      isVoiceListening,
      isInterrupted,
      agentStatus,
      providerInfo,
      mediaData,
      setLiveVisionCapture,
      getLiveVisionFrame
  ]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};