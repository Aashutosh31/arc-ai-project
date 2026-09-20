// Voice Runtime FINAL — Sarvam speech provider (server-side credentials only).
//
// Implements the two provider contracts the voice runtime owns:
//
//   STT  SarvamRealtimeSttProvider → createSession({ onInterim, onFinal,
//        onError, onCancel, onComplete, onSpeechStart, onSpeechEnd, signal })
//              session.writeAudio({ audio, format, seq })   // 24k mono frames
//              session.commit()                             // client silence
//              session.cancel(reason) / session.close()
//
//   TTS  SarvamStreamingTtsProvider → startStream({ voice, language, format,
//        signal, onAudio, onError }) with writeText/flush/cancel/close via the
//        base provider (SemanticTtsBuffer chunking) plus ONE persistent
//        bulbul:v3 WebSocket per response.
//
// Design notes that matter:
//   * The ARC wire format is ALWAYS PCM16-LE mono 24 kHz. Sarvam STT wants
//     16 kHz linear16 and bulbul:v3 outputs 24 kHz linear16 — the adapter is
//     the only place that resamples, and the TTS side needs none at all.
//   * The API key is read on the server (SARVAM_API_KEY) and sent only in the
//     `api-subscription-key` header to api.sarvam.ai. It never reaches the
//     browser and is never logged.
//   * Errors are normalized to stable SARVAM_* codes (auth/quota/rate/
//     connection/STT/TTS/language/audio) so the fallback chain can decide
//     without parsing raw vendor text, and raw payloads are never surfaced.
//   * Barge-in: `vad.speech_start` is surfaced as onSpeechStart (coordinator
//     → `voice:stt:speech:start`). The TTS socket has no in-band cancel, so
//     interruption CLOSES the socket — the only server-side way to stop
//     generation — and an AbortError keeps that path silent to the user.
const { STT_SESSION_FORMAT, STT_FRAME_BYTES, STT_MAX_SESSION_BYTES, STT_MAX_SESSION_MS, STT_MAX_INTERIMS } = require('./sttService');
const { SARVAM_STT_SAMPLE_RATE, resamplePcm16Mono } = require('./sarvamAudio');
const { sarvamTtsLanguageCode, sarvamSttLanguageCode } = require('./sarvamLanguage');
const { BaseStreamingTtsProvider } = require('./voiceTtsProvider');

// ---- Endpoints (env-overridable for staging/tests) --------------------------
const getSttEndpoint = () => process.env.SARVAM_STT_ENDPOINT || 'wss://api.sarvam.ai/speech-to-text-realtime/ws';
const getTtsEndpoint = () => process.env.SARVAM_TTS_ENDPOINT || 'wss://api.sarvam.ai/text-to-speech/ws';

// ---- Env-config -------------------------------------------------------------
const isSarvamConfigured = () => Boolean(process.env.SARVAM_API_KEY);
const getSarvamApiKey = () => String(process.env.SARVAM_API_KEY || '');
const getSttModel = () => process.env.SARVAM_STT_MODEL || 'saaras:v3-realtime';
const getSttLanguage = () => sarvamSttLanguageCode(process.env.SARVAM_STT_LANGUAGE || 'auto');
const getSttStreamType = () => process.env.SARVAM_STT_STREAM_TYPE || 'fast';
const getSttEndpointing = () => process.env.SARVAM_STT_ENDPOINTING || 'vad';
// Turn-end latency lever: Sarvam commits a transcript after this much
// silence. 700 felt slow in the live voice path; 350 is the new default
// (tunable via SARVAM_STT_SILENCE_MS during A/B, kept above the ~250 minimum
// Sarvam respects so we never clip the speaker's last word).
const getSttSilenceMs = () => Number(process.env.SARVAM_STT_SILENCE_MS || 350);
const getSttMinSpeechMs = () => Number(process.env.SARVAM_STT_MIN_SPEECH_MS || 250);
const getTtsModel = () => process.env.SARVAM_TTS_MODEL || 'bulbul:v3';
const getTtsSpeaker = () => process.env.SARVAM_TTS_SPEAKER || 'shubh';
// Conversational latency levers (documented Sarvam ranges — never outside):
// min_buffer_size 30–200 (default 30): text Sarvam accumulates before
// processing. Our own chunking is the primary lever; this stays low so
// Sarvam adds no second hidden wait behind our segments.
// max_chunk_length 50–500 (default 150): Sarvam-side synthesis unit.
const getTtsMinBufferSize = () => {
  const n = Math.floor(Number(process.env.SARVAM_TTS_MIN_BUFFER_SIZE || 30));
  return Math.min(200, Math.max(30, Number.isFinite(n) ? n : 30));
};
const getTtsMaxChunkLength = () => {
  const n = Math.floor(Number(process.env.SARVAM_TTS_MAX_CHUNK_LENGTH || 150));
  return Math.min(500, Math.max(50, Number.isFinite(n) ? n : 150));
};
const TTS_PING_INTERVAL_MS = 25000;
const STT_PING_INTERVAL_MS = 25000;
const CONNECT_TIMEOUT_MS = 10000;
const TTS_SEGMENT_TIMEOUT_MS = 20000;

