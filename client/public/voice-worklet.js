/* ARC-AI voice playback worklet — static same-origin module.
 *
 * Voice Runtime 3.0. Served from /voice-worklet.js (same-origin, no blob:
 * maximally compatible with Firefox autoplay/worklet policies). The engine
 * tries this URL first and falls back to a Blob-URL module built from the
 * identical source. Both MUST stay in sync — client/tests/voiceRuntime
 * asserts protocol parity.
 *
 * Protocol (main thread → worklet):
 *   { type: 'push', samples: Float32Array }  incremental frames (context rate)
 *   { type: 'flush' }                        drop everything immediately
 *   { type: 'getStats' }                     request a stats report
 *
 * Protocol (worklet → main thread):
 *   { type: 'stats', received, rendered, dropped, underruns }
 *
 * The worklet is the authoritative streaming playback engine: bounded ring
 * buffer, continuous output across chunk boundaries, silence on underflow,
 * no allocation inside process().
 */
class ArcVoicePlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 30s ring buffer at the CONTEXT rate (set via init message or default).
    this.capacity = 48000 * 30;
    this.buffer = new Float32Array(this.capacity);
    this.writePos = 0;
    this.readPos = 0;
    this.available = 0;
    this.received = 0;
    this.rendered = 0;
    this.dropped = 0;
    this.underruns = 0;
    // Mid-stream starvation: transitions from "had audio" to empty AFTER
    // playback began. The acceptance gate asserts gaps <= 1 per stream
    // (drain at the very end counts once); idle silence never counts.
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
registerProcessor('arc-voice-playback-processor', ArcVoicePlaybackProcessor);
