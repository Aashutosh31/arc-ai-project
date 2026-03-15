import React, { createContext, useState, useContext } from 'react';

const ChatContext = createContext();

export const useChat = () => useContext(ChatContext);

export const ChatProvider = ({ children }) => {
  const [messages, setMessages] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);

  // Add a standard, complete message
  const addMessage = (message) => {
    setMessages((prev) => [...prev, message]);
  };

  // Appends a streaming chunk to the current AI message
  const appendBotChunk = (chunk) => {
    setMessages((prev) => {
      const lastMsg = prev[prev.length - 1];
      
      // If the last message is already a streaming AI message, append to it
      if (lastMsg && lastMsg.sender === 'ai' && lastMsg.isStreaming) {
        const updated = [...prev];
        updated[updated.length - 1] = { 
            ...lastMsg, 
            text: lastMsg.text + chunk 
        };
        return updated;
      } else {
        // Otherwise, create the first chunk of a new AI message
        return [...prev, { sender: 'ai', text: chunk, isStreaming: true }];
      }
    });
  };

  // Marks the stream as complete
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

  return (
    <ChatContext.Provider value={{ 
        messages, 
        addMessage, 
        appendBotChunk, 
        finishBotStream,
        isProcessing, 
        setIsProcessing 
    }}>
      {children}
    </ChatContext.Provider>
  );
};