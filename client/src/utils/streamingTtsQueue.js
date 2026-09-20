// Voice Runtime 2.0 — bounded streaming TTS queue.
//
//   sentence 1 → speaking
//   sentence 2 → generating / queued
//   sentence 3 → pending
//
// Bounded depth (default 4). Overflow drops the OLDEST pending segment
// (never the one playing) and counts the drop for telemetry.
// Interrupt cancels the active request via AbortSignal, clears pending,
// and resolves to listening. Framework-free for Node tests.

export const DEFAULT_QUEUE_DEPTH = 4;

export class StreamingTtsQueue {
  constructor({ maxDepth = DEFAULT_QUEUE_DEPTH, synthesize = null } = {}) {
    this.maxDepth = maxDepth;
    this.synthesize = typeof synthesize === 'function' ? synthesize : null;
    this.pending = [];
    this.activeController = null;
    this.activeIndex = 0;
    this.nextIndex = 0;
    this.dropped = 0;
    this.completed = 0;
    this.cancelled = false;
    this.onAudio = null;
    this.onEvent = null;
  }

  get depth() {
    return this.pending.length;
  }

  enqueue(text) {
    const clean = String(text || '').trim();
    if (!clean) return -1;
    if (this.pending.length >= this.maxDepth) {
      this.pending.shift();
      this.dropped += 1;
    }
    const index = this.nextIndex;
    this.nextIndex += 1;
    this.pending.push({ text: clean, index });
    try { this.onEvent?.({ type: 'queued', index }); } catch { /* telemetry only */ }
    this._pump();
    return index;
  }

  async _pump() {
    if (this.activeController || this.pending.length === 0) return;
    if (!this.synthesize) return;
    const next = this.pending.shift();
    const controller = new AbortController();
    this.activeController = controller;
    try { this.onEvent?.({ type: 'started', index: next.index }); } catch { /* ignore */ }
    try {
      const stream = this.synthesize(next.text, { signal: controller.signal, index: next.index });
      if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
        for await (const chunk of stream) {
          if (controller.signal.aborted) break;
          try { this.onAudio?.(chunk, next.index); } catch { /* ignore */ }
        }
      } else if (stream && stream.audio) {
        try { this.onAudio?.(stream.audio, next.index); } catch { /* ignore */ }
      }
      this.completed += 1;
      try { this.onEvent?.({ type: 'completed', index: next.index }); } catch { /* ignore */ }
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        try { this.onEvent?.({ type: 'cancelled', index: next.index }); } catch { /* ignore */ }
      } else {
        try { this.onEvent?.({ type: 'error', index: next.index, error }); } catch { /* ignore */ }
      }
    } finally {
      if (this.activeController === controller) this.activeController = null;
      this.activeIndex = Math.max(this.activeIndex, next.index + 1);
      if (!this.cancelled) this._pump();
      this.cancelled = false;
    }
  }

  // Interrupt: abort active synthesis, clear pending, flush audio.
  // Returns the number of cleared pending segments.
  interrupt() {
    this.cancelled = true;
    try { this.activeController?.abort(); } catch { /* ignore */ }
    this.activeController = null;
    const cleared = this.pending.length;
    this.pending = [];
    try { this.onEvent?.({ type: 'interrupted', cleared }); } catch { /* ignore */ }
    return cleared;
  }

  reset() {
    this.interrupt();
    this.activeIndex = 0;
    this.nextIndex = 0;
    this.dropped = 0;
    this.completed = 0;
    this.cancelled = false;
  }

  getStats() {
    return {
      pending: this.pending.length,
      dropped: this.dropped,
      completed: this.completed,
      active: Boolean(this.activeController),
    };
  }
}
