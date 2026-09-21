// Server-side text-to-speech (opt-in) for browser-agnostic voice output.
//
// Architecture:
//   LLM chunk stream → TtsStreamBuffer → sentence/phrase boundary detection
//   → Gemini TTS per segment → `ai:tts:audio` socket events (base64 WAV)
//   → client audio queue → standard HTMLAudioElement playback.
//
// The browser only needs standard audio playback — no speechSynthesis voices
// required. When server TTS is disabled (default) or unavailable, the client
// keeps its existing browser speechSynthesis path unchanged.
//
// Env:
//   VOICE_TTS_PROVIDER=gemini (default) | sarvam | browser
//   GEMINI_TTS_MODEL=gemini-3.1-flash-tts-preview
//   GEMINI_TTS_VOICE=Kore
//   SARVAM_API_KEY + SARVAM_TTS_MODEL/SARVAM_TTS_SPEAKER (sarvam mode)
// Never logs keys, audio, or message text.
const { GoogleGenAI } = require("@google/genai");
const { toWellFormedUnicode } = require("../lib/llm/utils");
const { TTS_FALLBACK } = require("./sarvamLanguage");
const { pronunciationNormalize } = require("./speechNormalize");

const getTtsMode = () =>
  String(process.env.VOICE_TTS_PROVIDER || process.env.TTS_PROVIDER || "gemini")
    .trim()
    .toLowerCase();

// "Will the selected mode produce speech right now?" Mirrors the provider
// fallback chain in voiceTtsProvider.selectStreamingProvider so the client
// config and the runtime never disagree: sarvam → gemini → unavailable.
const isServerTtsActive = () => {
  const mode = getTtsMode();
  if (mode === "gemini") return Boolean(process.env.GEMINI_API_KEY);
  if (mode === "sarvam") {
    if (process.env.SARVAM_API_KEY) return true;
    // Degraded fallback (no Sarvam key): truthful Gemini, else off.
    return Boolean(process.env.GEMINI_API_KEY);
  }
  return false;
};

// The Gemini TTS model is mode-independent: it is what synthesizeSegment uses
// whenever a Gemini client does the synthesis. Keeping it separate prevents
// the Sarvam model (e.g. bulbul:v3) from leaking into Gemini requests when
// TTS_PROVIDER=sarvam but synthesis degrades to Gemini without a Sarvam key.
const getGeminiTtsModel = () =>
  process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview";

const getGeminiTtsVoice = () => process.env.GEMINI_TTS_VOICE || "Kore";

const getDefaultTtsLanguage = () => {
  const mode = getTtsMode();
  if (mode === "sarvam" && process.env.SARVAM_API_KEY) return TTS_FALLBACK;
  return "en-US";
};

let cachedClient = null;
const getClient = () => {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Server TTS is not configured (GEMINI_API_KEY missing).");
  }
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return cachedClient;
};

// Strip markdown/code/URLs so the voice never reads formatting literally,
// then apply the deterministic pronunciation layer (ARC-AI → spoken letters,
// script-aware via the TTS language when known).
const cleanTextForSpeech = (text, language = "") => {
  let cleaned = toWellFormedUnicode(String(text || ""));
  cleaned = cleaned.replace(/```[\s\S]*?```/g, " ");
  cleaned = cleaned.replace(/`([^`]+)`/g, "$1");
  cleaned = cleaned.replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g, "$1");
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, " ");
  cleaned = cleaned.replace(
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
    " ",
  );
  cleaned = cleaned.replace(/[*_#`|~<>^]/g, " ");
  cleaned = cleaned.replace(/&/g, " and ");
  cleaned = pronunciationNormalize(cleaned, language);
  cleaned = cleaned.replace(/\s{2,}/g, " ");
  return cleaned.trim();
};

