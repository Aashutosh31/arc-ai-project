# ARC-AI Advanced Voice Mode

This document describes the **current** conversational voice implementation (half-duplex), its input/output paths, and configuration. It reflects the code as it exists today.

> **Important:** Voice *input* and voice *output* are separate engines with separate capability detection. Both now route through the ARC server — the browser captures raw microphone frames but never transcribes or synthesizes.

---

## 1. Voice Architecture

Advanced Voice Mode is orchestrated by:

- **State machine** — `client/src/utils/voiceInteractionMachine.js` (framework-free, DOM-free, unit-testable).
- **Hook** — `client/src/hooks/useAdvancedVoice.js` wires the machine to the streaming server-STT channel, the mic capture engine, and the VAD/barge-in loop.
- **Capability detection** — `client/src/utils/voiceCapabilities.js` (feature detection only, no browser sniffing).
- **Output** — streaming server TTS via `client/src/audio/VoiceAudioEngine.js` (AudioWorklet) — primary; `useTextToSpeech.js` (browser `speechSynthesis`) is fallback only.
- **Input** — streaming server STT: `client/src/audio/VoiceMicCapture.js` captures mic frames, `client/src/utils/sttChannel.js` streams them to the server, `server/services/sttService.js` owns transcription (Sarvam realtime primary, Gemini fallback).
- **Server STT fallback (legacy)** — `POST /api/voice/transcribe` (`server/routes/voice.js`), a blob endpoint kept for old clients.
- **Server TTS** — `server/services/ttsService.js`, Gemini audio synthesized per semantic segment.

---

## 2. Supported Input Paths (STT)

| Path | When | Details |
| --- | --- | --- |
| **Streaming server STT (primary)** | `getUserMedia` available (client) and `sttService` active (server) | The mic feeds an input `AudioWorklet` (`voice-mic-worklet.js`) that resamples to **PCM16-LE mono 24 kHz** and emits 100 ms frames (`seq`, explicit `format`). Frames stream over the existing authenticated Socket.IO connection (`voice:stt:start/audio/commit/cancel`, server replies `voice:stt:started/interim/final/end/error/cancelled`), bounded (per-session byte/duration caps, one session per socket, seq dedupe). A trailing-silence `commit()` yields one deterministic `final`; the transcript flows through the state machine and is submitted for the response. Charging follows provider billing for transcription. |
| **Blob transcription (legacy compat)** | `voiceCapabilities.blobToBase64` / `transcribeAudioBlob` callers | Submits an already-recorded clip to `POST /api/voice/transcribe`. The interactive voice mode no longer uses it. |
| **Unsupported** | `getUserMedia` unavailable | Voice mode refuses to start with a clear message; typing still works. |

Voice mode is a single resolution: `getVoiceMode()` returns `'server'` when `hasUserMediaAudio()`, else `'unsupported'`. `GET /api/voice/tts-config` also advertises the server STT config with `usesBrowserSpeechRecognition: false`.

---

## 3. Output Paths (TTS)

| Path | When | Details |
| --- | --- | --- |
| **Streaming server TTS (Voice Runtime 3.0, primary)** | `TTS_PROVIDER=sarvam` (or `gemini`) with the matching provider key set | ONE continuous synthesis session per assistant response (`startStream/writeText/flush/cancel/close` in `server/services/voiceTtsProvider.js`). LLM deltas flow into a semantic buffer (multi-sentence chunks ~480 chars, opener merge-forward, never mid-word); each chunk synthesizes with prior-chunk prosody context (same voice/rhythm, never repeated). Speech-normalized input (`server/services/speechNormalize.js`: markdown/lists/tables/links read as pauses, never as markup). Sarvam (`bulbul:v3`) streams linear16 24 kHz over its API WebSocket and is re-emitted as binary PCM16-LE mono 24 kHz over the existing authenticated Socket.IO connection (`voice:tts:start/audio/end/error/cancel`), every packet carrying explicit format + monotonic `seq`. The client plays it through an `AudioWorklet` ring buffer (`VoiceAudioEngine`): device-default `AudioContext` rate with explicit resampling, bounded staging for pre-activation audio, pre-roll/jitter buffer, sequence validation, instant flush on barge-in. No OS speech services, no primary `SpeechSynthesis`, no browser-name branches. |
| **Server Gemini TTS (legacy compat)** | `TTS_PROVIDER=gemini` and `GEMINI_API_KEY` set | Pre-v3 WAV segments (`ai:tts:audio`) for old clients. New clients ignore this path while a `voice:tts:*` stream is active so the two voices never overlap. |
| **Browser speech synthesis (fallback only)** | No provider key (sarvam/gemini both missing), streaming disabled, or streaming unavailable | `speechSynthesis` with natural-voice preference, sentence/clause-split queue, Firefox resume guard, and a suppression threshold for very long replies. Used ONLY as fallback — never the primary path when streaming is active. |

