// Voice Runtime FINAL — server STT (provider-independent).
//
// The browser NEVER recognizes speech. It only captures microphone audio
// (getUserMedia → PCM16 mono 24 kHz frames over the authenticated socket)
// and receives transcribed text back. This module owns STT credentials and
// provider selection; the client knows nothing about the provider.
//
// Session contract (mirrors the streaming TTS provider):
//   provider.createSession({ onInterim, onFinal, onError, onEnd, signal })
//     -> session.writeAudio({ audio, format, seq })
//     -> session.commit()      // finalize the current utterance
//     -> session.cancel(reason)
//     -> session.close()
//
// Socket events (server -> client):
//   voice:stt:started    { sessionId, format, limits }
//   voice:stt:interim    { sessionId, seq, text }        // UI preview only
//   voice:stt:final      { sessionId, seq, text, language?, languageConfidence? }
//   voice:stt:end        { sessionId }
//   voice:stt:error      { sessionId, code, message }
//   voice:stt:cancelled  { sessionId, reason }
//   voice:stt:speech:start { sessionId }                 // provider VAD (backstop barge-in)
//   voice:stt:speech:end   { sessionId }
//
// Socket events (client -> server):
//   voice:stt:start
//   voice:stt:audio      { sessionId, seq, format, audio: Buffer }
//   voice:stt:commit     { sessionId }
//   voice:stt:cancel     { sessionId, reason }
//   voice:stt:close      { sessionId }
//
// Explicit wire format — never inferred:
//   PCM signed 16-bit little-endian, mono, 24000 Hz.
//   Every audio frame carries sampleRate/channels/bitDepth/encoding/seq.
//
// Bounds (bounded memory, bounded pending work):
//   one active session per socket; 6 MB max buffered audio (~2 min),
//   120 s max duration, 120 max interim events, strict duplicate-commit
//   rejection, stale (seq/session) audio dropped and counted.
const { GoogleGenAI } = require("@google/genai");
const {
  buildVoiceContext,
  normalizeTranscript,
} = require("./transcriptNormalizer");

const STT_SESSION_FORMAT = Object.freeze({
  encoding: "pcm16",
  codec: "pcm_s16le",
  sampleRate: 24000,
  channels: 1,
  bitDepth: 16,
  endianness: "le",
});

// ---- Wire constants ----------------------------------------------------
const STT_MAX_SESSION_BYTES = 6_000_000; // ~2 min of 24k mono
const STT_MAX_SESSION_MS = 120_000;
const STT_MAX_INTERIMS = 120;
const STT_FRAME_BYTES = 4800; // 100 ms of 24k mono pcm16

const normalizeAudioBuffer = (audio) => {
  if (Buffer.isBuffer(audio)) return audio;
  if (ArrayBuffer.isView(audio)) {
    return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  }
  if (audio instanceof ArrayBuffer) return Buffer.from(audio);
  if (audio && audio.type === "Buffer" && Array.isArray(audio.data)) {
    return Buffer.from(audio.data);
  }
  if (Array.isArray(audio)) return Buffer.from(audio);
  return Buffer.alloc(0);
};

// ---- PCM helpers --------------------------------------------------------
const pcm16ToWavBuffer = (pcm, { sampleRate = 24000, channels = 1 } = {}) => {
  const body = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + body.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
};

// ---- Base session: accumulation, bounds, commit guard, metrics ----------
class BaseStreamingSttSession {
  constructor({
    onInterim = null,
    onFinal = null,
    onError = null,
    onCancel = null,
    onComplete = null,
    signal = null,
  } = {}) {
    this.onInterim = typeof onInterim === "function" ? onInterim : null;
    this.onFinal = typeof onFinal === "function" ? onFinal : null;
    this.onError = typeof onError === "function" ? onError : null;
    this.onCancel = typeof onCancel === "function" ? onCancel : null;
    this.onComplete = typeof onComplete === "function" ? onComplete : null;
    this.signal = signal || null;
    this.state = "active"; // active -> committing -> done
    this.buffer = Buffer.alloc(0);
    this.bytes = 0;
    this.startedAt = Date.now();
    this.interimCount = 0;
    this.finalDelivered = false;
    this._lastSeq = null;
    this.metrics = {
      framesReceived: 0,
      bytesReceived: 0,
      seqFaults: 0,
      dupSeq: 0,
      interims: 0,
    };
    if (signal && signal.addEventListener) {
      this._onAbort = () => this.cancel("aborted");
      signal.addEventListener("abort", this._onAbort, { once: true });
    }
  }

