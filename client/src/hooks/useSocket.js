import { useEffect, useContext } from 'react';
import { SocketContext } from '../contexts/SocketContext';
import { useChat } from '../contexts/ChatContext';
import { useTextToSpeech } from './useTextToSpeech';

// 🚀 FIX: Global deduplication timer shared across all tabs and reloads
let lastReminderTime = 0;

export const useSocket = () => {
  const { socket, isConnected, authInfo, setAuthInfo } = useContext(SocketContext) || {}; 
  const { addMessage, appendBotChunk, finishBotStream, setIsProcessing, isInterruptedRef, setMediaData, setAgentStatus } = useChat();
  const { processStreamChunk, stop } = useTextToSpeech();

  useEffect(() => {
    if (!socket) return;

    socket.off('ai:tts:response:chunk');
    socket.off('bot_error');
    socket.off('ai:client:action');
    socket.off('ai:agent:status');
    socket.off('ai:credits:update');

    socket.on('ai:tts:response:chunk', (data) => {
      if (isInterruptedRef.current) return; 

      const { chunk, displayText, isFinal } = data;

      if (!isFinal) {
        appendBotChunk(displayText || chunk);
        processStreamChunk(displayText || chunk, false);
      } else {
        finishBotStream();
        setAgentStatus(null);
        processStreamChunk('', true);
      }
    });

    socket.on('ai:agent:status', (data) => {
      setAgentStatus(data?.status || null);
    });

    socket.on('ai:credits:update', (data) => {
      const creditsRemaining = Number(data?.creditsRemaining ?? 0);
      if (setAuthInfo) {
        setAuthInfo((prev) => ({
          ...(prev || {}),
          creditsRemaining
        }));
      }
      localStorage.setItem('creditsRemaining', String(creditsRemaining));
    });

    socket.on('ai:client:action', async (action) => {
      console.log('Received Client Action:', action);
      
      if (action.type === 'OPEN_URL') {
        window.open(action.url, '_blank');
      } 
      else if (action.type === 'COPY_TO_CLIPBOARD') {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(action.text);
            } else {
                const textArea = document.createElement("textarea");
                textArea.value = action.text;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                textArea.remove();
            }
        } catch (err) {}
      }
      else if (action.type === 'CHANGE_THEME') {
        document.documentElement.setAttribute('data-theme', action.theme);
      }
      else if (action.type === 'PLAY_MEDIA') {
        setMediaData({ videoId: action.videoId, title: action.title });
      }
      else if (action.type === 'STOP_MEDIA') {
        setMediaData(null); 
      }
      // 🚀 THE FIX: Catch Background Reminders Safely
      else if (action.type === 'TRIGGER_REMINDER') {
        const now = Date.now();
        // Ignore duplicate events that fire within the same 2 seconds!
        if (now - lastReminderTime < 2000) {
            console.log('Blocked duplicate React listener event.');
            return; 
        }
        lastReminderTime = now;

        stop(); // Silence anything currently playing
        
        addMessage({ sender: 'ai', text: `⏰ PROACTIVE REMINDER: ${action.message}` });
        
        const spokenMessage = `Excuse me sir, I have a reminder for you: ${action.message}`;
        processStreamChunk(spokenMessage, true);
      }
    });

    socket.on('bot_error', (errorMsg) => {
      setAgentStatus(null);
      finishBotStream();
      addMessage({ sender: 'ai', text: `[Error]: ${errorMsg}` });
    });

    return () => {
      socket.off('ai:tts:response:chunk');
      socket.off('bot_error');
      socket.off('ai:client:action');
      socket.off('ai:agent:status');
      socket.off('ai:credits:update');
    };
  }, [socket, appendBotChunk, finishBotStream, addMessage, processStreamChunk, isInterruptedRef, setMediaData, setAgentStatus, setAuthInfo]);

  const sendCommand = (text, imageBase64 = null, documentData = null) => {
    if (socket) {
      isInterruptedRef.current = false; 
      setAgentStatus(null);
      stop();
      setIsProcessing(true);
      
      const displayImage = imageBase64 ? `data:image/jpeg;base64,${imageBase64}` : null;
      const displayDoc = documentData ? documentData.name : null;
      
      addMessage({ sender: 'user', text, image: displayImage, documentName: displayDoc }); 
      
      socket.emit('ai:stt:final', { 
        command: text, 
        image: imageBase64,
        document: documentData
      }); 
    }
  };

  const interruptStream = () => {
    if (socket) {
      isInterruptedRef.current = true; 
      setAgentStatus(null);
      socket.emit('ai:stream:stop');   
      stop();                          
      finishBotStream();               
    }
  };

  return { sendCommand, interruptStream, socket, isConnected, authInfo, setAuthInfo };
};