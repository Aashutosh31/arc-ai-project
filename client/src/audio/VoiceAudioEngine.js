// Voice Runtime 3.0 — VoiceAudioEngine.
//
// The authoritative streaming playback engine. Worklet owns continuous
// output; this class owns everything the worklet must never guess:
//
// - explicit per-chunk format metadata (encoding/codec/rate/channels/
//   bitDepth/endianness/sequence) — never inferred, verified per chunk
// - Int16 → Float32 conversion with frame-alignment checks
// - resampling from the provider rate to the ACTUAL AudioContext rate
//   (creating the context at the device default; never forcing 24 kHz)
// - bounded staging queue so chunks arriving before activation are HELD,
//   never dropped (up to STAGE_CAP)
// - small pre-roll / jitter buffer so network unevenness never becomes
//   speak-pause-speak cadence
// - sequence validation (gaps/dupes counted, stale streams rejected)
// - full diagnostics for the Firefox acceptance gate
//
// Primary path never touches OS speech services. Capability-detected only.
import { VOICE_WORKLET_NAME, VOICE_WORKLET_STATIC_URL, getVoiceWorkletUrl } from './voiceAudioWorklet.js';

export const VOICE_SOURCE_RATE = 24000;
// Pre-roll: hold first audible output until this much audio is buffered
// (or PRE_ROLL_TIMEOUT_MS passes) — kills speak-pause-speak without
// adding steady-state latency.
export const PRE_ROLL_SAMPLES = 8400; // 0.35s at 24 kHz
export const PRE_ROLL_TIMEOUT_MS = 600;
// Staging cap for pre-activation audio: ~15s at 24 kHz mono 16-bit.
export const STAGE_CAP_BYTES = 720000;

export const hasVoiceAudioSupport = () => {
  try {
    if (typeof window === 'undefined') return false;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    if (typeof AudioWorkletNode === 'undefined') return false;
    return true;
  } catch {
    return false;
  }
};

// Decode little-endian PCM16 mono bytes to Float32. Returns { samples,
// alignedBytes, trimmed } — odd trailing bytes are trimmed (counted) so
// frame alignment is always explicit, never assumed.
export const pcm16ToFloat32 = (bytes) => {
  const view = bytes instanceof DataView
    ? bytes
    : new DataView(bytes?.buffer || new ArrayBuffer(0), bytes?.byteOffset || 0, bytes?.byteLength ?? bytes?.length ?? 0);
  const alignedBytes = view.byteLength - (view.byteLength % 2);
  const count = alignedBytes / 2;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return { samples: out, alignedBytes, trimmed: view.byteLength - alignedBytes };
};