  _alive() {
    return this.state === "active" || this.state === "committing";
  }

  writeAudio({ audio = null, format = null, seq = null } = {}) {
    const buf = normalizeAudioBuffer(audio);
    this.metrics.framesReceived += 1;
    if (buf.length) this.metrics.bytesReceived += buf.length;
    if (!this._alive()) {
      this.metrics.seqFaults += 1;
      return false;
    }
    // Format gate: reject anything that is not the explicit contract.
    if (
      !format ||
      format.encoding !== "pcm16" ||
      Number(format.sampleRate) !== STT_SESSION_FORMAT.sampleRate ||
      Number(format.channels) !== STT_SESSION_FORMAT.channels
    ) {
      this.metrics.seqFaults += 1;
      const error = new Error("Unexpected audio format for this STT session.");
      error.code = "VOICE_STT_FORMAT";
      this._fail(error);
      return false;
    }
    const expectedSeq = this.metrics.framesReceived - 1;
    if (typeof seq === "number") {
      if (this._lastSeq !== null && seq <= this._lastSeq)
        this.metrics.dupSeq += 1;
      else if (this._lastSeq !== null && seq > this._lastSeq + 1)
        this.metrics.seqFaults += 1;
      this._lastSeq = seq;
    } else {
      this.metrics.seqFaults += 1;
    }
    if (!buf.length) return true;
    if (this.bytes + buf.length > STT_MAX_SESSION_BYTES) {
      this._fail(
        Object.assign(
          new Error("Voice session exceeded the maximum audio length."),
          { code: "VOICE_STT_OVERFLOW" },
        ),
      );
      return false;
    }
    if (Date.now() - this.startedAt > STT_MAX_SESSION_MS) {
      const error = new Error("Voice session exceeded the maximum duration.");
      error.code = "VOICE_STT_OVERFLOW";
      this._fail(error);
      return false;
    }
    this.buffer = Buffer.concat([this.buffer, buf]);
    this.bytes += buf.length;
    this._onAudio(buf);
    return true;
  }

  // Subclass hook: streaming providers transcribe partial tails here.
  _onAudio(buf) {} // eslint-disable-line no-unused-vars

  async commit() {
    if (this.state === "done" || this.finalDelivered)
      return { committed: false, text: null };
    if (this.state === "committing") return { committed: false, text: null };
    this.state = "committing";
    try {
      const text = await this._transcribe(this.buffer);
      this._finish(text);
      return { committed: true, text };
    } catch (err) {
      this._fail(err);
      return { committed: false, text: null };
    }
  }

  // Subclass hook: full-utterance transcription. Returns text (possibly '').
  async _transcribe(buffer) {
    // eslint-disable-line no-unused-vars
    return "";
  }

  cancel(reason = "cancelled") {
    if (!this._alive()) return;
    this.state = "done";
    this._teardown();
    try {
      this.onCancel?.({ reason });
    } catch {
      /* best effort */
    }
    try {
      this.onComplete?.({ cancelled: true, reason });
    } catch {
      /* best effort */
    }
  }

  close() {
    this.state = "done";
    this._teardown();
  }

  _finish(text, meta) {
    if (this.finalDelivered) return false;
    this.finalDelivered = true;
    this.state = "done";
    try {
      this.onFinal?.(String(text || "").trim(), meta || undefined);
    } catch {
      /* best effort */
    }
    try {
      this.onComplete?.({ final: true });
    } catch {
      /* best effort */
    }
    return true;
  }