// ---- Normalized errors --------------------------------------------------------
const sarvaError = (code, message, extra = {}) => {
  const error = new Error(message);
  error.code = code;
  error.provider = 'sarvam';
  Object.assign(error, extra);
  return error;
};

const SARVAM_ERROR_CODES = Object.freeze([
  'SARVAM_AUTH_ERROR',
  'SARVAM_QUOTA_ERROR',
  'SARVAM_RATE_LIMIT',
  'SARVAM_CONNECTION_ERROR',
  'SARVAM_STT_ERROR',
  'SARVAM_TTS_ERROR',
  'SARVAM_UNSUPPORTED_LANGUAGE',
  'SARVAM_INVALID_AUDIO',
]);

const classifySarvamKind = ({ message = null, code = null } = {}) => {
  const text = `${String(code ?? '')} ${String(message ?? '')}`.toLowerCase();
  // Auth is matched SPECIFICALLY (api key / credentials / 401 | 403) — a plain
  // "invalid model or language" must never be mistaken for a key problem.
  if (/(unauthor|authentication|auth.?failed|apikey|api.?key|invalid (api|credential|key)|credential|401|403)/.test(text)) {
    return 'SARVAM_AUTH_ERROR';
  }
  if (/(quota|usage|billing|exhaust|spend|insufficient|free trial)/.test(text)) {
    return 'SARVAM_QUOTA_ERROR';
  }
  if (/(rate|429|too many|concurr)/.test(text)) {
    return 'SARVAM_RATE_LIMIT';
  }
  if (/(connection|network|refused|dns|timeout|1006|1011)/.test(text)) {
    return 'SARVAM_CONNECTION_ERROR';
  }
  return null;
};

const sarvaErrorFromMessage = (msg, fallbackCode) => {
  const kind = classifySarvamKind(msg || {});
  return sarvaError(kind || fallbackCode, String(msg?.message || 'Sarvam request failed.'), {
    providerDetail: {
      code: typeof msg?.code === 'number' ? msg.code : null,
      requestId: typeof msg?.request_id === 'string' ? msg.request_id.slice(0, 64) : null,
    },
  });
};

const sarvaErrorFromClose = (code, reason, fallbackCode) => {
  const reasonText = String(reason || '');
  if (code === 1003) {
    return sarvaError(classifySarvamKind({ message: reasonText }) || 'SARVAM_QUOTA_ERROR', reasonText || 'Sarvam closed the connection (quota or rate limit).', { retryable: false, closeCode: code });
  }
  if (code === 1008) {
    return sarvaError('SARVAM_CONNECTION_ERROR', reasonText || 'Sarvam closed an idle connection.', { retryable: true, closeCode: code });
  }
  if (code === 1011) {
    return sarvaError('SARVAM_CONNECTION_ERROR', reasonText || 'Sarvam reported an internal server error.', { retryable: true, closeCode: code });
  }
  if (code >= 4000 && code <= 4999) {
    return sarvaError(classifySarvamKind({ message: reasonText }) || fallbackCode, reasonText || 'Sarvam rejected the request.', { retryable: false, closeCode: code });
  }
  return sarvaError(fallbackCode, reasonText || 'Sarvam closed the connection unexpectedly.', { retryable: true, closeCode: code });
};

