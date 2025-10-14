// client/src/components/ChatInterface.jsx (FINAL CODE)
import React, { useEffect, useRef, useState } from 'react';
import styled, { keyframes } from 'styled-components';
import { useChat } from '../contexts/ChatContext';
import { useSocket } from '../hooks/useSocket';
import useTextToSpeech from '../hooks/useTextToSpeech'; // Import TTS Hook

const Waveform = keyframes`
    0%, 100% { height: 10px; transform: translateY(0); }
    50% { height: 20px; transform: translateY(-5px); }
`;
const MessageContainer = styled.div`
    display: flex;
    flex-direction: column;
    height: 60vh;
    width: 100%;
    max-width: 800px;
    background: rgba(10, 10, 30, 0.7); 
    backdrop-filter: blur(8px);
    border: 2px solid #00FFFF;
    border-radius: 15px;
    overflow-y: scroll;
    padding: 15px;
    margin-top: 20px;
    box-shadow: 0 0 30px rgba(0, 255, 255, 0.3);
`;
const MessageBubble = styled.div`
    margin: 8px 0;
    padding: 12px 18px;
    border-radius: 20px;
    max-width: 85%;
    font-size: 1.1em;
    line-height: 1.4;
    transition: all 0.3s ease-in-out;
    
    align-self: ${props => props.$role === 'user' ? 'flex-end' : 'flex-start'};
    background: ${props => props.$role === 'user' ? 'linear-gradient(135deg, #00BFFF, #0077CC)' : 'rgba(0, 255, 255, 0.1)'};
    color: ${props => props.$role === 'user' ? '#fff' : '#00FFFF'};
    border: ${props => props.$role === 'assistant' ? '1px solid #00FFFF' : 'none'};
`;
const TypingIndicator = styled.div`
    margin-left: 10px;
    span {
        display: inline-block;
        width: 4px;
        height: 4px;
        background: #00FFFF;
        border-radius: 50%;
        margin: 0 2px;
        animation: blink 0.7s infinite;
        &:nth-child(2) { animation-delay: 0.2s; }
        &:nth-child(3) { animation-delay: 0.4s; }
    }
`;
const WaveformBars = styled.div`
    display: flex;
    align-items: center;
    justify-content: center;
    height: 30px;
    margin-top: 10px;

    div {
        width: 4px;
        height: 10px;
        background: #FF00FF; /* Neon Pink/Purple for Voice */
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
    const { speak, isSpeaking } = useTextToSpeech(); // TTS hook
    const chatEndRef = useRef(null);
    
    const [streamingText, setStreamingText] = useState('');
    const [isTyping, setIsTyping] = useState(false);

    // --- Socket Listener for AI Response ---
    useEffect(() => {
        if (socket) {
            // Fragment listener is handled in the VoiceButton, but we need the final chunk here.
            socket.on('ai:tts:response:chunk', (data) => {
                if (!isTyping) setIsTyping(true);

                // For the portfolio demo, we are receiving the full chunk at once (isFinal: true)
                // In a true stream, you would append data.chunk to setStreamingText

                if (data.isFinal) {
                    const finalContent = data.chunk; // The full final response

                    // 1. Add final message
                    addMessage('assistant', finalContent); 
                    
                    // 2. Trigger TTS (Voice Output)
                    speak(finalContent); 

                    // 3. Clear stream/indicators
                    setStreamingText('');
                    setIsTyping(false);
                } else {
                    // For demo, we just show the typing animation while waiting for the single final chunk
                    setStreamingText(prev => prev + data.chunk);
                }
            });

            return () => socket.off('ai:tts:response:chunk');
        }
    }, [socket, addMessage, speak, isTyping]);

    // Auto-scroll to bottom of chat
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [history, streamingText]);

    return (
        <MessageContainer>
            {history.map((msg, index) => (
                <MessageBubble key={index} $role={msg.role}>
                    {msg.role === 'assistant' && <span style={{ fontWeight: 'bold' }}>ARC-AI: </span>}
                    {msg.content}
                    {msg.role === 'assistant' && isSpeaking && index === history.length - 1 && (
                        <WaveformBars>
                            <div></div><div></div><div></div><div></div><div></div>
                        </WaveformBars>
                    )}
                </MessageBubble>
            ))}

            {isTyping && (
                <MessageBubble $role="assistant">
                    <TypingIndicator><span></span><span></span><span></span></TypingIndicator>
                </MessageBubble>
            )}
            
            <div ref={chatEndRef} />
        </MessageContainer>
    );
};

export default ChatInterface;