// Split cleaned text into speakable segments: sentence ends first, then
// clause boundaries, then a hard character cap. Never split mid-word.
const splitIntoSpeechSegments = (text, { maxLength = 220 } = {}) => {
  const cleaned = cleanTextForSpeech(text);
  if (!cleaned) return [];

  const sentences = cleaned.split(/(?<=[.!?])\s+(?=[A-Z"“('0-9])/g) || [
    cleaned,
  ];
  const segments = [];

  const pushCapped = (value) => {
    const words = String(value || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    let buffer = "";
    for (const word of words) {
      const candidate = buffer ? `${buffer} ${word}` : word;
      if (candidate.length > maxLength && buffer) {
        segments.push(buffer.trim());
        buffer = word;
      } else {
        buffer = candidate;
      }
    }
    if (buffer.trim()) segments.push(buffer.trim());
  };

  for (const sentence of sentences) {
    const trimmed = String(sentence || "").trim();
    if (!trimmed) continue;
    if (trimmed.length <= maxLength) {
      segments.push(trimmed);
      continue;
    }
    const clauses = trimmed.split(/(?<=[,;:])\s+/);
    for (const clause of clauses) {
      const clauseText = String(clause || "").trim();
      if (!clauseText) continue;
      if (clauseText.length <= maxLength) segments.push(clauseText);
      else pushCapped(clauseText);
    }
  }

  return segments.filter(Boolean);
};

// Wrap raw 16-bit PCM mono base64 as a WAV base64 payload. Gemini TTS returns
// raw PCM (24kHz mono); WAV framing lets every browser play it with a plain
// HTMLAudioElement — no codec negotiation, no MediaSource needed.
// (Voice Runtime 2.0 keeps this for the legacy `ai:tts:audio` compat path;
// the primary v2 path streams raw PCM16 via `voice:tts:*` events.)
const pcm16ToWavBase64 = (
  pcmBase64,
  { sampleRate = 24000, channels = 1 } = {},
) => {
  const pcm = Buffer.from(String(pcmBase64 || ""), "base64");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString("base64");
};

const extractStreamAudio = (message) => {
  const parts = message?.candidates?.[0]?.content?.parts || [];
  return parts
    .map((part) => part?.inlineData?.data)
    .filter(Boolean)
    .map((data) => Buffer.from(String(data), "base64"));
};

// Synthesize one Gemini segment with the SDK's streaming content API. The
// model emits incremental inline AUDIO parts; each is forwarded immediately
// while the collected PCM remains available to the legacy WAV path.
const synthesizeSegment = async (
  text,
  { signal = null, voice = null, model = null, language = "" } = {},
) => {
  const cleanText = cleanTextForSpeech(text, language);
  if (!cleanText)
    throw Object.assign(new Error("Nothing speakable in TTS segment."), {
      statusCode: 400,
    });
  const startedAt = Date.now();
  const client = getClient();
  const chunks = [];
  const stream = await client.models.generateContentStream({
    model: model || getGeminiTtsModel(),
    contents: [
      {
        role: "user",
        parts: [{ text: `Say naturally, conversationally: ${cleanText}` }],
      },
    ],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice || getGeminiTtsVoice() },
        },
      },
      abortSignal: signal || undefined,
    },
  });
  for await (const message of stream) {
    if (signal?.aborted) {
      throw Object.assign(new Error("TTS stream cancelled."), {
        name: "AbortError",
        code: "TTS_CANCELLED",
      });
    }
    for (const chunk of extractStreamAudio(message)) {
      chunks.push(chunk);
      // The legacy caller consumes the collected result. Live streaming is
      // delivered by GeminiStreamingTtsProvider below.
    }
  }
  const pcm = Buffer.concat(chunks);
  if (!pcm.length)
    throw Object.assign(new Error("TTS provider returned no audio."), {
      statusCode: 502,
    });
  return {
    audioBase64: pcm16ToWavBase64(pcm.toString("base64")),
    mimeType: "audio/wav",
    voice: voice || getGeminiTtsVoice(),
    model: model || getGeminiTtsModel(),
    latencyMs: Date.now() - startedAt,
  };
};