A per-response `ai:tts:mode` event tells the client which engine to use, so they never play simultaneously. `GET /api/voice/tts-config` advertises streaming availability, PCM format, and event names without exposing credentials. Voice settings (provider, voice, speed, streaming toggle, fallback toggle) live in `client/src/utils/voiceSettings.js` (localStorage, no secrets). See [`llm-providers.md`](./llm-providers.md) and the README for TTS environment variables.

> **Validation status:** the streaming voice runtime is covered by headless unit tests (`server/tests/voiceRuntime.test.js`, `server/tests/voiceStt.test.js`, `server/tests/ttsService.test.js`, `server/tests/sttServiceSarvam.test.js`, `server/tests/sarvamStt.test.js`, `server/tests/sarvamTts.test.js`, `client/tests/voiceRuntime.test.mjs`, `client/tests/voiceSttClient.test.mjs`, `client/scripts/testVoiceMachine.js`) AND real headless-browser acceptance: Firefox + Chromium proof for BOTH paths — 440 Hz tone through the production engine, real `voice:tts:*` socket stream with interrupt latency and second-stream recovery, plus the FINAL input loop (real fake-mic `getUserMedia` capture → production worklet framing → `voice:stt:*` → server interim/final → audible reply → a second utterance transcribed while TTS is streaming, and an in-flight session cancelled by interrupt). Sarvam adds offline wire coverage for the realtime STT/TTS endpoints (config-first handshake, audio framing, detected-language metadata, VAD speech boundaries, error normalization) and a key-gated live suite. The browser-acceptance harness and its evidence JSON are generated locally under `.tmp-voice-e2e/` and not committed. Remaining manual QA: Edge/Safari, real-speech transcription quality on the real mic, audible listening check on real speakers, long-response prosody judgement, background/foreground tab behavior, refresh/reconnect with a live backend.

---

## 4. Half-Duplex State Machine

The machine enforces the half-duplex invariant at the **recognition** level:

- `state === 'speaking'` → no utterance can be recognized (frame transport is disabled, so the mic never reaches the transcriber while ARC speaks).
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
   └── tap / VAD speech ──▶ INTERRUPTED ──▶ LISTENING   (mic re-arms)
```

Transitions:

- **`activate`** — OFF → LISTENING; increments the turn; starts capture.
- **`onUtteranceSubmitted`** — LISTENING → PROCESSING; disables framing/transport; invalidates the turn (returns `false` for stale callbacks).
- **`onSpeechStarted`** — PROCESSING/LISTENING → SPEAKING; disables framing/transport (the half-duplex enforcement at the recognition level).
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
SPEAKING       ←── tap or automatic VAD barge-in anywhere here
   ↓ response ends
LISTENING

BARGE-IN:
SPEAKING
   ↓ tap / VAD speech
INTERRUPTED
   ↓
LISTENING
```

---

## 5. Microphone Lifecycle

- Raw frames reach the STT transport only while `listening` (**framing disabled otherwise** — audio may be captured but never leaves the device).
- **During `speaking` the physical mic stays on** with framing/transport off, so the VAD can detect the user interrupting ARC's reply (see §7). ARC's own output cannot be transcribed because framing stays off; real-world barge-in reliability still depends on `echoCancellation`.
- After ARC finishes speaking and generation settles, capture re-arms after `RESTART_LISTEN_DELAY_MS` (400 ms) — a clean restart boundary.
- An **input-ignore window** (350 ms) after (re)starting capture drops residual speaker/room tail so it is never treated as a new utterance.
- Mic constraints request: `echoCancellation`, `noiseSuppression`, `autoGainControl`.