  _fail(error) {
    if (this.state === "done") return;
    this.state = "done";
    const code = error?.code || "VOICE_STT_FAILED";
    try {
      this.onError?.(error || new Error("Voice transcription failed."));
    } catch {
      /* best effort */
    }
    try {
      this.onComplete?.({ error: true, code });
    } catch {
      /* best effort */
    }
  }

  _teardown() {
    this.buffer = Buffer.alloc(0);
    if (this.signal && this.signal.removeEventListener && this._onAbort) {
      this.signal.removeEventListener("abort", this._onAbort);
    }
  }
}

// ---- Mock provider (deterministic, pipeline/harness only) --------------
// Emits a predictable interim then a predictable final transcript the moment
// real microphone frames flow, so real-browser acceptance of the full
// capture → transport → STT → transcript pipeline is deterministic.
class MockSttSession extends BaseStreamingSttSession {
  constructor(options) {
    super(options);
    this.transcript =
      String(options?.transcript || "") || "Hello ARC, can you hear me?";
    this.interimA =
      this.transcript.length > 12
        ? `${this.transcript.slice(0, 12)}…`
        : `…${this.transcript}`;
  }

  _onAudio(buf) {
    if (this.interimCount === 0) {
      this.interimCount += 1;
      this._emitInterim(this.interimA);
    }
    if (this.bytes >= STT_FRAME_BYTES * 3 && this.interimCount === 1) {
      this.interimCount += 1;
      this._emitInterim(this.transcript);
    }
  }

  _emitInterim(text) {
    this.metrics.interims += 1;
    try {
      this.onInterim?.(text);
    } catch {
      /* best effort */
    }
  }

  async _transcribe() {
    return this.transcript;
  }
}

class MockSttProvider {
  constructor(options = {}) {
    this.kind = "mock";
    this.options = options;
  }
  createSession(options) {
    return new MockSttSession({ ...options, ...this.options });
  }
}

// ---- Gemini Live Transcription provider ---------------------------------
// The browser/socket contract stays 24 kHz. Gemini receives one 16 kHz PCM
// stream, resampled exactly once at this provider boundary.
const { resamplePcm16Mono } = require("./sarvamAudio");
const GEMINI_STT_MODEL = () =>
  process.env.GEMINI_STT_MODEL || "gemini-3.5-transcribe-live";
let geminiClient = null;
const getGeminiClient = () => {
  if (!process.env.GEMINI_API_KEY)
    throw new Error("Gemini STT is not configured (GEMINI_API_KEY missing).");
  if (!geminiClient)
    geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return geminiClient;
};

class GeminiSttSession extends BaseStreamingSttSession {
  constructor(options) {
    super(options);
    this.session = null;
    this.openPromise = null;
    this.sendChain = Promise.resolve();
    this.finalText = "";
    this.lastTranscript = "";
    this.detectedLanguage = null;
    this.commitWaitMs = Math.max(600, Number(options?.commitWaitMs) || 900);
    this.resolveCommit = null;
    this._speechStartEmitted = false;
  }

  _onAudio(buf) {
    if (!this._audioStartedLogged) {
      this._audioStartedLogged = true;
      console.log("[VoiceLatency] stt.firstAudioFrame bytes=%d", buf.length);
    }
    const pcm16 = resamplePcm16Mono(buf, STT_SESSION_FORMAT.sampleRate, 16000);
    if (!pcm16.length) return;
    this.sendChain = this.sendChain
      .then(async () => {
        const session = await this._open();
        if (this.state === "done") return;
        session.sendRealtimeInput({
          audio: {
            data: pcm16.toString("base64"),
            mimeType: "audio/pcm;rate=16000",
          },
        });
      })
      .catch((error) => this._fail(error));
  }

