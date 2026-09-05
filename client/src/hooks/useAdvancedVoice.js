import { useState, useEffect, useRef, useCallback } from 'react';
import { useChat } from '../contexts/ChatContext';
import {
  getSpeechRecognitionClass,
  getVoiceMode,
  pickRecordingMimeType,
  transcribeAudioBlob
} from '../utils/voiceCapabilities';

const SILENCE_SUBMIT_MS = 1500;
const MAX_UTTERANCE_MS = 60000;
// RMS speech threshold on analyser time-domain data (tune: speech >> room noise).
const SPEECH_RMS_THRESHOLD = 0.03;

export const useAdvancedVoice = (onFinalCommand, onInterrupt) => {
  const [isVoiceModeActive, setIsVoiceModeActive] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [voiceMode, setVoiceMode] = useState(null);
  const [voiceError, setVoiceError] = useState(null);
  const { setIsVoiceListening } = useChat();

  const recognitionRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const isSpeakingRef = useRef(false);
  const isVoiceModeActiveRef = useRef(false);
  const onFinalCommandRef = useRef(onFinalCommand);
  const onInterruptRef = useRef(onInterrupt);
  const errorLoggedRef = useRef(false);
  // Server-recording path refs
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const vadRafRef = useRef(null);
  const chunksRef = useRef([]);
  const speechSeenRef = useRef(false);
  const utteranceTimerRef = useRef(null);
  const transcribeAbortRef = useRef(null);

  useEffect(() => {
    onFinalCommandRef.current = onFinalCommand;
  }, [onFinalCommand]);

  useEffect(() => {
    onInterruptRef.current = onInterrupt;
  }, [onInterrupt]);

  useEffect(() => {
    isVoiceModeActiveRef.current = isVoiceModeActive;
  }, [isVoiceModeActive]);

  const reportErrorOnce = useCallback((logMessage, uiMessage) => {
    if (!errorLoggedRef.current) {
      errorLoggedRef.current = true;
      console.warn(`[Advanced Voice] ${logMessage}`);
    }
    setVoiceError(uiMessage);
  }, []);

  const clearError = useCallback(() => {
    errorLoggedRef.current = false;
    setVoiceError(null);
  }, []);

  const stopServerCycle = useCallback(() => {
    if (vadRafRef.current) {
      cancelAnimationFrame(vadRafRef.current);
      vadRafRef.current = null;
    }
    clearTimeout(silenceTimerRef.current);
    clearTimeout(utteranceTimerRef.current);
    transcribeAbortRef.current?.abort?.();
    transcribeAbortRef.current = null;
    try {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop();
      }
    } catch {
      // already stopped
    }
    recorderRef.current = null;
    chunksRef.current = [];
    try {
      audioCtxRef.current?.close?.();
    } catch {
      // already closed
    }
    audioCtxRef.current = null;
    analyserRef.current = null;
    try {
      streamRef.current?.getTracks?.().forEach((track) => track.stop());
    } catch {
      // tracks already stopped
    }
    streamRef.current = null;
    speechSeenRef.current = false;
  }, []);

  const submitServerTranscript = useCallback(async (blob) => {
    if (!isVoiceModeActiveRef.current) return;
    if (!blob || blob.size === 0) {
      startServerCycleRef.current?.();
      return;
    }
    setLiveTranscript('Transcribing…');
    try {
      const controller = new AbortController();
      transcribeAbortRef.current = controller;
      const text = await transcribeAudioBlob(blob, { signal: controller.signal });
      transcribeAbortRef.current = null;
      if (!isVoiceModeActiveRef.current) return;
      if (text) {
        console.log('[Advanced Voice] Server transcript. Submitting:', text);
        onFinalCommandRef.current?.(text);
      }
      setLiveTranscript('');
      clearError();
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (!isVoiceModeActiveRef.current) return;
      reportErrorOnce(
        `server transcription failed: ${err?.message || err}`,
        err?.code === 'VOICE_STT_UNAVAILABLE'
          ? 'Server voice transcription is not configured. You can still type your message, or use a browser with built-in voice recognition.'
          : `Voice transcription failed (${err?.message || 'unknown error'}). You can still type your message.`
      );
      stopServerCycle();
      setIsVoiceListening(false);
      setIsVoiceModeActive(false);
      isVoiceModeActiveRef.current = false;
      return;
    }
    // Continuous conversation: listen for the next utterance while active.
    if (isVoiceModeActiveRef.current) startServerCycleRef.current?.();
  }, [clearError, reportErrorOnce, stopServerCycle, setIsVoiceListening]);

  const startServerCycleRef = useRef(null);

  const startServerCycle = useCallback(async () => {
    if (!isVoiceModeActiveRef.current) return;
    stopServerCycle();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      reportErrorOnce(
        `microphone access failed: ${err?.message || err}`,
        err?.name === 'NotAllowedError'
          ? 'Microphone access was denied. Allow microphone permission and try again, or type your message.'
          : 'Could not access the microphone. Check your device settings, or type your message.'
      );
      setIsVoiceListening(false);
      setIsVoiceModeActive(false);
      isVoiceModeActiveRef.current = false;
      return;
    }
    if (!isVoiceModeActiveRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    streamRef.current = stream;
    setIsVoiceListening(true);
    setLiveTranscript('');

    // Voice-activity detection for barge-in + silence submit.
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioContextClass();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;
    } catch {
      analyserRef.current = null;
    }

    const mimeType = pickRecordingMimeType();
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (err) {
      reportErrorOnce(
        `recorder init failed: ${err?.message || err}`,
        'Recording is not available in this browser. Please type your message instead.'
      );
      stopServerCycle();
      setIsVoiceListening(false);
      setIsVoiceModeActive(false);
      isVoiceModeActiveRef.current = false;
      return;
    }
    chunksRef.current = [];
    speechSeenRef.current = false;
    recorder.ondataavailable = (event) => {
      if (event?.data && event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
      chunksRef.current = [];
      submitServerTranscript(blob);
    };
    recorderRef.current = recorder;
    try {
      recorder.start(250);
    } catch (err) {
      reportErrorOnce(
        `recorder start failed: ${err?.message || err}`,
        'Recording could not start. Please type your message instead.'
      );
      stopServerCycle();
      setIsVoiceListening(false);
      setIsVoiceModeActive(false);
      isVoiceModeActiveRef.current = false;
      return;
    }

    // Safety cap per utterance.
    utteranceTimerRef.current = setTimeout(() => {
      try {
        recorderRef.current?.state !== 'inactive' && recorderRef.current?.stop();
      } catch {
        // ignore
      }
    }, MAX_UTTERANCE_MS);

    // VAD loop: speech onset => barge-in; trailing silence => submit.
    const timeData = new Float32Array(2048);
    const pump = () => {
      if (!isVoiceModeActiveRef.current) return;
      const analyser = analyserRef.current;
      if (analyser) {
        analyser.getFloatTimeDomainData(timeData);
        let sum = 0;
        for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i];
        const rms = Math.sqrt(sum / timeData.length);
        if (rms > SPEECH_RMS_THRESHOLD) {
          if (!speechSeenRef.current) {
            speechSeenRef.current = true;
            isSpeakingRef.current = true;
            onInterruptRef.current?.();
          }
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        } else if (speechSeenRef.current && !silenceTimerRef.current) {
          silenceTimerRef.current = setTimeout(() => {
            isSpeakingRef.current = false;
            try {
              recorderRef.current?.state !== 'inactive' && recorderRef.current?.stop();
            } catch {
              // ignore
            }
          }, SILENCE_SUBMIT_MS);
        }
      }
      vadRafRef.current = requestAnimationFrame(pump);
    };
    if (analyserRef.current) {
      vadRafRef.current = requestAnimationFrame(pump);
    } else {
      // No analyser (rare): fall back to fixed-length utterances.
      silenceTimerRef.current = setTimeout(() => {
        try {
          recorderRef.current?.state !== 'inactive' && recorderRef.current?.stop();
        } catch {
          // ignore
        }
      }, 8000);
    }
  }, [reportErrorOnce, stopServerCycle, submitServerTranscript, setIsVoiceListening]);

  useEffect(() => {
    startServerCycleRef.current = startServerCycle;
  }, [startServerCycle]);

  const startNativeRecognition = useCallback(() => {
    const SpeechRecognition = getSpeechRecognitionClass();
    if (!SpeechRecognition) return false;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      console.log('[Advanced Voice] Listening...');
      setIsVoiceListening(true);
    };

    recognition.onspeechstart = () => {
      isSpeakingRef.current = true;
      if (onInterruptRef.current) onInterruptRef.current();
    };

    recognition.onspeechend = () => {
      isSpeakingRef.current = false;
    };

    recognition.onresult = (event) => {
      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }

      const currentText = (finalTranscript + interimTranscript).trim();
      setLiveTranscript(currentText);

      clearTimeout(silenceTimerRef.current);

      if (currentText.length > 0) {
        silenceTimerRef.current = setTimeout(() => {
          console.log('[Advanced Voice] Silence detected. Submitting:', currentText);
          if (onFinalCommandRef.current) {
            onFinalCommandRef.current(currentText);
          }
          setLiveTranscript('');
        }, SILENCE_SUBMIT_MS);
      }
    };

    recognition.onend = () => {
      setIsVoiceListening(false);
      if (isVoiceModeActiveRef.current && voiceModeRef.current === 'native') {
        try {
          recognition.start();
        } catch (error) {
          console.debug('[Advanced Voice] restart failed', error);
        }
      }
    };

    recognition.onerror = (event) => {
      if (event.error !== 'no-speech') {
        console.error('[Advanced Voice] Recognition error:', event.error);
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      return true;
    } catch (e) {
      console.error('[Advanced Voice] Failed to start recognition:', e);
      return false;
    }
  }, [setIsVoiceListening]);

  const voiceModeRef = useRef(null);
  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

  const stopAll = useCallback(() => {
    try {
      recognitionRef.current?.stop?.();
    } catch (error) {
      console.debug('[Advanced Voice] stop failed', error);
    }
    recognitionRef.current = null;
    stopServerCycle();
    clearTimeout(silenceTimerRef.current);
    setLiveTranscript('');
    setIsVoiceListening(false);
  }, [stopServerCycle, setIsVoiceListening]);

  // Cleanup on unmount: release microphone and all resources.
  useEffect(() => {
    return () => {
      isVoiceModeActiveRef.current = false;
      try {
        recognitionRef.current?.stop?.();
      } catch {
        // ignore during unmount
      }
      stopServerCycle();
      clearTimeout(silenceTimerRef.current);
    };
  }, [stopServerCycle]);

  const toggleAdvancedVoice = () => {
    if (isVoiceModeActive) {
      setIsVoiceModeActive(false);
      isVoiceModeActiveRef.current = false;
      voiceModeRef.current = null;
      setVoiceMode(null);
      stopAll();
      return;
    }

    clearError();
    const mode = getVoiceMode();
    if (mode === 'unsupported') {
      reportErrorOnce(
        'no voice capability (no SpeechRecognition, MediaRecorder, or microphone)',
        'Voice input is not available in this browser. Please type your message, or try a browser that supports microphone recording.'
      );
      return;
    }
    setVoiceMode(mode);
    voiceModeRef.current = mode;
    setIsVoiceModeActive(true);
    isVoiceModeActiveRef.current = true;
    if (mode === 'native') {
      const started = startNativeRecognition();
      if (!started) {
        reportErrorOnce(
          'native recognition failed to start',
          'Voice recognition could not start. Please type your message instead.'
        );
        setIsVoiceModeActive(false);
        isVoiceModeActiveRef.current = false;
        setVoiceMode(null);
        voiceModeRef.current = null;
      }
    } else {
      startServerCycle();
    }
  };

  return { isVoiceModeActive, liveTranscript, voiceMode, voiceError, toggleAdvancedVoice };
};
