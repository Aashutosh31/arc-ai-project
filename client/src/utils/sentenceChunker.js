// Voice Runtime 2.0 — sentence/phrase chunker (shared pure logic).
//
// Pipeline: LLM text delta → chunker → TTS request → audio stream → worklet.
// Boundaries: sentence end, punctuation/short pause, bounded max length.
// Never splits mid-word. Framework-free so Node tests can import it.

export const DEFAULT_MAX_CHUNK = 220;

export const cleanTextForVoice = (text) => {
  let cleaned = String(text || '');
  cleaned = cleaned.replace(/```[\s\S]*?```/g, ' ');
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  cleaned = cleaned.replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g, '$1');
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, ' ');
  cleaned = cleaned.replace(
    /[😀-🙏🌀-🗿🚀-🛿🤀-🧿🏻-🏿☀-⛿✀-➿]/gu,
    ' '
  );
  cleaned = cleaned.replace(/[*_#`|~<>^]/g, ' ');
  cleaned = cleaned.replace(/&/g, ' and ');
  cleaned = cleaned.replace(/\s{2,}/g, ' ');
  return cleaned.trim();
};

export const splitIntoVoiceChunks = (text, { maxLength = DEFAULT_MAX_CHUNK } = {}) => {
  const cleaned = cleanTextForVoice(text);
  if (!cleaned) return [];
  const sentences = cleaned.split(/(?<=[.!?])\s+(?=[A-Z"“('0-9])/g) || [cleaned];
  const segments = [];
  const pushCapped = (value) => {
    const words = String(value || '').trim().split(/\s+/).filter(Boolean);
    let buffer = '';
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
    const trimmed = String(sentence || '').trim();
    if (!trimmed) continue;
    if (trimmed.length <= maxLength) {
      segments.push(trimmed);
      continue;
    }
    const clauses = trimmed.split(/(?<=[,;:])\s+/);
    for (const clause of clauses) {
      const clauseText = String(clause || '').trim();
      if (!clauseText) continue;
      if (clauseText.length <= maxLength) segments.push(clauseText);
      else pushCapped(clauseText);
    }
  }
  return segments.filter(Boolean);
};

// Incremental chunker for live LLM deltas: accumulates text, emits only
// complete sentences/phrases so TTS is never fed token-by-token.
export class SentenceStreamChunker {
  constructor({ maxLength = DEFAULT_MAX_CHUNK } = {}) {
    this.buffer = '';
    this.maxLength = maxLength;
  }
  push(delta) {
    if (!delta) return [];
    this.buffer += String(delta);
    const out = [];
    const sentenceMatch = this.buffer.match(/^([\s\S]*?[.!?])(?=\s+[A-Z"“('0-9]|\s*$)/);
    if (sentenceMatch && sentenceMatch[1].trim().length >= 8) {
      out.push(sentenceMatch[1].trim());
      this.buffer = this.buffer.slice(sentenceMatch[1].length).trim();
      return out;
    }
    if (this.buffer.length >= this.maxLength + 20) {
      const cut = this.buffer.lastIndexOf(',', this.maxLength + 20);
      const at = cut > 80 ? cut + 1 : this.maxLength + 20;
      const piece = this.buffer.slice(0, at).trim();
      if (piece) out.push(piece);
      this.buffer = this.buffer.slice(at).trim();
    }
    return out;
  }
  flush() {
    const remainder = String(this.buffer || '').trim();
    this.buffer = '';
    if (!remainder) return [];
    return splitIntoVoiceChunks(remainder, { maxLength: this.maxLength });
  }
  reset() {
    this.buffer = '';
  }
}
