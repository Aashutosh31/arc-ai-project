import { useEffect, useContext, useRef } from 'react';
import { SocketContext } from '../contexts/SocketContext';
import { useChat } from '../contexts/ChatContext';
import { useTextToSpeech } from './useTextToSpeech';
import { useWorkspace } from '../contexts/WorkspaceContext';

interface DocumentData {
  name: string;
  [key: string]: unknown;
}

// 🚀 FIX: Global deduplication timer shared across all tabs and reloads
let lastReminderTime = 0;

export const useSocket = () => {
  const socketContext = useContext(SocketContext);
  const socket = socketContext?.socket;
  const isConnected = socketContext?.isConnected;
  // authInfo and setAuthInfo are not in SocketContext, fallback safely
  const authInfo: Record<string, unknown> | undefined = undefined;
  const setAuthInfo: React.Dispatch<React.SetStateAction<Record<string, unknown>>> | undefined = undefined;

  const { activeWorkspaceId } = useWorkspace();
  const { addMessage, appendBotChunk, finishBotStream, markBotInterrupted, setIsProcessing, setIsStreaming, isInterruptedRef, setIsInterrupted, setMediaData, setAgentStatus, setProviderInfo } = useChat();
  const { processStreamChunk, stop, stopSpeech } = useTextToSpeech();
  const speechCharCountRef = useRef(0);
  const suppressSpeechRef = useRef(false);
  const SPEECH_THRESHOLD = 1800;

  useEffect(() => {
    if (!socket) return;

    socket.off('ai:tts:response:chunk');
    socket.off('bot_error');
    socket.off('ai:client:action');
    socket.off('ai:agent:status');
    socket.off('ai:credits:update');

    socket.on('ai:tts:response:chunk', (data: Record<string, unknown>) => {
      if (isInterruptedRef.current) return; 

      const { chunk, displayText, isFinal } = data;
      const chunkText = String(displayText || chunk || '');

      if (chunkText) {
        speechCharCountRef.current += chunkText.length;
      }

      if (!suppressSpeechRef.current && speechCharCountRef.current >= SPEECH_THRESHOLD) {
        suppressSpeechRef.current = true;
        stopSpeech();
      }

      if (!isFinal) {
        appendBotChunk((displayText as string) || (chunk as string));
        if (!suppressSpeechRef.current) {
          processStreamChunk((displayText as string) || (chunk as string), false);
        }
      } else {
        finishBotStream();
        setAgentStatus(null);
        if (!suppressSpeechRef.current) {
          processStreamChunk('', true);
        }
        speechCharCountRef.current = 0;
        suppressSpeechRef.current = false;
      }
    });

    socket.on('ai:agent:status', (data: Record<string, unknown>) => {
      setAgentStatus((data?.status as string) || null);
    });

    socket.on('ai:provider:info', (data: Record<string, unknown>) => {
      if (setProviderInfo) {
        setProviderInfo({
          provider: data?.provider || null,
          fallbackUsed: Boolean(data?.fallbackUsed),
          detail: data?.detail || ''
        });
      }
    });

    socket.on('ai:credits:update', (data: Record<string, unknown>) => {
      const creditsRemaining = Number(data?.creditsRemaining ?? 0);
      if (setAuthInfo) {
        setAuthInfo((prev) => ({
          ...(prev || {}),
          creditsRemaining
        }));
      }
      localStorage.setItem('creditsRemaining', String(creditsRemaining));
    });

    socket.on('ai:client:action', async (action: Record<string, unknown>) => {
      console.log('Received Client Action:', action);
      
      if (action.type === 'OPEN_URL') {
        window.open(action.url as string, '_blank');
      } 
      else if (action.type === 'COPY_TO_CLIPBOARD') {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(action.text as string);
            } else {
                const textArea = document.createElement("textarea");
                textArea.value = action.text as string;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                textArea.remove();
            }
        } catch (error) {
          console.debug('[Socket] clipboard copy fallback failed', error);
        }
      }
      else if (action.type === 'CHANGE_THEME') {
        document.documentElement.setAttribute('data-theme', action.theme as string);
      }
      else if (action.type === 'PLAY_MEDIA') {
        setMediaData({ videoId: action.videoId as string, title: action.title as string });
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
        
        addMessage({ sender: 'ai', text: `⏰ PROACTIVE REMINDER: ${action.message as string}` });
        
        const spokenMessage = `Excuse me sir, I have a reminder for you: ${action.message as string}`;
        processStreamChunk(spokenMessage, true);
      }
    });

    socket.on('bot_error', (errorMsg: string) => {
      if (isInterruptedRef.current) {
        return;
      }
      setAgentStatus(null);
      finishBotStream();
      addMessage({ sender: 'ai', text: `[Error]: ${errorMsg}` });
    });

    return () => {
      socket.off('ai:tts:response:chunk');
      socket.off('bot_error');
      socket.off('ai:client:action');
      socket.off('ai:agent:status');
      socket.off('ai:provider:info');
      socket.off('ai:credits:update');
    };
  }, [socket, appendBotChunk, finishBotStream, addMessage, processStreamChunk, isInterruptedRef, setMediaData, setAgentStatus, setAuthInfo]);

  const sendCommand = (text: string, imageBase64: string | null = null, documentData: DocumentData | null = null, conversationId: string | null = null) => {
    if (socket) {
      isInterruptedRef.current = false; 
      if (setIsInterrupted) setIsInterrupted(false);
      setAgentStatus(null);
      if (setIsStreaming) setIsStreaming(true);
      stop();
      speechCharCountRef.current = 0;
      suppressSpeechRef.current = false;
      setIsProcessing(true);
      
      const displayImage = imageBase64 ? `data:image/jpeg;base64,${imageBase64}` : null;
      const displayDoc = documentData ? documentData.name : null;
      
      addMessage({ sender: 'user', text, image: displayImage, documentName: displayDoc }); 
      
      socket.emit('ai:stt:final', { 
        command: text, 
        image: imageBase64,
        document: documentData,
        conversationId,
        workspaceId: activeWorkspaceId || null
      }); 
    }
  };

  const interruptStream = () => {
    if (socket) {
      isInterruptedRef.current = true; 
      if (setIsInterrupted) setIsInterrupted(true);
      setAgentStatus(null);
      if (typeof stopSpeech === 'function') {
        stopSpeech();
      } else {
        stop();
      }
      speechCharCountRef.current = 0;
      suppressSpeechRef.current = false;
      socket.emit('ai:stream:stop');   
      markBotInterrupted?.();          
    }
  };

  return { sendCommand, interruptStream, socket, isConnected, authInfo, setAuthInfo };
};