---

## 6. Silence Detection (VAD)

Enabled on the streaming path:

- `AudioContext` + `AnalyserNode` (`fftSize: 2048`) compute RMS over time-domain data.
- Consistent RMS above `SPEECH_RMS_THRESHOLD` (0.03) marks speech; a following trailing silence of `SILENCE_SUBMIT_MS` (~1.5 s) issues a `voice:stt:commit`, which yields one server `final` per utterance.
- A synthesizable test waveform can be injected (`VoiceMicCapture.__injectFloat24k`) but only when `allowInject` is explicit or the URL carries a dev/test query — production builds never enable it.
- The VAD loop runs at `requestAnimationFrame` cadence with `VoiceMicCapture` diagnostics (energy only, no recognition).

---

## 7. One-Tap / Automatic Interruption (Barge-In)

- **Tap barge-in:** while `speaking`, a single tap invokes `bargeIn()`: it enters `INTERRUPTED`, calls `interruptGeneration()` (which emits `ai:stream:stop`), then transitions to `LISTENING` and re-arms the microphone.
- **Automatic VAD barge-in:** while `speaking`, the (still-live) mic RMS above `BARGE_RMS_THRESHOLD` (0.08) for ~6 consecutive frames invokes `machine.bargeIn()` so the user can simply start talking to cut ARC off.
- Barge-in while `processing` cancels generation and exits voice mode; double barge-ins are safe no-ops.
- Interrupting stops audio/generation and returns to listening so the user can immediately speak.

---

## 8. Stale Turn / Session Protection

Every listening cycle has a unique **turn id**. Entering any other state invalidates the previous turn:

- Late server STT results and TTS stream callbacks carrying a stale turn are discarded via `isTurnValid(turn)`.
- Client STT frames are sequence-ordered and format-gated; the shared `StreamingSttChannel` dedupes/queues frames during session startup and resets on disconnect/reconnect.
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
| `hasUserMediaAudio()` | `navigator.mediaDevices.getUserMedia` |
| `getVoiceMode()` | `'server'` (mic audio available) · `'unsupported'` |
| `blobToBase64()` / `transcribeAudioBlob()` | legacy blob STT helpers (kept for older clients) |

No `SpeechRecognition`, `webkitSpeechRecognition`, or `MediaRecorder` feature gates exist for the voice mode. Transcription and synthesis are server-owned.

Server STT/TTS availability is announced by the server (`GET /api/voice/tts-config`, `ai:tts:mode`); browser `speechSynthesis` presence is checked only for the fallback output path.

---

## 11. Autoplay Restrictions

- Browsers require a prior user gesture before audio can play. In practice this means the user must interact (tap/click) before ARC's spoken replies start. This affects the server-audio `AudioContext`/`AudioWorklet` and, where applicable, the `speechSynthesis` fallback.
- The client handles blocked playback gracefully (autoplay-blocked branches in `useServerTtsAudio.js`).

---

## 12. Configuration

Environment (server):

```env
# Voice transcription (server-owned STT)
SARVAM_API_KEY=...            # primary provider; auto-detected languages (default STT_PROVIDER=sarvam)
GEMINI_API_KEY=...            # fallback when Sarvam is unavailable
STT_PROVIDER=sarvam           # sarvam (default with key) | gemini | mock (deterministic, for tests/harness)
SARVAM_STT_MODEL=saaras:v3-realtime
SARVAM_STT_LANGUAGE=auto      # BCP-47 (e.g. hi-IN) or 'auto' (auto-detect)
SARVAM_STT_SILENCE_MS=700
SARVAM_STT_MIN_SPEECH_MS=250

# Optional server TTS (default TTS_PROVIDER=sarvam when SARVAM_API_KEY set)
TTS_PROVIDER=sarvam           # sarvam | browser | gemini
SARVAM_TTS_MODEL=bulbul:v3
SARVAM_TTS_SPEAKER=shubh
SARVAM_TTS_LANGUAGE=en-IN     # fallback; unsupported codes (incl. or-IN→od-IN) map to en-IN
GEMINI_API_KEY=...
GEMINI_TTS_MODEL=gemini-2.5-flash-preview-tts
TTS_VOICE=Kore
```

