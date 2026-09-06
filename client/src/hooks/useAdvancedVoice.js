import { useState, useEffect, useRef, useCallback } from 'react';
import { useChat } from '../contexts/ChatContext';
import {
  getSpeechRecognitionClass,
  getVoiceMode,
  pickRecordingMimeType,
  transcribeAudioBlob
} from '../utils/voiceCapabilities';
import { VoiceInteractionMachine } from '../utils/voiceInteractionMachine';

const SILENCE_SUBMIT_MS = 1500;
const MAX_UTTERANCE_MS = 60000;
// RMS speech threshold on analyser time-domain data (tune: speech >> room noise).
const SPEECH_RMS_THRESHOLD = 0.03;
// Clean restart boundary: ignore mic input briefly after (re)starting capture
// so residual speaker/room tail is never treated as a new utterance.
const INPUT_IGNORE_WINDOW_MS = 350;
// Wait after ARC finishes speaking before re-arming the mic, for the same reason.
const RESTART_LISTEN_DELAY_MS = 400;

// Secondary safeguard only (lifecycle control is the real fix): request the
// browser's built-in echo/noise suppression when available.
const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
};

const vlog = (message, turn) => {
  console.log(`[Advanced Voice] ${message}${turn != null ? ` (turn ${turn})` : ''}`);
};

