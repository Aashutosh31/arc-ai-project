import { useEffect, useContext } from 'react';
import { SocketContext } from '../contexts/SocketContext';
import { useChat } from '../contexts/ChatContext';
import { useTextToSpeech } from './useTextToSpeech';

export const useSocket = () => {
  const { socket, isConnected } = useContext(SocketContext) || {}; 
  
  const { addMessage, appendBotChunk, finishBotStream, setIsProcessing, isInterruptedRef } = useChat();
  const { processStreamChunk, stop } = useTextToSpeech();

  useEffect(() => {
    if (!socket) return;

    socket.off('ai:tts:response:chunk');
    socket.off('bot_error');
    socket.off('ai:client:action'); 

    socket.on('ai:tts:response:chunk', (data) => {
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

    // 🚀 UPDATED: Listen for multiple types of client actions!
    socket.on('ai:client:action', async (action) => {
      console.log('Received Client Action:', action);
      
      if (action.type === 'OPEN_URL') {
        window.open(action.url, '_blank');
      } 
      else if (action.type === 'COPY_TO_CLIPBOARD') {
        try {
            // Modern browsers: use the Clipboard API
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(action.text);
            } else {
                // Fallback for older browsers
                const textArea = document.createElement("textarea");
                textArea.value = action.text;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                textArea.remove();
            }
            console.log("✅ Successfully copied to clipboard!");
        } catch (err) {
            console.error('❌ Failed to copy to clipboard:', err);
        }
      }
    });

    socket.on('bot_error', (errorMsg) => {
      finishBotStream();
      addMessage({ sender: 'ai', text: `[Error]: ${errorMsg}` });
    });

    return () => {
      socket.off('ai:tts:response:chunk');
      socket.off('bot_error');
      socket.off('ai:client:action');
    };
  }, [socket, appendBotChunk, finishBotStream, addMessage, processStreamChunk, isInterruptedRef]);

  const sendCommand = (text) => {
    if (socket) {
      isInterruptedRef.current = false; 
      stop();
      setIsProcessing(true);
      addMessage({ sender: 'user', text }); 
      socket.emit('ai:stt:final', { command: text }); 
    }
  };

  const interruptStream = () => {
    if (socket) {
      isInterruptedRef.current = true; 
      socket.emit('ai:stream:stop');   
      stop();                          
      finishBotStream();               
    }
  };

  return { sendCommand, interruptStream, socket, isConnected };
};