// ---- Transports ---------------------------------------------------------------
// connectSarvam opens a WebSocket (`ws`) with the server-side key, parses the
// JSON text frames the Sarvam endpoints use, and surfaces normalized events.
// A `transport` factory may be injected (tests) — it receives the same args and
// must resolve a ws-like handle (.send/.close/.terminate + ws.on('message'|...)).
const defaultTransport = (url, { apiKey }) => {
  const WebSocket = require('ws');
  return new WebSocket(url, { headers: { 'api-subscription-key': String(apiKey || '') } });
};

const connectSarvam = ({ url, apiKey = '', timeoutMs = CONNECT_TIMEOUT_MS, transport = null, onMessage = null, onClose = null, onError = null, onOpen = null } = {}) => {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(sarvaError('SARVAM_CONNECTION_ERROR', 'Timed out connecting to Sarvam.', { retryable: true }));
    }, timeoutMs);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { attach?.ws?.terminate?.(); } catch { /* ignore */ }
      reject(error);
    };
    const attach = (ws) => {
      if (!ws || typeof ws.send !== 'function') {
        fail(sarvaError('SARVAM_CONNECTION_ERROR', 'Invalid Sarvam transport.'));
        return;
      }
      attach.ws = ws;
      ws.on('message', (data, isBinary) => {
        if (typeof onMessage !== 'function') return;
        let parsed = null;
        try {
          const text = typeof data === 'string' ? data : String(data?.toString?.());
          parsed = JSON.parse(text);
        } catch { /* raw text or binary — passed through unparsed */ }
        try { onMessage(parsed, data); } catch { /* consumer-internal */ }
      });
      ws.on('error', (err) => {
        try { onError?.(err); } catch { /* ignore */ }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.terminate?.(); } catch { /* ignore */ }
        reject(sarvaError('SARVAM_CONNECTION_ERROR', 'Sarvam WebSocket error.', { cause: err, retryable: true }));
      });
      ws.on('close', (code, reason) => { try { onClose?.(code, String(reason || '')); } catch { /* ignore */ } });
      if (Number(ws.readyState) === 1) {
        settled = true;
        clearTimeout(timer);
        try { onOpen?.(ws); } catch { /* ignore */ }
        resolve(ws);
        return;
      }
      ws.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { onOpen?.(ws); } catch { /* ignore */ }
        resolve(ws);
      });
    };
    try {
      if (transport) {
        Promise.resolve(transport({ url, apiKey, onMessage, onClose, onError, onOpen }))
          .then(attach)
          .catch((err) => fail(sarvaError('SARVAM_CONNECTION_ERROR', 'Sarvam transport failed.', { cause: err, retryable: true })));
        return;
      }
      attach(defaultTransport(url, { apiKey }));
    } catch (err) {
      fail(sarvaError('SARVAM_CONNECTION_ERROR', 'Failed to open Sarvam WebSocket.', { cause: err, retryable: true }));
    }
  });
};

// =====================================================================
// STT — Sarvam realtime (saaras:v3-realtime / saaras:v4)
// =====================================================================
const buildSttUrl = () => {
  const query = new URLSearchParams();
  query.set('model', getSttModel());
  query.set('language_code', getSttLanguage());
  query.set('stream_type', getSttStreamType());
  query.set('endpointing', getSttEndpointing());
  query.set('silence_duration_ms', String(getSttSilenceMs()));
  query.set('min_speech_duration_ms', String(getSttMinSpeechMs()));
  return `${getSttEndpoint()}?${query.toString()}`;
};

