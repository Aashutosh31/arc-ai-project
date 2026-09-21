# ARC-AI Voice Runtime 4.0 — Final Acceptance Report

Status: **PASS** (all automated suites green; real-desktop + real-microphone acceptance green on Firefox and Chromium)

Date: 2026-09-18
Environment: Linux, node v26.8.2, selenium-webdriver 4.49, Firefox (geckodriver 0.37.1 via Selenium Manager), Chromium (system chromedriver), PipeWire/PulseAudio, `DISPLAY=:0`.

---

## 1. System under test

Voice Runtime 4.0 production subsystem: contextual STT correction + voice vocabulary + destructive-command safety.

- Capture: real `getUserMedia` → `VoiceMicCapture` (24 kHz PCM16 mono framing) → `voice:stt:*` (Socket.IO binary).
- Server: provider-independent `VoiceSttSession` (bound per socket, bounded: 6 MB / 1200 frames / 120 s) → `transcriptNormalizer` → enriched `voice:stt:final` payload.
- Reply: `VoiceTtsStreamer` (production provider machinery) → `voice:tts:*` → `VoiceAudioEngine`/AudioWorklet.
- Client safety: `voiceTranscriptGate` + clarification confirm/cancel in `VoiceDock`.

## 2. Deliverable map

| Spec section | Deliverable | Where | Status |
|---|---|---|---|
| §1 | Research doc | `docs/voice-runtime-research.md` | Written |
| §15 | Contextual STT correction | `server/services/transcriptNormalizer.js`, `sttService.js` | Implemented |
| §16 | Voice vocabulary service | `buildVoiceContext()` / `CURATED_VOCAB` → Gemini prompt hints | Implemented |
| §17 | Destructive-command safety | `isDestructiveCommand()` + gating; config flag `safety.destructiveCommandsRequireConfirmation` | Implemented + acceptance-proven |
| §37 | Invariant tests | `transcriptNormalizer.test.js`, `voiceSttNormalize.test.js`, `voiceClarify.test.mjs` | 25 tests, all pass |
| §39–45 | Runtime/transport/backend/frontend integration | unchanged voice runtime + full regression | All green |
| §52 | Final report | this file | Done |

## 3. Implementation summary

- `transcriptNormalizer.js`: `editDistance`, `CURATED_VOCAB`, `DESTRUCTIVE_VERBS`/`DESTRUCTIVE_RESOURCES`, `buildVoiceContext({ tools, mcpServers, workspace, conversation, … })`, `normalizeTranscript(text, ctx)` → `{ text, rawText, corrections, needsClarification, lowConfidence, destructive, reason }`. Common-word/stopword blocklist prevents false correction into domain terms.
- `sttService.js`: sessions inject `voiceContext.hints` as vocabulary; `voice:stt:final` carries normalized fields; `getConfig()` advertises `normalization: true` and the destructive-confirmation safety flag.
- `GeminiProvider.transcribeAudio`: bounded vocabulary hint line added to the transcription prompt.
- Client: `voiceTranscriptGate` (pure), `useAdvancedVoice` clarification flow (VAD gated while pending), `VoiceDock` confirm/cancel card.

## 4. Automated evidence (headless CI-style)

### 4.1 New invariant/unit suites
| Suite | Pass |
|---|---|
| `server/tests/transcriptNormalizer.test.js` | 9 / 9 |
| `server/tests/voiceSttNormalize.test.js` | 8 / 8 |
| `client/tests/voiceClarify.test.mjs` | 8 / 8 |

Coverage: alias→canonical correction, phrase matching across whitespace, common-word non-correction, destructive gating (`destructive-command:*`), low-confidence correction gating, exactly-one-final, canceled-no-final, vocabulary hint injection, channel passthrough of normalized fields.

