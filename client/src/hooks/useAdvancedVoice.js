import { useState, useEffect, useRef, useCallback } from "react";
import { useChat } from "../contexts/ChatContext";
import { getVoiceMode } from "../utils/voiceCapabilities";
import { VoiceInteractionMachine } from "../utils/voiceInteractionMachine";
import { VoiceMicCapture } from "../audio/VoiceMicCapture";
import { getSharedSttChannel } from "../utils/sttChannel";
import { shouldGateTranscript } from "../utils/voiceTranscriptGate";
import { getSharedVoiceEngine } from "../audio/voiceEngineSingleton";

const SILENCE_SUBMIT_MS = 650;
// RMS speech threshold on analyser time-domain data (tune: speech >> room noise).
const SPEECH_RMS_THRESHOLD = 0.015;
// Barge-in while ARC is speaking: sustained speech energy above a higher bar
// (echo cancellation suppresses ARC's own output; this excludes short noise).
const BARGE_RMS_THRESHOLD = 0.08;
// ~6 consecutive VAD frames (~100-200ms) above the barge threshold before
// interrupting, so transient noise never stops ARC mid-word.
const BARGE_HOLD_FRAMES = 6;
// Clean restart boundary: ignore mic input briefly after (re)starting a turn
// so residual speaker/room tail is never treated as a new utterance.
const INPUT_IGNORE_WINDOW_MS = 350;
// Device startup/click noise is routinely above the speech threshold on
// mobile and Firefox. A final transcript is only actionable after sustained
// local speech evidence, never merely because an STT session is open.
const SPEECH_HOLD_FRAMES = 4;
const MIN_UTTERANCE_MS = 280;
// Wait after ARC finishes speaking before re-arming the mic, for the same reason.
const RESTART_LISTEN_DELAY_MS = 400;
// Server VAD backstop: commit shortly after the provider reports the speaker
// stopped. Reliable even when ambient noise keeps the local RMS above the
// silence floor — previously the local-only silence timer could never fire in
// a noisy room, leaving the mode stuck "listening" without submitting anything.
const SPEECH_END_COMMIT_MS = 200;
// Hard bound on one utterance: if sustained speech/noise never quiets enough
// for a silence commit, force it so the command is still processed instead of
// listening indefinitely.
const MAX_UTTERANCE_MS = 12000;
// When an utterance is underway, "quiet" is relative to the loudest sample we
// have actually measured (peak*ratio), not an absolute RMS floor. This makes
// silence-submit dependable on mics/rooms where the resting noise exceeds the
// absolute SPEECH_RMS_THRESHOLD yet is clearly below the user's speech.
const RMS_PEAK_QUIET_RATIO = 0.25;

const vlog = (message, turn) => {
  console.log(
    `[Advanced Voice] ${message}${turn != null ? ` (turn ${turn})` : ""}`,
  );
};

