# ARC-AI Voice Runtime 4.0 — Research & Design Decisions

This document records the provider research and the architecture decisions for the
conversational voice runtime (STT input + TTS output). It explains **why** the
runtime is shaped the way it is, what was rejected, and which assumptions/limits
the implementation deliberately carries. It pairs with `docs/advanced-voice.md`,
which describes the implementation as it exists in code.

---

## 1. Chosen architecture (summary)

- **Transport:** the existing authenticated Socket.IO WebSocket connection, with
  binary PCM payloads. No WebRTC peer, no second connection.
- **Input (STT):** the browser captures microphone frames with `getUserMedia` →
  an input `AudioWorklet` resamples to **PCM16-LE mono 24 kHz**, emits 100 ms
  frames (`seq` + explicit `format`), streams them to the server over
  `voice:stt:start/audio/commit/cancel`. The server owns transcription
  (`server/services/sttService.js` → Sarvam realtime, Gemini unary fallback).
  The browser **never** recognizes speech.
- **Output (TTS):** the model reply is chunked into semantic sentences
  server-side; each chunk is synthesized to PCM16 (Sarvam `bulbul:v3` streaming
  TTS, Gemini speech fallback) and streamed
  back over `voice:tts:start/audio/end/error/cancel` to a playback
  `AudioWorklet` (`VoiceAudioEngine`) with pre-roll buffering. Browser
  `speechSynthesis` is fallback-only.
- **Turn-taking:** client-side VAD on the mic graph (RMS thresholds) +
  trailing-silence `commit`, plus barge-in (sustained speech while ARC speaks
  cancels STT + TTS). One STT session per socket, strict bounds (6 MB / 120 s /
  120 interims).
- **Robustness:** deterministic correction/vocabulary layer (§4) and
  confirmation-gating of destructive commands (§5) live server-side, so the
  client stays thin and every browser behaves identically.

---

## 2. Provider research (as of this writing)

### 2.1 Speech-to-text landscape

| Option | Verdict | Reason |
| --- | --- | --- |
| Browser `SpeechRecognition` (webkit/Chrome) | **Rejected** — not on the critical path | Vendor-specific, Firefox/Safari inconsistent, no server visibility/audit, cannot feed the same transcript into ARC's tool layer; also disallowed by spec ("never uses browser speech recognition"). |
| **Gemini transcription (`generateContent`/unary)** | **Chosen (fallback)** | `gemini-3.5-transcribe` is the current unary model for recorded audio (Interactions/Files API). Kept as the streaming provider's fallback; env key already present. |
| **Sarvam realtime STT (`saaras:v3-realtime`)** | **Chosen (default primary, realtime)** | Native WebSocket, PCM16-LE 16 kHz in, `stream_type=fast` incremental interims + authoritative finals, built-in VAD `speech_start/end` events routed as `voice:stt:speech:start/end`, and per-final `language` + `language_confidence` (auto-detection; the one provider confidence signal we feed the client). Requires `SARVAM_API_KEY`; server resamples the client's 24 kHz frames to 16 kHz on the wire. |
| Gemini Live API (`gemini-3.5-transcribe-live`) | **Documented / future path** | Sub-second streaming interims, `interim_input_transcription` + finalized `input_transcription`, built-in `custom_vocabulary` (up to 1,000 terms), automatic activity detection, 10-minute sessions, 85+ languages. Live API is Chrome/Edge-aligned and bidirectional over WebSockets; Firefox/Safari support is weaker, so it is not the default transport today. Runs server-to-server (our design) or client-to-server with ephemeral tokens. |
| Deepgram Nova / AssemblyAI / Azure Speech | Rejected (for now) | Additional credentials + a second server-side integration with no capability the chosen provider lacks for this scope; documented as a clean provider seam. |
| Local (Whisper.cpp / Vosk) | Rejected | CPU/RAM cost on the ARC host, model maintenance, and no meaningful latency win for a conversational voice runtime on this hardware. |

**Key Gemini STT facts used in the design:**

- `gemini-3.5-transcribe` (unary, up to 1 hour) supports `custom_vocabulary`
  (≤ 1,000 terms) and 85+ languages with auto-detection. File processing with
  diarization/timestamps is limited to 30 minutes.
- `gemini-3.5-transcribe-live` (Live API) provides incremental
  `interim_input_transcription` and authoritative `input_transcription`
  per turn, `mode: VERBATIM | SMART`, and `custom_vocabulary`.
- The current provider path (`GeminiProvider.transcribeAudio`) uses
  `generateContent` with the ordinary chat model and returns text only — **no
  confidence scores or word alternatives**. Our correction layer (§4) therefore
  cannot rely on provider confidence; it computes its own heuristic confidence
  from vocabulary edit-distance and gates destructive commands on it.

