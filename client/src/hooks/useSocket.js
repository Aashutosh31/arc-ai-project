import { useEffect, useContext } from 'react';
import { useRef } from 'react';
import { SocketContext } from '../contexts/SocketContext';
import { useChat } from '../contexts/ChatContext';
import { useTextToSpeech } from './useTextToSpeech';
import { useServerTtsAudio } from './useServerTtsAudio';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { applyTheme } from '../utils/theme';
import { getSharedVoiceEngine, getSharedVoiceTelemetry } from '../audio/voiceEngineSingleton';
import { createVoiceOwnership } from '../audio/voiceOwnership';
import { getSharedSttChannel, STT_CHANNEL_EVENTS } from '../utils/sttChannel';
import { getVoiceSettings } from '../utils/voiceSettings';

// 🚀 FIX: Global deduplication timer shared across all tabs and reloads
let lastReminderTime = 0;

// 🚀 FIX: multiple components consume useSocket simultaneously (chat,
// dashboard, voice dock). Listener registration is reference-counted per
// socket so unmounting one consumer (e.g. closing the voice dock) can not
// strip the shared listeners out from under the others — which previously
// silenced streaming, client actions, and status updates app-wide.
const socketListenerRefs = new WeakMap();
const SOCKET_EVENTS = [
  'ai:tts:response:chunk',
  'ai:tts:mode',
  'ai:tts:audio',
  'ai:tts:audio:stop',
  'voice:tts:start',
  'voice:tts:audio',
  'voice:tts:end',
  'voice:tts:error',
  'voice:tts:cancel',
  ...STT_CHANNEL_EVENTS,
  'bot_error',
  'ai:client:action',
  'ai:agent:status',
  'ai:provider:info',
  'ai:credits:update',
];

const acquireSocketListeners = (socket) => {
  const next = (socketListenerRefs.get(socket) || 0) + 1;
  socketListenerRefs.set(socket, next);
};

const releaseSocketListeners = (socket) => {
  const next = (socketListenerRefs.get(socket) || 1) - 1;
  if (next <= 0) {
    socketListenerRefs.delete(socket);
    for (const event of SOCKET_EVENTS) {
      try {
        socket.off(event);
      } catch {
        // ignore teardown failures
      }
    }
  }
};