class SarvamSttSession {
  constructor(options = {}) {
    this.onInterim = typeof options.onInterim === 'function' ? options.onInterim : null;
    this.onFinal = typeof options.onFinal === 'function' ? options.onFinal : null;
    this.onError = typeof options.onError === 'function' ? options.onError : null;
    this.onCancel = typeof options.onCancel === 'function' ? options.onCancel : null;
    this.onComplete = typeof options.onComplete === 'function' ? options.onComplete : null;
    this.onSpeechStart = typeof options.onSpeechStart === 'function' ? options.onSpeechStart : null;
    this.onSpeechEnd = typeof options.onSpeechEnd === 'function' ? options.onSpeechEnd : null;
    this.signal = options.signal || null;
    this.transport = options.transport || null;
    // Bounded, provider-independent vocabulary hints. The realtime API has no
    // vocabulary field; carried for parity and passed verbatim to nothing.
    this.vocabulary = Array.isArray(options.vocabulary) ? options.vocabulary.slice(0, 120) : null;
    // Bounded window (ms) commit() waits for the server-authored final after
    // sending {"event":"end"}. Configurable for offline tests.
    this.commitWaitMs = Math.max(0, Number.isFinite(options.commitWaitMs) ? options.commitWaitMs : 2500);

    this.state = 'active'; // active -> committing -> done
    this.bytes = 0;
    this.startedAt = Date.now();
    this.interimCount = 0;
    this.finalDelivered = false;
    this._lastSeq = null;
    this.ws = null;
    this._openPromise = null;
    this._sendChain = Promise.resolve();
    this._pingTimer = null;
    this.lastPartialText = '';
    this.detectedLanguage = null;
    this.languageConfidence = null;
    this.metrics = {
      framesReceived: 0,
      bytesReceived: 0,
      resampleSamples: 0,
      audioFramesSent: 0,
      interims: 0,
      finals: 0,
      speechStarts: 0,
      seqFaults: 0,
      dupSeq: 0,
      pings: 0,
    };
  }

  _alive() {
    return this.state === 'active' || this.state === 'committing';
  }

  // ---- connection ----------------------------------------------------------
  _open() {
    if (this.ws) return Promise.resolve(this.ws);
    if (this._openPromise) return this._openPromise;
    if (!isSarvamConfigured()) {
      this._openPromise = Promise.reject(
        sarvaError('SARVAM_AUTH_ERROR', 'Sarvam is not configured (SARVAM_API_KEY missing).')
      );
      return this._openPromise;
    }
    this._openPromise = connectSarvam({
      url: buildSttUrl(),
      apiKey: getSarvamApiKey(),
      transport: this.transport,
      onMessage: (msg) => this._handleMessage(msg),
      onClose: (code, reason) => this._handleClose(code, reason),
    })
      .then((ws) => {
        this.ws = ws;
        this._startPing();
        return ws;
      })
      .catch((err) => {
        if (this._alive()) this._fail(err);
        throw err;
      });
    return this._openPromise;
  }

