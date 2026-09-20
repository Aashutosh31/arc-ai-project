// Voice Runtime 3.0 — speech normalization layer.
//
// assistant text → speech-normalized text → TTS
//
// Presentation-only: strips formatting the voice must never read aloud
// ("asterisk", "hash", "backtick", table pipes, link URLs, "colon") while
// preserving meaning. Text chat is untouched — this layer feeds ONLY the
// TTS input. Framework-free and DOM-free for unit tests.
const { toWellFormedUnicode } = require('../lib/llm/utils');

// ---- Deterministic pronunciation layer (ARC-AI) ----
//
// The product name must sound right in TTS regardless of provider or voice.
// We map EXACT spellings of the product name to one fixed spoken form BEFORE
// general abbreviation expansion, so "ARC-AI" is never read as "arc… eye" or
// reduced by the generic `\bAI\b → 'A I'` rule into "ARC- A I". Deterministic:
// no models, no lookup tables, exactly ONE authoritative transformation.
//
// Spoken outcome is script-aware: Hindi TTS (language starts with "hi")
// receives the Devanagari letter spelling it can pronounce naturally; every
// other language/voice gets the Latin letters. This transforms TTS INPUT only —
// visible chat text is never mutated.
const ARC_AI_PATTERN = /\bARC[\s\u002D\u2010-\u2015\u2212_]*A\.?I\.?(?![\p{L}\p{N}])/giu;

const arcAiPronunciation = (language = '') => {
  const base = String(language || '').toLowerCase();
  if (base.startsWith('hi')) return 'ए आर सी ए आई';
  return 'A R C A I';
};

const pronunciationNormalize = (text, language = '') => {
  const source = toWellFormedUnicode(String(text || ''));
  if (!ARC_AI_PATTERN.test(source)) return source;
  ARC_AI_PATTERN.lastIndex = 0;
  return source.replace(ARC_AI_PATTERN, () => arcAiPronunciation(language));
};

// Convert assistant prose into speakable prose. Meaning-preserving:
// headings become phrases, list markers become pauses, links keep their
// anchor text, code/URLs/tables are linearized or dropped.
const speechNormalize = (text, language = '') => {
  let out = toWellFormedUnicode(String(text || ''));

  // Fenced code blocks and inline code: never read literally.
  out = out.replace(/```[\s\S]*?```/g, ' ');
  out = out.replace(/`([^`]+)`/g, '$1');

  // Images: keep alt text, drop the URL.
  out = out.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '$1');
  // Links: keep anchor text, drop the URL.
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1');
  // Bare URLs: never read character-by-character.
  out = out.replace(/https?:\/\/[^\s]+/g, ' ');

  // ATX headings: "## Options" → "Options". Never say "hash".
  out = out.replace(/^#{1,6}\s+/gm, '');
  // Blockquotes: read the content, not the marker.
  out = out.replace(/^>\s?/gm, '');
  // Horizontal rules / separators.
  out = out.replace(/^\s*([-*_]\s*){3,}\s*$/gm, ' ');
  // Table rows: pipes become pauses, alignment rows vanish.
  out = out.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ' ');
  out = out.replace(/\|/g, ', ');
  // Bullets / ordered markers → natural pause phrasing.
  out = out.replace(/(^|\n)\s*[-*+]\s+/g, '$1');
  out = out.replace(/(^|\n)\s*\d+[.)]\s+/g, '$1');
  // Mid-prose ordered markers after a sentence end ("End. 2. Next" → "End. Next").
  out = out.replace(/([.!?]\s+)\d{1,2}[.)]\s+(?=[A-Z"“('])/g, '$1');
  // Bold/italic/strike markers.
  out = out.replace(/(\*\*|__)(.*?)\1/g, '$2');
  out = out.replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2');
  out = out.replace(/~~(.*?)~~/g, '$1');

  // Colons introducing lists read as a pause, not the word "colon".
  out = out.replace(/\s*:\s*\n/g, ', ');
  out = out.replace(/\s*:\s*$/g, '');
  // Semicolons read as short pauses.
  out = out.replace(/;/g, ',');

  // Deterministic product-name pronunciation: ARC-AI → "A R C A I" (or the
  // Devanagari letter form for Hindi TTS). BEFORE generic abbreviation
  // expansion so `\bAI\b → 'A I'` can never re-chunk the spelled letters.
  out = pronunciationNormalize(out, language);

  // Common abbreviations that TTS mangles.
  const abbreviations = [
    [/\bP\.S\./gi, 'By the way'],
    [/\be\.g\./gi, 'for example'],
    [/\bi\.e\./gi, 'that is'],
    [/\betc\./gi, 'and so on'],
    [/\bvs\./gi, 'versus'],
    [/\bAI\b/g, 'A I'],
    [/\bAPI\b/g, 'A P I'],
    [/\bURL\b/gi, 'link'],
    [/\bNASA\b/g, 'Nasa'],
  ];
  for (const [pattern, replacement] of abbreviations) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(/&/g, ' and ');
  // "3.14" → "3 point 14".
  out = out.replace(/\b(\d+)\.(\d+)\b/g, '$1 point $2');

  // Emoji / pictographs: never spoken.
  out = out.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, ' ');
  // Leftover markdown punctuation.
  out = out.replace(/[*_#`|~<>^]/g, ' ');
  // Collapse shrieking punctuation, keep ONE natural pause.
  out = out.replace(/[!?]{2,}/g, '!');
  out = out.replace(/\.{3,}/g, '.');
  out = out.replace(/,\s*,+/g, ', ');
  out = out.replace(/\s*([,;:.!?])\s*/g, '$1 ');
  out = out.replace(/\s{2,}/g, ' ');
  return out.trim();
};