  async _open() {
    if (this.session) return this.session;
    if (this.openPromise) return this.openPromise;
    this.openPromise = getGeminiClient()
      .live.connect({
        model: GEMINI_STT_MODEL(),
        config: {
          responseModalities: ["TEXT"],
          // The installed Gemini Live SDK/API accepts the transcription
          // object, but not languageCodes on this endpoint. Leaving it empty
          // enables its native automatic language detection without causing
          // session setup to fail before any microphone audio is accepted.
          inputAudioTranscription: {},
        },
        callbacks: {
          onmessage: (message) => this._handleMessage(message),
          onerror: (event) =>
            this._fail(event?.error || new Error("Gemini Live STT failed.")),
          onclose: () => {
            if (this._alive() && this.state !== "committing")
              this._fail(new Error("Gemini Live STT connection closed."));
          },
        },
      })
      .then((session) => {
        this.session = session;
        return session;
      })
      .catch((error) => {
        this._fail(error);
        throw error;
      });
    return this.openPromise;
  }

  _handleMessage(message) {
    const transcription = message?.serverContent?.inputTranscription;
    if (transcription?.text) {
      const text = String(transcription.text).trim();
      console.log(
        "[VoiceLatency] stt.transcription finished=%s chars=%d",
        Boolean(transcription.finished),
        text.length,
      );
      const detectedLanguage =
        transcription.language ||
        transcription.languageCode ||
        message?.serverContent?.language;
      if (detectedLanguage)
        this.detectedLanguage = String(detectedLanguage).slice(0, 16);
      // Best-known transcript for the current turn. gemini-3.5-transcribe-live
      // streams interims (finished=false) and may never emit finished / a
      // turnComplete for a committed stream, so keep the freshest chunk as the
      // commit backstop — mirroring Sarvam's lastPartialText behavior — or a
      // committed turn would finalize empty and the client would discard it.
      this.lastTranscript = text;
      if (transcription.finished) {
        this.finalText = text;
        if (this.state === "committing")
          this._finish(
            this.finalText,
            this.detectedLanguage
              ? { language: this.detectedLanguage }
              : undefined,
          );
      } else if (
        this.state !== "done" &&
        this.interimCount < STT_MAX_INTERIMS
      ) {
        this.interimCount += 1;
        this.metrics.interims += 1;
        try {
          this.onInterim?.(text);
        } catch {
          /* best effort */
        }
      }
    }
    // Emit speech start/end events for client VAD backstop
    if (message?.serverContent?.inputTranscription && !this._speechStartEmitted) {
      this._speechStartEmitted = true;
      try { this.onSpeechStart?.(); } catch { /* best effort */ }
    }
    if (message?.serverContent?.turnComplete || message?.serverContent?.inputTranscription?.finished) {
      this._speechStartEmitted = false;
      try { this.onSpeechEnd?.(); } catch { /* best effort */ }
    }
    if (
      message?.serverContent?.turnComplete &&
      this.state === "committing" &&
      !this.finalDelivered
    ) {
      // Server-side end of turn: finalize with the authoritative text when the
      // provider delivered it, otherwise the freshest transcription chunk.
      this._finish(
        this.finalText || this.lastTranscript || "",
        this.detectedLanguage
          ? { language: this.detectedLanguage }
          : undefined,
      );
    }
  }

  async commit() {
    if (
      this.state === "done" ||
      this.finalDelivered ||
      this.state === "committing"
    )
      return { committed: false, text: null };
    this.state = "committing";
    try {
      const session = await this._open();
      await this.sendChain;
      session.sendRealtimeInput({ audioStreamEnd: true });
      await new Promise((resolve) => {
        this.resolveCommit = resolve;
        const timer = setTimeout(resolve, this.commitWaitMs);
        this._commitTimer = timer;
      });
      if (!this.finalDelivered) {
        // The provider never reported the turn as finished. Finalize with the
        // freshest transcription we actually received — never silently emit an
        // empty final for a turn that produced interims.
        this._finish(
          this.finalText || this.lastTranscript || "",
          this.detectedLanguage
            ? { language: this.detectedLanguage }
            : undefined,
        );
      }
      return {
        committed: true,
        text: this.finalText || this.lastTranscript || "",
      };
    } catch (error) {
      this._fail(error);
      return { committed: false, text: null };
    }
  }

  _finish(text, meta) {
    const result = super._finish(text, meta);
    if (result) {
      if (this._commitTimer) clearTimeout(this._commitTimer);
      this.resolveCommit?.();
      this.resolveCommit = null;
    }
    return result;
  }

