// client/src/components/ChatInterface.jsx
import React, { useEffect, useRef, useState } from 'react';
import styled, { keyframes } from 'styled-components';
import { useChat } from '../contexts/ChatContext';
import { useSocket } from '../hooks/useSocket';
import useTextToSpeech from '../hooks/useTextToSpeech';

const Waveform = keyframes`
  0%, 100% { height: 10px; transform: translateY(0); }
  50% { height: 20px; transform: translateY(-5px); }
`;

const MessageContainer = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  width: 100%;
  background: rgba(10, 10, 30, 0.7);
  backdrop-filter: blur(8px);
  border: 2px solid #00ffff;
  border-radius: 14px;
  overflow-y: auto;
  padding: 14px 14px 10px;
  box-shadow: 0 0 22px rgba(0, 255, 255, 0.25);

  /* Constrain height inside parent */
  min-height: 260px;
  max-height: 100%;

  /* Custom Scrollbar Styling */
  &::-webkit-scrollbar {
    width: 8px;
  }

  &::-webkit-scrollbar-track {
    background: rgba(10, 10, 30, 0.9);
    border-radius: 10px;
    margin: 10px 0;
  }

  &::-webkit-scrollbar-thumb {
    background: linear-gradient(180deg, #00ffff, #0077cc);
    border-radius: 10px;
    border: 2px solid rgba(10, 10, 30, 0.9);
    transition: all 0.3s ease;
  }

  &::-webkit-scrollbar-thumb:hover {
    background: linear-gradient(180deg, #00ffff, #00bfff);
    box-shadow: 0 0 10px rgba(0, 255, 255, 0.5);
  }

  scrollbar-width: thin;
  scrollbar-color: #00ffff rgba(10, 10, 30, 0.9);

  @media (max-width: 600px) {
    padding: 10px 10px 8px;
    border-width: 1px;
  }
`;

const MessageBubble = styled.div`
  margin: 6px 0;
  padding: 10px 14px;
  border-radius: 18px;
  max-width: 90%;
  font-size: 0.95rem;
  line-height: 1.4;
  transition: all 0.25s ease-in-out;
  word-break: break-word;

  align-self: ${props => (props.$role === 'user' ? 'flex-end' : 'flex-start')};
  background: ${props =>
    props.$role === 'user'
      ? 'linear-gradient(135deg, #00bfff, #0077cc)'
      : 'rgba(0, 255, 255, 0.08)'};
  color: ${props => (props.$role === 'user' ? '#fff' : '#00ffff')};
  border: ${props => (props.$role === 'assistant' ? '1px solid #00ffff' : 'none')};

  @media (min-width: 768px) {
    font-size: 1rem;
    max-width: 80%;
  }
`;

const TypingIndicator = styled.div`
  margin-left: 4px;

  span {
    display: inline-block;
    width: 4px;
    height: 4px;
    background: #00ffff;
    border-radius: 50%;
    margin: 0 2px;
    animation: blink 0.7s infinite;
  }

  @keyframes blink {
    0% { opacity: 0.3; }
    50% { opacity: 1; }
    100% { opacity: 0.3; }
  }

  span:nth-child(2) { animation-delay: 0.2s; }
  span:nth-child(3) { animation-delay: 0.4s; }
`;

const WaveformBars = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-start;
  height: 24px;
  margin-top: 6px;

  div {
    width: 4px;
    height: 10px;
    background: #ff00ff;
    margin: 0 2px;
    border-radius: 2px;
    animation: ${Waveform} 0.5s infinite alternate;

    &:nth-child(1) { animation-delay: 0s; }
    &:nth-child(2) { animation-delay: 0.1s; }
    &:nth-child(3) { animation-delay: 0.2s; }
    &:nth-child(4) { animation-delay: 0.3s; }
    &:nth-child(5) { animation-delay: 0.4s; }
  }
`;

const ChatInterface = () => {
  const { history, addMessage } = useChat();
  const { socket } = useSocket();
  const { speak, isSpeaking } = useTextToSpeech();
  const chatEndRef = useRef(null);

  const [streamingText, setStreamingText] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  useEffect(() => {
    if (socket) {
      socket.on('ai:tts:response:chunk', (data) => {
        if (!isTyping) setIsTyping(true);

        if (data.isFinal) {
          const finalContent = data.chunk;

          addMessage('assistant', finalContent);
          speak(finalContent);

          setStreamingText('');
          setIsTyping(false);
        } else {
          setStreamingText(prev => prev + data.chunk);
        }
      });

      return () => socket.off('ai:tts:response:chunk');
    }
  }, [socket, addMessage, speak, isTyping]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, streamingText]);

  return (
    <MessageContainer>
      {history.map((msg, index) => (
        <MessageBubble key={index} $role={msg.role}>
          {msg.role === 'assistant' && (
            <span style={{ fontWeight: 'bold' }}>ARC-AI: </span>
          )}
          {msg.content}
          {msg.role === 'assistant' &&
            isSpeaking &&
            index === history.length - 1 && (
              <WaveformBars>
                <div></div><div></div><div></div><div></div><div></div>
              </WaveformBars>
            )}
        </MessageBubble>
      ))}

      {isTyping && (
        <MessageBubble $role="assistant">
          <TypingIndicator>
            <span></span><span></span><span></span>
          </TypingIndicator>
        </MessageBubble>
      )}

      <div ref={chatEndRef} />
    </MessageContainer>
  );
};

export default ChatInterface;