// Bounded SEMANTIC chunking for continuous synthesis.
//
// Steady-state chunks are multi-sentence (target ~200 chars) so each
// synthesis request carries enough context for natural prosody. The FIRST
// chunk of a response is special: a fast path emits the first complete
// sentence (60-220 chars) as soon as it is available, so speech starts
// while the LLM is still generating — instead of waiting for ~500 chars.
// Steady chunks stay small enough that each synthesis roundtrip (~1s)
// finishes well before the previous chunk's audio (~4s) drains, keeping
// the sequential chain ahead of playback with no mid-response gaps.
// Boundaries prefer, in order: paragraph break, sentence end, clause pause,
// word boundary. Never splits mid-word. A single over-long sentence falls
// back to clause splits, then word packing at the hard cap.
const SEMANTIC_TARGET = 200;
const SEMANTIC_MAX = 320;

// First-speech fast path: emit the first complete sentence once it is
// available, bounded so openers never synthesize as lonely 1-2 word blips
// ("Absolutely." merges forward) and runaway sentences stay intact.
// Tuned for low first-audio latency: 40-120 chars natural opener, hard cap
// ~150 so nothing wanders beyond Sarvam's per-utterance max_chunk_length.
const FIRST_TARGET_MIN = 40;
const FIRST_TARGET_MAX = 150;