// Linear-interpolation resampler for mono Float32. Transparent when
// fromRate === toRate (returns the input untouched).
export const resampleFloat32 = (samples, fromRate, toRate) => {
  if (!samples || !samples.length) return new Float32Array(0);
  const from = Number(fromRate) || 0;
  const to = Number(toRate) || 0;
  if (!from || !to || from === to) return samples;
  const ratio = from / to;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const index = Math.floor(pos);
    const frac = pos - index;
    const a = samples[index] || 0;
    const b = samples[index + 1] !== undefined ? samples[index + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
};

export const normalizeSocketAudioChunk = (payload) => {
  if (!payload) return null;
  const raw = payload.audio ?? payload.chunk ?? payload.data;
  if (!raw) return null;
  try {
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (typeof raw === 'string') {
      const binary = atob(raw);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    if (typeof raw === 'object' && raw.type === 'Buffer' && Array.isArray(raw.data)) {
      return Uint8Array.from(raw.data);
    }
  } catch {
    return null;
  }
  return null;
};

export class VoiceAudioEngine {
  constructor({ onStateChange = null, onUnderrun = null, onStats = null } = {}) {
    this.onStateChange = typeof onStateChange === 'function' ? onStateChange : null;
    this.onUnderrun = typeof onUnderrun === 'function' ? onUnderrun : null;
    this.onStats = typeof onStats === 'function' ? onStats : null;
    this.context = null;
    this.contextRate = 0;
    this.workletNode = null;
    this.ready = false;
    this.blocked = false;
    this.initError = null;
    this.playing = false;
    this.queuedSamples = 0;
    this.underruns = 0;
    this.playbackStartAt = null;
    this.firstChunkAt = null;
    this._initPromise = null;
    // Pre-roll / jitter buffer (resampled Float32 at context rate).
    this.preRoll = [];
    this.preRollSamples = 0;
    this.preRollTimer = null;
    this.preRollReleased = false;
    // Staging for pre-activation audio (raw entries, bounded).
    this.staged = [];
    this.stagedBytes = 0;
    this.stagedDropped = 0;
    // Sequence + stream tracking.
    this.currentStreamId = null;
    this.lastSeqByStream = new Map();
    // Diagnostic counters (counts only — never speech content).
    this.counters = {
      receivedChunks: 0,
      receivedBytes: 0,
      receivedFrames: 0,
      renderedFrames: 0,
      gapCount: 0,
      dupeCount: 0,
      staleDropped: 0,
      formatMismatch: 0,
      trimmedBytes: 0,
      assumedRate: 0,
      workletDropped: 0,
      starvationGaps: 0,
    };
    this.audioActuallyStoppedAt = null;
  }

  _setPlaying(next) {
    if (this.playing === next) return;
    this.playing = next;
    try { this.onStateChange?.(next ? 'playing' : 'idle'); } catch { /* ui only */ }
  }

  // MUST be called from a user gesture (mic press / voice activation / send).
  // Safe to call repeatedly; reuses the context afterwards. On success any
  // staged pre-activation audio is released to the worklet in order.
  async ensureFromGesture() {
    if (this.ready && this.context) {
      try {
        if (this.context.state === 'suspended') await this.context.resume();
        if (this.context.state === 'suspended') {
          this.blocked = true;
          return false;
        }
        this.blocked = false;
        this._drainStaged();
        return true;
      } catch (error) {
        this.blocked = true;
        this.initError = String(error?.message || error);
        return false;
      }
    }
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._init();
    const result = await this._initPromise;
    this._initPromise = null;
    return result;
  }

  _createContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    // Device default rate — never forced. Resampling happens explicitly
    // per chunk against context.sampleRate.
    return new Ctx();
  }

  async _init() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx || typeof AudioWorkletNode === 'undefined') {
        this.blocked = true;
        this.initError = 'AudioWorklet not available in this browser.';
        return false;
      }
      let context;
      try {
        context = this._createContext();
      } catch (error) {
        this.blocked = true;
        this.initError = `AudioContext creation failed: ${error?.message || error}`;
        return false;
      }
      this.context = context;
      this.contextRate = context.sampleRate || 0;
      if (context.state === 'suspended') {
        try { await context.resume(); } catch { /* gesture may still be missing */ }
      }
      if (context.state === 'suspended' || context.state === 'closed') {
        // NOT a silent failure: caller surfaces "Enable voice". Staged audio
        // is retained so the retry after a real gesture plays it.
        this.blocked = true;
        this.initError = `AudioContext ${context.state}; needs user gesture.`;
        return false;
      }
      // Same-origin static module first (best Firefox compatibility),
      // Blob-URL module as fallback. Either failure is explicit.
      let loaded = false;
      let loadError = '';
      try {
        await context.audioWorklet.addModule(VOICE_WORKLET_STATIC_URL);
        loaded = true;
      } catch (error) {
        loadError = String(error?.message || error);
        try {
          await context.audioWorklet.addModule(getVoiceWorkletUrl());
          loaded = true;
        } catch (error2) {
          loadError += `; blob fallback: ${error2?.message || error2}`;
        }
      }
      if (!loaded) {
        this.blocked = true;
        this.initError = `AudioWorklet load failed: ${loadError}`;
        return false;
      }
      let node;
      try {
        node = new AudioWorkletNode(context, VOICE_WORKLET_NAME, {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
      } catch (error) {
        this.blocked = true;
        this.initError = `AudioWorkletNode failed: ${error?.message || error}`;
        return false;
      }
      node.port.onmessage = (event) => {
        if (event?.data?.type === 'stats') {
          const stats = event.data;
          this.counters.renderedFrames = Number(stats.rendered) || 0;
          this.underruns = Number(stats.underruns) || 0;
          this.counters.workletDropped = Number(stats.dropped) || 0;
          this.counters.starvationGaps = Number(stats.gaps) || 0;
          try { this.onStats?.({ ...this.counters }); } catch { /* telemetry only */ }
          if (this.counters.renderedFrames > 0 && this.playbackStartAt == null) {
            this.playbackStartAt = Date.now();
          }
        }
      };
      node.connect(context.destination);
      this.workletNode = node;
      this.ready = true;
      this.blocked = false;
      this.initError = null;
      this._drainStaged();
      return true;
    } catch (error) {
      this.blocked = true;
      this.initError = String(error?.message || error);
      return false;
    }
  }

  async resume() {
    try {
      if (this.context && this.context.state === 'suspended') {
        await this.context.resume();
      }
      if (this.context && this.context.state === 'closed') {
        this.ready = false;
        this.workletNode = null;
        this.blocked = true;
        return false;
      }
      this.blocked = this.context ? this.context.state === 'suspended' : true;
      if (!this.blocked) this._drainStaged();
      return !this.blocked;
    } catch {
      return false;
    }
  }

  // A new response started server-side (voice:tts:start). Adopt its stream id
  // so a previously COMPLETED stream's id can never starve the new one:
  // endStream() intentionally keeps the id for trailing in-flight grace, so
  // without this adoption every turn after the first would be dropped as
  // stale and the browser would stay silent. Never touches queued audio —
  // adoption only affects which FUTURE chunks are accepted.
  startStream(streamId = null) {
    if (streamId && streamId !== this.currentStreamId) {
      this.currentStreamId = streamId;
      this.lastSeqByStream.clear();
    }
  }

  // Primary ingest: explicit metadata, sequence validation, resampling,
  // pre-roll. Returns 'played' | 'staged' | 'dropped-stale' | false.
  ingestSocketPayload(payload) {
    const bytes = normalizeSocketAudioChunk(payload);
    if (!bytes || !bytes.length) return false;
    const streamId = payload?.streamId ?? null;
    const seq = Number(payload?.seq ?? payload?.chunkIndex ?? NaN);
    const format = payload?.format || {};
    const sourceRate = Number(format.sampleRate) || 0;
    if (!sourceRate) this.counters.assumedRate += 1;
    const encoding = String(format.encoding || format.codec || 'pcm16').toLowerCase();
    const channels = Number(format.channels) || 1;
    if ((encoding !== 'pcm16' && encoding !== 'pcm16le') || channels !== 1) {
      this.counters.formatMismatch += 1;
      return false;
    }
    // Stale-stream rejection: audio from a cancelled/superseded stream is
    // never played (interruption safety).
    if (this.currentStreamId && streamId && streamId !== this.currentStreamId) {
      this.counters.staleDropped += 1;
      return 'dropped-stale';
    }
    if (!this.currentStreamId && streamId) this.currentStreamId = streamId;
    // Sequence validation per stream.
    if (streamId && Number.isFinite(seq)) {
      const last = this.lastSeqByStream.get(streamId);
      if (last !== undefined) {
        if (seq === last) {
          this.counters.dupeCount += 1;
          return 'dropped-stale';
        }
        if (seq > last + 1) this.counters.gapCount += (seq - last - 1);
      }
      this.lastSeqByStream.set(streamId, seq);
    }
    if (this.firstChunkAt == null) this.firstChunkAt = Date.now();
    this.counters.receivedChunks += 1;
    this.counters.receivedBytes += bytes.length;
    // Not ready yet: STAGE (bounded) instead of dropping — the gesture that
    // unlocks the context releases staged audio in order.
    if (!this.ready || !this.workletNode) {
      if (this.stagedBytes + bytes.length > STAGE_CAP_BYTES) {
        this.stagedDropped += 1;
        return false;
      }
      this.staged.push({ bytes, sourceRate: sourceRate || VOICE_SOURCE_RATE });
      this.stagedBytes += bytes.length;
      return 'staged';
    }
    this._pushBytes(bytes, sourceRate || VOICE_SOURCE_RATE);
    return 'played';
  }

  _pushBytes(bytes, sourceRate) {
    const { samples, trimmed } = pcm16ToFloat32(bytes);
    if (trimmed) this.counters.trimmedBytes += trimmed;
    if (!samples.length) return false;
    if (this.firstChunkAt == null) this.firstChunkAt = Date.now();
    this.counters.receivedFrames += samples.length;
    const atRate = resampleFloat32(samples, sourceRate, this.contextRate || sourceRate);
    // Pre-roll / jitter buffer: accumulate until threshold or timeout.
    if (!this.preRollReleased) {
      this.preRoll.push(atRate);
      this.preRollSamples += atRate.length;
      if (this.preRollTimer == null) {
        this.preRollTimer = setTimeout(() => this._releasePreRoll(), PRE_ROLL_TIMEOUT_MS);
      }
      if (this.preRollSamples >= PRE_ROLL_SAMPLES) this._releasePreRoll();
      this._setPlaying(true);
      return true;
    }
    try {
      this.workletNode.port.postMessage({ type: 'push', samples: atRate }, [atRate.buffer]);
    } catch {
      return false;
    }
    this.queuedSamples += atRate.length;
    this._setPlaying(true);
    return true;
  }

  _releasePreRoll() {
    if (this.preRollReleased) return;
    this.preRollReleased = true;
    if (this.preRollTimer != null) {
      try { clearTimeout(this.preRollTimer); } catch { /* ignore */ }
      this.preRollTimer = null;
    }
    // Concatenate pre-roll into ONE push — chunk boundaries never become
    // audible gaps at speech onset.
    let total = 0;
    for (const part of this.preRoll) total += part.length;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const part of this.preRoll) {
      merged.set(part, offset);
      offset += part.length;
    }
    this.preRoll = [];
    this.preRollSamples = 0;
    if (total && this.workletNode) {
      try {
        this.workletNode.port.postMessage({ type: 'push', samples: merged }, [merged.buffer]);
        this.queuedSamples += total;
      } catch { /* teardown-safe */ }
    }
  }

  _drainStaged() {
    if (!this.ready || !this.workletNode) return;
    const entries = this.staged;
    this.staged = [];
    this.stagedBytes = 0;
    for (const entry of entries) {
      this._pushBytes(entry.bytes, entry.sourceRate);
    }
  }

  // Back-compat shims (diagnostic tone path + legacy callers).
  pushPcm16(bytes, sourceRate = VOICE_SOURCE_RATE) {
    if (!bytes) return false;
    if (this.firstChunkAt == null) this.firstChunkAt = Date.now();
    this.counters.receivedChunks += 1;
    this.counters.receivedBytes += bytes.length || bytes.byteLength || 0;
    if (!this.ready || !this.workletNode) {
      if (this.stagedBytes + bytes.length > STAGE_CAP_BYTES) return false;
      this.staged.push({ bytes, sourceRate });
      this.stagedBytes += bytes.length;
      if (this.firstChunkAt == null) this.firstChunkAt = Date.now();
      return true;
    }
    return this._pushBytes(bytes, sourceRate);
  }

  pushSocketPayload(payload) {
    const result = this.ingestSocketPayload(payload);
    return result === 'played' || result === 'staged';
  }

  // Immediate flush on interruption. Returns a Date.now() timestamp so
  // callers can measure interruptRequestedAt → audioActuallyStoppedAt on
  // one clock (<100ms perceived target).
  flush() {
    this.audioActuallyStoppedAt = Date.now();
    try {
      this.workletNode?.port?.postMessage({ type: 'flush' });
    } catch { /* teardown-safe */ }
    if (this.preRollTimer != null) {
      try { clearTimeout(this.preRollTimer); } catch { /* ignore */ }
      this.preRollTimer = null;
    }
    this.preRoll = [];
    this.preRollSamples = 0;
    this.preRollReleased = false;
    this.queuedSamples = 0;
    this.playbackStartAt = null;
    this.firstChunkAt = null;
    this.currentStreamId = null;
    this._setPlaying(false);
    return this.audioActuallyStoppedAt;
  }

  endStream(streamId = null) {
    // Segment/stream completion WITHOUT dropping state: trailing in-flight
    // chunks for the same stream are still accepted (grace). A NEW stream id
    // is adopted via startStream() (called on voice:tts:start) and only a
    // NEW stream id or cancel resets — so sequential completed turns keep
    // playing instead of going stale-silent.
    if (streamId && this.currentStreamId && streamId !== this.currentStreamId) return;
    this._releasePreRoll();
  }

  cancelStream() {
    this.lastSeqByStream.clear();
    this.staged = [];
    this.stagedBytes = 0;
    return this.flush();
  }

  requestStats() {
    return new Promise((resolve) => {
      try {
        if (!this.workletNode) {
          resolve({ ...this.counters, renderedFrames: 0 });
          return;
        }
        const handler = (event) => {
          if (event?.data?.type === 'stats') {
            try { this.workletNode.port.removeEventListener('message', handler); } catch { /* ignore */ }
            resolve({
              ...this.counters,
              received: Number(event.data.received) || 0,
              renderedFrames: Number(event.data.rendered) || 0,
              workletDropped: Number(event.data.dropped) || 0,
              underruns: Number(event.data.underruns) || 0,
              gaps: Number(event.data.gaps) || 0,
            });
          }
        };
        // MessagePort supports addEventListener in all target browsers.
        this.workletNode.port.addEventListener('message', handler);
        try { this.workletNode.port.start?.(); } catch { /* ignore */ }
        this.workletNode.port.postMessage({ type: 'getStats' });
        setTimeout(() => {
          try { this.workletNode.port.removeEventListener('message', handler); } catch { /* ignore */ }
          resolve({ ...this.counters });
        }, 1000);
      } catch {
        resolve({ ...this.counters });
      }
    });
  }

  markPlaybackIdle() {
    this._setPlaying(false);
  }

  getState() {
    return {
      ready: this.ready,
      blocked: this.blocked,
      playing: this.playing,
      underruns: this.underruns,
      contextState: this.context?.state || 'none',
      contextRate: this.contextRate || 0,
      initError: this.initError,
    };
  }

  getTelemetry() {
    return {
      underruns: this.underruns,
      firstChunkAt: this.firstChunkAt,
      playbackStartAt: this.playbackStartAt,
    };
  }

  // Full evidence object for the Firefox acceptance gate. Counts only.
  getDiagnostics() {
    let secure = null;
    try { secure = typeof window !== 'undefined' ? Boolean(window.isSecureContext) : null; } catch { /* ignore */ }
    return {
      secureContext: secure,
      audioWorkletAvailable: (() => { try { return typeof AudioWorkletNode !== 'undefined'; } catch { return false; } })(),
      contextState: this.context?.state || 'none',
      contextRate: this.contextRate || 0,
      sourceRate: VOICE_SOURCE_RATE,
      ready: this.ready,
      blocked: this.blocked,
      initError: this.initError,
      playing: this.playing,
      stagedEntries: this.staged.length,
      stagedBytes: this.stagedBytes,
      stagedDropped: this.stagedDropped,
      preRollReleased: this.preRollReleased,
      counters: { ...this.counters },
      firstChunkAt: this.firstChunkAt,
      playbackStartAt: this.playbackStartAt,
      audioActuallyStoppedAt: this.audioActuallyStoppedAt,
    };
  }

  dispose() {
    if (this.preRollTimer != null) {
      try { clearTimeout(this.preRollTimer); } catch { /* ignore */ }
      this.preRollTimer = null;
    }
    try { this.workletNode?.disconnect?.(); } catch { /* ignore */ }
    try { this.context?.close?.(); } catch { /* ignore */ }
    this.workletNode = null;
    this.context = null;
    this.ready = false;
    this._setPlaying(false);
  }
}