  _startPing() {
    if (this._pingTimer) return;
    this._pingTimer = setInterval(() => {
      if (!this._alive() || !this.ws) return;
      this.metrics.pings += 1;
      this._send(JSON.stringify({ event: 'ping' }));
    }, STT_PING_INTERVAL_MS);
    if (this._pingTimer.unref) this._pingTimer.unref();
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _send(text) {
    this._sendChain = this._sendChain
      .then(() => {
        if (this.state === 'done' || !this.ws) return;
        return new Promise((resolve) => {
          try { this.ws.send(text, () => resolve()); } catch { resolve(); }
        });
      })
      .catch(() => {});
    return this._sendChain;
  }

  // ---- audio plumbing -------------------------------------------------------
  writeAudio({ audio = null, format = null, seq = null } = {}) {
    const buf = Buffer.isBuffer(audio) ? audio : (audio instanceof Uint8Array ? Buffer.from(audio) : Buffer.alloc(0));
    this.metrics.framesReceived += 1;
    if (buf.length) this.metrics.bytesReceived += buf.length;
    if (!this._alive()) {
      this.metrics.seqFaults += 1;
      return false;
    }
    if (!format || format.encoding !== 'pcm16' || Number(format.sampleRate) !== STT_SESSION_FORMAT.sampleRate
      || Number(format.channels) !== STT_SESSION_FORMAT.channels) {
      this.metrics.seqFaults += 1;
      const error = new Error('Unexpected audio format for this STT session.');
      error.code = 'VOICE_STT_FORMAT';
      this._fail(error);
      return false;
    }
    if (typeof seq === 'number') {
      if (this._lastSeq !== null && seq <= this._lastSeq) this.metrics.dupSeq += 1;
      else if (this._lastSeq !== null && seq > this._lastSeq + 1) this.metrics.seqFaults += 1;
      this._lastSeq = seq;
    } else {
      this.metrics.seqFaults += 1;
    }
    if (!buf.length) return true;
    if (this.bytes + buf.length > STT_MAX_SESSION_BYTES) {
      const error = new Error('Voice session exceeded the maximum audio length.');
      error.code = 'VOICE_STT_OVERFLOW';
      this._fail(error);
      return false;
    }
    if (Date.now() - this.startedAt > STT_MAX_SESSION_MS) {
      const error = new Error('Voice session exceeded the maximum duration.');
      error.code = 'VOICE_STT_OVERFLOW';
      this._fail(error);
      return false;
    }
    this.bytes += buf.length;
    this._streamFrame(buf);
    return true;
  }

  _streamFrame(buf) {
    const pcm16 = resamplePcm16Mono(buf, STT_SESSION_FORMAT.sampleRate, SARVAM_STT_SAMPLE_RATE);
    this.metrics.resampleSamples += Math.floor(pcm16.length / 2);
    if (!pcm16.length) return;
    this.metrics.audioFramesSent += 1;
    const b64 = pcm16.toString('base64');
    this._open()
      .then(() => {
        if (this.state !== 'active') return;
        this._send(JSON.stringify({ event: 'audio_input', audio: b64 }));
      })
      .catch(() => { /* surfaced via _open rejection → _fail */ });
  }

  // ---- server messages -------------------------------------------------------
  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const type = msg.event;
    switch (type) {
      case 'session.begin':
        break;
      case 'vad.speech_start':
        this.metrics.speechStarts += 1;
        try { this.onSpeechStart?.(); } catch { /* best effort */ }
        break;
      case 'vad.speech_end':
        try { this.onSpeechEnd?.(); } catch { /* best effort */ }
        break;
      case 'transcript.partial': {
        const text = String(msg.text ?? msg.transcript ?? '').trim();
        if (typeof msg.language === 'string' && msg.language) this.detectedLanguage = msg.language;
        if (text) this.lastPartialText = text;
        if (this.state === 'done') break;
        if (this.interimCount >= STT_MAX_INTERIMS) break;
        if (!text) break;
        this.interimCount += 1;
        this.metrics.interims += 1;
        try { this.onInterim?.(text); } catch { /* best effort */ }
        break;
      }
      case 'transcript.final': {
        const text = String(msg.text ?? msg.transcript ?? '').trim();
        if (typeof msg.language === 'string' && msg.language) this.detectedLanguage = msg.language;
        if (typeof msg.language_confidence === 'number') this.languageConfidence = msg.language_confidence;
        this._deliverFinal(text || this.lastPartialText, this.detectedLanguage, this.languageConfidence);
        break;
      }
      case 'error': {
        const err = sarvaErrorFromMessage(msg, 'SARVAM_STT_ERROR');
        if (msg?.is_fatal && this.state !== 'done') {
          this.state = 'done';
          this._stopPing();
        }
        try { this.onError?.(err); } catch { /* best effort */ }
        break;
      }
      case 'config.updated':
      case 'pong':
        break;
      case 'session.end':
        if (!this.finalDelivered && this.state !== 'done') {
          this._deliverFinal(this.lastPartialText, this.detectedLanguage, this.languageConfidence);
        }
        if (this.state !== 'done') {
          this.state = 'done';
          this._stopPing();
          try { this.onComplete?.({ ended: true }); } catch { /* best effort */ }
        }
        break;
      default:
        break;
    }
  }

  _handleClose(code, reason) {
    this._stopPing();
    if (this.state === 'done') return;
    if (code === 1000 || code === 1005) {
      this.state = 'done';
      try { this.onComplete?.({ ended: true }); } catch { /* best effort */ }
      return;
    }
    const err = sarvaErrorFromClose(code, reason, 'SARVAM_STT_ERROR');
    if (this._alive()) this._fail(err);
  }

