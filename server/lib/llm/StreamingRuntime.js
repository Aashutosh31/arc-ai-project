const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class StreamingRuntime {
  constructor(options = {}) {
    this.chunkDelayMs = Number(options.chunkDelayMs || process.env.LLM_STREAM_CHUNK_DELAY_MS || 20);
  }

  async emitText(socket, text, signal = null, onChunk = null) {
    if (!socket) return '';

    const safeText = String(text || '').trim();
    if (!safeText) {
      socket.emit('ai:tts:response:chunk', { chunk: '', displayText: '', isFinal: true });
      return '';
    }

    const words = safeText.split(' ');
    let emittedText = '';

    try {
      for (const word of words) {
        if ((signal && signal.aborted) || socket.isInterrupted) {
          console.log('[StreamingRuntime] emitText interrupted');
          break;
        }
        const chunk = `${word} `;
        emittedText += chunk;
        socket.emit('ai:tts:response:chunk', { chunk, displayText: chunk, isFinal: false });

        if (typeof onChunk === 'function') {
          await onChunk(chunk, { text: chunk, isFinal: false });
        }

        if (this.chunkDelayMs > 0) {
          await delay(this.chunkDelayMs);
        }
      }
    } finally {
      socket.emit('ai:tts:response:chunk', { chunk: '', displayText: '', isFinal: true });
    }

    return emittedText.trim();
  }

  async consume(stream, socket, signal = null, onChunk = null) {
    let accumulatedText = '';

    if (!stream) {
      if (socket) {
        socket.emit('ai:tts:response:chunk', { chunk: '', displayText: '', isFinal: true });
      }
      return accumulatedText;
    }

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
        }

        if (typeof onChunk === 'function') {
          await onChunk(text, chunk);
        }
      }
    } finally {
      if (socket) {
        socket.emit('ai:tts:response:chunk', { chunk: '', displayText: '', isFinal: true });
      }
    }

    return accumulatedText;
  }
}

module.exports = StreamingRuntime;