// Server-side text-to-speech (opt-in) for browser-agnostic voice output.
//
// Architecture:
//   LLM chunk stream → TtsStreamBuffer → sentence/phrase boundary detection
//   → Gemini TTS per segment → `ai:tts:audio` socket events (base64 WAV)
//   → client audio queue → standard HTMLAudioElement playback.
//
// The browser only needs standard audio playback — no speechSynthesis voices
// required. When server TTS is disabled (default) or unavailable, the client
// keeps its existing browser speechSynthesis path unchanged.
//
// Env:
//   TTS_PROVIDER=browser (default) | gemini
//   TTS_MODEL=gemini-2.5-flash-preview-tts
//   TTS_VOICE=Kore
// Reuses GEMINI_API_KEY. Never logs keys, audio, or message text.
const { GoogleGenAI } = require('@google/genai');
const { toWellFormedUnicode } = require('../lib/llm/utils');

const getTtsMode = () => String(process.env.TTS_PROVIDER || 'browser').trim().toLowerCase();

const isServerTtsActive = () => getTtsMode() === 'gemini' && Boolean(process.env.GEMINI_API_KEY);

const getTtsModel = () => process.env.TTS_MODEL || 'gemini-2.5-flash-preview-tts';

const getTtsVoice = () => process.env.TTS_VOICE || 'Kore';

let cachedClient = null;
const getClient = () => {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('Server TTS is not configured (GEMINI_API_KEY missing).');
  }
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return cachedClient;
};

// Strip markdown/code/URLs so the voice never reads formatting literally.
const cleanTextForSpeech = (text) => {
  let cleaned = toWellFormedUnicode(String(text || ''));
  cleaned = cleaned.replace(/```[\s\S]*?```/g, ' ');
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  cleaned = cleaned.replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g, '$1');
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, ' ');
  cleaned = cleaned.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, ' ');
  cleaned = cleaned.replace(/[*_#`|~<>^]/g, ' ');
  cleaned = cleaned.replace(/&/g, ' and ');
  cleaned = cleaned.replace(/\s{2,}/g, ' ');
  return cleaned.trim();
};

// Split cleaned text into speakable segments: sentence ends first, then
// clause boundaries, then a hard character cap. Never split mid-word.
const splitIntoSpeechSegments = (text, { maxLength = 220 } = {}) => {
  const cleaned = cleanTextForSpeech(text);
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

// Wrap raw 16-bit PCM mono base64 as a WAV base64 payload. Gemini TTS returns
// raw PCM (24kHz mono); WAV framing lets every browser play it with a plain
// HTMLAudioElement — no codec negotiation, no MediaSource needed.
const pcm16ToWavBase64 = (pcmBase64, { sampleRate = 24000, channels = 1 } = {}) => {
  const pcm = Buffer.from(String(pcmBase64 || ''), 'base64');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString('base64');
};

const extractAudioBase64 = (response) => {
  const candidates = response?.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      const data = part?.inlineData?.data;
      if (data) return String(data);
    }
  }
  return '';
};

// Synthesize one speakable segment. Throws safe, key-free errors on failure
// so callers can skip the segment and keep the queue moving.
const synthesizeSegment = async (text, { signal = null, voice = null, model = null } = {}) => {
  const cleanText = cleanTextForSpeech(text);
  if (!cleanText) {
    const error = new Error('Nothing speakable in TTS segment.');
    error.statusCode = 400;
    throw error;
  }

  const client = getClient();
  const startedAt = Date.now();
  const response = await client.models.generateContent({
    model: model || getTtsModel(),
    contents: [{ role: 'user', parts: [{ text: `Say naturally, conversationally: ${cleanText}` }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice || getTtsVoice() }
        }
      },
      abortSignal: signal || undefined
    }
  });

  const pcmBase64 = extractAudioBase64(response);
  if (!pcmBase64) {
    const error = new Error('TTS provider returned no audio.');
    error.statusCode = 502;
    throw error;
  }

  return {
    audioBase64: pcm16ToWavBase64(pcmBase64),
    mimeType: 'audio/wav',
    voice: voice || getTtsVoice(),
    model: model || getTtsModel(),
    latencyMs: Date.now() - startedAt
  };
};