const streamGeminiTts = async (
  text,
  { signal = null, voice = null, model = null, onAudio = null } = {},
) => {
  const cleanText = cleanTextForSpeech(text);
  if (!cleanText)
    throw Object.assign(new Error("Nothing speakable in TTS segment."), {
      statusCode: 400,
    });
  const stream = await getClient().models.generateContentStream({
    model: model || getGeminiTtsModel(),
    contents: [
      {
        role: "user",
        parts: [{ text: `Say naturally, conversationally: ${cleanText}` }],
      },
    ],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice || getGeminiTtsVoice() },
        },
      },
      abortSignal: signal || undefined,
    },
  });
  const chunks = [];
  for await (const message of stream) {
    if (signal?.aborted)
      throw Object.assign(new Error("TTS stream cancelled."), {
        name: "AbortError",
        code: "TTS_CANCELLED",
      });
    for (const chunk of extractStreamAudio(message)) {
      chunks.push(chunk);
      try {
        onAudio?.(chunk);
      } catch {
        /* delivery is best effort */
      }
    }
  }
  return Buffer.concat(chunks);
};
// Voice Runtime 2.0 — deterministic PCM handling.
//
// The v2 wire format is raw PCM signed 16-bit mono 24kHz. Gemini returns raw
// PCM; the legacy path wraps it in WAV for HTMLAudioElement compat. These
// helpers convert between the two without provider-specific leakage.
const VOICE_PCM_SAMPLE_RATE = 24000;
const VOICE_PCM_CHANNELS = 1;

// Strip a 44-byte WAV header (when present) and return raw PCM16 bytes.
// Accepts either raw PCM base64 or WAV base64; never throws on malformed
// input — returns an empty Buffer so callers skip truthfully.
const wavBase64ToPcm16 = (audioBase64) => {
  try {
    const bytes = Buffer.from(String(audioBase64 || ""), "base64");
    if (
      bytes.length >= 44 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WAVE"
    ) {
      return bytes.subarray(44);
    }
    return bytes;
  } catch {
    return Buffer.alloc(0);
  }
};

// Split PCM16 bytes into streamable binary chunks (default ~0.2s).
const splitPcmForStream = (pcmBuffer, chunkBytes = 9600) => {
  const buf = Buffer.isBuffer(pcmBuffer)
    ? pcmBuffer
    : Buffer.from(pcmBuffer || []);
  const chunks = [];
  for (let offset = 0; offset < buf.length; offset += chunkBytes) {
    chunks.push(
      buf.subarray(offset, Math.min(offset + chunkBytes, buf.length)),
    );
  }
  return chunks;
};

// Buffers LLM text, extracts complete speakable segments at natural
// boundaries, and synthesizes them in order in the background. Socket audio
// delivery never blocks text delivery: push() only enqueues; synthesis runs
// on an internal chain. A single failed segment is skipped (logged) without
// stopping the queue; abort/interrupt stops everything and tells the client
// to flush via `ai:tts:audio:stop`.
class TtsStreamBuffer {
  constructor({
    socket = null,
    signal = null,
    synthesize = null,
    language = "",
  } = {}) {
    this.socket = socket;
    this.signal = signal;
    this.language = language;
    this.synthesize =
      typeof synthesize === "function" ? synthesize : synthesizeSegment;
    this.buffer = "";
    this.segmentIndex = 0;
    this.chain = Promise.resolve();
    this.stopped = false;
    this.audioStartedAt = null;
  }