  _teardown() {
    try {
      this.session?.close?.();
    } catch {
      /* best effort */
    }
    if (this._commitTimer) clearTimeout(this._commitTimer);
    super._teardown();
  }
}

class GeminiSttProvider {
  constructor() {
    this.kind = "gemini";
  }
  createSession(options) {
    return new GeminiSttSession(options);
  }
}

// ---- Selection -------------------------------------------------------------
// Unavailable marker truthfully advertises the state instead of failing late.
class UnavailableSttProvider {
  constructor() {
    this.kind = "unavailable";
  }
  createSession() {
    return {
      writeAudio() {
        return false;
      },
      commit: async () => false,
      cancel() {},
      close() {},
      metrics: {},
    };
  }
}

const selectStreamingSttProvider = ({ provider = null } = {}) => {
  const requested = String(
    provider ||
      process.env.VOICE_STT_PROVIDER ||
      process.env.STT_PROVIDER ||
      "gemini",
  )
    .trim()
    .toLowerCase();
  if (requested === "mock") return new MockSttProvider();
  if (requested === "sarvam") {
    // Lazily imported: sarvamProvider consumes STT constants above, and this
    // module is the coordinator surface, so the cycle is broken at runtime.
    const sarvamProvider = require("./sarvamProvider");
    if (sarvamProvider.isSarvamConfigured())
      return new sarvamProvider.SarvamRealtimeSttProvider();
    // Sensible fallback: without a Sarvam key we degrade to Gemini (clearly
    // "unavailable" only if neither provider is configured).
    if (process.env.GEMINI_API_KEY) return new GeminiSttProvider();
  }
  if (requested === "gemini" && process.env.GEMINI_API_KEY)
    return new GeminiSttProvider();
  return new UnavailableSttProvider();
};

const isServerSttActive = () => {
  const requested = String(
    process.env.VOICE_STT_PROVIDER || process.env.STT_PROVIDER || "gemini",
  )
    .trim()
    .toLowerCase();
  if (requested === "mock") return true;
  if (requested === "sarvam") {
    const sarvamProvider = require("./sarvamProvider");
    if (sarvamProvider.isSarvamConfigured()) return true;
    return Boolean(process.env.GEMINI_API_KEY);
  }
  if (requested === "gemini") return Boolean(process.env.GEMINI_API_KEY);
  return false;
};

const getConfig = () => {
  const provider = String(
    process.env.VOICE_STT_PROVIDER || process.env.STT_PROVIDER || "gemini",
  )
    .trim()
    .toLowerCase();
  const kind =
    provider === "mock"
      ? "mock"
      : isServerSttActive()
        ? provider === "gemini"
          ? "gemini"
          : "sarvam"
        : null;
  return {
    available: isServerSttActive(),
    provider: kind,
    format: STT_SESSION_FORMAT,
    limits: { maxBytes: STT_MAX_SESSION_BYTES, maxMs: STT_MAX_SESSION_MS },
    events: [
      "voice:stt:started",
      "voice:stt:interim",
      "voice:stt:final",
      "voice:stt:end",
      "voice:stt:error",
      "voice:stt:cancelled",
      "voice:stt:speech:start",
      "voice:stt:speech:end",
    ],
    usesBrowserSpeechRecognition: false,
    normalization: true,
    safety: { destructiveCommandsRequireConfirmation: true },
  };
};

// ---- Socket coordinator -----------------------------------------------------
// One active STT session per socket (bounded). Mirrors VoiceTtsStreamer's
// shape: it owns the socket emissions, never the recording content.
class VoiceSttSession {
  constructor({ socket, provider = null, limits = {}, context = null } = {}) {
    this.socket = socket;
    this.provider = provider || selectStreamingSttProvider();
    this.session = null;
    this.sessionId = null;
    this.finalSeq = 0;
    this.interimSeq = 0;
    this.closed = false;
    // Voice latency timeline (elapsed/absolute ms only — never audio or text).
    this.speechStartAt = null;
    this.lastSpeechEndAt = null;
    this.finalAt = null;
    // Domain/workspace vocabulary for the recognizer + the normalization layer.
    // Bounded, deterministic, provider-independent; caller may inject context.
    this.voiceContext =
      context && Array.isArray(context?.terms) ? context : buildVoiceContext();
  }