export const useAdvancedVoice = (onFinalCommand, onInterrupt) => {
  const [isVoiceModeActive, setIsVoiceModeActive] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [voiceMode, setVoiceMode] = useState(null);
  const [voiceError, setVoiceError] = useState(null);
  const [voiceInteractionState, setVoiceInteractionState] = useState("idle");
  // Pending confirmation for destructive/low-confidence transcripts (§15/§17).
  // When set, the transcript is NOT submitted until the user confirms; the VAD
  // is gated so the confirm/cancel decision cannot be overwritten by new speech.
  const [clarification, setClarification] = useState(null);
  const clarificationRef = useRef(false);
  const pendingClarificationRef = useRef(null);
  // Independent mic mute: session stays active, capture is simply not started.
  // TTS playback is unaffected, so ARC can still speak while muted.
  const [micMuted, setMicMuted] = useState(false);
  const micMutedRef = useRef(false);
  const { setIsVoiceListening, isSpeaking, isProcessing } = useChat();

  const onFinalCommandRef = useRef(onFinalCommand);
  const onInterruptRef = useRef(onInterrupt);
  const micRef = useRef(null);
  const channelRef = useRef(null);
  const vadRafRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const restartTimerRef = useRef(null);
  const currentTurnRef = useRef(null);
  const sessionStartedForTurnRef = useRef(null);
  const speechSeenRef = useRef(false);
  const speechHoldRef = useRef(0);
  const speechStartedAtRef = useRef(0);
  const rmsPeakRef = useRef(0);
  const commitGuardRef = useRef(false);
  const bargeTallyRef = useRef(0);
  const ignoreInputUntilRef = useRef(0);
  const isVoiceModeActiveRef = useRef(false);
  const errorLoggedRef = useRef(false);
  const speechImmediateRef = useRef(false);
  const captureReadyRef = useRef(false);
  // Provider-visible transcript for evidence checks that must NOT depend on
  // the local analyser latch (speechSeenRef never latches on some real mics).
  const liveTranscriptRef = useRef("");
  // A user tapped Stop to send: an empty final must exit to idle (no empty AI
  // request) instead of re-opening the mic to keep listening.
  const stopPendingRef = useRef(false);

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

  useEffect(() => {
    onFinalCommandRef.current = onFinalCommand;
  }, [onFinalCommand]);

  useEffect(() => {
    onInterruptRef.current = onInterrupt;
  }, [onInterrupt]);

  useEffect(() => {
    isVoiceModeActiveRef.current = isVoiceModeActive;
  }, [isVoiceModeActive]);

  useEffect(() => {
    micMutedRef.current = micMuted;
  }, [micMuted]);

  const clearTimers = useCallback(() => {
    clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;
    clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
    if (vadRafRef.current) {
      cancelAnimationFrame(vadRafRef.current);
      vadRafRef.current = null;
    }
  }, []);

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

  // Single commit entry point for a detected utterance. Guards on machine
  // state + flags so the several commit triggers (local silence, server VAD
  // speech:end, max-utterance watchdog, explicit stop) can never double-submit.
  // `force` is reserved for the user's explicit Stop tap: the utterance is
  // committed regardless of the local VAD latch, because the tap IS the
  // "I finished speaking" signal.
  const commitCurrentUtterance = useCallback((reason, { force = false } = {}) => {
    const machine = machineRef.current;
    const turn = currentTurnRef.current;
    if (!machine.isTurnValid(turn) || machine.state !== "listening") return false;
    if (micMutedRef.current || clarificationRef.current) return false;
    const evidence =
      speechSeenRef.current || Boolean(liveTranscriptRef.current?.trim());
    if ((!force && !evidence) || commitGuardRef.current) return false;
    commitGuardRef.current = true;
    clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;
    vlog(`committing utterance (${reason})`, turn);
    liveTranscriptRef.current = "";
    setLiveTranscript("");
    try {
      channelRef.current?.commit();
    } catch {
      /* ignore */
    }
    return true;
  }, []);

  const commitUtteranceRef = useRef(null);
  useEffect(() => {
    commitUtteranceRef.current = commitCurrentUtterance;
  }, [commitCurrentUtterance]);

  // Silence-submit: commit ~SILENCE_SUBMIT_MS after the most recent evidence
  // of speech, whichever source proves it (loud RMS frames OR a provider
  // interim transcript). Each fresh interim re-arms the deadline, so natural
  // silence after the LAST interim commits even when the local analyser never
  // latches speechSeen. Safe to call repeatedly: guards prevent double-commit.
  const armSilenceCommit = useCallback(() => {
    const machine = machineRef.current;
    if (!machine || machine.state !== "listening") return;
    if (micMutedRef.current || clarificationRef.current) return;
    if (commitGuardRef.current) return;
    clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      silenceTimerRef.current = null;
      commitUtteranceRef.current?.("silence");
    }, SILENCE_SUBMIT_MS);
  }, []);

  const exitVoiceMode = useCallback(() => {
    clearTimers();
    pendingClarificationRef.current = null;
    clarificationRef.current = false;
    setClarification(null);
    try {
      channelRef.current?.cancel?.("deactivated");
    } catch {
      /* ignore */
    }
    try {
      micRef.current?.setFramingEnabled?.(false);
    } catch {
      /* ignore */
    }
    try {
      micRef.current?.stop?.();
    } catch {
      /* ignore */
    }
    micRef.current = null;
    captureReadyRef.current = false;
    setIsVoiceListening(false);
    setLiveTranscript("");
    liveTranscriptRef.current = "";
    setIsVoiceModeActive(false);
    isVoiceModeActiveRef.current = false;
    voiceModeRef.current = null;
    setVoiceMode(null);
    micMutedRef.current = false;
    setMicMuted(false);
    stopPendingRef.current = false;
  }, [clearTimers, setIsVoiceListening]);

  // Truthful terminal failure: never claim "Listening…" after a hard error.
  const failVoice = useCallback(
    (code, logMessage, uiMessage) => {
      const machine = machineRef.current;
      clearTimers();
      pendingClarificationRef.current = null;
      clarificationRef.current = false;
      setClarification(null);
      if (machine.state !== "error") {
        machine.onError(code || "voice failed");
      } else {
        machine.deactivate("error already terminal");
      }
      reportErrorOnce(logMessage, uiMessage);
      try {
        channelRef.current?.cancel?.(code || "failed");
      } catch {
        /* ignore */
      }
      try {
        micRef.current?.setFramingEnabled?.(false);
      } catch {
        /* ignore */
      }
      try {
        micRef.current?.stop?.();
      } catch {
        /* ignore */
      }
      micRef.current = null;
      captureReadyRef.current = false;
      setIsVoiceListening(false);
      setIsVoiceModeActive(false);
      isVoiceModeActiveRef.current = false;
      voiceModeRef.current = null;
      setVoiceMode(null);
    },
    [clearTimers, reportErrorOnce, setIsVoiceListening],
  );

  // ---- Server STT final/interim routing ------------------------------------
  // `data` is the channel final payload: { text, rawText, corrections,
  // needsClarification, lowConfidence, destructive, reason,
  // language?, languageConfidence? }.
  const handleFinalTranscript = useCallback((data) => {
    const machine = machineRef.current;
    const turn = currentTurnRef.current;
    const raw = typeof data === "string" ? { text: data } : data || {};
    const transcript = String(raw?.text || "").trim();
    const stopped = stopPendingRef.current;
    stopPendingRef.current = false;
    console.log("[Advanced Voice] handleFinalTranscript", { turn, machineState: machine.state, currentTurnRef: currentTurnRef.current, hasText: Boolean(transcript) });
    if (!transcript) {
      if (stopped) {
        // Explicit Stop with nothing captured: leave voice mode. Returning to
        // idle (no empty AI request) instead of re-opening the mic to listen.
        liveTranscriptRef.current = "";
        setLiveTranscript("");
        machine.deactivate("user stopped");
        exitVoiceMode();
        return;
      }
      machine.restartListening("empty transcript");
      liveTranscriptRef.current = "";
      setLiveTranscript("");
      return;
    }
    if (machine.state === "processing" || machine.state === "speaking" || machine.state === "idle") {
      console.log("[Advanced Voice] skipping, machine state:", machine.state);
      return;
    }
    setLiveTranscript(transcript);
    liveTranscriptRef.current = transcript;
    const meta = {
      language: typeof raw?.language === "string" && raw.language ? raw.language : null,
      languageConfidence: typeof raw?.languageConfidence === "number" ? Math.max(0, Math.min(1, raw.languageConfidence)) : null,
    };
    if (shouldGateTranscript(raw)) {
      console.log(`[Advanced Voice] STT final needs confirmation`);
      pendingClarificationRef.current = {
        text: transcript, rawText: String(raw?.rawText ?? transcript),
        corrections: Array.isArray(raw?.corrections) ? raw.corrections : null,
        destructive: raw?.destructive || null, lowConfidence: Boolean(raw?.lowConfidence),
        reason: raw?.reason ?? null, language: meta.language, languageConfidence: meta.languageConfidence,
      };
      clarificationRef.current = true;
      setClarification(pendingClarificationRef.current);
      return;
    }
    if (machine.onUtteranceSubmitted(turn)) {
      onFinalCommandRef.current?.(transcript, meta);
    } else if (machine.state === 'listening' && !channelRef.current?.activeSession) {
      // Final arrived outside the current listening cycle and the STT session
      // is already dead (no active session). Refresh capture + session so the
      // next utterance is not silently starved of a transcriber — previously
      // the mode could keep "listening" forever without ever processing again.
      machine.restartListening("final outside cycle; session stale");
    }
    liveTranscriptRef.current = "";
    setLiveTranscript("");
  }, [exitVoiceMode]);

  // User confirmed the risky transcript (destructive or low-confidence).
  const confirmClarification = useCallback(() => {
    const pending = pendingClarificationRef.current;
    if (!pending) return;
    pendingClarificationRef.current = null;
    clarificationRef.current = false;
    setClarification(null);
    setLiveTranscript(pending.text);
    liveTranscriptRef.current = pending.text;
    const machine = machineRef.current;
    const turn = currentTurnRef.current;
    if (machine.onUtteranceSubmitted(turn)) {
      onFinalCommandRef.current?.(pending.text, {
        language: pending.language || null,
        languageConfidence: pending.languageConfidence ?? null,
      });
    }
    setLiveTranscript("");
    liveTranscriptRef.current = "";
  }, []);

  // User declined the risky transcript: stay listening with a fresh cycle.
  const cancelClarification = useCallback(() => {
    const machine = machineRef.current;
    if (!clarificationRef.current) return;
    pendingClarificationRef.current = null;
    clarificationRef.current = false;
    setClarification(null);
    setLiveTranscript("");
    liveTranscriptRef.current = "";
    machine.restartListening("clarification cancelled");
  }, []);

  const handleFinalTranscriptRef = useRef(null);
  useEffect(() => {
    handleFinalTranscriptRef.current = handleFinalTranscript;
  }, [handleFinalTranscript]);

  const handleChannelError = useCallback(
    (err, code = null) => {
      const machine = machineRef.current;
      if (!machine.isTurnValid(currentTurnRef.current)) return;
      const c = String(code || err?.code || "VOICE_STT_FAILED");
      if (c === "VOICE_STT_UNAVAILABLE") {
        failVoice(
          "VOICE_STT_UNAVAILABLE",
          `server STT not configured: ${err?.message || err || ""}`,
          "Server voice transcription is not configured. You can still type your message.",
        );
      } else if (c === "VOICE_STT_TIMEOUT") {
        failVoice(
          "VOICE_STT_TIMEOUT",
          `STT session did not start: ${err?.message || err || ""}`,
          "Voice transcription did not start. Try again, or type your message.",
        );
      } else if (c === "VOICE_STT_DISCONNECTED") {
        failVoice(
          "VOICE_STT_DISCONNECTED",
          "no socket available for STT",
          "Voice requires a connection to ARC. Reconnect and try again, or type your message.",
        );
      } else {
        failVoice(
          c,
          `STT failed: ${err?.message || err || ""}`,
          `Voice transcription failed (${err?.message || "unknown error"}). You can still type your message.`,
        );
      }
    },
    [failVoice],
  );

  const handleChannelErrorRef = useRef(null);
  useEffect(() => {
    handleChannelErrorRef.current = handleChannelError;
  }, [handleChannelError]);

  // ---- Mic capture + framing -----------------------------------------------
  const onFrameRef = useRef(null);
  const handleMicError = useCallback(
    (err) => {
      const machine = machineRef.current;
      const turn = currentTurnRef.current;
      if (!machine.isTurnValid(turn)) return;
      const name = err?.name || "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        failVoice(
          "VOICE_PERMISSION_DENIED",
          `microphone permission denied: ${err?.message || err}`,
          "Microphone access was denied. Allow microphone permission and try again, or type your message.",
        );
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        failVoice(
          "VOICE_NO_DEVICE",
          `no microphone device found: ${err?.message || err}`,
          "No microphone was found. Check your device and try again, or type your message.",
        );
      } else if (name === "NotReadableError" || name === "TrackStartError") {
        failVoice(
          "VOICE_DEVICE_BUSY",
          `microphone is busy: ${err?.message || err}`,
          "The microphone is being used by another app. Close it and try again, or type your message.",
        );
      } else {
        failVoice(
          "VOICE_MIC_FAILED",
          `microphone capture failed: ${err?.message || err}`,
          "Could not start the microphone. Check your device settings, or type your message.",
        );
      }
    },
    [failVoice],
  );

  const handleMicErrorRef = useRef(null);
  useEffect(() => {
    handleMicErrorRef.current = handleMicError;
  }, [handleMicError]);

  const beginSessionForSpeech = useCallback((turn) => {
    const machine = machineRef.current;
    if (!machine.isTurnValid(turn) || machine.state !== "listening") return;
    if (sessionStartedForTurnRef.current === turn) return;
    sessionStartedForTurnRef.current = turn;
    // activate() runs synchronously before the isVoiceModeActive effect has
    // mounted its channel reference. Resolve the shared channel here so the
    // first utterance cannot miss voice:stt:start.
    const channel = channelRef.current || getSharedSttChannel();
    channelRef.current = channel;
    try {
      Promise.resolve(channel.begin())
        .then(() => {
          if (machineRef.current.isTurnValid(turn)) {
            vlog("STT session started", turn);
          }
        })
        .catch((err) => handleChannelErrorRef.current?.(err));
    } catch (err) {
      handleChannelErrorRef.current?.(err);
    }
  }, []);

  // Resolve mic capture lazily; single getUserMedia for the whole session.
  const ensureMic = useCallback(async () => {
    if (micRef.current?.running) {
      captureReadyRef.current = true;
      micRef.current.setFramingEnabled(true);
      setIsVoiceListening(true);
      return micRef.current;
    }
    if (!micRef.current) {
      const capture = new VoiceMicCapture();
      capture._onFrame = onFrameRef.current;
      micRef.current = capture;
    }
    if (!onFrameRef.current) {
      onFrameRef.current = (packet) => {
        if (micMutedRef.current) return;
        channelRef.current?.sendFrame?.(packet);
      };
    }
    await micRef.current.start({
      onFrame: (packet) => onFrameRef.current?.(packet),
      onError: (err) => handleMicErrorRef.current?.(err),
    });
    captureReadyRef.current = true;
    micRef.current.setFramingEnabled(true);
    setIsVoiceListening(true);
    return micRef.current;
  }, [setIsVoiceListening]);

  const setFramingEnabled = useCallback((enabled) => {
    try {
      micRef.current?.setFramingEnabled?.(enabled);
    } catch {
      /* ignore */
    }
  }, []);

  // ---- Machine action bridging --------------------------------------------------
  const startCaptureRef = useRef(null);
  useEffect(() => {
    startCaptureRef.current = (turn) => {
      // Muted sessions never capture: no mic, no VAD, no transcription.
      if (micMutedRef.current) {
        setIsVoiceListening(false);
        return;
      }
      currentTurnRef.current = turn;
      sessionStartedForTurnRef.current = null;
      speechSeenRef.current = false;
      speechHoldRef.current = 0;
      speechStartedAtRef.current = 0;
      rmsPeakRef.current = 0;
      commitGuardRef.current = false;
      stopPendingRef.current = false;
      liveTranscriptRef.current = "";
      bargeTallyRef.current = 0;
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
      ignoreInputUntilRef.current = Date.now() + INPUT_IGNORE_WINDOW_MS;
      try {
        setFramingEnabled(true);
      } catch {
        /* ignore */
      }
      // Open STT before waiting for RMS. Quiet microphones can fall below the
      // detector threshold; audio must still reach the provider in that case.
      speechImmediateRef.current = false;
      beginSessionForSpeech(turn);
      ensureMic().catch((err) => handleMicErrorRef.current?.(err));
    };
  }, [
    setIsVoiceListening,
    setFramingEnabled,
    beginSessionForSpeech,
    ensureMic,
  ]);

  const stopCaptureInternalRef = useRef(null);
  useEffect(() => {
    stopCaptureInternalRef.current = (reason) => {
      // During processing or speaking, fully stop the mic so the user
      // gets clear feedback that the assistant is handling their command.
      // Barge-in is still handled via the server VAD (speech:start events)
      // and the channel stays active for the STT session.
      if (reason === "speaking" || reason === "processing") {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
        try {
          setFramingEnabled(false);
        } catch {
          /* ignore */
        }
        try {
          micRef.current?.stop?.();
        } catch {
          /* ignore */
        }
        micRef.current = null;
        captureReadyRef.current = false;
        setIsVoiceListening(false);
        return;
      }
      // deactivated / error / muted → full stop.
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
      try {
        channelRef.current?.cancel?.(reason || "stopped");
      } catch {
        /* ignore */
      }
      try {
        micRef.current?.setFramingEnabled?.(false);
      } catch {
        /* ignore */
      }
      try {
        micRef.current?.stop?.();
      } catch {
        /* ignore */
      }
      micRef.current = null;
      captureReadyRef.current = false;
      setIsVoiceListening(false);
      if (reason !== "muted") setLiveTranscript("");
    };
  }, [setIsVoiceListening, setFramingEnabled]);

  // ---- VAD: silence-submit (listening) + barge-in (speaking) -----------------
  useEffect(() => {
    const channel = getSharedSttChannel();
    channelRef.current = channel;
    const off = channel.onEvent((type, data) => {
      if (type === "interim") {
        if (machineRef.current.state !== "listening") return;
        liveTranscriptRef.current = String(data?.text || "");
        setLiveTranscript(liveTranscriptRef.current);
        // Provider interims are speech evidence the analyser may never latch
        // (speechSeenRef). Each fresh interim re-arms the silence deadline, so
        // the natural-silence commit fires ~SILENCE_SUBMIT_MS after the LAST
        // interim — the reliable silent-turn end even with a dead analyser.
        if (liveTranscriptRef.current.trim()) armSilenceCommit();
      } else if (type === "final") {
        console.log("[Advanced Voice] received STT final", { text: data?.text?.substring(0, 20), hasText: Boolean(data?.text) });
        handleFinalTranscriptRef.current?.(data);
      } else if (type === "error") {
        handleChannelErrorRef.current?.(data || {}, data?.code);
      } else if (type === "speech:start") {
        if (!isVoiceModeActiveRef.current) return;
        const m = machineRef.current;
        if (m.state === "speaking") {
          speechImmediateRef.current = true;
          vlog("barge-in: server VAD speech_start while ARC speaking", m.turn);
          m.bargeIn();
        } else if (m.state === "listening" && !speechSeenRef.current) {
          speechSeenRef.current = true;
          speechStartedAtRef.current = Date.now();
        }
      } else if (type === "speech:end") {
        // Server VAD says the speaker stopped. Commit shortly after — this is
        // the reliable endpoint for mics/rooms where the local RMS floor never
        // quiets enough for the silence timer to fire on its own.
        if (!isVoiceModeActiveRef.current || clarificationRef.current) return;
        if (
          (speechSeenRef.current || Boolean(liveTranscriptRef.current?.trim())) &&
          !commitGuardRef.current &&
          !silenceTimerRef.current
        ) {
          silenceTimerRef.current = setTimeout(() => {
            silenceTimerRef.current = null;
            commitUtteranceRef.current?.("server speech end");
          }, SPEECH_END_COMMIT_MS);
        }
      }
    });

    const timeData = new Float32Array(2048);
    const tick = () => {
      if (!isVoiceModeActiveRef.current) return;
      const machine = machineRef.current;
      const state = machine.state;
      const muted = micMutedRef.current;
      const analyser = micRef.current?.getAnalyser?.() || null;
      let rms = 0;
      if (analyser) {
        analyser.getFloatTimeDomainData(timeData);
        let sum = 0;
        for (let i = 0; i < timeData.length; i += 1)
          sum += timeData[i] * timeData[i];
        rms = Math.sqrt(sum / timeData.length);
      }
      const ignore = Date.now() < ignoreInputUntilRef.current;

      if (state === "listening" && !muted && !clarificationRef.current) {
        // "Quiet" is relative once speech has begun: the floor rises with the
        // loudest measured sample so resting mic noise on a real device never
        // holds the silence-submit hostage. Loud/speech energy is ALSO judged
        // against this relative floor — otherwise room/IAQ residue above the
        // absolute SPEECH_RMS_THRESHOLD but below the floor stays in the
        // "speech" branch forever and cancels the silence timer on every frame,
        // leaving the turn stuck in listening (no commit, no final, no request).
        const quietFloor = Math.max(
          SPEECH_RMS_THRESHOLD,
          rmsPeakRef.current * RMS_PEAK_QUIET_RATIO,
        );
        const loud = rms > quietFloor && !ignore;
        if (loud) {
          speechHoldRef.current += 1;
          if (!speechSeenRef.current) {
            // A single startup/click spike is not an utterance. This makes
            // silence commits reliable across Chrome, Firefox, Brave and
            // mobile WebView without changing the microphone transport.
            if (speechHoldRef.current >= SPEECH_HOLD_FRAMES) {
              speechSeenRef.current = true;
              speechStartedAtRef.current = Date.now();
              rmsPeakRef.current = Math.max(rmsPeakRef.current, rms);
              beginSessionForSpeech(currentTurnRef.current);
            }
          } else {
            rmsPeakRef.current = Math.max(rmsPeakRef.current, rms);
          }
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        } else {
          speechHoldRef.current = 0;
          if (
            rms <= quietFloor &&
            (speechSeenRef.current || Boolean(liveTranscriptRef.current?.trim())) &&
            Date.now() - speechStartedAtRef.current >= MIN_UTTERANCE_MS
          ) {
            armSilenceCommit();
          }
        }
        // Watchdog: even sustained speech/noise must eventually be committed,
        // otherwise the mode could "listen" forever without processing.
        if (
          (speechSeenRef.current || Boolean(liveTranscriptRef.current?.trim())) &&
          !commitGuardRef.current &&
          !clarificationRef.current &&
          Date.now() - speechStartedAtRef.current >= MAX_UTTERANCE_MS
        ) {
          commitUtteranceRef.current?.("max-utterance");
        }
      } else if (state === "speaking" && !muted) {
        if (rms > BARGE_RMS_THRESHOLD && !ignore) {
          bargeTallyRef.current += 1;
          if (bargeTallyRef.current >= BARGE_HOLD_FRAMES) {
            bargeTallyRef.current = 0;
            speechSeenRef.current = true;
            speechImmediateRef.current = true;
            vlog("barge-in: sustained speech while ARC speaking", machine.turn);
            machine.bargeIn();
          }
        } else {
          bargeTallyRef.current = 0;
        }
      }
      vadRafRef.current = requestAnimationFrame(tick);
    };

    vadRafRef.current = requestAnimationFrame(tick);
    return () => {
      off();
      cancelAnimationFrame(vadRafRef.current);
      vadRafRef.current = null;
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
      try {
        channelRef.current?.cancel?.("deactivated");
      } catch {
        /* ignore */
      }
      try {
        micRef.current?.setFramingEnabled?.(false);
      } catch {
        /* ignore */
      }
      try {
        micRef.current?.stop?.();
      } catch {
        /* ignore */
      }
      micRef.current = null;
      captureReadyRef.current = false;
      channelRef.current = null;
    };
  }, [armSilenceCommit]);

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  // Canonical speaking signal drives the machine. Mic stays live during
  // speaking (framing off) so barge-in is possible; onSpeechStarted only
  // marks the transition.
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
    if (
      !isProcessing &&
      (machine.state === "speaking" || machine.state === "processing")
    ) {
      clearRestartTimer();
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null;
        machine.onSpeechEnded();
      }, RESTART_LISTEN_DELAY_MS);
    }
    return () => {};
  }, [isSpeaking, isProcessing, isVoiceModeActive, clearRestartTimer]);

  const toggleAdvancedVoice = () => {
    const machine = machineRef.current;
    if (!isVoiceModeActiveRef.current || machine.state === "idle") {
      clearTimers();
      clearError();
      // Mic press is a user gesture — initialize/resume the AudioContext so
      // streaming playback is unlocked afterwards.
      try {
        getSharedVoiceEngine()?.ensureFromGesture?.();
      } catch {
        /* never blocks voice */
      }
      const mode = getVoiceMode();
      if (mode === "unsupported") {
        machine.onError("no voice capability");
        reportErrorOnce(
          "no voice capability (no getUserMedia mic capture or Web Audio)",
          "Voice input is not available in this browser. Please type your message, or try a browser with microphone support.",
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
    // A tap while listening is context-aware:
    //   * with a pending utterance → STOP & SEND: stop capture so no new PCM
    //     enters this turn, then finalize the current provider turn. Exactly
    //     one final flows back → onUtteranceSubmitted → processing → the AI
    //     request. (Previously the tap exited/muted, discarding the transcript
    //     and never forcing a transition out of listening.)
    //   * with nothing pending → true off (mic off, session released).
    // Muting remains a separate explicit control.
    if (machine.state === "listening") {
      if (micMutedRef.current) {
        toggleMicMuted();
        return;
      }
      if (clarificationRef.current) {
        // A transcript is awaiting confirm/cancel; the dialog owns this stop.
        vlog("stop: clarification pending", machine.turn);
        return;
      }
      if (commitGuardRef.current) {
        // An utterance is already being finalized (silence/backstop/watchdog);
        // do not cancel it or double-commit. It will reach processing shortly.
        vlog("stop: already finalizing", machine.turn);
        return;
      }
      // STOP & SEND: stop new PCM from entering this turn, then finalize the
      // current provider turn. The commit is FORCED — the tap is the explicit
      // "I am done speaking" signal and must NOT depend on the local VAD latch
      // (speechSeenRef stays false on real mics/rooms). One final flows back →
      // onUtteranceSubmitted → processing → exactly one AI request. An empty
      // final exits to idle (no empty request).
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
      try {
        setFramingEnabled(false);
      } catch {
        /* ignore */
      }
      try {
        micRef.current?.stop?.();
      } catch {
        /* ignore */
      }
      micRef.current = null;
      captureReadyRef.current = false;
      setIsVoiceListening(false);
      if (commitCurrentUtterance("user stop", { force: true })) {
        stopPendingRef.current = true;
      } else {
        machine.deactivate("toggled off");
        exitVoiceMode();
      }
      return;
    }
    // In-mode taps are state-dependent (barge-in, cancel, or exit).
    const outcome = machine.toggle();
    if (outcome === "deactivated" || outcome === "cancelled") {
      exitVoiceMode();
    }
  };

  const voiceModeRef = useRef(null);
  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

  const toggleMicMuted = () => {
    const machine = machineRef.current;
    const next = !micMutedRef.current;
    micMutedRef.current = next;
    setMicMuted(next);
    if (next) {
      try {
        micRef.current?.setFramingEnabled?.(false);
      } catch {
        /* ignore */
      }
      try {
        micRef.current?.stop?.();
      } catch {
        /* ignore */
      }
      micRef.current = null;
      captureReadyRef.current = false;
      setIsVoiceListening(false);
    } else if (machine.state === "listening") {
      machine.restartListening("unmuted");
    }
    return next;
  };

  // Cleanup on unmount: release microphone and all resources.
  useEffect(() => {
    return () => {
      isVoiceModeActiveRef.current = false;
      clearTimers();
      try {
        channelRef.current?.cancel?.("unmount");
      } catch {
        /* ignore */
      }
      try {
        micRef.current?.stop?.();
      } catch {
        /* ignore */
      }
      micRef.current = null;
    };
  }, [clearTimers]);

  return {
    isVoiceModeActive,
    liveTranscript,
    voiceMode,
    voiceError,
    voiceInteractionState,
    toggleAdvancedVoice,
    micMuted,
    toggleMicMuted,
    clarification,
    confirmClarification,
    cancelClarification,
  };
};
