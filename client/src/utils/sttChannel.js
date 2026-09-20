// Voice Runtime FINAL — client streaming STT channel.
//
// One authenticated socket transports microphone audio frames produced by
// VoiceMicCapture (24 kHz mono PCM16, explicit format + seq) to the ARC
// server, which owns transcription.  The client only:
//   begin()  → emit voice:stt:start, await voice:stt:started (sessionId)
//   sendFrame → emit voice:stt:audio (bounded, deduped, format-gated)
//   commit()  → emit voice:stt:commit on trailing silence
//   cancel()  → emit voice:stt:cancel (barge-in/user cancel)
// and routes voice:stt:* server events (interim preview / final submit).
//
// No browser-side recognition anywhere in this path.
// Bounds mirror the server: 6 MB, 1200 frames, single active session.
import { VOICE_MIC_FORMAT } from "../audio/voiceMicWorklet.js";

const STT_MAX_CLIENT_BYTES = 6_000_000;
const STT_MAX_CLIENT_FRAMES = 1200;
const STT_START_TIMEOUT_MS = 8000;

const toWireAudio = (bytes) => {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) {
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  }
  return bytes;
};

let sharedChannel = null;

export const getSharedSttChannel = () => {
  if (!sharedChannel) sharedChannel = new StreamingSttChannel();
  return sharedChannel;
};

export class StreamingSttChannel {
  constructor() {
    this.socket = null;
    this.sessionId = null;
    this.sentSessionId = null;
    this.active = false;
    this._pendingStart = null;
    this._pendingHandlers = null;
    this._queued = [];
    this._lastSeq = null;
    this._listeners = new Set();
    // Commit requested while voice:stt:started was still in flight; dispatched
    // as soon as the session exists (avoids silently dropping the finalize).
    this._pendingCommit = false;
    this.counters = {
      starts: 0,
      framesSent: 0,
      bytesSent: 0,
      queuedFrames: 0,
      droppedFrames: 0,
      interims: 0,
      finals: 0,
      staleEvents: 0,
      resets: 0,
    };
  }

  // useSocket registers its socket here (last setup wins).
  configure(socket) {
    this.socket = socket || null;
    if (!socket) this.reset();
  }