  open() {
    if (this.closed) return null;
    // Bound: never run two STT sessions on one socket.
    if (this.session) this.session.cancel("superseded");
    this.sessionId = `stt_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
    this.finalSeq = 0;
    this.interimSeq = 0;
    this._speechStartEmitted = false;
    // `provider` may be a concrete provider instance, else env-selected.
    const provider =
      this.provider && typeof this.provider.createSession === "function"
        ? this.provider
        : selectStreamingSttProvider();
    if (provider.kind === "unavailable") {
      try {
        this.socket.emit("voice:stt:error", {
          sessionId: this.sessionId,
          code: "VOICE_STT_UNAVAILABLE",
          message:
            "Server voice transcription is not configured. You can still type your message.",
        });
      } catch {
        /* best effort */
      }
      this.session = null;
      return null;
    }
    this.session = provider.createSession({
      vocabulary: this.voiceContext.hints || this.voiceContext.terms || [],
      onInterim: (text) => {
        if (this.closed) return;
        this.interimSeq += 1;
        try {
          this.socket.emit("voice:stt:interim", {
            sessionId: this.sessionId,
            seq: this.interimSeq,
            text: String(text || ""),
          });
        } catch {
          /* best effort */
        }
      },
      onFinal: (text, meta = {}) => {
        if (this.closed) return;
        this.finalSeq += 1;
        this.finalAt = Date.now();
        try {
          // T1 marker: transcript.final received by ARC (speech_end → final
          // tail latency. Deltas computed vs the stamped session fields).
          console.log(
            "[VoiceLatency] stt.final at=%d afterSpeechEndMs=%d",
            this.finalAt,
            this.lastSpeechEndAt ? this.finalAt - this.lastSpeechEndAt : null,
          );
        } catch {
          /* telemetry must never break delivery */
        }
        const normalized = normalizeTranscript(text, this.voiceContext);
        const payload = {
          sessionId: this.sessionId,
          seq: this.finalSeq,
          text: normalized.text,
          rawText: normalized.rawText,
          corrections: normalized.corrections,
          needsClarification: normalized.needsClarification,
          lowConfidence: normalized.lowConfidence,
          destructive: normalized.destructive,
          reason: normalized.reason,
        };
        if (meta && typeof meta === "object") {
          // Sarvam reports a per-utterance language when language_code=auto.
          // Nullable and additive: only present when the provider detects it.
          if (typeof meta.language === "string" && meta.language) {
            payload.language = String(meta.language).slice(0, 16);
            payload.languageConfidence =
              typeof meta.languageConfidence === "number"
                ? Math.max(0, Math.min(1, meta.languageConfidence))
                : null;
          }
        }
        try {
          this.socket.emit("voice:stt:final", payload);
        } catch {
          /* best effort */
        }
      },
      onSpeechStart: () => {
        if (this.closed) return;
        this.speechStartAt = Date.now();
        try {
          this.socket.emit("voice:stt:speech:start", {
            sessionId: this.sessionId,
          });
        } catch {
          /* best effort */
        }
      },
      onSpeechEnd: () => {
        if (this.closed) return;
        this.lastSpeechEndAt = Date.now();
        try {
          // T0 marker: VAD detected the speaker stopped (URGENT for the STT
          // tail — commit should follow closely behind).
          console.log(
            "[VoiceLatency] stt.speechEnd at=%d",
            this.lastSpeechEndAt,
          );
        } catch {
          /* telemetry must never break delivery */
        }
        try {
          this.socket.emit("voice:stt:speech:end", {
            sessionId: this.sessionId,
          });
        } catch {
          /* best effort */
        }
      },
      onError: (error) => {
        if (this.closed) return;
        try {
          this.socket.emit("voice:stt:error", {
            sessionId: this.sessionId,
            code: String(error?.code || "VOICE_STT_FAILED"),
            message: String(
              error?.message || "Voice transcription failed.",
            ).slice(0, 300),
          });
          this.session = null;
        } catch {
          /* best effort */
        }
      },
      onCancel: (info) => {
        if (this.closed) return;
        try {
          this.socket.emit("voice:stt:cancelled", {
            sessionId: this.sessionId,
            reason: info?.reason || "cancelled",
          });
        } catch {
          /* best effort */
        }
        this.session = null;
      },
      onComplete: (info) => {
        if (this.closed) return;
        if (!info?.cancelled && !info?.error) {
          try {
            this.socket.emit("voice:stt:end", { sessionId: this.sessionId });
          } catch {
            /* best effort */
          }
        }
      },
    });
    try {
      this.socket.emit("voice:stt:started", {
        sessionId: this.sessionId,
        format: STT_SESSION_FORMAT,
        limits: { maxBytes: STT_MAX_SESSION_BYTES, maxMs: STT_MAX_SESSION_MS },
        usesBrowserSpeechRecognition: false,
      });
    } catch {
      /* best effort */
    }
    return this.sessionId;
  }

  handleAudio(payload = {}) {
    if (!this.session || !payload || payload.sessionId !== this.sessionId) {
      try {
        this.socket.emit("voice:stt:error", {
          sessionId: payload?.sessionId || null,
          code: "VOICE_STT_STALE",
          message: "Voice session is not active.",
        });
      } catch {
        /* best effort */
      }
      return false;
    }
    return this.session.writeAudio({
      audio: payload.audio,
      format: payload.format,
      seq: payload.seq,
    });
  }

  commit() {
    if (!this.session) return false;
    return this.session.commit();
  }

  cancel(reason = "cancelled") {
    if (!this.session || this.closed) return;
    const session = this.session;
    this.session = null;
    session.cancel(reason);
  }

  close() {
    this.closed = true;
    if (this.session) {
      const session = this.session;
      this.session = null;
      session.close();
    }
  }
}

// Per-socket wiring. No browser-name logic, no shared mutable state.
// Accepts an optional explicit provider (tests/harness); production uses
// env-driven selection.
const bindSocket = (socket, { provider = null, context = null } = {}) => {
  const coordinator = new VoiceSttSession({ socket, provider, context });
  socket.sttSession = coordinator;

  socket.on("voice:stt:start", () => {
    try {
      coordinator.open();
    } catch (err) {
      try {
        socket.emit("voice:stt:error", {
          code: "VOICE_STT_FAILED",
          message: String(err?.message || "Voice session failed.").slice(
            0,
            200,
          ),
        });
      } catch {
        /* best effort */
      }
    }
  });

  socket.on("voice:stt:audio", (payload, ack = null) => {
    try {
      const accepted = coordinator.handleAudio(payload);
      if (typeof ack === "function") {
        ack({
          accepted: Boolean(accepted),
          bytes: normalizeAudioBuffer(payload?.audio).length,
        });
      }
    } catch {
      if (typeof ack === "function")
        ack({ accepted: false, bytes: 0, code: "VOICE_STT_FAILED" });
      /* best effort */
    }
  });

  socket.on("voice:stt:commit", (payload) => {
    try {
      coordinator.commit();
    } catch {
      /* best effort */
    }
    const _ = payload;
  });

  socket.on("voice:stt:cancel", (payload) => {
    try {
      coordinator.cancel(payload?.reason || "user cancel");
    } catch {
      /* best effort */
    }
  });

  socket.on("voice:stt:close", () => {
    try {
      coordinator.close();
    } catch {
      /* best effort */
    }
  });

  return coordinator;
};

module.exports = {
  STT_SESSION_FORMAT,
  STT_MAX_SESSION_BYTES,
  STT_MAX_SESSION_MS,
  STT_MAX_INTERIMS,
  STT_FRAME_BYTES,
  normalizeAudioBuffer,
  pcm16ToWavBuffer,
  BaseStreamingSttSession,
  MockSttProvider,
  GeminiSttProvider,
  GeminiSttSession,
  selectStreamingSttProvider,
  isServerSttActive,
  getConfig,
  VoiceSttSession,
  bindSocket,
};
