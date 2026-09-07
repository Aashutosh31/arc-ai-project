# ARC-AI Advanced Voice Mode

This document describes the **current** conversational voice implementation (half-duplex), its input/output paths, and configuration. It reflects the code as it exists today.

> **Important:** Voice *input* and voice *output* are separate engines with separate capability detection. Not all browsers use the same STT implementation.

---

## 1. Voice Architecture

Advanced Voice Mode is orchestrated by:

- **State machine** — `client/src/utils/voiceInteractionMachine.js` (framework-free, DOM-free, unit-testable).
- **Hook** — `client/src/hooks/useAdvancedVoice.js` wires the machine to real browser APIs (`SpeechRecognition`, `MediaRecorder`, `AudioContext`).
- **Capability detection** — `client/src/utils/voiceCapabilities.js` (feature detection only, no browser sniffing).
- **Output** — `client/src/hooks/useTextToSpeech.js` (browser `speechSynthesis`) and/or `client/src/hooks/useServerTtsAudio.js` (server-generated audio).
- **Server STT fallback** — `POST /api/voice/transcribe` (`server/routes/voice.js`), transcribed by Gemini.
- **Server TTS (optional)** — `server/services/ttsService.js`, Gemini audio synthesized per segment.

---

## 2. Supported Input Paths (STT)

| Path | When | Details |
| --- | --- | --- |
| **Native** | Browser exposes `window.SpeechRecognition` / `window.webkitSpeechRecognition` | Continuous recognition (`continuous: true`, `interimResults: true`, `lang: 'en-US'`). A trailing-silence timer (~1.5 s) finalizes and submits the utterance. ARC-AI restarts recognition only while still `listening` on the same turn. |
| **Server fallback** | No native recognition but `getUserMedia` + `MediaRecorder` available | Records in 250 ms chunks (`pickRecordingMimeType()` codec negotiation), performs RMS-based VAD, and submits the recorded clip to `POST /api/voice/transcribe`. Charges **1 ARC-AI credit** (distinct from provider billing). |
| **Unsupported** | Neither capability | Voice mode refuses to start with a clear message; typing still works. |

The mode is auto-resolved via `getVoiceMode()`: `'native'` → `'server'` → `'unsupported'`.

---

## 3. Output Paths (TTS)

| Path | When | Details |
| --- | --- | --- |
| **Browser speech synthesis** | Default (`TTS_PROVIDER=browser` or unset) | `speechSynthesis` with natural-voice preference, sentence/clause-split queue, Firefox resume guard, and a suppression threshold for very long replies. |
| **Server Gemini TTS** | `TTS_PROVIDER=gemini` **and** `GEMINI_API_KEY` set | LLM text is buffered in `TtsStreamBuffer`, split at sentence boundaries, synthesized per segment, and streamed as base64 WAV over Socket.IO (`ai:tts:audio`). The client queues and plays with a plain `HTMLAudioElement`. |

A per-response `ai:tts:mode` event tells the client which engine to use, so they never play simultaneously. See [`llm-providers.md`](./llm-providers.md) and the README for TTS environment variables.

> **Validation status:** the server Gemini-TTS path is implemented and covered by headless unit tests (`server/tests/ttsService.test.js`). It has *not* been validated across a wide browser matrix — treat cross-browser server TTS as implemented but requiring manual browser validation.

---

## 4. Half-Duplex State Machine

The machine enforces the half-duplex invariant:

- `state === 'speaking'` → microphone capture **must** be stopped.
- `state === 'listening'` → TTS playback **must not** be active.

```
OFF
 │  tap
 ▼
LISTENING ──silence/end-of-utterance──▶ PROCESSING
   ▲                                      │ response starts
   │                                      ▼
   │◀────────── response ends ──────── SPEAKING
   │
   └── tap (barge-in) ──▶ INTERRUPTED ──▶ LISTENING   (mic re-arms)
```

Transitions:

- **`activate`** — OFF → LISTENING; increments the turn; starts capture.
- **`onUtteranceSubmitted`** — LISTENING → PROCESSING; stops capture; invalidates the turn (returns `false` for stale callbacks).
- **`onSpeechStarted`** — PROCESSING/LISTENING → SPEAKING; stops capture (the half-duplex enforcement).
- **`onSpeechEnded`** — SPEAKING/PROCESSING → LISTENING; restarts capture with a fresh turn.
- **`bargeIn`** — SPEAKING → INTERRUPTED → LISTENING; interrupts generation; restarts capture.
- **`toggle`** — single-button semantics: activate, barge-in, cancel (during processing), or exit.
- **`onError`** — any state → ERROR (terminal until the user re-toggles).
- **`deactivate`** — any state → OFF.

State diagram (ASCII):

```
LISTENING
   ↓ silence/utterance finalized
PROCESSING
   ↓ response starts
SPEAKING       ←── tap anywhere here
   ↓ response ends
LISTENING

BARGE-IN:
SPEAKING
   ↓ tap
INTERRUPTED
   ↓
LISTENING
```

---

## 5. Microphone Lifecycle