  extractCompleteSegments() {
    // A segment is complete at a sentence end, or when the buffer grows past
    // the cap (split at the last clause boundary so we never cut mid-word).
    const segments = [];
    const sentenceMatch = this.buffer.match(
      /^([\s\S]*?[.!?])(?=\s+[A-Z"“('0-9]|\s*$)/,
    );
    if (sentenceMatch && sentenceMatch[1].trim().length >= 8) {
      segments.push(sentenceMatch[1].trim());
      this.buffer = this.buffer.slice(sentenceMatch[1].length).trim();
      return segments;
    }
    if (this.buffer.length >= 240) {
      const cut = this.buffer.lastIndexOf(",", 240);
      const at = cut > 80 ? cut + 1 : 240;
      const piece = this.buffer.slice(0, at).trim();
      if (piece) segments.push(piece);
      this.buffer = this.buffer.slice(at).trim();
    }
    return segments;
  }

  push(text) {
    if (this.stopped || !text) return;
    this.buffer += String(text);
    for (const segment of this.extractCompleteSegments()) {
      this.enqueueSegment(segment);
    }
  }

  enqueueSegment(segment) {
    const index = this.segmentIndex;
    this.segmentIndex += 1;
    this.chain = this.chain.then(async () => {
      if (this.stopped || (this.signal && this.signal.aborted)) return;
      try {
        const result = await this.synthesize(segment, {
          signal: this.signal,
          language: this.language,
        });
        if (this.stopped || (this.signal && this.signal.aborted)) return;
        if (this.audioStartedAt == null) this.audioStartedAt = Date.now();
        if (this.socket) {
          this.socket.emit("ai:tts:audio", {
            index,
            audio: result.audioBase64,
            mimeType: result.mimeType || "audio/wav",
            isFinal: false,
          });
        }
      } catch (error) {
        // Skip the failed segment and keep the queue moving. Never expose
        // provider internals or keys — message only, truncated.
        console.warn(
          "[TTS] segment synthesis failed, skipping:",
          String(error?.message || error).slice(0, 160),
        );
      }
    });
  }

  async flush() {
    const remainder = String(this.buffer || "").trim();
    this.buffer = "";
    if (remainder && !this.stopped) {
      this.enqueueSegment(remainder);
    }
    await this.chain;
    if (!this.stopped && this.socket) {
      this.socket.emit("ai:tts:audio", {
        index: this.segmentIndex,
        audio: null,
        isFinal: true,
      });
    }
  }

  stop() {
    this.stopped = true;
    this.buffer = "";
    if (this.socket) {
      this.socket.emit("ai:tts:audio:stop", { reason: "interrupted" });
    }
  }
}

// Voice Runtime 3.0 — streaming voice channel over the existing
// authenticated Socket.IO connection (no second socket).
//
// Explicit voice events (control = structured JSON, audio = binary):
//   voice:tts:start  { streamId, voice, language, format }
//   voice:tts:audio  { streamId, segmentIndex, seq, audio: Buffer, format }
//   voice:tts:end    { streamId }
//   voice:tts:error  { streamId, segmentIndex, code, message }
//   voice:tts:cancel { streamId, reason }
//
// Every audio packet carries explicit metadata — format, codec,
// sampleRate, channels, bitDepth, endianness, sequence number — so the
// browser NEVER infers rates or layout. seq is monotonic per stream; the
// client validates gaps/dupes and rejects stale streams.
//
// ONE continuous synthesis session per assistant response: AIService pushes
// LLM text deltas via push(); the session emits large semantic chunks
// (prosody context preserved across chunks) rather than one isolated
// synthesis per sentence. flush() synthesizes the remainder and closes the
// session; stop() cancels immediately (barge-in).
//
// Binary audio never rides inside normal chat messages. A legacy
// `ai:tts:audio` WAV event is still emitted per segment for old clients,
// but the primary path is the binary PCM stream above.
const VOICE_STREAM_FORMAT = Object.freeze({
  encoding: "pcm16",
  codec: "pcm_s16le",
  sampleRate: VOICE_PCM_SAMPLE_RATE,
  channels: VOICE_PCM_CHANNELS,
  bitDepth: 16,
  endianness: "le",
});

class VoiceTtsStreamer {
  constructor({
    socket = null,
    signal = null,
    provider = null,
    voice = null,
    language = "en-US",
  } = {}) {
    this.socket = socket;
    this.signal = signal;
    this.voice = voice || null;
    this.language = language;
    this.streamId = `vts_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.format = { ...VOICE_STREAM_FORMAT };
    this.seq = 0;
    this.segmentIndex = 0;
    this.stopped = false;
    this.started = false;
    this.firstByteAt = null;
    this.llmFirstSentenceAt = null;
    this.providerFactory = provider;
    this.session = null;
    this._sessionError = null;
    // Lazily resolved so tests can inject a mock provider.
    this._provider =
      provider && typeof provider.startStream === "function" ? provider : null;
    this._onFirstByte = null;
  }

  onFirstByte(callback) {
    if (typeof callback === "function") this._onFirstByte = callback;
  }

  _getProvider() {
    if (this._provider) return this._provider;
    // Lazy require avoids a hard cycle (voiceTtsProvider requires ttsService).
    // eslint-disable-next-line global-require
    const { selectStreamingProvider } = require("./voiceTtsProvider");
    const factory = this.providerFactory;
    this._provider =
      factory && typeof factory.startStream === "function"
        ? factory
        : selectStreamingProvider({});
    return this._provider;
  }

  _ensureSession() {
    if (this.session) return this.session;
    const provider = this._getProvider();
    const streamer = this;
    this.session = provider.startStream({
      voice: this.voice,
      language: this.language,
      format: { ...this.format },
      signal: this.signal,
      onAudio: (chunk) => streamer._emitAudio(chunk),
      onError: (error) => streamer._failSegment(error),
    });
    return this.session;
  }

  _emitAudio(chunk) {
    if (this.stopped || (this.signal && this.signal.aborted)) return;
    const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
    if (!audio.length) return;
    if (this.firstByteAt == null) {
      this.firstByteAt = Date.now();
      try {
        // T9 marker: first synthesized audio left the server toward the client.
        console.log(
          "[VoiceLatency] tts.firstSocketEmit at=%d",
          this.firstByteAt,
        );
        this._onFirstByte?.({ at: this.firstByteAt });
      } catch {
        /* telemetry only */
      }
    }
    const seq = this.seq;
    this.seq += 1;
    if (this.socket) {
      this.socket.emit("voice:tts:audio", {
        streamId: this.streamId,
        segmentIndex: this.segmentIndex,
        seq,
        audio,
        format: { ...this.format },
      });
    }
  }

  push(text) {
    if (this.stopped || !text) return;
    if (this.llmFirstSentenceAt == null && /[.!?]\s/.test(String(text))) {
      this.llmFirstSentenceAt = Date.now();
    }
    try {
      if (!this.started) {
        this.started = true;
        if (this.socket) {
          this.socket.emit("voice:tts:start", {
            streamId: this.streamId,
            voice: this.voice,
            language: this.language,
            format: { ...this.format },
          });
        }
      }
      this._ensureSession().writeText(String(text));
    } catch (error) {
      this._failSegment(error);
    }
  }

  _failSegment(error) {
    if (
      error?.name === "AbortError" ||
      error?.code === "TTS_CANCELLED" ||
      (this.signal && this.signal.aborted)
    ) {
      return;
    }
    console.warn(
      "[VoiceTTS] segment failed, skipping:",
      String(error?.message || error).slice(0, 160),
    );
    this.segmentIndex += 1;
    if (this.socket) {
      this.socket.emit("voice:tts:error", {
        streamId: this.streamId,
        segmentIndex: this.segmentIndex,
        code: error?.code || error?.statusCode || "TTS_ERROR",
        message: "Spoken reply unavailable for one segment; text continues.",
      });
    }
  }

  async flush() {
    if (this.stopped) return;
    try {
      await this._ensureSession().flush();
      await this._ensureSession().close();
    } catch (error) {
      this._failSegment(error);
    }
    if (!this.stopped && this.socket) {
      this.socket.emit("voice:tts:end", { streamId: this.streamId });
      // Bounded playback telemetry: counts only, never audio content.
      try {
        console.log(
          "[VoiceTTS] response streamId=%s emittedChunks=%d",
          this.streamId,
          this.seq,
        );
      } catch {
        /* telemetry must never break delivery */
      }
    }
  }

  stop(reason = "interrupted") {
    this.stopped = true;
    try {
      this.session?.cancel?.();
    } catch {
      /* ignore */
    }
    if (this.socket) {
      this.socket.emit("voice:tts:cancel", { streamId: this.streamId, reason });
      this.socket.emit("ai:tts:audio:stop", { reason });
    }
  }
}

module.exports = {
  getTtsMode,
  isServerTtsActive,
  getGeminiTtsModel,
  getGeminiTtsVoice,
  getDefaultTtsLanguage,
  cleanTextForSpeech,
  splitIntoSpeechSegments,
  pcm16ToWavBase64,
  wavBase64ToPcm16,
  splitPcmForStream,
  VOICE_PCM_SAMPLE_RATE,
  VOICE_PCM_CHANNELS,
  VOICE_STREAM_FORMAT,
  synthesizeSegment,
  streamGeminiTts,
  TtsStreamBuffer,
  VoiceTtsStreamer,
};