export const useSocket = () => {
  const { socket, isConnected, authInfo, setAuthInfo } = useContext(SocketContext) || {}; 
  const { activeWorkspaceId } = useWorkspace();
  const { addMessage, appendBotChunk, finishBotStream, markBotInterrupted, setIsProcessing, setIsStreaming, isInterruptedRef, setIsInterrupted, setMediaData, setAgentStatus, setProviderInfo, setIsSpeaking } = useChat();
  const { processStreamChunk, stop, stopSpeech } = useTextToSpeech();
  const { enqueueSegment, resetAudio } = useServerTtsAudio();
  // Voice Runtime 3.0 — streaming voice channel state. The binary PCM
  // events (voice:tts:*) ride the same authenticated socket (no second
  // connection). Audio chunks go to the shared AudioWorklet engine with
  // explicit format metadata + sequence numbers; control stays JSON.
  // Diagnostic counters only — never speech content.
  const voiceStreamRef = useRef({ streamId: null });
  const voiceMetricsRef = useRef({
    ttsStreamStarted: 0,
    ttsFirstAudioByte: 0,
    ttsAudioChunks: 0,
    ttsAudioBytes: 0,
  });
  const voiceBlockedRef = useRef(false);
  // Voice Runtime 3.0 playback ownership (per response). One state machine
  // arbitrates the two concurrent audio channels — the legacy WAV queue and
  // the AudioWorklet PCM stream — so exactly one voice opens per response:
  //   - legacy segments play only while the worklet owns nothing (fallback);
  //   - the FIRST worklet chunk PREEMPTS any live legacy segment via
  //     resetAudio() instead of only muting future ones — that preemption is
  //     what closes the open-both-voices race (WAV installs+plays instantly
  //     while the worklet path holds audio behind its pre-roll);
  //   - reset() on every new response/mode/interrupt/disconnect.
  // voiceSpeakingRef + voiceSpeakingStreamRef: ARC is audibly speaking via
  // the worklet for this stream (drives barge-in + UI, never wedged: the
  // drain-watch always terminates).
  const voiceOwnershipRef = useRef(createVoiceOwnership());
  const voiceSpeakingRef = useRef(false);
  const voiceSpeakingStreamRef = useRef(null);
  const drainTimerRef = useRef(null);
  const cancelDrainWatch = () => {
    if (drainTimerRef.current) {
      try { clearInterval(drainTimerRef.current); } catch { /* ignore */ }
      drainTimerRef.current = null;
    }
  };
  const markVoiceSpeaking = (value, streamId = null) => {
    voiceSpeakingRef.current = Boolean(value);
    if (value) voiceSpeakingStreamRef.current = streamId;
    try { setIsSpeaking(Boolean(value)); } catch { /* ui only */ }
  };
  const setVoiceBlocked = (value) => {
    voiceBlockedRef.current = Boolean(value);
    try {
      window.dispatchEvent(new CustomEvent('arc:voice-blocked', { detail: { blocked: Boolean(value) } }));
    } catch { /* ui hint only */ }
  };
  // 'browser' = speechSynthesis path (default, current behavior).
  // 'server'  = server-generated audio queue; browser speech is suppressed
  // for the response so the two voices never overlap.
  const ttsModeRef = useRef('browser');
  const speechCharCountRef = useRef(0);
  const suppressSpeechRef = useRef(false);
  const SPEECH_THRESHOLD = 1800;

  useEffect(() => {
    if (!socket) return;

    // Last setup wins so closures stay fresh; cleanup only detaches when
    // no consumer remains (see socketListenerRefs).
    acquireSocketListeners(socket);

    socket.off('ai:tts:response:chunk');
    socket.off('ai:tts:mode');
    socket.off('ai:tts:audio');
    socket.off('ai:tts:audio:stop');
    socket.off('voice:tts:start');
    socket.off('voice:tts:audio');
    socket.off('voice:tts:end');
    socket.off('voice:tts:error');
    socket.off('voice:tts:cancel');
    for (const event of STT_CHANNEL_EVENTS) socket.off(event);
    socket.off('bot_error');
    socket.off('ai:client:action');
    socket.off('ai:agent:status');
    socket.off('ai:credits:update');

    // Server TTS mode announcement per response. A new response always
    // starts from a clean slate: drop stale audio and reset the mode.
    socket.on('ai:tts:mode', (data) => {
      resetAudio();
      cancelDrainWatch();
      voiceOwnershipRef.current.reset();
      markVoiceSpeaking(false);
      ttsModeRef.current = data?.mode === 'server' ? 'server' : 'browser';
    });

    socket.on('ai:tts:audio', (data) => {
      if (ttsModeRef.current !== 'server') return;
      if (data?.isFinal) return;
      // The AudioWorklet owns speech for this response once it has received
      // worklet audio — the legacy WAV queue stays silent so the two voices
      // never overlap. Legacy remains the fallback while the worklet path
      // has delivered nothing for this response.
      if (getVoiceSettings().streamingEnabled && !voiceOwnershipRef.current.legacyShouldPlay()) return;
      if (enqueueSegment(data)) voiceOwnershipRef.current.markLegacyLive();
    });

    socket.on('ai:tts:audio:stop', () => {
      resetAudio();
      cancelDrainWatch();
      voiceOwnershipRef.current.reset();
      markVoiceSpeaking(false);
      try { getSharedVoiceEngine()?.cancelStream(); } catch { /* ignore */ }
      voiceStreamRef.current = { streamId: null };
    });

    // ---- Voice Runtime 3.0 primary path (streaming server TTS) ----
    // Continuous audio arrives BEFORE the full LLM response completes; the
    // worklet plays it as one stream across chunk boundaries. Stream-id
    // tracking (not a boolean flag) means trailing in-flight chunks are
    // never dropped by a premature end event, while cancelled/superseded
    // streams are rejected by the engine and never played stale.
    socket.on('voice:tts:start', (data) => {
      const settings = getVoiceSettings();
      if (!settings.streamingEnabled) return;
      voiceStreamRef.current = { streamId: data?.streamId || null };
      voiceMetricsRef.current.ttsStreamStarted += 1;
      // A new stream supersedes any previous one: adopt its id so sequential
      // completed turns keep playing (previously every turn after the first
      // was dropped as stale). A drain-watch from an older stream is over.
      cancelDrainWatch();
      voiceOwnershipRef.current.reset();
      try { getSharedVoiceEngine()?.startStream?.(data?.streamId || null); } catch { /* ignore */ }
      try { getSharedVoiceTelemetry().markLlmFirstSentence(); } catch { /* ignore */ }
    });

    socket.on('voice:tts:audio', (data) => {
      const settings = getVoiceSettings();
      if (!settings.streamingEnabled) return;
      const engine = getSharedVoiceEngine();
      if (!engine) return;
      const result = engine.ingestSocketPayload(data);
      if (result === 'played' || result === 'staged') {
        // Ownership hand-off: the worklet is now the audible path for this
        // response. If a legacy WAV segment already opened (it can — the WAV
        // queue plays synchronously while the worklet path is still behind
        // its pre-roll), PREEMPT it immediately so only one voice speaks:
        // resetAudio() stops the current segment, drops queued segments and
        // the preloaded next one, and makes late 'ended'/play promises
        // harmless no-ops. Happens once per response (first accepted chunk).
        const { preemptLegacy } = voiceOwnershipRef.current.onWorkletChunk();
        if (preemptLegacy) resetAudio();
        // First audible evidence for this stream: ARC is speaking. Drives
        // barge-in detection + UI; cleared on drain (end) or interrupt.
        if (!voiceSpeakingRef.current) markVoiceSpeaking(true, data?.streamId || null);
        const bytes = data?.audio?.byteLength ?? data?.chunk?.byteLength ?? 0;
        voiceMetricsRef.current.ttsAudioChunks += 1;
        voiceMetricsRef.current.ttsAudioBytes += Number(bytes) || 0;
        if (!voiceMetricsRef.current.ttsFirstAudioByte) {
          voiceMetricsRef.current.ttsFirstAudioByte = Date.now();
        }
        try { getSharedVoiceTelemetry().markTtsFirstByte(); } catch { /* ignore */ }
        // Engine stages pre-activation audio instead of dropping it; only
        // surface "Enable voice" when the engine reports it is blocked.
        if (result === 'staged' && engine.blocked) setVoiceBlocked(true);
        else if (result === 'played' && !engine.blocked) setVoiceBlocked(false);
      }
    });

    socket.on('voice:tts:end', (data) => {
      // Grace completion: release pre-roll, keep the stream id so trailing
      // in-flight chunks still land. Cancel/new-mode resets tracking.
      // Speaking stays true until the queued audio actually drains out of
      // the worklet (polled, bounded) — ending it here would restart the
      // mic while ARC is still audibly talking.
      const endedStream = data?.streamId || null;
      try { getSharedVoiceEngine()?.endStream(endedStream); } catch { /* ignore */ }
      try { getSharedVoiceTelemetry().markTtsEnd(); } catch { /* ignore */ }
      if (import.meta?.env?.DEV) {
        try { getSharedVoiceTelemetry().log(); } catch { /* ignore */ }
        try {
          const diag = getSharedVoiceEngine()?.getDiagnostics?.();
          if (diag) console.debug('[BrowserVoice] end', JSON.stringify(diag.counters));
        } catch { /* ignore */ }
      }
      if (!voiceSpeakingRef.current) return;
      cancelDrainWatch();
      let polls = 0;
      drainTimerRef.current = setInterval(async () => {
        polls += 1;
        let drained = false;
        try {
          const stats = await getSharedVoiceEngine()?.requestStats?.();
          const received = Number(stats?.received ?? 0);
          const rendered = Number(stats?.rendered ?? stats?.renderedFrames ?? 0);
          if (received > 0 && rendered >= received - 4096) drained = true;
        } catch {
          if (polls >= 2) drained = true;
        }
        if (drained || polls >= 40) {
          cancelDrainWatch();
          // Only clear if no newer stream has taken over speaking meanwhile.
          if (voiceSpeakingStreamRef.current === endedStream || voiceSpeakingStreamRef.current == null) {
            markVoiceSpeaking(false);
          }
        }
      }, 750);
    });

    socket.on('voice:tts:error', () => {
      // Truthful state: one segment failed; text chat continues unaffected.
      // Browser speech fallback (if enabled) is driven by the text path.
    });

    socket.on('voice:tts:cancel', () => {
      cancelDrainWatch();
      voiceOwnershipRef.current.reset();
      markVoiceSpeaking(false);
      try { getSharedVoiceEngine()?.cancelStream(); } catch { /* ignore */ }
      voiceStreamRef.current = { streamId: null };
    });

    // ---- Voice Runtime FINAL: server STT (streaming, provider-owned) ----
    // The browser never recognizes speech; it only ships PCM frames and
    // consumes interim/final transcripts. useAdvancedVoice subscribes to the
    // shared channel; this layer only routes authenticated socket events.
    const channel = getSharedSttChannel();
    channel.configure(socket);
    for (const event of STT_CHANNEL_EVENTS) {
      socket.on(event, (data) => {
        try { channel.handleServerEvent(event, data); } catch { /* ignore */ }
      });
    }

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
        const settings = getVoiceSettings();
        // Voice Runtime 2.0: when streaming server TTS is enabled and the
        // server announced server mode, the AudioWorklet owns speech — the
        // browser SpeechSynthesis fallback stays silent (no double voice).
        // Otherwise SpeechSynthesis remains the fallback path.
        const streamingOwnsSpeech = settings.streamingEnabled && ttsModeRef.current === 'server';
        if (!suppressSpeechRef.current && !streamingOwnsSpeech) {
          processStreamChunk(displayText || chunk, false);
        }
      } else {
        finishBotStream();
        setAgentStatus(null);
        const settings = getVoiceSettings();
        const streamingOwnsSpeech = settings.streamingEnabled && ttsModeRef.current === 'server';
        if (!suppressSpeechRef.current && !streamingOwnsSpeech) {
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
        // Single source of truth: validates, persists, and notifies Settings UI.
        applyTheme(action.theme);
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
      resetAudio();
      finishBotStream();
      if (!isInterruptedRef.current) {
        addMessage({ sender: 'ai', text: `[Error]: ${errorMsg}` });
      }
    });

    return () => {
      cancelDrainWatch();
      releaseSocketListeners(socket);
    };
  }, [socket, appendBotChunk, finishBotStream, addMessage, processStreamChunk, enqueueSegment, resetAudio, isInterruptedRef, setMediaData, setAgentStatus, setAuthInfo]);

  // Voice Runtime 3.0 reconnect recovery: a dropped socket returns voice
  // to a safe idle — cancel the stream (flush + drop staged/seq state),
  // never resume stale audio after reconnect. Voice Runtime FINAL: the STT
  // session is server-side per socket; a disconnect invalidates it, so the
  // channel resets and the next begin() starts a fresh session.
  useEffect(() => {
    if (!socket) return undefined;
    const onDisconnect = () => {
      cancelDrainWatch();
      voiceOwnershipRef.current.reset();
      markVoiceSpeaking(false);
      try { getSharedVoiceEngine()?.cancelStream(); } catch { /* ignore */ }
      voiceStreamRef.current = { streamId: null };
      try { getSharedSttChannel().reset(); } catch { /* ignore */ }
    };
    const onReconnect = () => {
      try { getSharedVoiceEngine()?.cancelStream(); } catch { /* ignore */ }
      voiceStreamRef.current = { streamId: null };
      try { getSharedVoiceTelemetry().reset(); } catch { /* ignore */ }
      try {
        getSharedSttChannel().configure(socket);
        getSharedSttChannel().reset();
      } catch { /* ignore */ }
    };
    socket.on('disconnect', onDisconnect);
    socket.on('connect', onReconnect);
    return () => {
      try { socket.off('disconnect', onDisconnect); } catch { /* ignore */ }
      try { socket.off('connect', onReconnect); } catch { /* ignore */ }
    };
  }, [socket]);

  const sendCommand = (text, imageBase64 = null, documentData = null, conversationId = null, voiceLanguage = null) => {
    if (socket) {
      isInterruptedRef.current = false; 
      if (setIsInterrupted) setIsInterrupted(false);
      setAgentStatus(null);
      if (setIsStreaming) setIsStreaming(true);
      stop();
      resetAudio();
      // Voice Runtime 3.0: user gesture (send action) initializes/resumes
      // the audio engine; afterwards the context is reused. Never blocks send.
      // The gesture promise clears a stale "blocked" hint when it resolves.
      try {
        getSharedVoiceEngine()?.ensureFromGesture?.()?.then?.((ok) => {
          if (ok) setVoiceBlocked(false);
          else setVoiceBlocked(true);
        });
      } catch { /* ignore */ }
      try { getSharedVoiceTelemetry().reset(); } catch { /* ignore */ }
      voiceStreamRef.current = { streamId: null };
      cancelDrainWatch();
      voiceOwnershipRef.current.reset();
      markVoiceSpeaking(false);
      setVoiceBlocked(false);
      ttsModeRef.current = 'browser';
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
        workspaceId: activeWorkspaceId || null,
        // Per-turn voice language auto-detected by server STT (Sarvam), if any.
        language: typeof voiceLanguage === 'string' && voiceLanguage ? voiceLanguage : null
      }); 
    }
  };

  const interruptStream = () => {
    if (socket) {
      isInterruptedRef.current = true;
      if (setIsInterrupted) setIsInterrupted(true);
      setAgentStatus(null);
      // Voice Runtime 3.0 barge-in: abort TTS generation server-side AND
      // stop scheduled playback client-side, then return to listening.
      // Never waits for the current sentence. Measures
      // interruptRequestedAt → audioActuallyStoppedAt (<100ms target).
      try { getSharedVoiceTelemetry().markInterruptRequest(); } catch { /* ignore */ }
      try { socket.emit('voice:tts:cancel', { reason: 'barge-in' }); } catch { /* ignore */ }
      cancelDrainWatch();
      voiceOwnershipRef.current.reset();
      markVoiceSpeaking(false);
      try {
        const stoppedAt = getSharedVoiceEngine()?.cancelStream?.();
        try { getSharedVoiceTelemetry().markAudioStopped(stoppedAt); } catch { /* ignore */ }
      } catch { /* ignore */ }
      voiceStreamRef.current = { streamId: null };
      if (typeof stopSpeech === 'function') {
        stopSpeech();
      } else {
        stop();
      }
      resetAudio();
      ttsModeRef.current = 'browser';
      speechCharCountRef.current = 0;
      suppressSpeechRef.current = false;
      socket.emit('ai:stream:stop');
      try { getSharedVoiceTelemetry().markInterruptComplete(); } catch { /* ignore */ }
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