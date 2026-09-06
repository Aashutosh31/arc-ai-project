import { useEffect, useContext } from 'react';
import { useRef } from 'react';
import { SocketContext } from '../contexts/SocketContext';
import { useChat } from '../contexts/ChatContext';
import { useTextToSpeech } from './useTextToSpeech';
import { useWorkspace } from '../contexts/WorkspaceContext';

// 🚀 FIX: Global deduplication timer shared across all tabs and reloads
let lastReminderTime = 0;

export const useSocket = () => {
  const { socket, isConnected, authInfo, setAuthInfo } = useContext(SocketContext) || {}; 
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

    socket.on('ai:tts:response:chunk', (data) => {
      const { chunk, displayText, isFinal } = data;

      // Terminal events always run cleanup (idempotent): swallowing them while
      // interrupted is what used to wedge "Stop Generating" on forever.
      // Only content appends/speech stay gated on the interrupt flag.
      if (isInterruptedRef.current) {
        if (isFinal) {
          finishBotStream();
          setAgentStatus(null);
        }
        return;
      }
      const chunkText = String(displayText || chunk || '');

      if (chunkText) {
        speechCharCountRef.current += chunkText.length;
      }

      if (!suppressSpeechRef.current && speechCharCountRef.current >= SPEECH_THRESHOLD) {
        suppressSpeechRef.current = true;
        stopSpeech();
      }

      if (!isFinal) {
        appendBotChunk(displayText || chunk);
        if (!suppressSpeechRef.current) {
          processStreamChunk(displayText || chunk, false);
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

    socket.on('ai:agent:status', (data) => {
      setAgentStatus(data?.status || null);
    });

    socket.on('ai:provider:info', (data) => {
      if (setProviderInfo) {
        setProviderInfo({
          provider: data?.provider || null,
          fallbackUsed: Boolean(data?.fallbackUsed),
          detail: data?.detail || ''
        });
      }
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
        } catch (error) {
          console.debug('[Socket] clipboard copy fallback failed', error);
        }
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
      // Always terminate the generation state (idempotent) so a failure can
      // never leave the UI generating forever — even if it arrives late.
      // The visible error message is only appended for the active request;
      // errors for an intentionally stopped request stay silent.
      setAgentStatus(null);
      finishBotStream();
      if (!isInterruptedRef.current) {
        addMessage({ sender: 'ai', text: `[Error]: ${errorMsg}` });
      }
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

  const sendCommand = (text, imageBase64 = null, documentData = null, conversationId = null) => {
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
      // Local terminal transition: the generation is over as far as the UI is
      // concerned. Previously this relied on the server's terminal events,
      // which are swallowed while interrupted — leaving "Stop Generating"
      // stuck forever. finishBotStream is idempotent, so any late server
      // terminal event is a harmless no-op.
      finishBotStream();
    }
  };

  return { sendCommand, interruptStream, socket, isConnected, authInfo, setAuthInfo };
};