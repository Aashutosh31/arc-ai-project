// Voice Runtime FINAL — microphone input worklet module.
//
// Canonical worklet source lives in client/public/voice-mic-worklet.js and
// is duplicated here as VOICE_MIC_WORKLET_SOURCE for Blob fallback loading
// (best Firefox worklet compatibility).  The two files MUST stay identical;
// client/tests/voiceRuntime.test.mjs asserts parity.
//
// Exports:
//   VOICE_MIC_WORKLET_NAME  — processor name registered in the worklet
//   VOICE_MIC_WORKLET_SOURCE — raw source text (ES module inside worklet)
//   VOICE_MIC_FORMAT — explicit wire format every emitted frame carries

export const VOICE_MIC_WORKLET_NAME = 'arc-voice-mic-processor';

export const VOICE_MIC_FORMAT = Object.freeze({
  encoding: 'pcm16',
  codec: 'pcm_s16le',
  sampleRate: 24000,
  channels: 1,
  bitDepth: 16,
  endianness: 'le',
});

// Emitted by the worklet port.postMessage:
//   { type:'frames', seq, format, bytes: Int16Array }

export const VOICE_MIC_WORKLET_SOURCE = `// Voice Runtime FINAL — microphone input AudioWorklet.
// Canonical worklet source; copied to client/src/audio/voiceMicWorklet.js
// (as a string constant) and client/public/voice-mic-worklet.js (static file).
//
// Device default sample rate → deterministic 24 kHz mono PCM signed 16-bit
// little-endian framing, emitted via port.postMessage every 2400 resampled
// samples (100 ms of 24 kHz audio = 4800 bytes), with explicit format
// metadata + monotonic sequence number.
//
// In:  Float32Array blocks from the input AudioWorkletNode (128 samples
//      at the device sample rate).
// Out: ArrayBuffer-backed Int16Array transferred to the main thread.
//
// Controls:
//   port.onmessage { type: 'flush' }  — emit any remaining <2400 samples
//   port.onmessage { type: 'reset' }  — clear accumulator on utterance end
//
// Never infers format; every emitted frame carries the full contract:
//   encoding  'pcm16'
//   codec     'pcm_s16le'
//   sampleRate 24000
//   channels  1
//   bitDepth  16
//   endianness 'le'
//   seq       monotonic per-processor lifetime
/* global registerProcessor, sampleRate, AudioWorkletProcessor */

const TARGET_RATE = 24000;
const EMIT_EVERY_SAMPLES = 2400; // 100 ms at 24 kHz = 4800 bytes pcm16

// ---- Linear-interpolation resampler ------------------------------------
// One-sample granularity; carries fractional phase across process() blocks
// so block boundaries cause at most a single-sample interpolation error
// (inaudible and acceptable for transport framing).
class LinearResampler {
  constructor(srcRate = 48000, dstRate = TARGET_RATE) {
    this.ratio = dstRate / srcRate;
    this.f = 0;                // fractional source position within current block
    this.prev = 0;             // last source sample of previous block
    this.prevInit = false;
  }

  // Returns Float32Array of dstRate-resampled samples.
  process(block) {
    if (!block || !block.length) return new Float32Array(0);
    const srcLen = block.length;
    const outLen = Math.max(1, Math.round(srcLen * this.ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = this.f + i * (1 / this.ratio); // source position (float)
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      let a, b;
      if (i0 >= 0 && i0 < srcLen - 1) {
        a = block[i0];
        b = block[i0 + 1];
      } else if (i0 === srcLen - 1) {
        // Last valid source sample; hold or interpolate with next block's
        // first sample (unknown yet). Using the next source sample would
        // require block overlap; instead hold, which is standard practice.
        a = block[i0];
        b = a;
      } else if (!this.prevInit) {
        // Very first sample(s) before a previous block is available.
        a = block[0];
        b = block[Math.min(1, srcLen - 1)];
      } else {
        // Position before the current block (rare, happens only if ratio
        // skips past the first sample due to rounding). Use previous.
        a = this.prev;
        b = block[0];
      }
      out[i] = a + (b - a) * frac;
    }
    this.prev = block[srcLen - 1];
    this.prevInit = true;
    // Phase wrap: advance f by the distance covered in source units.
    // outLen/ratio is the number of source samples consumed.
    this.f += outLen / this.ratio - srcLen;
    // Wrap f into [0, srcLen) for next block.  In normal operation f ends
    // up in [0, 1) or slightly above due to rounding — clamp to avoid
    // negative drift.
    if (this.f < 0) this.f = 0;
    if (this.f > srcLen) this.f = srcLen - 0.001;
    return out;
  }
}

// ---- Processor ----------------------------------------------------------
registerProcessor('arc-voice-mic-processor', class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.srcRate = sampleRate || 48000;
    this.resampler = new LinearResampler(this.srcRate, TARGET_RATE);
    this.accum = new Float32Array(EMIT_EVERY_SAMPLES * 4); // headroom
    this.accLen = 0;
    this.seq = 0;
    this.port.onmessage = (e) => {
      if (e.data?.type === 'flush') this._flush();
      else if (e.data?.type === 'reset') { this.accLen = 0; this.seq = 0; }
    };
  }

  _emit(floatSamples) {
    if (!floatSamples || !floatSamples.length) return;
    // float32 [-1,1] → int16 PCM16 LE
    const int16 = new Int16Array(floatSamples.length);
    for (let i = 0; i < floatSamples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, floatSamples[i]));
      int16[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    }
    const format = {
      encoding: 'pcm16',
      codec: 'pcm_s16le',
      sampleRate: TARGET_RATE,
      channels: 1,
      bitDepth: 16,
      endianness: 'le',
    };
    try {
      this.port.postMessage(
        { type: 'frames', seq: this.seq++, format, bytes: int16 },
        [int16.buffer],
      );
    } catch {
      // postMessage may fail after processor shutdown; ignore.
    }
  }

  _flush() {
    if (this.accLen > 0) {
      this._emit(this.accum.subarray(0, this.accLen));
      this.accLen = 0;
    }
  }

  process(inputs) {
    const input = inputs?.[0]?.[0];
    if (!input || !input.length) return true;
    const resampled = this.resampler.process(input);
    if (!resampled.length) return true;

    // Accumulate and emit exactly once per EMIT_EVERY_SAMPLES.
    const need = EMIT_EVERY_SAMPLES - this.accLen;
    if (resampled.length >= need) {
      this.accum.set(resampled.subarray(0, need), this.accLen);
      this._emit(this.accum.subarray(0, EMIT_EVERY_SAMPLES));
      this.accLen = 0;
      // If there are leftover resampled samples beyond the emitted window,
      // carry them into the accumulator.  (Normally at most 0-1 samples.)
      const remain = resampled.length - need;
      if (remain > 0) {
        this.accum.set(resampled.subarray(need), 0);
        this.accLen = remain;
      }
    } else {
      this.accum.set(resampled, this.accLen);
      this.accLen += resampled.length;
    }
    return true;
  }
});`;