**Key Sarvam STT facts used in the design:**

- Transport is a plain WebSocket (`wss://api.sarvam.ai/speech-to-text-realtime/ws`)
  authenticated by the `api-subscription-key` header; the server holds the key,
  the client never sees it. Audio is base64 PCM16-LE mono **16 kHz** (the server
  resamples the 24 kHz client frames; the 100 ms→4800-byte mapping is tested).
- `stream_type=fast` yields interim `transcript.partial` + authoritative
  `transcript.final`; `endpointing=vad` delivers `vad.speech_start` /
  `vad.speech_end` which the coordinator surfaces as
  `voice:stt:speech:start/end` (the client uses speech:start as a backup
  barge-in signal). `language_code=auto` returns `language` +
  `language_confidence` per final; VAD control maps to
  `SARVAM_STT_SILENCE_MS`/`SARVAM_STT_MIN_SPEECH_MS`.
- Server errors normalize to `SARVAM_AUTH_ERROR` (invalid/expired key),
  `SARVAM_QUOTA_ERROR`, `SARVAM_RATE_LIMIT`, `SARVAM_CONNECTION_ERROR`,
  `SARVAM_STT_ERROR`, `SARVAM_UNSUPPORTED_LANGUAGE`, `SARVAM_INVALID_AUDIO`;
  wire-format violations on the client path keep the legacy
  `VOICE_STT_FORMAT`/`VOICE_STT_OVERFLOW` codes the client already handles.

### 2.2 Text-to-speech landscape

| Option | Verdict | Reason |
| --- | --- | --- |
| **Server Gemini speech → PCM16 over socket** | **Chosen (fallback)** | Speech synthesis on the ARC server keeps voices consistent and auditable; browser `speechSynthesis` is an OS-dependent fallback only. |
| **Sarvam streaming TTS (`bulbul:v3`)** | **Chosen (default primary)** | Config-first WebSocket (`speaker`, `language_code`, linear16, 24 kHz, buffer cadence); text/flush per semantic segment; output is PCM16 24 kHz mono — the exact contract the VoiceAudioEngine renders, so nothing changes on the client wire. One ongoing session per response, reused across segments. |
| Gemini 3.1 streaming TTS (`gemini-3.1-flash-tts-preview`, Interactions API / Cloud TTS streaming `synthesize`, `stream: true`) | Documented / future path | Streaming TTS is supported for TTS models from 3.1; output is PCM 24 kHz mono, matching the runtime's `STT_SESSION_FORMAT`/`VOICE_AUDIO_FORMAT`. If Sarvam latency/coverage becomes a bottleneck, this is a drop-in upgrade at the `VoiceTtsProvider` seam. |
| Gemini 2.5 TTS (`gemini-2.5-flash-preview-tts`) | **Deprecated (current code path)** | Gemini 2.5 models are scheduled for shutdown **October 2026**. The current `ttsService` still emits this model; switching the default to a 3.1 streaming model is a provider-config change, not an architecture change. |

**Key Gemini TTS facts used in the design:**

- Streaming TTS is supported only on TTS models from version 3.1
  (`gemini-3.1-flash-tts-preview`); older flash TTS models are unary.
- Audio output is PCM16 24 kHz mono — the exact contract the VoiceAudioEngine
  renders, so a moving to streaming TTS later changes nothing on the wire.

**Key Sarvam TTS facts used in the design:**

- Transport is a plain WebSocket (`wss://api.sarvam.ai/text-to-speech/ws`)
  authenticated by the `api-subscription-key` header; the first message is the
  `config` (speaker `shubh`, `language_code`, linear16, 24 kHz), then `text` +
  `flush` per segment, and the session stays open across all semantic segments
  of one reply (connection reuse). Server replies carry `type: audio` (payloads
  nested under `data.audio`) and a `type: event` with `event_type: final`.
- Language is **deterministic**: only `bn-IN en-IN gu-IN hi-IN kn-IN ml-IN mr-IN
  od-IN pa-IN ta-IN te-IN` are accepted; the STT-detected language is mapped (so
  `or-IN`→`od-IN`) and anything unsupported falls back to `en-IN`, so the
  streamer never sends a Bulbul-rejected code.
- The streamer has no in-band barge-in cancel; barge-in closes the session
  (`SARVAM_TTS_ERROR` suppressed as an `AbortError`) which is why barge-in
  latency stays server-side transport-bound.

### 2.3 Browser primitives research

- `AudioWorklet` (input + output graphs) is supported in Firefox, Chromium,
  Safari, and Edge; the runtime's worklet files are loaded both as static
  scripts and as blob URLs, and `voiceCapabilities` feature-detects without
  user-agent sniffing.