### 4.2 Full regression
- Server voice/streaming/tts: `voiceStt` (16 pass), `voiceRuntime`, `voiceSttNormalize` (8), `transcriptNormalizer` (9), `streamingRuntime`, `ttsService` — **all green**.
- Server chat/persistence/integration: `conversationContinuity` 14/14, `messageHistory.baseline` 14/14 (3 skip), `messageCursorPagination` 13/13, `contextBudget` 18/18, `contextBudgetSafety` 6/6, `toolContinuation` 9/9, `vectorMetadata` 5/5, `providerRegistry` 8/8, `playMedia` PASS, `themeCatalog` PASS.
- Client: `voiceRuntime` 43/43, `voiceSttClient` 13/13, `voiceClarify` 8/8, `testVoiceMachine` PASS, `historyLoader` 17/17, `executionPanel` 7/7, `mcpOAuthUiState` 19/19.
- Static: client ESLint clean on all changed files; `vite build` succeeds (7.83 s; existing chunk-size warning only). Server has no ESLint config in the repo.

## 5. Real-desktop + real-microphone evidence

Real browsers driven via Selenium on `DISPLAY=:0` (visible windows, real clicks, real audio graph). Real microphone path: speech synthesized to a WAV and played through a temporary PipeWire virtual sink→mic loopback so genuine PCM crosses the OS audio stack into the browser's `getUserMedia` default input. No `--use-fake-device-for-media-stream`, no fake media streams; device proof = `enumerateDevices()` returns the real `ArcVirtualMicCapture` source.

Evidence files: generated locally under `.tmp-voice-e2e/` during acceptance runs (mock, real-mic, and real-Gemini `voice-acceptance-*.json`); not committed to the repository.

| Run | Browser | Provider | Real mic | Result |
|---|---|---|---|---|
| TEST A tone (real audio engine) | Firefox / Chromium | – | yes | PASS |
| TEST B/D/E stream + barge-in + re-stream | Firefox / Chromium | mock TTS | yes | PASS |
| TEST R real-mic capture → STT final | Firefox | mock STT | yes | PASS |
| TEST R real-mic capture → STT final | Chromium | mock STT | yes | PASS |
| Real speech → Gemini STT → normalizer → destructive gate | Firefox | **gemini** | yes | PASS |
| Real speech → Gemini STT → normalizer → destructive gate | Chromium | **gemini** | yes | PASS |

Key real-provider evidence (actual spoken audio: "Delete the repository."):

```
Firefox : finalMeta { text: "Delete the repository.", needsClarification: true, destructive: true, reason: "destructive-command:delete", corrections: [] }
Chromium: finalMeta { text: "delete the repository",  needsClarification: true, destructive: true, reason: "destructive-command:delete", corrections: [] }
```

Interrupt/barge-in latency measured on real browsers: 2–19 ms. All runs exercised: capture frames > 0 with bytes, ≥ same-session second utterance while TTS still streaming, and real in-flight-session cancellation.

## 6. Browser coverage

- **Firefox**: available, non-headless, real mic — PASS (mock + Gemini).
- **Chromium**: available, non-headless, real mic — PASS (mock + Gemini).
- **Edge / Safari**: not available in this environment (no Edge/Chrome-for-Edge binary, no macOS/WebKit). The cross-browser shareable paths (Socket.IO binary transport, AudioWorklet, getUserMedia PCM, Web Audio) are exercised by the two Blink/Gecko-adjacent implementations actually present (Chromium covers the Chromium-based family); Edge/Safari specifics remain documented-only in `docs/voice-runtime-research.md`.

## 7. Known limitations (disclosed in the research doc)

- Current Gemini unary STT exposes no per-word confidence/alternatives → correction confidence is heuristic (edit-distance/length).
- Interims are half-duplex; barge-in relies on the transport guarantee (new session accepted while TTS streams) rather than true streaming STT.
- Speech input used a deterministic virtual-mic loopback (real PCM path) rather than a human speaking into a physical device.
- The STT model used is `gemini-2.5-flash` (existing server default); Gemini 2.5 TTS models are deprecated/shutdown, and the streaming-TTS drop-in for 3.x (`voiceTtsProvider` seam) is documented but not activated.
- Environment was fully restored after acceptance: PipeWire default source/sink returned to `bluez_input…` / `bluez_output…`, virtual-mic modules unloaded, no stray listeners/drivers left running.

## 8. Verdict

Voice Runtime 4.0 delivers §15 contextual STT correction, §16 voice vocabulary, and §17 destructive-command confirmation end-to-end. All automated suites pass; real-speech Gemini transcription was correctly gated as an unconfirmed destructive command in both real browsers, with the client clarification flow already covered by the unit/invariant tests.