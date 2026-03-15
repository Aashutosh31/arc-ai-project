import { useEffect, useContext } from 'react';
import { SocketContext } from '../contexts/SocketContext';
import { useChat } from '../contexts/ChatContext';
import { useTextToSpeech } from './useTextToSpeech';

export const useSocket = () => {
  const { socket, isConnected } = useContext(SocketContext) || {}; 
  
  const { addMessage, appendBotChunk, finishBotStream, setIsProcessing } = useChat();
  const { processStreamChunk, stop } = useTextToSpeech();

  useEffect(() => {
    if (!socket) return;

    // 🚀 FIX 1: Wipe previous listeners to prevent the "Double Text" glitch!
    socket.off('ai:tts:response:chunk');
    socket.off('bot_error');

    // Listen for incoming streaming chunks
    socket.on('ai:tts:response:chunk', (data) => {
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
  }, [socket, appendBotChunk, finishBotStream, addMessage, processStreamChunk]);

  // Expose a helper to send text commands from the Chat UI
  const sendCommand = (text) => {
    if (socket) {
      stop();
      setIsProcessing(true);
      addMessage({ sender: 'user', text }); // Adds text to UI
      socket.emit('ai:stt:final', { command: text }); // Sends to server
    }
  };

  return { sendCommand, socket, isConnected };
};