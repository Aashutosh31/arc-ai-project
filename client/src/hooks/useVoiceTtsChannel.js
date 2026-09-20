// Voice Runtime 2.0 — voice channel UI binder.
//
// Audio routing lives in useSocket (always mounted, even when the VoiceDock
// is closed). This hook is the UI-facing binder for voice surfaces:
//   - ensureAudioFromGesture(): call from mic press / voice activation / send
//   - interruptVoice(): barge-in — aborts generation + flushes the worklet
//   - audioBlocked: true when playback needs a user gesture ("Enable voice")
//   - ttsMode / telemetry snapshots for compact indicators
//
// Half-duplex ownership stays with VoiceInteractionMachine/useAdvancedVoice;
// this hook never starts microphone capture.
import { useCallback, useEffect, useState } from 'react';
import { useChat } from '../contexts/ChatContext';
import { hasVoiceAudioSupport } from '../audio/VoiceAudioEngine';
import { getSharedVoiceEngine, getSharedVoiceTelemetry } from '../audio/voiceEngineSingleton';
import { getVoiceSettings } from '../utils/voiceSettings';

export const VOICE_EVENTS = Object.freeze({
  START: 'voice:tts:start',
  AUDIO: 'voice:tts:audio',
  END: 'voice:tts:end',
  ERROR: 'voice:tts:error',
  CANCEL: 'voice:tts:cancel',
});

const hasSpeechSynthesisFallback = () => {
  try {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  } catch {
    return false;
  }
};

export const useVoiceTtsChannel = (socket) => {
  const { setIsSpeaking } = useChat();
  const [ttsMode, setTtsMode] = useState('server');
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [telemetrySnapshot, setTelemetrySnapshot] = useState(null);

  useEffect(() => {
    const onBlocked = (event) => {
      setAudioBlocked(Boolean(event?.detail?.blocked));
    };
    try {
      window.addEventListener('arc:voice-blocked', onBlocked);
    } catch { /* ignore */ }
    return () => {
      try { window.removeEventListener('arc:voice-blocked', onBlocked); } catch { /* ignore */ }
    };
  }, []);

  useEffect(() => {
    if (!socket) return undefined;
    const onMode = (data) => {
      setTtsMode(data?.mode === 'server' ? 'server' : 'fallback-browser');
    };
    const onError = () => {
      const settings = getVoiceSettings();
      if (settings.fallbackEnabled && hasSpeechSynthesisFallback()) {
        setTtsMode('fallback-browser');
      }
      try { setTelemetrySnapshot(getSharedVoiceTelemetry().snapshot()); } catch { /* ignore */ }
    };
    const onEnd = () => {
      try { setTelemetrySnapshot(getSharedVoiceTelemetry().snapshot()); } catch { /* ignore */ }
    };
    try { socket.on('ai:tts:mode', onMode); } catch { /* ignore */ }
    try { socket.on('voice:tts:error', onError); } catch { /* ignore */ }
    try { socket.on('voice:tts:end', onEnd); } catch { /* ignore */ }
    return () => {
      try { socket.off('ai:tts:mode', onMode); } catch { /* ignore */ }
      try { socket.off('voice:tts:error', onError); } catch { /* ignore */ }
      try { socket.off('voice:tts:end', onEnd); } catch { /* ignore */ }
    };
  }, [socket]);

  // MUST be called from a user gesture (mic press / voice activation / send).
  const ensureAudioFromGesture = useCallback(async () => {
    const engine = getSharedVoiceEngine();
    if (!engine) return false;
    const ok = await engine.ensureFromGesture();
    setAudioBlocked(!ok);
    return ok;
  }, []);

  const interruptVoice = useCallback(() => {
    try { getSharedVoiceTelemetry().markInterruptRequest(); } catch { /* ignore */ }
    try { socket?.emit('voice:tts:cancel', { reason: 'barge-in' }); } catch { /* ignore */ }
    try {
      const stoppedAt = getSharedVoiceEngine()?.cancelStream?.();
      try { getSharedVoiceTelemetry().markAudioStopped(stoppedAt); } catch { /* ignore */ }
    } catch { /* ignore */ }
    try { setIsSpeaking(false); } catch { /* ignore */ }
    try { getSharedVoiceTelemetry().markInterruptComplete(); } catch { /* ignore */ }
    try { setTelemetrySnapshot(getSharedVoiceTelemetry().snapshot()); } catch { /* ignore */ }
  }, [socket, setIsSpeaking]);

  return {
    ttsMode,
    audioBlocked,
    telemetry: telemetrySnapshot,
    ensureAudioFromGesture,
    interruptVoice,
    voiceAudioSupported: hasVoiceAudioSupport(),
    speechFallbackAvailable: hasSpeechSynthesisFallback(),
  };
};