// Buffers LLM text, extracts complete speakable segments at natural
// boundaries, and synthesizes them in order in the background. Socket audio
// delivery never blocks text delivery: push() only enqueues; synthesis runs
// on an internal chain. A single failed segment is skipped (logged) without
// stopping the queue; abort/interrupt stops everything and tells the client
// to flush via `ai:tts:audio:stop`.
class TtsStreamBuffer {
  constructor({ socket = null, signal = null, synthesize = null } = {}) {
    this.socket = socket;
    this.signal = signal;
    this.synthesize = typeof synthesize === 'function' ? synthesize : synthesizeSegment;
    this.buffer = '';
    this.segmentIndex = 0;
    this.chain = Promise.resolve();
    this.stopped = false;
    this.audioStartedAt = null;
  }

  extractCompleteSegments() {
    // A segment is complete at a sentence end, or when the buffer grows past
    // the cap (split at the last clause boundary so we never cut mid-word).
    const segments = [];
    const sentenceMatch = this.buffer.match(/^([\s\S]*?[.!?])(?=\s+[A-Z"“('0-9]|\s*$)/);
    if (sentenceMatch && sentenceMatch[1].trim().length >= 8) {
      segments.push(sentenceMatch[1].trim());
      this.buffer = this.buffer.slice(sentenceMatch[1].length).trim();
      return segments;
    }
    if (this.buffer.length >= 240) {
      const cut = this.buffer.lastIndexOf(',', 240);
      const at = cut > 80 ? cut + 1 : 240;
      const piece = this.buffer.slice(0, at).trim();
      if (piece) segments.push(piece);
      this.buffer = this.buffer.slice(at).trim();
    }
    return segments;
  }

  push(text) {
    if (this.stopped || !text) return;
    this.buffer += String(text);
    for (const segment of this.extractCompleteSegments()) {
      this.enqueueSegment(segment);
    }
  }

  enqueueSegment(segment) {
    const index = this.segmentIndex;
    this.segmentIndex += 1;
    this.chain = this.chain.then(async () => {
      if (this.stopped || (this.signal && this.signal.aborted)) return;
      try {
        const result = await this.synthesize(segment, { signal: this.signal });
        if (this.stopped || (this.signal && this.signal.aborted)) return;
        if (this.audioStartedAt == null) this.audioStartedAt = Date.now();
        if (this.socket) {
          this.socket.emit('ai:tts:audio', {
            index,
            audio: result.audioBase64,
            mimeType: result.mimeType || 'audio/wav',
            isFinal: false
          });
        }
      } catch (error) {
        // Skip the failed segment and keep the queue moving. Never expose
        // provider internals or keys — message only, truncated.
        console.warn('[TTS] segment synthesis failed, skipping:', String(error?.message || error).slice(0, 160));
      }
    });
  }

  async flush() {
    const remainder = String(this.buffer || '').trim();
    this.buffer = '';
    if (remainder && !this.stopped) {
      this.enqueueSegment(remainder);
    }
    await this.chain;
    if (!this.stopped && this.socket) {
      this.socket.emit('ai:tts:audio', { index: this.segmentIndex, audio: null, isFinal: true });
    }
  }

  stop() {
    this.stopped = true;
    this.buffer = '';
    if (this.socket) {
      this.socket.emit('ai:tts:audio:stop', { reason: 'interrupted' });
    }
  }
}

module.exports = {
  getTtsMode,
  isServerTtsActive,
  getTtsModel,
  getTtsVoice,
  cleanTextForSpeech,
  splitIntoSpeechSegments,
  pcm16ToWavBase64,
  synthesizeSegment,
  TtsStreamBuffer
};