// Strong terminal punctuation across supported scripts (Latin + Devanagari
// danda/double-danda + Arabic question mark). Units must END with one of
// these (plus optional closing quotes) to be first-chunk eligible.
const STRONG_TERMINAL_RE = /[.?!।॥؟]["'”’)\]]?\s*$/;

const packWords = (value, max, segments) => {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  let buffer = '';
  for (const word of words) {
    const candidate = buffer ? `${buffer} ${word}` : word;
    if (candidate.length > max && buffer) {
      segments.push(buffer.trim());
      buffer = word;
    } else {
      buffer = candidate;
    }
  }
  if (buffer.trim()) segments.push(buffer.trim());
};

// Split NORMALIZED text into speakable semantic units (sentences/clauses).
// Multilingual: Latin terminals (. ? ! …) plus Devanagari danda (। ॥) plus
// Arabic question mark (؟). The lookahead accepts Latin (either case),
// Devanagari, and Arabic word starts so "है। कल" splits like "end. Next".
const splitSemanticUnits = (normalized) => {
  const units = [];
  // Paragraphs first — natural longer pauses live here.
  const paragraphs = String(normalized || '').split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean);
  for (const paragraph of paragraphs) {
    const sentences = paragraph.split(/(?<=[.!?…।॥؟])\s+(?=[A-Za-z"“('0-9\u0900-\u097F\u0600-\u06FF])/g) || [paragraph];
    for (const sentence of sentences) {
      const trimmed = String(sentence || '').trim();
      if (!trimmed) continue;
      if (trimmed.length <= SEMANTIC_MAX) {
        units.push(trimmed);
        continue;
      }
      // Over-long sentence: clause splits, then word packing.
      const clauses = trimmed.split(/(?<=[,;:—–])\s+/);
      for (const clause of clauses) {
        const clauseText = String(clause || '').trim();
        if (!clauseText) continue;
        if (clauseText.length <= SEMANTIC_MAX) units.push(clauseText);
        else packWords(clauseText, SEMANTIC_MAX, units);
      }
    }
  }
  return units.filter(Boolean);
};

// Group semantic units into synthesis chunks around SEMANTIC_TARGET.
// Units are never split to hit the target — a chunk may exceed it when a
// single unit is long; small units accumulate. Headlines/short openers
// merge forward so "Here are three options:" never synthesizes alone.
const chunkSemanticUnits = (units, { target = SEMANTIC_TARGET, max = SEMANTIC_MAX } = {}) => {
  const chunks = [];
  let buffer = '';
  const flush = () => {
    if (buffer.trim()) chunks.push(buffer.trim());
    buffer = '';
  };
  for (const unit of units) {
    const candidate = buffer ? `${buffer} ${unit}` : unit;
    // Merge-forward: a short opener (<80 chars ending in ':') always joins
    // the next unit so list intros sound like one natural phrase.
    const isOpener = buffer && buffer.length < 80 && /[:,]$/.test(buffer.trim());
    if (!buffer || candidate.length <= target || isOpener) {
      buffer = candidate;
      continue;
    }
    if (buffer.length >= target * 0.5) {
      flush();
      buffer = unit;
    } else {
      // Buffer too small to stand alone (would roboticize): allow overflow.
      buffer = candidate;
    }
  }
  flush();
  // Hard-cap anything still oversized without touching word integrity.
  const capped = [];
  for (const chunk of chunks) {
    if (chunk.length <= max + 80) capped.push(chunk);
    else packWords(chunk, max, capped);
  }
  return capped.filter(Boolean);
};

// Incremental semantic buffer for live LLM deltas: accumulates normalized
// text, emits synthesis-sized chunks only at safe boundaries. Token-by-token
// synthesis is structurally impossible here — output requires a boundary.
// The FIRST emission takes a fast path (first complete sentence, 60-220
// chars) so speech starts while the LLM is still generating; steady state
// then continues at SEMANTIC_TARGET.
class SemanticTtsBuffer {
  constructor({ target = SEMANTIC_TARGET, max = SEMANTIC_MAX, language = '' } = {}) {
    this.target = target;
    this.max = max;
    this.language = language;
    this.buffer = '';
    this.emittedFirst = false;
  }
  // Fast path: first complete sentence available. Rule ordering for a live
  // LLM stream (the buffered/flush path shares this code but only sees whole
  // multi-sentence responses):
  //   1. Single complete sentence in the buffer -> emit it NOW. Streams often
  //      deliver a short answer as fragment deltas ("Yes," / " I can hear
  //      you!"); requiring a second unit had stalled these until flush().
  //      We only ever stop a sentence at a strong terminal, so this is provably
  //      a finished utterance and cannot be silently partial.
  //   2. Multiple units: short (< FIRST_TARGET_MIN) complete openers merge
  //      forward ONLY when the next sentence is already complete and the pair
  //      stays bounded; otherwise the known-complete opener is emitted right
  //      away (a growing next sentence must not delay the first speech).
  _extractFirst() {
    const units = splitSemanticUnits(this.buffer);
    if (units.length === 0) return null;
    const [first, second, ...rest] = units;
    if (!STRONG_TERMINAL_RE.test(first)) return null;
    if (units.length === 1) {
      this.buffer = '';
      this.emittedFirst = true;
      return first;
    }
    if (first.length >= FIRST_TARGET_MIN) {
      this.buffer = [second, ...rest].join(' ');
      this.emittedFirst = true;
      return first;
    }
    const merged = `${first} ${second}`;
    if (STRONG_TERMINAL_RE.test(second) && merged.length <= FIRST_TARGET_MAX) {
      this.buffer = rest.join(' ');
      this.emittedFirst = true;
      return merged;
    }
    // Short opener without a mergeable partner: speak the known-complete
    // first unit now; the streaming second unit stays buffered as steady
    // state and will join the next chunk.
    this.buffer = [second, ...rest].join(' ');
    this.emittedFirst = true;
    return first;
  }
  push(delta) {
    if (!delta) return [];
    this.buffer += (this.buffer ? ' ' : '') + speechNormalize(delta, this.language);
    this.buffer = this.buffer.replace(/\s{2,}/g, ' ').trim();
    if (!this.emittedFirst) {
      const fast = this._extractFirst();
      if (fast) return [fast];
    }
    if (this.buffer.length < this.target) return [];
    const units = splitSemanticUnits(this.buffer);
    if (units.length <= 1) {
      // One long unit without a boundary yet: split only past the hard cap.
      if (this.buffer.length >= this.max + 80) {
        const cut = this.buffer.lastIndexOf(',', this.max);
        const at = cut > 120 ? cut + 1 : this.max;
        const piece = this.buffer.slice(0, at).trim();
        this.buffer = this.buffer.slice(at).trim();
        return piece ? [piece] : [];
      }
      return [];
    }
    // Hold the LAST unit back (it may still be growing); chunk the rest.
    const ready = units.slice(0, -1);
    const held = units[units.length - 1];
    const chunks = chunkSemanticUnits(ready, { target: this.target, max: this.max });
    this.buffer = held;
    return chunks;
  }
  flush() {
    const remainder = String(this.buffer || '').trim();
    this.buffer = '';
    if (!remainder) return [];
    return chunkSemanticUnits(splitSemanticUnits(remainder), { target: this.target, max: this.max });
  }
  reset() {
    this.buffer = '';
    this.emittedFirst = false;
  }
}

module.exports = {
  speechNormalize,
  pronunciationNormalize,
  ARC_AI_PATTERN,
  arcAiPronunciation,
  splitSemanticUnits,
  chunkSemanticUnits,
  SemanticTtsBuffer,
  SEMANTIC_TARGET,
  SEMANTIC_MAX,
  FIRST_TARGET_MIN,
  FIRST_TARGET_MAX,
  STRONG_TERMINAL_RE,
};
