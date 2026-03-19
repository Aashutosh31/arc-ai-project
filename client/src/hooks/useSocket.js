import { useEffect, useContext } from 'react';
import { SocketContext } from '../contexts/SocketContext';
import { useChat } from '../contexts/ChatContext';
import { useTextToSpeech } from './useTextToSpeech';

export const useSocket = () => {
  const { socket, isConnected } = useContext(SocketContext) || {}; 
  
  // 🚀 FIX: Pull in the global interruption reference
  const { addMessage, appendBotChunk, finishBotStream, setIsProcessing, isInterruptedRef } = useChat();
  const { processStreamChunk, stop } = useTextToSpeech();

  useEffect(() => {
    if (!socket) return;

    socket.off('ai:tts:response:chunk');
    socket.off('bot_error');

    socket.on('ai:tts:response:chunk', (data) => {
      // 🚀 CRITICAL FIX: If user clicked stop, DROP ALL INCOMING DATA!
      if (isInterruptedRef.current) return; 

      const { chunk, displayText, isFinal } = data;

      if (!isFinal) {
        appendBotChunk(displayText || chunk);
        processStreamChunk(displayText || chunk, false);
      } else {
        finishBotStream();
        processStreamChunk('', true);
      }
    });

    socket.on('bot_error', (errorMsg) => {
      finishBotStream();
      addMessage({ sender: 'ai', text: `[Error]: ${errorMsg}` });
    });

    return () => {
      socket.off('ai:tts:response:chunk');
      socket.off('bot_error');
    };
  }, [socket, appendBotChunk, finishBotStream, addMessage, processStreamChunk, isInterruptedRef]);

  const sendCommand = (text) => {
    if (socket) {
      isInterruptedRef.current = false; // Reset interruption flag for new prompt
      stop();
      setIsProcessing(true);
      addMessage({ sender: 'user', text }); 
      socket.emit('ai:stt:final', { command: text }); 
    }
  };

  const interruptStream = () => {
    if (socket) {
      isInterruptedRef.current = true; // Block incoming chunks instantly
      socket.emit('ai:stream:stop');   // Tell backend to stop generating
      stop();                          // Stop browser TTS audio
      finishBotStream();               // Stop UI typing animation
    }
  };

  return { sendCommand, interruptStream, socket, isConnected };
};