export const useAdvancedVoice = (onFinalCommand, onInterrupt) => {
  const [isVoiceModeActive, setIsVoiceModeActive] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [voiceMode, setVoiceMode] = useState(null);
  const [voiceError, setVoiceError] = useState(null);
  const [voiceInteractionState, setVoiceInteractionState] = useState('idle');
  const { setIsVoiceListening, isSpeaking, isProcessing } = useChat();

  const recognitionRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const restartTimerRef = useRef(null);
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
  const ignoreInputUntilRef = useRef(0);
  const micStoppedAtRef = useRef(null);
  const micStartedAtRef = useRef(null);

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

  const machineRef = useRef(null);
  if (!machineRef.current) {
    machineRef.current = new VoiceInteractionMachine({
      log: (message) => console.log(message),
      actions: {
        startCapture: (turn) => startCaptureRef.current?.(turn),
        stopCapture: (reason) => stopCaptureInternalRef.current?.(reason),
        interruptGeneration: () => onInterruptRef.current?.(),
        onStateChange: (next) => setVoiceInteractionState(next),
      },
    });
  }

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  // Full capture teardown for BOTH paths. Never submits anything; callers
  // invalidate the turn first so late callbacks are discarded, not transcribed.
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

  const stopCaptureInternal = useCallback((reason = 'stop') => {
    const machine = machineRef.current;
    clearRestartTimer();
    try {
      recognitionRef.current?.stop?.();
    } catch (error) {
      console.debug('[Advanced Voice] recognition stop failed', error);
    }
    recognitionRef.current = null;
    stopServerCycle(reason);
    clearTimeout(silenceTimerRef.current);
    setLiveTranscript('');
    setIsVoiceListening(false);
    const stoppedAt = Date.now();
    const startLatency = micStartedAtRef.current != null ? stoppedAt - micStartedAtRef.current : null;
    micStoppedAtRef.current = stoppedAt;
    vlog(`microphone: stopped (${reason})`, machine.turn);
    if (startLatency != null) {
      console.log(`[Advanced Voice] microphone: was capturing for ${startLatency}ms`);
    }
  }, [clearRestartTimer, stopServerCycle, setIsVoiceListening]);

  const stopCaptureInternalRef = useRef(null);
  useEffect(() => {
    stopCaptureInternalRef.current = stopCaptureInternal;
  }, [stopCaptureInternal]);

  const armInputIgnoreWindow = useCallback(() => {
    ignoreInputUntilRef.current = Date.now() + INPUT_IGNORE_WINDOW_MS;
  }, []);

  const submitServerTranscript = useCallback(async (blob, turn) => {
    const machine = machineRef.current;
    if (!machine.isTurnValid(turn) || machine.state !== 'listening') {
      console.debug('[Advanced Voice] discarding stale server transcript callback');
      return;
    }
    if (!blob || blob.size === 0) {
      // Silent cycle: keep listening with a fresh turn.
      machine.restartListening('empty cycle');
      return;
    }
    setLiveTranscript('Transcribing…');
    try {
      const controller = new AbortController();
      transcribeAbortRef.current = controller;
      const text = await transcribeAudioBlob(blob, { signal: controller.signal });
      transcribeAbortRef.current = null;
      if (!machine.isTurnValid(turn) || machine.state !== 'listening') {
        console.debug('[Advanced Voice] discarding stale transcription result');
        return;
      }
      if (text) {
        console.log(`[Advanced Voice] server transcript received (${text.length} chars)`);
        if (machine.onUtteranceSubmitted(turn)) {
          onFinalCommandRef.current?.(text);
        }
      } else if (machine.state === 'listening') {
        machine.restartListening('empty transcript');
      }
      setLiveTranscript('');
      clearError();
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (!isVoiceModeActiveRef.current) return;
      machine.onError(err?.message || 'transcription failed');
      reportErrorOnce(
        `server transcription failed: ${err?.message || err}`,
        err?.code === 'VOICE_STT_UNAVAILABLE'
          ? 'Server voice transcription is not configured. You can still type your message, or use a browser with built-in voice recognition.'
          : `Voice transcription failed (${err?.message || 'unknown error'}). You can still type your message.`
      );
      setIsVoiceListening(false);
      setIsVoiceModeActive(false);
      isVoiceModeActiveRef.current = false;
    }
  }, [clearError, reportErrorOnce, setIsVoiceListening]);

  const startServerCycleRef = useRef(null);

  const startServerCycle = useCallback(async (turn) => {
    const machine = machineRef.current;
    if (!machine.isTurnValid(turn) || machine.state !== 'listening') return;
    stopServerCycle('restart');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    } catch (err) {
      if (!machine.isTurnValid(turn)) return;
      machine.onError(err?.message || 'microphone access failed');
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
    if (!machine.isTurnValid(turn) || machine.state !== 'listening') {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    streamRef.current = stream;
    setIsVoiceListening(true);
    setLiveTranscript('');
    armInputIgnoreWindow();
    micStartedAtRef.current = Date.now();
    vlog('microphone: started (server cycle)', turn);

    // Voice-activity detection for silence submit. Barge-in is handled by the
    // button while speaking (mic is OFF then), so onset never interrupts here.
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
      if (!machine.isTurnValid(turn)) return;
      machine.onError(err?.message || 'recorder init failed');
      reportErrorOnce(
        `recorder init failed: ${err?.message || err}`,
        'Recording is not available in this browser. Please type your message instead.'
      );
      setIsVoiceListening(false);
      setIsVoiceModeActive(false);
      isVoiceModeActiveRef.current = false;
      return;
    }
    chunksRef.current = [];
    speechSeenRef.current = false;
    recorder.ondataavailable = (event) => {
      // Drop chunks captured inside the restart ignore window (speaker tail).
      if (Date.now() < ignoreInputUntilRef.current) return;
      if (event?.data && event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
      chunksRef.current = [];
      submitServerTranscript(blob, turn);
    };
    recorderRef.current = recorder;
    try {
      recorder.start(250);
    } catch (err) {
      if (!machine.isTurnValid(turn)) return;
      machine.onError(err?.message || 'recorder start failed');
      reportErrorOnce(
        `recorder start failed: ${err?.message || err}`,
        'Recording could not start. Please type your message instead.'
      );
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

    // VAD loop: trailing silence => submit. Runs ONLY while listening; any
    // other state stops scheduling frames so ARC's own speech is never seen.
    const timeData = new Float32Array(2048);
    const pump = () => {
      if (!isVoiceModeActiveRef.current) return;
      if (!machine.isTurnValid(turn) || machine.state !== 'listening') return;
      const analyser = analyserRef.current;
      if (analyser) {
        analyser.getFloatTimeDomainData(timeData);
        let sum = 0;
        for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i];
        const rms = Math.sqrt(sum / timeData.length);
        if (rms > SPEECH_RMS_THRESHOLD) {
          speechSeenRef.current = true;
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        } else if (speechSeenRef.current && !silenceTimerRef.current) {
          silenceTimerRef.current = setTimeout(() => {
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
  }, [reportErrorOnce, stopServerCycle, submitServerTranscript, setIsVoiceListening, armInputIgnoreWindow]);

  useEffect(() => {
    startServerCycleRef.current = startServerCycle;
  }, [startServerCycle]);

  const startNativeRecognition = useCallback((turn) => {
    const machine = machineRef.current;
    if (!machine.isTurnValid(turn) || machine.state !== 'listening') return false;
    const SpeechRecognition = getSpeechRecognitionClass();
    if (!SpeechRecognition) return false;

    try {
      recognitionRef.current?.stop?.();
    } catch {
      // ignore stale instance
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      if (!machine.isTurnValid(turn)) return;
      vlog('microphone: started (native recognition)', turn);
      micStartedAtRef.current = Date.now();
      setIsVoiceListening(true);
    };

    recognition.onspeechstart = () => {
      // Recognition runs only while listening; ARC audio can never reach here
      // because capture is stopped before speaking. Defensive: interrupt only
      // if the machine somehow believes ARC is speaking.
      if (machine.state === 'speaking' && onInterruptRef.current) onInterruptRef.current();
    };

    recognition.onresult = (event) => {
      if (!machine.isTurnValid(turn) || machine.state !== 'listening') {
        console.debug('[Advanced Voice] discarding stale recognition result');
        return;
      }
      if (Date.now() < ignoreInputUntilRef.current) return;
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
          if (!machine.isTurnValid(turn) || machine.state !== 'listening') return;
          console.log(`[Advanced Voice] native transcript received (${currentText.length} chars)`);
          if (machine.onUtteranceSubmitted(turn)) {
            onFinalCommandRef.current?.(currentText);
          }
          setLiveTranscript('');
        }, SILENCE_SUBMIT_MS);
      }
    };

    recognition.onend = () => {
      setIsVoiceListening(false);
      // State-aware restart: ONLY while still listening on the same turn.
      // This is the fix for the old bug where recognition restarted (and
      // transcribed ARC's voice) during speaking/processing.
      if (
        isVoiceModeActiveRef.current &&
        voiceModeRef.current === 'native' &&
        machine.isTurnValid(turn) &&
        machine.state === 'listening'
      ) {
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
    armInputIgnoreWindow();
    try {
      recognition.start();
      return true;
    } catch (e) {
      console.error('[Advanced Voice] Failed to start recognition:', e);
      return false;
    }
  }, [setIsVoiceListening, armInputIgnoreWindow]);

  const startCaptureRef = useRef(null);
  useEffect(() => {
    startCaptureRef.current = (turn) => {
      const mode = voiceModeRef.current;
      if (mode === 'native') {
        const started = startNativeRecognition(turn);
        if (!started) {
          const machine = machineRef.current;
          if (machine.isTurnValid(turn)) {
            machine.onError('native recognition failed to start');
            reportErrorOnce(
              'native recognition failed to start',
              'Voice recognition could not start. Please type your message instead.'
            );
            setIsVoiceListening(false);
            setIsVoiceModeActive(false);
            isVoiceModeActiveRef.current = false;
          }
        }
      } else {
        startServerCycle(turn);
      }
    };
  }, [startNativeRecognition, startServerCycle, reportErrorOnce, setIsVoiceListening]);

  const voiceModeRef = useRef(null);
  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

  // Canonical speaking signal (browser TTS + server audio both drive the same
  // isSpeaking flag). Drives the machine; mic stops immediately on speech
  // start and restarts on a clean boundary after speech + generation settle.
  useEffect(() => {
    const machine = machineRef.current;
    if (!isVoiceModeActiveRef.current) {
      clearRestartTimer();
      return;
    }
    if (isSpeaking) {
      clearRestartTimer();
      machine.onSpeechStarted();
      return;
    }
    if (!isProcessing && (machine.state === 'speaking' || machine.state === 'processing')) {
      clearRestartTimer();
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null;
        machine.onSpeechEnded();
      }, RESTART_LISTEN_DELAY_MS);
    }
    return () => {};
  }, [isSpeaking, isProcessing, isVoiceModeActive, clearRestartTimer]);

  // React-side teardown after the machine has already transitioned to idle
  // (via toggle/deactivate). Keeps UI flags and refs consistent.
  const exitVoiceMode = useCallback(() => {
    clearRestartTimer();
    transcribeAbortRef.current?.abort?.();
    transcribeAbortRef.current = null;
    setIsVoiceListening(false);
    setIsVoiceModeActive(false);
    isVoiceModeActiveRef.current = false;
    voiceModeRef.current = null;
    setVoiceMode(null);
    setLiveTranscript('');
  }, [clearRestartTimer, setIsVoiceListening]);

  // Cleanup on unmount: release microphone and all resources.
  useEffect(() => {
    return () => {
      clearRestartTimer();
      isVoiceModeActiveRef.current = false;
      try {
        recognitionRef.current?.stop?.();
      } catch {
        // ignore during unmount
      }
      stopServerCycle('unmount');
      clearTimeout(silenceTimerRef.current);
    };
  }, [stopServerCycle, clearRestartTimer]);

  const toggleAdvancedVoice = () => {
    const machine = machineRef.current;
    if (!isVoiceModeActiveRef.current || machine.state === 'idle') {
      clearRestartTimer();
      clearError();
      const mode = getVoiceMode();
      if (mode === 'unsupported') {
        machine.onError('no voice capability');
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
      machine.activate();
      return;
    }
    // In-mode taps are state-dependent (barge-in, cancel, or exit).
    const outcome = machine.toggle();
    if (outcome === 'deactivated' || outcome === 'cancelled') {
      exitVoiceMode();
    }
  };

  return { isVoiceModeActive, liveTranscript, voiceMode, voiceError, voiceInteractionState, toggleAdvancedVoice };
};