- `AudioContext` autoplay policy: creation must follow a user gesture. The
  mic-toggle press and the "Enable voice" dock pill both call
  `ensureFromGesture`/`ensureAudioFromGesture`, and `useVoiceTtsChannel`
  surfaces `audioBlocked` truthfully when the browser refuses.
- `getUserMedia` tracks stay live across the whole voice session (Single
  getUserMedia), with the transport merely pausing framing — that is what makes
  barge-in possible while ARC speaks and mute behavior independent of the
  session.

---

## 3. Rejected alternatives (detail)

1. **WebRTC for mic → server:** adds a peer-connection with ICE/STUN state and a
   second path to secure. The Socket.IO binary frame channel gives the same
   upload at this scale with the auth/session guarantees already in place and is
   trivially bounded/testable.
2. **Client-to-server Gemini Live API:** attractive latency, but (a) Chrome/Edge
   bias vs. our Firefox/Chromium/Safari/Edge matrix, (b) exposes provider policy
   decisions to the client, (c) requires ephemeral-token plumbing and still
   leaves turn-taking to us. Our server-side seam can adopt it later without a
   client change.
3. **Server speech for the whole reply before streaming:** first-byte latency
   grows with reply length; streaming semantic chunks gives earlier audio and
   barge-in responsiveness. Rejected.
4. **Local audio queues with `setTimeout` pacing:** jitter and underruns. A
   worklet ring buffer with pre-roll is the stable approach (existing engine).

---

## 4. Contextual STT correction & vocabulary (implementation notes)

- `server/services/transcriptNormalizer.js` implements `buildVoiceContext` and
  `normalizeTranscript` (pure, deterministic).
- Vocabulary is assembled from the tool registry (tool names/phrases), MCP/API
  server names, workspace-aware terms, and a curated technical domain list
  (e.g. "GitHub", "Linear", "Notion", "React", "MongoDB", "WhatsApp", "ARC"),
  bounded to keep the STT prompt and edit-distance work cheap.
- `normalizeTranscript` corrects near-miss tokens by edit distance against the
  vocabulary and returns `{ text, rawText, corrections, needsClarification,
  destructive }`. Because the current provider returns no confidence, the
  heuristics (distance/length → confidence) are the authoritative "low
  confidence" signal.
- The server emits `voice:stt:final` with the normalized `text` **plus**
  `rawText`, `corrections`, `needsClarification`, and `destructive`, so the UI
  can show exactly what changed and gate destructive commands.

---

## 5. Destructive-command safety (implementation notes)

- Destructive verbs (`delete`, `remove`, `clear`, `reset`, `shut[down]`,
  `revoke`, `terminate`, `kill`, `wipe`, `cancel` against named resources …)
  are detected together with their target resource (conversation, memory,
  repository, workspace, database, token, email, calendar, file, account).
- **Rule:** a destructive command always sets `needsClarification`, so the
  client presents an explicit Confirm/Cancel before the transcript is submitted
  to ARC's tool layer. Low-confidence edits on the destructive target raise the
  bar higher (confirmation text shows the original raw transcript).
- Non-destructive low-confidence transcripts are flagged (`needsClarification`)
  but may be auto-submitted after user confirmation in the same dock flow.

---

## 6. Known limitations (accepted)

- **Transcript confidence is heuristic for both providers** — Gemini returns no
  confidence at all; Sarvam returns `language_confidence` (worst/last-final) but
  no per-word alternative scores. Correction confidence remains edit-distance
  based; the Sarvam `language`/`language_confidence` is surfaced to the client
  and used to pick the reply language, never to gate commands.
- **Half-duplex turn flow** for interims; continuous Live-API-style full-duplex
  is a documented next step, not part of this delivery.
- **One STT session per socket, 6 MB / 120 s** capture cap per utterance —
  adequate for command-style conversation, bounded by design.
- **Sarvam TTS supports 11 Indian languages**; other locales fall back to (or
  are transcribed in) `en-IN`. English remains the out-of-the-box voice.
- **Streaming TTS default is now Sarvam `bulbul:v3`**; the legacy Gemini 2.5
  path (`gemini-2.5-flash-preview-tts`) remains and its October 2026 deprecation
  is unchanged. The provider seam (`VoiceTtsProvider`) is structured so the
  default can switch again without touching transport or rendering.
- **Live/custom-vocabulary STT gains** (smoothed interims, provider-native
  vocabulary bias) are not exercised today because neither chosen path has a
  `custom_vocabulary` knob that reliably improves short utterances; the
  deterministic normalizer covers the gap.
- Real-provider acceptance depends on `SARVAM_API_KEY` (primary) or
  `GEMINI_API_KEY` (fallback) present in `server/.env`; the deterministic mock
  provider covers pipeline acceptance everywhere.