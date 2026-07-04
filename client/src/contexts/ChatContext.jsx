import React, { createContext, useCallback, useEffect, useMemo, useRef, useState, useContext } from 'react';
import { useWorkspace } from './WorkspaceContext';

const ChatContext = createContext();

export const useChat = () => useContext(ChatContext);

// Exportable sanitizer for display-time normalization
export const sanitizeForDisplay = (text) => {
  if (!text || typeof text !== 'string') return text;
  let t = String(text);
  t = t.replace(/\r\n|\r/g, '\n');
  t = t.replace(/\*{1,2}/g, '');
  t = t.replace(/_{1,2}/g, '');
  t = t.replace(/`+/g, '');
  t = t.replace(/https?:\/\/[^\s]+/g, '');
  t = t.replace(/([.,!?:;])(?=\S)/g, '$1 ');
  t = t.replace(/(\S)([—–-])/g, '$1 $2');
  t = t.replace(/([—–-])(\S)/g, '$1 $2');
  t = t.replace(/\s{2,}/g, ' ');
  t = t.replace(/([!?.]){2,}/g, '$1');
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