Explicit capture format for both mic input and server-synthesized audio: PCM signed 16-bit LE mono **24 kHz** (`sampleRate: 24000`, `channels: 1`, `endianness: 'le'`); every frame and audio packet carries the format plus a monotonic `seq`.

Tunables in `useAdvancedVoice.js` (client constants): `SILENCE_SUBMIT_MS=1500`, `SPEECH_RMS_THRESHOLD=0.03`, `BARGE_RMS_THRESHOLD=0.08`, `BARGE_HOLD_FRAMES=6`, `INPUT_IGNORE_WINDOW_MS=350`, `RESTART_LISTEN_DELAY_MS=400`.

---

## 13. Troubleshooting

- **Microphone permission denied / no device** — the client reports a truthful error (`VOICE_PERMISSION_DENIED`, `VOICE_NO_DEVICE`, `VOICE_DEVICE_BUSY`, `VOICE_MIC_FAILED`); re-enable mic access for the site and toggle voice again.
- **STT unavailable (`VOICE_STT_UNAVAILABLE`)** — the server has no active STT provider (no `SARVAM_API_KEY` and no `GEMINI_API_KEY`). Typing still works.
- **STT session did not start (`VOICE_STT_TIMEOUT`)** — `voice:stt:started` did not arrive in ~8 s; disconnect/reconnect resets the channel, and the UI explains that typing still works.
- **TTS never plays** — usually an autoplay-policy issue: interact with the page first.
- **Different voices on different machines** — browser voices are OS-provided; the server-Gemini path removes this variance (when enabled).
- **Barge-in doesn't trigger reliably on real hardware** — check OS-level echo cancellation/AEC; the client requests `echoCancellation` but OS/device settings can override it.
- **Video/mic echo** — ensure `echoCancellation`/`noiseSuppression` are not overridden by OS settings (the client requests both).

---

## 14. Testing Limitations

- **Automated (CI-less, local):**
  - `node client/scripts/testVoiceMachine.js` — full state-machine regression (turns, barge-in, stale-callback protection, half-duplex invariants).
  - `node client/tests/voiceSttClient.test.mjs` — worklet framing parity, capture bounds, channel lifecycle, seq dedupe/format gating, disconnect truthfulness.
  - `node client/tests/voiceRuntime.test.mjs` — TTS client runtime.
  - `node server/tests/voiceStt.test.js` — server STT coordinator (sessions, bounds, dedupe, providers, cancel).
  - `node server/tests/sttServiceSarvam.test.js` — Sarvam STT coordinator over an injected socket (explicit wire format, detected language/confidence feedback, commit/supersede/cancel, stale rejection, VAD-event speech boundaries).
  - Sarvam wire unit tests (all in `server/tests/`): `sarvamLanguage.test.js` (detected-language → Bulbul code mapping, or-IN→od-IN, en-IN fallback), `sarvamAudio.test.js` (24→16 kHz resample parity), `sarvamStt.test.js` (URL params, connect gates, error classification, commit guard), `sarvamTts.test.js` (config-first handshake, single session reuse, language override, cancel, buffer flush).
  - `node server/tests/sarvamLive.test.js` (needs `SARVAM_API_KEY`) — real endpoint smoke: silence STT session, `stream_type=fast`, one-line TTS into audible audio, `hi-IN` override.
  - `node server/tests/voiceRuntime.test.js`, `server/tests/ttsService.test.js` — server TTS semantics.
  - `npm run test:sarvam` (both) — full Sarvam offline suite; the local browser-acceptance harness (`.tmp-voice-e2e/`, not committed) provides real headless Firefox + Chromium end-to-end input/output acceptance (`run-acceptance.js [browser] [mock|gemini]`, `run-acceptance-real.js [browser] [mock|gemini|sarvam]`; fake-mic capture → STT interim/final → audible reply → barge-in → cancel).
- **Not automated:** real-speech transcription quality on the physical microphone, audible listening judgement on real speakers, and browser behaviors outside Firefox/Chromium (Edge/Safari) still require manual QA.