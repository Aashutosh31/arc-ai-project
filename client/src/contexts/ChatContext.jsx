import React, { createContext, useState, useContext, useRef } from 'react';

const ChatContext = createContext();

export const useChat = () => useContext(ChatContext);

export const ChatProvider = ({ children }) => {
  const [messages, setMessages] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const [isSpeaking, setIsSpeaking] = useState(false);
  const [agentStatus, setAgentStatus] = useState(null);

  // 🚀 NEW: State to hold the currently playing YouTube video
  const [mediaData, setMediaData] = useState(null);
  const liveVisionCaptureRef = useRef(() => null);

  const isInterruptedRef = useRef(false);

  const addMessage = (message) => {
    setMessages((prev) => [...prev, message]);
  };

  const replaceMessages = (nextMessages = []) => {
    setMessages(Array.isArray(nextMessages) ? nextMessages : []);
    setIsProcessing(false);
  };

  const clearMessages = () => {
    setMessages([]);
    setIsProcessing(false);
  };

  const appendBotChunk = (chunk) => {
    setMessages((prev) => {
      const lastMsg = prev[prev.length - 1];
      if (lastMsg && lastMsg.sender === 'ai' && lastMsg.isStreaming) {
        const updated = [...prev];
        updated[updated.length - 1] = { ...lastMsg, text: lastMsg.text + chunk };
        return updated;
      } else {
        return [...prev, { sender: 'ai', text: chunk, isStreaming: true }];
      }
    });
  };

  const finishBotStream = () => {
    setMessages((prev) => {
      const updated = [...prev];
      const lastMsg = updated[updated.length - 1];
      if (lastMsg && lastMsg.sender === 'ai') {
        lastMsg.isStreaming = false;
      }
      return updated;
    });
    setIsProcessing(false);
  };

  const setLiveVisionCapture = (captureFn) => {
    liveVisionCaptureRef.current = typeof captureFn === 'function' ? captureFn : () => null;
  };

  const getLiveVisionFrame = () => {
    try {
      return liveVisionCaptureRef.current?.() || null;
    } catch {
      return null;
    }
  };

  return (
    <ChatContext.Provider value={{ 
        messages, 
        addMessage, 
        replaceMessages,
        clearMessages,
        appendBotChunk, 
        finishBotStream,
        isProcessing, 
        setIsProcessing,
        isSpeaking,
        setIsSpeaking,
        agentStatus,
        setAgentStatus,
        isInterruptedRef,
        mediaData,
        setMediaData,
        setLiveVisionCapture,
        getLiveVisionFrame
    }}>
      {children}
    </ChatContext.Provider>
  );
};