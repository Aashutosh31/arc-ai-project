// Voice Runtime 3.0 — provider-independent streaming TTS contract.
//
// Two entry points:
//
//   streamSpeech({ text, voice, language, format, signal })
//     single-shot async generator: started / audio / completed.
//     (Kept for compat and tests.)
//
//   startStream({ voice, language, format, signal, onAudio })
//     CONTINUOUS session for one assistant response:
//       session.writeText(delta)   LLM text deltas, as they arrive
//       session.flush()            synthesize remainder, await delivery
//       session.cancel()           abort immediately (barge-in)
//       session.close()            flush + end the session
//
// The session holds ONE logical synthesis context per response. Adapters
// whose vendor protocol supports true incremental streaming send segments
// through one connection; adapters over unary synthesis (e.g. Gemini)
// synthesize large semantic chunks SEQUENTIALLY through the session with
// prior-chunk prosody context — never one isolated session per sentence.
//
// React never sees provider internals. The client only sees `voice:tts:*`
// socket events with PCM audio + explicit format metadata.
//
// Audio format default: PCM signed 16-bit little-endian, mono, 24 kHz.
const ttsService = require("./ttsService");
const speechNormalize = require("./speechNormalize");

const VOICE_AUDIO_FORMAT = Object.freeze({
  encoding: "pcm16",
  codec: "pcm_s16le",
  sampleRate: 24000,
  channels: 1,
  bitDepth: 16,
  endianness: "le",
});

// Split decoded PCM16 bytes into streamable chunks. Default ~0.2s at 24kHz
// mono 16-bit (9600 bytes) — small enough for low-latency first-audio,
// large enough to avoid per-packet overhead.
const DEFAULT_CHUNK_BYTES = 9600;

const chunkPcm16 = (pcmBuffer, chunkBytes = DEFAULT_CHUNK_BYTES) => {
  const chunks = [];
  const buf = Buffer.isBuffer(pcmBuffer)
    ? pcmBuffer
    : Buffer.from(pcmBuffer || []);
  for (let offset = 0; offset < buf.length; offset += chunkBytes) {
    chunks.push(
      buf.subarray(offset, Math.min(offset + chunkBytes, buf.length)),
    );
  }
  return chunks;
};

const throwAborted = () => {
  const error = new Error("TTS stream cancelled.");
  error.name = "AbortError";
  error.code = "TTS_CANCELLED";
  throw error;
};

// Base provider shape. Concrete providers implement _synthesizePcm().
// streamSpeech() is the ONLY entry React/server-runtime touches.
class BaseStreamingTtsProvider {
  constructor({ name = "base", voice = null, language = "en-US" } = {}) {
    this.name = name;
    this.defaultVoice = voice;
    this.defaultLanguage = language;
  }

  get format() {
    return { ...VOICE_AUDIO_FORMAT };
  }

  // Async generator: yields { type: 'started' } then Buffer chunks then
  // { type: 'completed', latencyMs }. Throws on error; AbortError on cancel.
  async *streamSpeech({
    text,
    voice = null,
    language = null,
    format = null,
    signal = null,
  } = {}) {
    const startedAt = Date.now();
    // Speech-normalized (not raw markdown): the voice never reads formatting.
    // The deterministic pronunciation layer is language-aware (Hindi letters
    // for hi-* voices, Latin otherwise) so the product name sounds right.
    const cleanText = speechNormalize.speechNormalize(
      text,
      language || this.defaultLanguage,
    );
    if (!cleanText) {
      const error = new Error("Nothing speakable in TTS segment.");
      error.statusCode = 400;
      throw error;
    }
    if (signal?.aborted) throwAborted();
    yield {
      type: "started",
      provider: this.name,
      voice: voice || this.defaultVoice || null,
      language: language || this.defaultLanguage,
      format: format || this.format,
    };
    const pcm = await this._synthesizePcm(cleanText, {
      voice,
      language,
      signal,
    });
    if (signal?.aborted) throwAborted();
    for (const chunk of chunkPcm16(pcm)) {
      if (signal?.aborted) throwAborted();
      yield { type: "audio", chunk, format: format || this.format };
    }
    yield { type: "completed", latencyMs: Date.now() - startedAt };
  }

  // Must resolve a Buffer of raw PCM16 mono 24kHz bytes. Override per provider.
  // contextBefore: tail of the previously synthesized chunk (already spoken,
  // never to be repeated) so multi-chunk responses keep one voice/rhythm.
  // eslint-disable-next-line no-unused-vars
  async _synthesizePcm(
    cleanText,
    { voice, language, signal, contextBefore = "" } = {},
  ) {
    throw new Error(
      `TTS provider "${this.name}" has no synthesizer configured.`,
    );
  }

