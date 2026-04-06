import React, { useEffect, useRef, useState } from 'react';
import styled, { keyframes } from 'styled-components';
import { useChat } from '../contexts/ChatContext';
import { useSocket } from '../hooks/useSocket';

const Waveform = keyframes`
  0%, 100% { height: 10px; transform: translateY(0); }
  50% { height: 20px; transform: translateY(-5px); }
`;

const typing = keyframes`
  0%, 100% { transform: translateY(0); opacity: 0.5; }
  50% { transform: translateY(-5px); opacity: 1; }
`;

const ChatWrapper = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  width: 100%;
  height: 100%;
  gap: 12px;
`;

// 🚀 UPGRADE: Swapped hardcoded colors for CSS Variables!
const MessageContainer = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  background: var(--chat-bg);
  backdrop-filter: blur(8px);
  border: 2px solid var(--primary-hex);
  border-radius: 14px;
  overflow-y: auto;
  padding: 14px 14px 10px;
  box-shadow: 0 0 22px rgba(var(--primary-rgb), 0.25);
  min-height: 260px;
  transition: all 0.5s ease;

  &::-webkit-scrollbar { width: 8px; }
  &::-webkit-scrollbar-track { background: rgba(0,0,0,0.2); }
  &::-webkit-scrollbar-thumb { background: var(--primary-hex); border-radius: 4px; }
`;

const MessageBubble = styled.div`
  max-width: 80%;
  margin-bottom: 12px;
  padding: 12px 16px;
  border-radius: 12px;
  line-height: 1.4;
  align-self: ${props => props.$role === 'user' ? 'flex-end' : 'flex-start'};
  background: ${props => props.$role === 'user' ? 'rgba(var(--primary-rgb), 0.15)' : 'rgba(var(--secondary-rgb), 0.15)'};
  border: 1px solid ${props => props.$role === 'user' ? 'rgba(var(--primary-rgb), 0.4)' : 'rgba(var(--secondary-rgb), 0.4)'};
  color: #fff;
  white-space: pre-wrap;
  word-wrap: break-word;
  transition: all 0.5s ease;
`;

const WaveformBars = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 10px;
  height: 20px;

  div {
    width: 3px;
    background: var(--primary-hex);
    border-radius: 2px;
    animation: ${Waveform} 1s ease-in-out infinite;
  }
  div:nth-child(2) { animation-delay: 0.1s; }
  div:nth-child(3) { animation-delay: 0.2s; }
  div:nth-child(4) { animation-delay: 0.3s; }
  div:nth-child(5) { animation-delay: 0.4s; }
`;

const TypingIndicator = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;

  span {
    width: 6px;
    height: 6px;
    background: var(--secondary-hex);
    border-radius: 50%;
    animation: ${typing} 1.4s infinite ease-in-out both;
  }
  span:nth-child(1) { animation-delay: -0.32s; }
  span:nth-child(2) { animation-delay: -0.16s; }
`;

const StopButton = styled.button`
  align-self: center;
  background: rgba(255, 0, 0, 0.15);
  border: 1px solid rgba(255, 0, 0, 0.4);
  color: #ff4d4d;
  padding: 8px 16px;
  border-radius: 20px;
  cursor: pointer;
  margin-top: 10px;
  font-size: 14px;
  display: inline-block;
  transition: all 0.2s;

  &:hover { background: rgba(255, 0, 0, 0.3); color: #fff; }
`;

const InputForm = styled.form`
  display: flex;
  gap: 10px;
  width: 100%;
`;

const TextInput = styled.input`
  flex: 1;
  background: var(--chat-bg);
  border: 1px solid rgba(var(--primary-rgb), 0.4);
  color: #fff;
  padding: 12px 18px;
  border-radius: 24px;
  font-size: 15px;
  outline: none;
  transition: all 0.5s ease;

  &:focus {
    border-color: var(--primary-hex);
    box-shadow: 0 0 10px rgba(var(--primary-rgb), 0.2);
  }
  &::placeholder { color: rgba(255, 255, 255, 0.4); }
`;

const SendButton = styled.button`
  background: var(--primary-hex);
  color: #020314;
  border: none;
  padding: 0 24px;
  border-radius: 24px;
  font-weight: bold;
  cursor: pointer;
  transition: all 0.5s ease;

  &:hover {
    box-shadow: 0 0 15px rgba(var(--primary-rgb), 0.4);
    opacity: 0.9;
  }
  &:disabled {
    background: rgba(var(--primary-rgb), 0.2);
    color: rgba(255, 255, 255, 0.5);
    cursor: not-allowed;
  }
`;

const ChatInterface = () => {
  const { messages, isProcessing, isSpeaking } = useChat();
  const { interruptStream, sendCommand } = useSocket(); 
  const [inputText, setInputText] = useState('');
  const chatEndRef = useRef(null);

  const isBusy = isProcessing || isSpeaking;

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
      if (event.code === 'Space' && isBusy) {
        event.preventDefault(); 
        interruptStream();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isBusy, interruptStream]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isProcessing, isSpeaking]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!inputText.trim() || isBusy) return;
    sendCommand(inputText.trim());
    setInputText('');
  };

  return (
    <ChatWrapper>
      <MessageContainer>
        {messages.map((msg, index) => (
          <MessageBubble key={index} $role={msg.sender === 'ai' ? 'assistant' : 'user'}>
            {msg.sender === 'ai' && <span style={{ fontWeight: 'bold' }}>ARC-AI: </span>}
            {msg.text}
            {msg.sender === 'ai' && (msg.isStreaming || (isSpeaking && index === messages.length - 1)) && (
              <WaveformBars><div></div><div></div><div></div><div></div><div></div></WaveformBars>
            )}
          </MessageBubble>
        ))}

        {isProcessing && (messages.length === 0 || messages[messages.length - 1].sender !== 'ai') && (
          <MessageBubble $role="assistant">
            <TypingIndicator><span></span><span></span><span></span></TypingIndicator>
          </MessageBubble>
        )}

        {isBusy && (
          <StopButton onClick={interruptStream}>
            ⏹ {isSpeaking ? "Stop Speaking" : "Stop Generating"} (Press Space)
          </StopButton>
        )}

        <div ref={chatEndRef} />
      </MessageContainer>

      <InputForm onSubmit={handleSubmit}>
        <TextInput 
          type="text" placeholder="Message ARC-AI..." 
          value={inputText} onChange={(e) => setInputText(e.target.value)}
          disabled={isBusy} autoComplete="off"
        />
        <SendButton type="submit" disabled={!inputText.trim() || isBusy}>Send</SendButton>
      </InputForm>
    </ChatWrapper>
  );
};

export default ChatInterface;