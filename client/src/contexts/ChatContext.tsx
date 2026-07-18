import React, { createContext, useCallback, useEffect, useMemo, useRef, useState, useContext, ReactNode, MutableRefObject } from 'react';
import { useWorkspace } from './WorkspaceContext';

export interface ChatMessage {
  sender: 'ai' | 'user' | 'system';
  text: string;
  isStreaming?: boolean;
  isInterrupted?: boolean;
  [key: string]: unknown;
}

export interface MediaData {
  videoId?: string;
  [key: string]: unknown;
}

interface ChatContextType {
  messages: ChatMessage[];
  addMessage: (message: ChatMessage) => void;
  replaceMessages: (nextMessages?: ChatMessage[]) => void;
  clearMessages: () => void;
  appendBotChunk: (chunk: string) => void;
  finishBotStream: () => void;
  markBotInterrupted: () => void;
  isProcessing: boolean;
  setIsProcessing: (nextValue: boolean | ((prev: boolean) => boolean)) => void;
  isStreaming: boolean;
  setIsStreaming: (val: boolean) => void;
  isSpeaking: boolean;
  setIsSpeaking: (val: boolean) => void;
  isVoiceListening: boolean;
  setIsVoiceListening: (val: boolean) => void;
  isInterrupted: boolean;
  setIsInterrupted: (val: boolean) => void;
  agentStatus: string | null;
  setAgentStatus: (status: string | null) => void;
  providerInfo: Record<string, unknown> | null;
  setProviderInfo: (info: Record<string, unknown> | null) => void;
  isInterruptedRef: MutableRefObject<boolean>;
  mediaData: MediaData | null;
  setMediaData: (data: MediaData | null) => void;
  setLiveVisionCapture: (captureFn: () => string | null) => void;
  getLiveVisionFrame: () => string | null;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

export const useChat = () => {
  const context = useContext(ChatContext);
  if (!context) throw new Error("useChat must be used within a ChatProvider");
  return context;
};

// Exportable sanitizer for display-time normalization
export const sanitizeForDisplay = (text: unknown): string => {
  if (!text || typeof text !== 'string') return text ? String(text) : '';
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

export const ChatProvider = ({ children }: { children: ReactNode }) => {
  const { activeWorkspaceId, workspaceRevision } = useWorkspace();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isProcessing, setIsProcessingState] = useState<boolean>(false);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);

  const [isSpeaking, setIsSpeaking] = useState<boolean>(false);
  const [isVoiceListening, setIsVoiceListening] = useState<boolean>(false);
  const [isInterrupted, setIsInterrupted] = useState<boolean>(false);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const [providerInfo, setProviderInfo] = useState<Record<string, unknown> | null>(null);

  // 🚀 NEW: State to hold the currently playing YouTube video
  const [mediaData, setMediaData] = useState<MediaData | null>(null);
  const liveVisionCaptureRef = useRef<() => string | null>(() => null);

  const isInterruptedRef = useRef<boolean>(false);

  const setIsProcessing = useCallback((nextValue: boolean | ((prev: boolean) => boolean)) => {
    const resolvedValue = typeof nextValue === 'function' ? nextValue(isProcessing) : nextValue;
    const nextBoolean = Boolean(resolvedValue);
    setIsProcessingState(nextBoolean);
    setIsStreaming(nextBoolean);
  }, [isProcessing]);

  const addMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const replaceMessages = useCallback((nextMessages: ChatMessage[] = []) => {
    setMessages(Array.isArray(nextMessages) ? nextMessages : []);
    setIsProcessingState(false);
    setIsStreaming(false);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setIsProcessingState(false);
    setIsStreaming(false);
  }, []);

  const appendBotChunk = useCallback((chunk: string) => {
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
    const normalizeFinalText = (text: string) => sanitizeForDisplay(text);

    setMessages((prev) => {
      const updated = [...prev];
      const lastMsg = updated[updated.length - 1];
      if (lastMsg && lastMsg.sender === 'ai') {
        lastMsg.text = normalizeFinalText(lastMsg.text || '');
        lastMsg.isStreaming = false;
      }
      return updated;
    });
    setIsProcessingState(false);
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
    setIsProcessingState(false);
    setIsStreaming(false);
    setIsInterrupted(true);
  }, []);

  

  const setLiveVisionCapture = useCallback((captureFn: () => string | null) => {
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