  onEvent(listener) {
    if (typeof listener !== "function") return () => {};
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit(type, data) {
    for (const listener of [...this._listeners]) {
      try {
        listener(type, data);
      } catch {
        /* UI must not break the channel */
      }
    }
  }

  get activeSession() {
    return this.active && Boolean(this.sessionId);
  }

  // ---- Client-driven commands ---------------------------------------------
  async begin() {
    if (!this.socket?.connected) {
      throw Object.assign(new Error("Voice requires a connection to ARC."), {
        code: "VOICE_STT_DISCONNECTED",
      });
    }
    if (this.active) {
      await this._waitStarted();
      return this.sessionId;
    }
    this.active = true;
    this.counters.starts += 1;
    this._lastSeq = -1;
    this._queued = [];
    try {
      this.socket.emit("voice:stt:start", {});
    } catch {
      /* server replies voice:stt:started */
    }
    await this._waitStarted();
    return this.sessionId;
  }

  async _waitStarted() {
    if (this.sessionId) {
      this._drainQueue();
      return this.sessionId;
    }
    if (this._pendingStart) return this._pendingStart;
    this._pendingStart = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingStart = null;
        this._pendingHandlers = null;
        if (!this.sessionId && this.active) {
          this.active = false;
          this._emit("error", {
            code: "VOICE_STT_TIMEOUT",
            message: "Voice transcription did not start. Try again.",
          });
          reject(
            Object.assign(new Error("Voice transcription did not start."), {
              code: "VOICE_STT_TIMEOUT",
            }),
          );
        }
      }, STT_START_TIMEOUT_MS);
      this._pendingHandlers = () => {
        clearTimeout(timer);
        this._pendingStart = null;
        this._pendingHandlers = null;
        this._drainQueue();
        resolve(this.sessionId);
      };
    });
    return this._pendingStart;
  }

  // One frame in, one frame out.  Bounded + deduped + format-gated.
  sendFrame({ seq, bytes, format } = {}) {
    if (!this.active || !bytes || !bytes.byteLength) {
      this.counters.droppedFrames += 1;
      return false;
    }
    if (
      this.counters.framesSent >= STT_MAX_CLIENT_FRAMES ||
      this.counters.bytesSent + bytes.byteLength > STT_MAX_CLIENT_BYTES
    ) {
      this.counters.droppedFrames += 1;
      return false;
    }
    const fmt = format || VOICE_MIC_FORMAT;
    if (
      fmt.encoding !== "pcm16" ||
      Number(fmt.sampleRate) !== VOICE_MIC_FORMAT.sampleRate ||
      Number(fmt.channels) !== VOICE_MIC_FORMAT.channels
    ) {
      this.counters.droppedFrames += 1;
      return false;
    }
    const frameSeq = typeof seq === "number" ? seq : this._lastSeq + 1;
    if (this._lastSeq !== null && frameSeq <= this._lastSeq) {
      this.counters.droppedFrames += 1;
      return false;
    }
    this._lastSeq = frameSeq;
    this.counters.framesSent += 1;
    this.counters.bytesSent += bytes.byteLength;
    if (this.counters.framesSent === 1) {
      console.debug("[Voice] first microphone PCM frame queued", {
        bytes: bytes.byteLength,
        sampleRate: fmt.sampleRate,
      });
    }
    const payload = {
      sessionId: this.sessionId,
      seq: frameSeq,
      format: fmt,
      audio: toWireAudio(bytes),
    };
    if (this.sessionId) {
      try {
        this.socket.emit("voice:stt:audio", payload, (ack = {}) => {
          if (ack.accepted === false) {
            this.counters.droppedFrames += 1;
            this._emit("error", {
              code: ack.code || "VOICE_STT_AUDIO_REJECTED",
              message: `Server rejected microphone audio (${ack.bytes || 0} bytes).`,
            });
          }
        });
      } catch {
        /* ignore */
      }
      return true;
    }
    // Started event may still be in flight: queue a shallow copy (bounded).
    this.counters.queuedFrames += 1;
    this._queued.push({ seq: frameSeq, format: fmt, bytes: bytes.slice(0) });
    if (this._queued.length > 400) this._queued.shift();
    return true;
  }

  _drainQueue() {
    if (!this.sessionId) return;
    const queued = this._queued;
    this._queued = [];
    for (const frame of queued) {
      try {
        this.socket.emit(
          "voice:stt:audio",
          {
            sessionId: this.sessionId,
            seq: frame.seq,
            format: frame.format,
            audio: toWireAudio(frame.bytes),
          },
          (ack = {}) => {
            if (ack.accepted === false) {
              this.counters.droppedFrames += 1;
              this._emit("error", {
                code: ack.code || "VOICE_STT_AUDIO_REJECTED",
                message: `Server rejected microphone audio (${ack.bytes || 0} bytes).`,
              });
            }
          },
        );
      } catch {
        /* ignore */
      }
    }
  }

  commit() {
    if (this._pendingStart) {
      // Session start signal is still in flight; finalize as soon as the
      // session exists instead of silently dropping the user's stop.
      this._pendingCommit = true;
      this.active = true;
      return;
    }
    if (this.sessionId && this.socket?.connected) {
      try {
        this.socket.emit("voice:stt:commit", { sessionId: this.sessionId });
      } catch {
        /* ignore */
      }
    }
    this.active = false;
    this._queued = [];
  }

  cancel(reason = "user cancel") {
    if (this.sessionId && this.socket?.connected) {
      try {
        this.socket.emit("voice:stt:cancel", {
          sessionId: this.sessionId,
          reason,
        });
      } catch {
        /* ignore */
      }
    }
    this.sessionId = null;
    this.sentSessionId = null;
    this.active = false;
    this._pendingStart = null;
    this._pendingHandlers = null;
    this._pendingCommit = false;
    this._queued = [];
  }

  reset() {
    this.sessionId = null;
    this.sentSessionId = null;
    this.active = false;
    this._pendingStart = null;
    this._pendingHandlers = null;
    this._pendingCommit = false;
    this._queued = [];
    this._lastSeq = null;
    this.counters.resets += 1;
  }

  // ---- Server → client event routing ---------------------------------------
  handleServerEvent(type, data = {}) {
    switch (type) {
      case "voice:stt:started": {
        this.sessionId = data?.sessionId || null;
        if (this._pendingHandlers) this._pendingHandlers();
        if (this._pendingCommit) {
          // A commit was queued while the session was starting: dispatch it now.
          this._pendingCommit = false;
          try {
            this.socket.emit("voice:stt:commit", { sessionId: this.sessionId });
          } catch {
            /* ignore */
          }
        }
        this._emit("started", { sessionId: this.sessionId });
        break;
      }
      case "voice:stt:interim":
        this.counters.interims += 1;
        this._emit("interim", { text: String(data?.text || "") });
        break;
      case "voice:stt:final":
        this.counters.finals += 1;
        this._emit("final", {
          text: String(data?.text || ""),
          rawText: String(data?.rawText ?? data?.text ?? ""),
          corrections: Array.isArray(data?.corrections)
            ? data.corrections
            : null,
          needsClarification: Boolean(data?.needsClarification),
          lowConfidence: Boolean(data?.lowConfidence),
          destructive: data?.destructive ? { ...data.destructive } : null,
          reason: data?.reason ?? null,
          // Per-utterance language auto-detected by the server provider
          // (Sarvam language_code=auto). Nullable + additive.
          language:
            typeof data?.language === "string" && data.language
              ? data.language
              : null,
          languageConfidence:
            typeof data?.languageConfidence === "number"
              ? Math.max(0, Math.min(1, data.languageConfidence))
              : null,
        });
        break;
      case "voice:stt:speech:start":
        // Provider VAD backstop: server says speech began (barge-in while
        // the assistant is speaking — the client's RMS path is primary).
        this._emit("speech:start", { sessionId: this.sessionId });
        break;
      case "voice:stt:speech:end":
        this._emit("speech:end", { sessionId: this.sessionId });
        break;
      case "voice:stt:end":
        // Server finalized the session; the next utterance starts fresh.
        this.sessionId = null;
        this.active = false;
        this._emit("end", {});
        break;
      case "voice:stt:error":
        this._emit("error", {
          code: String(data?.code || "VOICE_STT_FAILED"),
          message: String(data?.message || "Voice transcription failed."),
        });
        break;
      case "voice:stt:cancelled":
        this.sessionId = null;
        this.active = false;
        this._emit("cancelled", {
          reason: String(data?.reason || "cancelled"),
        });
        break;
      default:
        break;
    }
  }
}

export const STT_CHANNEL_EVENTS = [
  "voice:stt:started",
  "voice:stt:interim",
  "voice:stt:final",
  "voice:stt:end",
  "voice:stt:error",
  "voice:stt:cancelled",
  "voice:stt:speech:start",
  "voice:stt:speech:end",
];

export const _resetSttChannelForTests = () => {
  sharedChannel = null;
};