  _deliverFinal(text, language, confidence) {
    if (this.finalDelivered || this.state === 'done') return false;
    this.finalDelivered = true;
    this.state = 'done';
    this._stopPing();
    this.lastPartialText = String(text || '').trim();
    if (language) this.detectedLanguage = language;
    this.finalText = this.lastPartialText;
    this.finalLanguage = this.detectedLanguage;
    this.finalLanguageConfidence = this.languageConfidence;
    this.metrics.finals += 1;
    try {
      this.onFinal?.(this.lastPartialText, {
        language: typeof language === 'string' ? language : null,
        languageConfidence: typeof confidence === 'number' ? confidence : null,
      });
    } catch { /* best effort */ }
    try { this.onComplete?.({ final: true }); } catch { /* best effort */ }
    return true;
  }

  // ---- lifecycle --------------------------------------------------------------
  // Client-side commit: ask Sarvam to finalize the utterance for us ({"event":
  // "end"} triggers vad.speech_end → transcript.final → session.end), then wait
  // a bounded window for the server-authored final. When the server never
  // finalizes (e.g. no speech or a dropped socket), the freshest partial
  // transcript is the backstop final.
  async commit() {
    if (this.state === 'done' || this.finalDelivered) return { committed: false, text: null };
    if (this.state === 'committing') return { committed: false, text: null };
    if (!this._alive()) {
      this.state = 'done';
      return { committed: false, text: null };
    }
    this.state = 'committing';
    try { await this._send(JSON.stringify({ event: 'end', audio: false })); } catch { /* best effort */ }
    const started = Date.now();
    while (!this.finalDelivered && Date.now() - started < this.commitWaitMs) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    if (this.finalDelivered) {
      return { committed: true, text: this.finalText || '' };
    }
    this._deliverFinal(this.lastPartialText, this.detectedLanguage, this.languageConfidence);
    return { committed: true, text: this.finalText || '' };
  }

  cancel(reason = 'cancelled') {
    if (!this._alive()) return;
    this.state = 'done';
    this._teardown();
    try { this.onCancel?.({ reason }); } catch { /* best effort */ }
    try { this.onComplete?.({ cancelled: true, reason }); } catch { /* best effort */ }
  }

  close() {
    this.state = 'done';
    this._teardown();
  }

  _fail(error) {
    if (this.state === 'done') return;
    this.state = 'done';
    this._teardown();
    try { this.onError?.(error); } catch { /* best effort */ }
    try { this.onComplete?.({ error: true, code: error?.code || 'SARVAM_STT_ERROR' }); } catch { /* best effort */ }
  }

  _teardown() {
    this._stopPing();
    const ws = this.ws;
    this.ws = null;
    this._openPromise = null;
    if (ws) {
      try { ws.close?.(1000, ''); } catch { /* ignore */ }
      try { ws.terminate?.(); } catch { /* ignore */ }
    }
    if (this.signal && this.signal.removeEventListener && this._onAbort) {
      this.signal.removeEventListener('abort', this._onAbort);
      this._onAbort = null;
    }
  }
}
class SarvamRealtimeSttProvider {
  constructor(options = {}) {
    this.kind = 'sarvam';
    this.options = options || {};
  }
  createSession(options) {
    return new SarvamSttSession({ ...this.options, ...options });
  }
}

// =====================================================================
// TTS — bulbul:v3 streaming (persistent WebSocket per response)
// =====================================================================
const buildTtsUrl = () => {
  const query = new URLSearchParams();
  query.set('model', getTtsModel());
  query.set('send_completion_event', 'true');
  return `${getTtsEndpoint()}?${query.toString()}`;
};

class SarvamStreamingTtsProvider extends BaseStreamingTtsProvider {
  constructor(options = {}) {
    super({ name: 'sarvam', voice: options.voice || getTtsSpeaker(), language: 'en-IN' });
    this.options = options || {};
    this._conn = null;
  }

  _speakerFor(voice) {
    const value = String(voice || '').trim();
    if (value && value.toLowerCase() !== 'kore') return value;
    return this.options.speaker || getTtsSpeaker();
  }

  _sendJson(conn, object) {
    if (!conn || !conn.alive || !conn.ws) return false;
    try { conn.ws.send(JSON.stringify(object)); return true; } catch { return false; }
  }