  // Open ONE continuous synthesis session for a full assistant response.
  // onAudio(chunkBuffer, { chunkOrdinal }) receives raw PCM16 per packet.
  // onError(error, { chunkOrdinal }) reports a failed chunk WITHOUT
  // breaking the session — the stream continues (text chat unaffected).
  startStream({
    voice = null,
    language = null,
    format = null,
    signal = null,
    onAudio = null,
    onError = null,
  } = {}) {
    const provider = this;
    const resolvedFormat = format || this.format;
    const { SemanticTtsBuffer } = require("./speechNormalize");
    const semantic = new SemanticTtsBuffer({
      language: language || this.defaultLanguage,
    });
    let chain = Promise.resolve();
    let cancelled = false;
    let closed = false;
    let chunkOrdinal = 0;
    let previousTail = "";
    let firstScheduledAt = null;
    const emit = (packet) => {
      try {
        onAudio?.(packet.chunk, { chunkOrdinal });
      } catch {
        /* delivery best-effort */
      }
    };
    const synthesizeOne = async (normalizedChunk) => {
      if (cancelled || (signal && signal.aborted)) return;
      const ordinal = chunkOrdinal;
      chunkOrdinal += 1;
      let pcm;
      let streamed = false;
      try {
        pcm = await provider._synthesizePcm(normalizedChunk, {
          voice,
          language,
          signal,
          contextBefore: previousTail,
          onAudio: (chunk) => {
            streamed = true;
            if (cancelled || (signal && signal.aborted)) return;
            emit({ type: "audio", chunk, format: resolvedFormat, ordinal });
          },
        });
      } catch (error) {
        // Skip the failed chunk and keep the SESSION alive — one bad chunk
        // must never wedge the response. Cancellation stays silent.
        if (
          error?.name === "AbortError" ||
          error?.code === "TTS_CANCELLED" ||
          (signal && signal.aborted)
        )
          return;
        try {
          onError?.(error, { chunkOrdinal: ordinal });
        } catch {
          /* reporting only */
        }
        return;
      }
      // Prosody context for the NEXT chunk: tail of what was just spoken.
      previousTail = String(normalizedChunk || "").slice(-160);
      if (cancelled || (signal && signal.aborted)) return;
      if (!streamed) {
        for (const packet of chunkPcm16(pcm)) {
          if (cancelled || (signal && signal.aborted)) return;
          emit({
            type: "audio",
            chunk: packet,
            format: resolvedFormat,
            ordinal,
          });
        }
      }
    };
    const schedule = (normalizedChunk) => {
      // The chain NEVER rejects outward: errors are routed to onError above,
      // so a failure cannot poison later chunks or the flush await.
      chain = chain
        .then(() => synthesizeOne(normalizedChunk))
        .catch((error) => {
          try {
            onError?.(error, { chunkOrdinal });
          } catch {
            /* reporting only */
          }
        });
    };
    return {
      provider: this.name,
      format: resolvedFormat,
      writeText(delta) {
        if (closed || cancelled || !delta) return;
        for (const chunk of semantic.push(delta)) {
          if (firstScheduledAt == null) {
            firstScheduledAt = Date.now();
            try {
              // T6 marker: first natural sentence became TTS-eligible while
              // the LLM was still streaming.
              console.log(
                "[VoiceLatency] tts.firstChunkEmitted at=%d",
                firstScheduledAt,
              );
            } catch {
              /* telemetry must never break delivery */
            }
          }
          schedule(chunk);
        }
      },
      async flush() {
        if (cancelled) return;
        for (const chunk of semantic.flush()) {
          schedule(chunk);
        }
        await chain;
      },
      cancel() {
        cancelled = true;
        semantic.reset();
      },
      async close() {
        if (closed) return;
        closed = true;
        await this.flush();
      },
    };
  }
}

// Gemini-backed provider. Wraps the existing segment synthesizer (which
// returns WAV base64), strips the WAV header, and re-emits raw PCM16 so the
// wire format stays deterministic (pcm16/24k/mono) regardless of provider.
// Multi-chunk responses are synthesized through ONE session with prosody
// context (same voice/pace/rhythm continued, previous chunk never repeated).
class GeminiStreamingTtsProvider extends BaseStreamingTtsProvider {
  constructor({ synthesize = null, voice = null, language = "en-US" } = {}) {
    super({ name: "gemini", voice, language });
    this._synthesize =
      typeof synthesize === "function"
        ? synthesize
        : ttsService.synthesizeSegment;
  }

  _promptFor(cleanText, contextBefore) {
    if (contextBefore && String(contextBefore).trim()) {
      return (
        "Continue the same conversational turn in the same voice, pace and rhythm. " +
        `Already spoken (context only, do NOT repeat): "${String(contextBefore).slice(-160)}" ` +
        `Now say naturally, conversationally: ${cleanText}`
      );
    }
    return `Say naturally, conversationally: ${cleanText}`;
  }

