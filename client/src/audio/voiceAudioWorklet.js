// Voice Runtime 3.0 — AudioWorklet processor source + headless model.
//
// Runs off the main React thread. Bounded ring buffer, continuous output
// across chunk boundaries, silence on underflow, instant flush, no
// allocation inside process(). The worklet is rate-agnostic: it plays
// Float32 mono frames at the CONTEXT rate; the engine resamples the 24 kHz
// provider PCM up front so the worklet never guesses rates.
//
// Loading: the engine tries same-origin /voice-worklet.js first (best
// Firefox compatibility), then this Blob-URL module. Both MUST stay in
// sync — tests assert protocol parity. Capability-detected only, no
// browser-name branches anywhere in this path.
export const VOICE_WORKLET_NAME = 'arc-voice-playback-processor';
export const VOICE_WORKLET_STATIC_URL = '/voice-worklet.js';

export const VOICE_WORKLET_SOURCE = `
class ArcVoicePlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 48000 * 30;
    this.buffer = new Float32Array(this.capacity);
    this.writePos = 0;
    this.readPos = 0;
    this.available = 0;
    this.received = 0;
    this.rendered = 0;
    this.dropped = 0;
    this.underruns = 0;
    this.hadAudio = false;
    this.starved = false;
    this.gaps = 0;
    this.sinceReport = 0;
    this.port.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'push') {
        const input = msg.samples;
        if (input && input.length) {
          for (let i = 0; i < input.length; i += 1) {
            if (this.available >= this.capacity) {
              this.readPos = (this.readPos + 1) % this.capacity;
              this.available -= 1;
              this.dropped += 1;
            }
            this.buffer[this.writePos] = input[i];
            this.writePos = (this.writePos + 1) % this.capacity;
            this.available += 1;
          }
          this.received += input.length;
          this.hadAudio = true;
        }
      } else if (msg.type === 'flush') {
        this.writePos = 0;
        this.readPos = 0;
        this.available = 0;
        this.starved = false;
      } else if (msg.type === 'getStats') {
        this.port.postMessage({
          type: 'stats',
          received: this.received,
          rendered: this.rendered,
          dropped: this.dropped,
          underruns: this.underruns,
          gaps: this.gaps,
        });
        this.sinceReport = 0;
      }
    };
  }
  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output.length) return true;
    const channel = output[0];
    for (let i = 0; i < channel.length; i += 1) {
      if (this.available > 0) {
        channel[i] = this.buffer[this.readPos];
        this.readPos = (this.readPos + 1) % this.capacity;
        this.available -= 1;
        this.rendered += 1;
        this.starved = false;
      } else {
        channel[i] = 0;
        this.underruns += 1;
        if (this.hadAudio && !this.starved) {
          this.starved = true;
          this.gaps += 1;
        }
      }
    }
    this.sinceReport += channel.length;
    if (this.sinceReport >= 48000) {
      this.port.postMessage({
        type: 'stats',
        received: this.received,
        rendered: this.rendered,
        dropped: this.dropped,
        underruns: this.underruns,
        gaps: this.gaps,
      });
      this.sinceReport = 0;
    }
    return true;
  }
}
registerProcessor('${VOICE_WORKLET_NAME}', ArcVoicePlaybackProcessor);
`;

let cachedWorkletUrl = null;

export const getVoiceWorkletUrl = () => {
  if (cachedWorkletUrl) return cachedWorkletUrl;
  const blob = new Blob([VOICE_WORKLET_SOURCE], { type: 'application/javascript' });
  cachedWorkletUrl = URL.createObjectURL(blob);
  return cachedWorkletUrl;
};

// Headless ring-buffer mirror of the worklet logic for unit tests.
export class WorkletRingBufferModel {
  constructor(capacity = 720000) {
    this.capacity = capacity;
    this.buffer = new Float32Array(capacity);
    this.writePos = 0;
    this.readPos = 0;
    this.available = 0;
    this.received = 0;
    this.rendered = 0;
    this.dropped = 0;
    this.underruns = 0;
    this.hadAudio = false;
    this.starved = false;
    this.gaps = 0;
  }
  push(samples) {
    for (const sample of samples) {
      if (this.available >= this.capacity) {
        this.readPos = (this.readPos + 1) % this.capacity;
        this.available -= 1;
        this.dropped += 1;
      }
      this.buffer[this.writePos] = sample;
      this.writePos = (this.writePos + 1) % this.capacity;
      this.available += 1;
    }
    this.received += samples.length;
    if (samples.length) this.hadAudio = true;
  }
  pull(frames) {
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      if (this.available > 0) {
        out[i] = this.buffer[this.readPos];
        this.readPos = (this.readPos + 1) % this.capacity;
        this.available -= 1;
        this.rendered += 1;
        this.starved = false;
      } else {
        out[i] = 0;
        this.underruns += 1;
        if (this.hadAudio && !this.starved) {
          this.starved = true;
          this.gaps += 1;
        }
      }
    }
    return out;
  }
  flush() {
    this.writePos = 0;
    this.readPos = 0;
    this.available = 0;
    this.starved = false;
  }
  getStats() {
    return {
      received: this.received,
      rendered: this.rendered,
      dropped: this.dropped,
      underruns: this.underruns,
      gaps: this.gaps,
    };
  }
}