  async _ensureConnection({ voice = null, language = null }) {
    const resolvedLanguage = sarvamTtsLanguageCode(language || this.defaultLanguage);
    const resolvedVoice = this._speakerFor(voice);
    if (this._conn && this._conn.alive
      && this._conn.language === resolvedLanguage
      && this._conn.voice === resolvedVoice) {
      return this._conn;
    }
    return this._openConnection({ voice: resolvedVoice, language: resolvedLanguage });
  }

  async _openConnection({ voice, language }) {
    await this._closeConnection(false);
    if (!isSarvamConfigured()) {
      throw sarvaError('SARVAM_AUTH_ERROR', 'Sarvam is not configured (SARVAM_API_KEY missing).');
    }
    const conn = {
      voice,
      language,
      alive: false,
      ws: null,
      pending: null,
      pingTimer: null,
      connectedAt: Date.now(),
      firstTextAt: null,
      firstAudioAt: null,
    };
    const ws = await connectSarvam({
      url: buildTtsUrl(),
      apiKey: getSarvamApiKey(),
      transport: this.options.transport,
      onMessage: (msg) => this._onConnMessage(conn, msg),
      onClose: (code, reason) => this._onConnClose(conn, code, reason),
    });
    // Attach the socket first: config/audio send routing keys off conn.ws.
    conn.ws = ws;
    conn.alive = true;
    // Config first, always: mandatory speaker + language, linear16 @ 24 kHz to
    // match the ARC wire format, small buffers so short reply sentences stream.
    const configured = this._sendJson(conn, {
      type: 'config',
      data: {
        speaker: voice,
        language_code: language,
        output_audio_codec: 'linear16',
        speech_sample_rate: '24000',
        min_buffer_size: getTtsMinBufferSize(),
        max_chunk_length: getTtsMaxChunkLength(),
      },
    });
    if (!configured) {
      try { ws.close(1000, ''); } catch { /* ignore */ }
      throw sarvaError('SARVAM_TTS_ERROR', 'Sarvam TTS connection closed before configuration.');
    }
    conn.pingTimer = setInterval(() => {
      if (conn.alive) this._sendJson(conn, { type: 'ping' });
    }, TTS_PING_INTERVAL_MS);
    if (conn.pingTimer.unref) conn.pingTimer.unref();
    this._conn = conn;
    return conn;
  }

