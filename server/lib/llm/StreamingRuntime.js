const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toFiniteDelay = (value, fallbackMs) => {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallbackMs;
};

class StreamingRuntime {
  constructor(options = {}) {
    // Nullish default chain (NOT `||`): an explicitly configured 0 stays 0.
    // Unset/invalid values fall back to 0 — no artificial delay in production.
    // Set LLM_STREAM_CHUNK_DELAY_MS=20 to restore the simulated typing effect.
    const configured = options.chunkDelayMs ?? process.env.LLM_STREAM_CHUNK_DELAY_MS ?? 0;
    this.chunkDelayMs = toFiniteDelay(configured, 0);
  }

  // Background callbacks (e.g. DB persistence) must NEVER gate socket
  // delivery. They are chained per call so ordering is preserved, and any
  // rejection is captured and logged so persistence can neither slow down
  // nor break the response path. The call awaits the chain before resolving
  // so callers keep the "everything settled" guarantee without delaying emits.
  trackCallback(state, fn, ...args) {
    if (typeof fn !== 'function') return;
    state.pending = state.pending.then(() => fn(...args)).catch((error) => {
      console.warn('[StreamingRuntime] background callback failed:', error?.message || error);
    });
  }

  fireHook(hooks, name) {
    try {
      if (hooks && typeof hooks[name] === 'function') hooks[name]();
    } catch {
      // diagnostics must never break delivery
    }
  }

  async emitText(socket, text, signal = null, onChunk = null, hooks = {}) {
    if (!socket) return '';

    const safeText = String(text || '').trim();
    if (!safeText) {
      socket.emit('ai:tts:response:chunk', { chunk: '', displayText: '', isFinal: true });
      this.fireHook(hooks, 'onLastChunk');
      return '';
    }

    const state = { pending: Promise.resolve() };
    const words = safeText.split(' ');
    let emittedText = '';
    let firstChunkSent = false;

    try {
      for (const word of words) {
        if ((signal && signal.aborted) || socket.isInterrupted) {
          console.log('[StreamingRuntime] emitText interrupted');
          break;
        }
        const chunk = `${word} `;
        emittedText += chunk;
        // Socket delivery happens FIRST and never awaits persistence.
        socket.emit('ai:tts:response:chunk', { chunk, displayText: chunk, isFinal: false });
        if (!firstChunkSent) {
          firstChunkSent = true;
          this.fireHook(hooks, 'onFirstChunk');
        }

        this.trackCallback(state, onChunk, chunk, { text: chunk, isFinal: false });

        if (this.chunkDelayMs > 0) {
          await delay(this.chunkDelayMs);
        }
      }
    } finally {
      socket.emit('ai:tts:response:chunk', { chunk: '', displayText: '', isFinal: true });
      this.fireHook(hooks, 'onLastChunk');
      await state.pending;
    }

    return emittedText.trim();
  }

  async consume(stream, socket, signal = null, onChunk = null, hooks = {}) {
    let accumulatedText = '';

    if (!stream) {
      if (socket) {
        socket.emit('ai:tts:response:chunk', { chunk: '', displayText: '', isFinal: true });
      }
      this.fireHook(hooks, 'onLastChunk');
      return accumulatedText;
    }

    const state = { pending: Promise.resolve() };
    let firstChunkSent = false;

    try {
      for await (const chunk of stream) {
        if ((signal && signal.aborted) || (socket && socket.isInterrupted)) {
          console.log('[StreamingRuntime] consume interrupted');
          break;
        }

        // Preserve whitespace inside chunks; do not trim here. Frontend will safely concatenate.
        const text = String(chunk?.text || chunk?.chunk || chunk?.displayText || '');
        if (text === null || text === undefined) continue;
        if (text.length === 0) continue;

        accumulatedText += text;

        if (socket) {
          socket.emit('ai:tts:response:chunk', { chunk: text, displayText: text, isFinal: false });
          if (!firstChunkSent) {
            firstChunkSent = true;
            this.fireHook(hooks, 'onFirstChunk');
          }
        }

        this.trackCallback(state, onChunk, text, chunk);
      }
    } finally {
      if (socket) {
        socket.emit('ai:tts:response:chunk', { chunk: '', displayText: '', isFinal: true });
      }
      this.fireHook(hooks, 'onLastChunk');
      await state.pending;
    }

    return accumulatedText;
  }
}

module.exports = StreamingRuntime;