  async _synthesizePcm(
    cleanText,
    {
      voice = null,
      signal = null,
      contextBefore = "",
      onAudio = null,
      language = "",
    } = {},
  ) {
    if (this._synthesize !== ttsService.synthesizeSegment) {
      const result = await this._synthesize(
        this._promptFor(cleanText, contextBefore),
        {
          voice: voice || this.defaultVoice,
          model: ttsService.getGeminiTtsModel(),
          signal,
          language,
        },
      );
      const pcm = ttsService.wavBase64ToPcm16(result.audioBase64);
      if (!pcm.length)
        throw Object.assign(new Error("TTS provider returned no audio."), {
          statusCode: 502,
        });
      return pcm;
    }
    return ttsService.streamGeminiTts(
      this._promptFor(cleanText, contextBefore),
      {
        signal,
        voice: voice || ttsService.getGeminiTtsVoice(),
        model: ttsService.getGeminiTtsModel(),
        onAudio,
      },
    );
  }
}

// Deterministic in-process provider for tests and for graceful operation
// when no cloud TTS is configured. Emits a short sine tone per character
// window so buffering/queue/interrupt paths can be exercised headlessly.
class MockStreamingTtsProvider extends BaseStreamingTtsProvider {
  constructor({ toneHz = 440 } = {}) {
    super({ name: "mock" });
    this.toneHz = toneHz;
  }

  async _synthesizePcm(cleanText) {
    const seconds = Math.min(2, Math.max(0.2, String(cleanText).length / 60));
    const total = Math.floor(VOICE_AUDIO_FORMAT.sampleRate * seconds);
    const pcm = Buffer.alloc(total * 2);
    for (let i = 0; i < total; i += 1) {
      const sample = Math.sin(
        (2 * Math.PI * this.toneHz * i) / VOICE_AUDIO_FORMAT.sampleRate,
      );
      pcm.writeInt16LE(Math.floor(sample * 12000), i * 2);
    }
    return pcm;
  }
}

// Unavailable provider — always throws a truthful, key-free error so the
// caller can fall through the fallback chain (never claim success).
class UnavailableTtsProvider extends BaseStreamingTtsProvider {
  constructor({ reason = "Server TTS is not configured." } = {}) {
    super({ name: "unavailable" });
    this.reason = reason;
  }

  async _synthesizePcm() {
    const error = new Error(this.reason);
    error.statusCode = 503;
    error.code = "TTS_UNAVAILABLE";
    throw error;
  }
}

// Provider selection. Order: explicit override → sarvam (when configured) →
// gemini (when configured, and as sarvam's degraded fallback) → unavailable
// (caller falls back to alternate/browser speech, truthfully).
const selectStreamingProvider = ({
  provider = null,
  synthesize = null,
} = {}) => {
  const requested = String(provider || process.env.TTS_PROVIDER || "gemini")
    .trim()
    .toLowerCase();
  if (requested === "mock") return new MockStreamingTtsProvider();
  if (requested === "unavailable") return new UnavailableTtsProvider();
  if (requested === "sarvam") {
    // Lazily imported: sarvamProvider needs BaseStreamingTtsProvider from this
    // module, so the cycle is broken at selection time, not require time.
    const sarvamProvider = require("./sarvamProvider");
    if (sarvamProvider.isSarvamConfigured()) {
      return new sarvamProvider.SarvamStreamingTtsProvider({ synthesize });
    }
    // Degraded fallback without a Sarvam key: drop to Gemini.
    if (process.env.GEMINI_API_KEY) {
      return new GeminiStreamingTtsProvider({ synthesize });
    }
  }
  if (requested === "gemini" && process.env.GEMINI_API_KEY) {
    return new GeminiStreamingTtsProvider({ synthesize });
  }
  // Alternate configured provider hook: TTS_PROVIDER=alternate with
  // TTS_ALTERNATE_ENABLED=1 resolves to mock-tone here; real deployments
  // plug a second cloud provider without touching React.
  if (requested === "alternate" && process.env.TTS_ALTERNATE_ENABLED === "1") {
    return new MockStreamingTtsProvider({ toneHz: 520 });
  }
  return new UnavailableTtsProvider({
    reason:
      "Server TTS is not configured (TTS_PROVIDER=gemini + GEMINI_API_KEY, or TTS_PROVIDER=sarvam + SARVAM_API_KEY required).",
  });
};

module.exports = {
  VOICE_AUDIO_FORMAT,
  DEFAULT_CHUNK_BYTES,
  chunkPcm16,
  BaseStreamingTtsProvider,
  GeminiStreamingTtsProvider,
  MockStreamingTtsProvider,
  UnavailableTtsProvider,
  selectStreamingProvider,
};