  _onConnMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'audio') {
      const pending = conn.pending;
      const base64 = msg?.data?.audio;
      if (conn.firstAudioAt == null) {
        conn.firstAudioAt = Date.now();
        try {
          // T8 marker: first synthesized audio chunk returned by Sarvam.
          console.log('[VoiceLatency] tts.firstAudio at=%d afterOpenMs=%d',
            conn.firstAudioAt,
            conn.connectedAt ? conn.firstAudioAt - conn.connectedAt : null);
        } catch { /* telemetry must never break synthesis */ }
      }
      if (pending && typeof base64 === 'string' && base64) {
        try { pending.chunks.push(Buffer.from(base64, 'base64')); } catch { /* base64 fail → skip chunk */ }
      }
      return;
    }
    if (msg.type === 'event' && msg.data?.event_type === 'final') {
      const pending = conn.pending;
      if (pending) pending.resolve(pending.chunks);
      return;
    }
    if (msg.type === 'error') {
      const pending = conn.pending;
      if (pending) pending.reject(sarvaErrorFromMessage(msg, 'SARVAM_TTS_ERROR'));
      return;
    }
    // 'audio'/'event'/'error' are the only server message types per the spec.
  }

  _onConnClose(conn, code, reason) {
    if (conn.pingTimer) { clearInterval(conn.pingTimer); conn.pingTimer = null; }
    conn.alive = false;
    if (conn === this._conn) this._conn = null;
    const pending = conn.pending;
    conn.pending = null;
    if (!pending) return;
    const abort = new Error('TTS stream cancelled.');
    abort.name = 'AbortError';
    abort.code = 'TTS_CANCELLED';
    if (code === 1000 || code === 1005) {
      pending.reject(abort);
    } else {
      pending.reject(sarvaErrorFromClose(code, reason, 'SARVAM_TTS_ERROR'));
    }
  }

  async _synthesizePcm(cleanText, { voice = null, language = null, signal = null } = {}) {
    const text = String(cleanText || '').trim();
    if (!text) {
      throw sarvaError('SARVAM_TTS_ERROR', 'Nothing speakable in TTS segment.');
    }
    const conn = await this._ensureConnection({ voice, language });
    const abortError = () => {
      const error = new Error('TTS stream cancelled.');
      error.name = 'AbortError';
      error.code = 'TTS_CANCELLED';
      return error;
    };
    if (signal && signal.aborted) throw abortError();
    if (!conn.alive) {
      throw sarvaError('SARVAM_TTS_ERROR', 'Sarvam TTS connection is not open.');
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const token = {};
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
        if (conn.pending === token) conn.pending = null;
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this._closeConnection().catch(() => {});
        reject(abortError());
      };
      conn.pending = {
        chunks: [],
        chars: text.length,
        resolve: (chunks) => {
          if (settled) return;
          settled = true;
          cleanup();
          // Bounded playback telemetry: counts only, never audio content.
          // chars = application-side segment size (double-buffering watch).
          try {
            const bytes = (chunks || []).reduce((sum, c) => sum + (c ? c.length : 0), 0);
            console.log('[SarvamTTS] segment ok chunks=%d chars=%d bytes=%d codec=linear16 rate=24000', (chunks || []).length, text.length, bytes);
          } catch { /* telemetry must never break synthesis */ }
          resolve(Buffer.concat(chunks || []));
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      };
      if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        conn.pending?.reject?.(sarvaError('SARVAM_TTS_ERROR', 'Sarvam TTS timed out while synthesizing a segment.', { retryable: true }));
      }, TTS_SEGMENT_TIMEOUT_MS);
      if (conn.firstTextAt == null) {
        conn.firstTextAt = Date.now();
        try {
          // T7 marker: first text segment submitted to Sarvam TTS.
          console.log('[VoiceLatency] tts.textSent at=%d afterOpenMs=%d',
            conn.firstTextAt,
            conn.connectedAt ? conn.firstTextAt - conn.connectedAt : null);
        } catch { /* telemetry must never break synthesis */ }
      }
      this._sendJson(conn, { type: 'text', data: { text } });
      this._sendJson(conn, { type: 'flush' });
    });
  }

  async _closeConnection(notifyPending = true) {
    const conn = this._conn;
    this._conn = null;
    if (!conn) return;
    if (conn.pingTimer) { clearInterval(conn.pingTimer); conn.pingTimer = null; }
    conn.alive = false;
    const pending = conn.pending;
    conn.pending = null;
    try { conn.ws?.close?.(1000, ''); } catch { /* ignore */ }
    try { conn.ws?.terminate?.(); } catch { /* ignore */ }
    if (pending && notifyPending) {
      const error = new Error('TTS stream cancelled.');
      error.name = 'AbortError';
      error.code = 'TTS_CANCELLED';
      try { pending.reject(error); } catch { /* ignore */ }
    }
  }

  // Override startStream to glue provider-level connection teardown onto the
  // base session lifecycle: cancel() (barge-in — close the socket, the only
  // way to stop synthesis) and close() (turn end — release the socket).
  startStream(options = {}) {
    const session = super.startStream(options);
    const provider = this;
    return {
      ...session,
      cancel() {
        try { session.cancel(); } catch { /* ignore */ }
        provider._closeConnection().catch(() => {});
      },
      async close() {
        try { await session.close(); } finally {
          await provider._closeConnection();
        }
      },
    };
  }
}

module.exports = {
  SARVAM_ERROR_CODES,
  sarvaError,
  classifySarvamKind,
  sarvaErrorFromMessage,
  sarvaErrorFromClose,
  connectSarvam,
  defaultTransport,
  isSarvamConfigured,
  getSarvamApiKey,
  buildSttUrl,
  buildTtsUrl,
  SarvamSttSession,
  SarvamRealtimeSttProvider,
  SarvamStreamingTtsProvider,
};