- Frames capture with the microphone only while `listening`.
- **During `speaking` the mic is disabled**, so ARC can never transcribe its own speech.
- After ARC finishes speaking and generation settles, capture re-arms after `RESTART_LISTEN_DELAY_MS` (400 ms) — a clean restart boundary.
- An **input-ignore window** (350 ms) after (re)starting capture drops residual speaker/room tail so it is never treated as a new utterance.
- Mic constraints request: `echoCancellation`, `noiseSuppression`, `autoGainControl`.

---

## 6. Silence Detection (VAD)

Enabled on the server-transcription path:

- `AudioContext` + `AnalyserNode` (`fftSize: 2048`) compute RMS over time-domain data.
- Consistent RMS above `SPEECH_RMS_THRESHOLD` (0.03) marks speech; a following trailing silence of `SILENCE_SUBMIT_MS` (~1.5 s) stops the recorder and submits the clip.
- `MAX_UTTERANCE_MS` (60 s) caps a single utterance; without an analyser, a fixed ~8 s clip is used.
- The VAD loop runs **only** while `listening`.

The native path uses the browser engine's own end-of-speech detection plus a 1.5 s silence timer.

---

## 7. One-Tap Interruption (Barge-In)

- While `speaking`, a single tap invokes `bargeIn()`: it enters `INTERRUPTED`, calls `interruptGeneration()` (which emits `ai:stream:stop`), then transitions to `LISTENING` and re-arms the microphone.
- Barge-in while `processing` cancels generation and exits voice mode; double barge-ins are safe no-ops.
- Interrupting stops audio/generation and returns to listening so the user can immediately speak.

---

## 8. Stale Turn Protection

Every listening cycle has a unique **turn id**. Entering any other state invalidates the previous turn:

- Late `SpeechRecognition` results, recorder `onstop` callbacks, and server transcription responses carrying a stale turn are discarded via `isTurnValid(turn)`.
- State-aware restart only happens while still `listening` on the same turn (the fix for the old bug where recognition restarted during `speaking`/`processing` and transcribed ARC's voice).

---

## 9. Live Vision Integration

- `LiveVisionCamera` provides a live webcam stream.
- When a voice command is finalized, the current camera frame (base64 JPEG) is captured and attached to the command payload over `ai:stt:final`.
- The image is routed to a **multimodal-capable provider (Gemini)**; text-only providers are excluded. See [`vision-and-multimodal.md`](./vision-and-multimodal.md).

---

## 10. Browser Capability Detection

| Detection | Source |
| --- | --- |
| `hasNativeSTT()` | `SpeechRecognition || webkitSpeechRecognition` |
| `hasRecordingSTT()` | `getUserMedia` + `MediaRecorder` |
| `getVoiceMode()` | `'native'` · `'server'` · `'unsupported'` |
| `pickRecordingMimeType()` | webm/opus → webm → mp4 → ogg → empty |

Server TTS availability is announced by the server (`ai:tts:mode`); browser TTS presence is checked via `speechSynthesis`/`voiceschanged`.

---

## 11. Autoplay Restrictions

- Browsers require a prior user gesture before audio can play. In practice this means the user must interact (tap/click) before ARC's spoken replies start. This affects both browser `speechSynthesis` and the server-audio `HTMLAudioElement` queue.
- The client handles blocked playback gracefully (autoplay-blocked branches in `useServerTtsAudio.js`).

---

## 12. Configuration

Environment (server):

```env
# Voice input fallback uses Gemini for transcription
GEMINI_API_KEY=...

# Optional server TTS
TTS_PROVIDER=browser     # browser (default) | gemini
TTS_MODEL=gemini-2.5-flash-preview-tts
TTS_VOICE=Kore
```

Tunables in `useAdvancedVoice.js` (client constants): `SILENCE_SUBMIT_MS=1500`, `MAX_UTTERANCE_MS=60000`, `SPEECH_RMS_THRESHOLD=0.03`, `INPUT_IGNORE_WINDOW_MS=350`, `RESTART_LISTEN_DELAY_MS=400`.

---

## 13. Troubleshooting

- **Microphone permission denied** — `NotAllowedError`; re-enable mic access for the site and toggle voice again.
- **Native recognition unavailable** — the client automatically uses the server path. If that fails with `VOICE_STT_UNAVAILABLE`, `GEMINI_API_KEY` is missing/expired; typing still works, and browsers with native recognition are unaffected.
- **Server STT not configured** — `POST /api/voice/transcribe` returns 503; the UI explains that native/typing still work.
- **TTS never plays** — usually an autoplay-policy issue: interact with the page first.
- **Different voices on different machines** — browser voices are OS-provided; the server-Gemini path removes this variance (when enabled).
- **Video/mic echo** — ensure `echoCancellation`/`noiseSuppression` are not overridden by OS settings (the client requests both).

---

## 14. Testing Limitations

- **Automated (CI-less, local):** `node scripts/testVoiceMachine.js` executes regression tests for the full state machine (`VoiceInteractionMachine`) — full turns, barge-in, repeated turns, stale-callback protection, and half-duplex invariants, all without a DOM or network.
- **Not automated:** real microphone capture, native `SpeechRecognition`, server transcription, and speech-synthesis playback are **not** covered by live browser automation. These paths require **manual browser QA** and behave differently across browsers/OSes.
- Server-side TTS logic is headless-tested (`server/tests/ttsService.test.js`), but end-to-end cross-browser audio is not.