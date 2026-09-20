/* Sarvam realtime STT unit tests (offline) — run with: node tests/sarvamStt.test.js
 *
 * Exercises the full STT session contract against an injected fake WebSocket
 * transport — no network, no credentials beyond a dummy key. Verifies the
 * resample→base64 wire frame, partial/final routing, VAD speech events, the
 * language metadata on finals, bounds gating, and lifecycle close/cancel.
 */

const assert = require('assert');
const { SarvamRealtimeSttProvider, SarvamSttSession } = require('../services/sarvamProvider');

const STT_MIC_FORMAT = { encoding: 'pcm16', codec: 'pcm_s16le', sampleRate: 24000, channels: 1, bitDepth: 16, endianness: 'le' };

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (err) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeWs {
  constructor() {
    this.sent = [];
    this.listeners = {};
    this.readyState = 0;
    this.opened = false;
    this.closedCode = null;
    this.closedReason = '';
  }
  on(event, cb) {
    (this.listeners[event] = this.listeners[event] || []).push(cb);
    return this;
  }
  emit(event, ...args) {
    for (const cb of this.listeners[event] || []) cb(...args);
  }
  send(text, cb) {
    this.sent.push(typeof text === 'string' ? JSON.parse(text) : text);
    if (cb) cb();
    return true;
  }
  openNow() {
    this.readyState = 1;
    this.opened = true;
    this.emit('open');
  }
  close(code = 1000, reason = '') {
    if (this.closedCode !== null) return;
    this.closedCode = code;
    this.closedReason = String(reason);
    this.emit('close', code, reason);
  }
  terminate() {
    if (this.closedCode === null) this.close(1006, 'terminate');
  }
  pushMessage(object) {
    this.emit('message', JSON.stringify(object));
  }
}

const framePcm = (bytes = 4800) => Buffer.alloc(bytes); // 100 ms of 24k mono silence

const setupEnv = () => {
  const prev = process.env.SARVAM_API_KEY;
  process.env.SARVAM_API_KEY = 'test-key';
  return () => {
    if (prev !== undefined) process.env.SARVAM_API_KEY = prev;
    else delete process.env.SARVAM_API_KEY;
  };
};

console.log('Sarvam STT Tests (offline)');
console.log('==========================');

let checkCount = 0;
const sessionChecks = [];

console.log('\n1. Wire format (24 kHz → Sarvam 16 kHz, base64)');
(async () => {
  const restore = setupEnv();
  try {
    const ws = new FakeWs();
    const provider = new SarvamRealtimeSttProvider({ transport: () => ws });
    const session = provider.createSession({});
    ws.openNow();
    const result = session.writeAudio({ audio: framePcm(), format: STT_MIC_FORMAT, seq: 0 });
    assert.strictEqual(result, true);
    await tick(20);
    assert.ok(ws.sent.some((m) => m.event === 'ping') === false);
    const input = ws.sent.find((m) => m.event === 'audio_input');
    assert.ok(input, 'audio_input was sent');
    const decodedBytes = Buffer.from(input.audio, 'base64');
    // 4800 bytes @ 24k = 100 ms → 3200 bytes @ 16k.
    assert.strictEqual(decodedBytes.length, 3200, `expected 3200-byte frame, got ${decodedBytes.length}`);
    const ack = input.audio.length === 4268; // ceil(3200*4/3) → ~4268 base64 chars (no padding overflow)
    assert.ok(ack, `base64 length sanity: ${input.audio.length}`);
    session.close();
    console.log('  PASS  frames ship as base64 16k linear16');
  } catch (err) {
    console.error('  FAIL  frames ship as base64 16k linear16');
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
  checkCount += 1;
  restore();
})();

console.log('\n2. Partial/final routing + language metadata');
(async () => {
  const restore = setupEnv();
  try {
    const ws = new FakeWs();
    const events = [];
    const provider = new SarvamRealtimeSttProvider({ transport: () => ws });
    const session = provider.createSession({
      onInterim: (t) => events.push(['interim', t]),
      onFinal: (t, meta) => events.push(['final', t, meta]),
      onComplete: (info) => events.push(['complete', info]),
    });
    ws.openNow();
    session.writeAudio({ audio: framePcm(), format: STT_MIC_FORMAT, seq: 0 });
    await tick(10);
    ws.pushMessage({ event: 'vad.speech_start' });
    ws.pushMessage({ event: 'transcript.partial', transcript: 'namaste', language: 'hi-IN' });
    ws.pushMessage({ event: 'transcript.partial', transcript: 'namaste bhai', language: 'hi-IN' });
    ws.pushMessage({ event: 'transcript.final', transcript: 'namaste bhai', language: 'hi-IN', language_confidence: 0.87 });
    await tick(10);
    assert.ok(events.some(([t]) => t === 'interim'), 'interim delivered');
    const final = events.find(([t]) => t === 'final');
    assert.ok(final, 'final delivered');
    assert.strictEqual(final[1], 'namaste bhai');
    assert.strictEqual(final[2].language, 'hi-IN');
    assert.strictEqual(final[2].languageConfidence, 0.87);
    session.close();
    console.log('  PASS  partial/final route with detected language + confidence');
  } catch (err) {
    console.error('  FAIL  partial/final route with detected language + confidence');
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
  checkCount += 1;
  restore();
})();

console.log('\n3. VAD backstop events');
(async () => {
  const restore = setupEnv();
  try {
    const ws = new FakeWs();
    let speechStarts = 0;
    let speechEnds = 0;
    const provider = new SarvamRealtimeSttProvider({ transport: () => ws });
    const session = provider.createSession({ onSpeechStart: () => { speechStarts += 1; }, onSpeechEnd: () => { speechEnds += 1; } });
    ws.openNow();
    session.writeAudio({ audio: framePcm(), format: STT_MIC_FORMAT, seq: 0 });
    await tick(10);
    ws.pushMessage({ event: 'vad.speech_start' });
    ws.pushMessage({ event: 'vad.speech_end' });
    await tick(10);
    assert.strictEqual(speechStarts, 1);
    assert.strictEqual(speechEnds, 1);
    session.close();
    console.log('  PASS  vad.speech_start/end surface as backstop events');
  } catch (err) {
    console.error('  FAIL  vad.speech_start/end surface as backstop events');
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
  checkCount += 1;
  restore();
})();

console.log('\n4a. Commit asks the server to finalize; server final wins');
(async () => {
  const restore = setupEnv();
  try {
    const ws = new FakeWs();
    const finals = [];
    const provider = new SarvamRealtimeSttProvider({ transport: () => ws, commitWaitMs: 2000 });
    const session = provider.createSession({ onFinal: (t, meta) => finals.push({ t, meta }) });
    ws.openNow();
    session.writeAudio({ audio: framePcm(), format: STT_MIC_FORMAT, seq: 0 });
    await tick(10);
    ws.pushMessage({ event: 'transcript.partial', text: 'interim arctic', language: 'en-IN' });
    await tick(10);
    const commitPromise = session.commit();
    await tick(5); // let {"event":"end"} flush before the server (fake) answers
    // Server answers the {"event":"end"} with a server-authored final.
    ws.pushMessage({ event: 'transcript.final', text: 'arctic expedition', language: 'en-IN', language_confidence: 0.94 });
    const committed = await commitPromise;
    assert.strictEqual(committed.committed, true);
    assert.strictEqual(committed.text, 'arctic expedition');
    assert.ok(ws.sent.some((m) => m.event === 'end'), 'commit sent {"event":"end"} to Sarvam');
    assert.strictEqual(finals.length, 1, 'final delivered exactly once');
    assert.strictEqual(finals[0].t, 'arctic expedition');
    assert.strictEqual(finals[0].meta.language, 'en-IN');
    assert.strictEqual(finals[0].meta.languageConfidence, 0.94);
    const again = await session.commit();
    assert.strictEqual(again.committed, false, 'second commit is a no-op');
    session.close();
    console.log('  PASS  commit requests server finalization; server final delivered');
  } catch (err) {
    console.error('  FAIL  commit requests server finalization; server final delivered');
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
  checkCount += 1;
  restore();
})();

console.log('\n4b. Commit guard: fallback final from freshest partial when server is silent');
(async () => {
  const restore = setupEnv();
  try {
    const ws = new FakeWs();
    const finals = [];
    const provider = new SarvamRealtimeSttProvider({ transport: () => ws, commitWaitMs: 60 });
    const session = provider.createSession({ onFinal: (t, meta) => finals.push({ t, meta }) });
    ws.openNow();
    session.writeAudio({ audio: framePcm(), format: STT_MIC_FORMAT, seq: 0 });
    await tick(10);
    ws.pushMessage({ event: 'transcript.partial', transcript: 'partial text', language: 'ta-IN' });
    await tick(10);
    const committed = await session.commit();
    assert.strictEqual(committed.committed, true);
    assert.strictEqual(committed.text, 'partial text');
    assert.strictEqual(finals.length, 1, 'final delivered exactly once');
    assert.strictEqual(finals[0].t, 'partial text');
    assert.strictEqual(finals[0].meta.language, 'ta-IN');
    // A server final arriving after commit is a no-op (never double-submit).
    ws.pushMessage({ event: 'transcript.final', transcript: 'server final', language: 'ta-IN' });
    const again = await session.commit();
    assert.strictEqual(again.committed, false);
    assert.strictEqual(finals.length, 1, 'final still delivered exactly once');
    session.close();
    console.log('  PASS  commit finalizes from freshest partial; late server final suppressed');
  } catch (err) {
    console.error('  FAIL  commit finalizes from freshest partial; late server final suppressed');
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
  checkCount += 1;
  restore();
})();

console.log('\n5. Bounds: format gate, byte ceiling, timeout');
(async () => {
  const restore = setupEnv();
  try {
    const ws = new FakeWs();
    let errorCode = null;
    const provider = new SarvamRealtimeSttProvider({ transport: () => ws });
    const session = provider.createSession({ onError: (e) => { errorCode = e?.code; } });
    ws.openNow();
    // Wrong format → rejected with VOICE_STT_FORMAT, session failed.
    const badFormat = session.writeAudio({ audio: framePcm(), format: { ...STT_MIC_FORMAT, sampleRate: 48000 }, seq: 0 });
    assert.strictEqual(badFormat, false);
    assert.strictEqual(errorCode, 'VOICE_STT_FORMAT');
    const session2 = provider.createSession({});
    ws.openNow();
    // Byte ceiling: 6 MB → fail before accepting.
    const big = Buffer.alloc(2);
    session2.writeAudio({ audio: framePcm(), format: STT_MIC_FORMAT, seq: 1 });
    // Force the byte counter near the ceiling, then exceed.
    session2.bytes = 6_000_000;
    const overflow = session2.writeAudio({ audio: big, format: STT_MIC_FORMAT, seq: 2 });
    assert.strictEqual(overflow, false);
    assert.strictEqual(session2.state, 'done');
    // Invalid seq (monotonicity) counted as seq fault, still accepted frame-wise.
    const session3 = provider.createSession({});
    ws.openNow();
    session3.writeAudio({ audio: framePcm(), format: STT_MIC_FORMAT, seq: 5 });
    session3.writeAudio({ audio: framePcm(), format: STT_MIC_FORMAT, seq: 2 }); // duplicate → dupSeq
    assert.strictEqual(session3.metrics.dupSeq, 1);
    session3.close();
    console.log('  PASS  format gate, byte ceiling, and seq duplicate counting');
  } catch (err) {
    console.error('  FAIL  format gate, byte ceiling, and seq duplicate counting');
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
  checkCount += 1;
  restore();
})();

console.log('\n6. Vendor error classification + close codes');
(async () => {
  const restore = setupEnv();
  try {
    const ws = new FakeWs();
    const errors = [];
    const provider = new SarvamRealtimeSttProvider({ transport: () => ws });
    const session = provider.createSession({ onError: (e) => errors.push(e) });
    ws.openNow();
    session.writeAudio({ audio: framePcm(), format: STT_MIC_FORMAT, seq: 0 });
    await tick(10);
    ws.pushMessage({ event: 'error', code: 4004, is_fatal: true, message: 'invalid model or language' });
    await tick(10);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'SARVAM_STT_ERROR');
    assert.strictEqual(session.state, 'done');
    const session2 = provider.createSession({ onError: (e) => errors.push(e) });
    ws.openNow();
    session2.writeAudio({ audio: framePcm(), format: STT_MIC_FORMAT, seq: 0 });
    await tick(10);
    ws.close(1003, 'quota exceeded for the subscription'); // fatal server close
    await tick(10);
    assert.strictEqual(errors[1].code, 'SARVAM_QUOTA_ERROR');
    session2.close();
    console.log('  PASS  error message + close codes classify to SARVAM_* codes');
  } catch (err) {
    console.error('  FAIL  error message + close codes classify to SARVAM_* codes');
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
  checkCount += 1;
  restore();
})();

console.log('\n7. Missing key → SARVAM_AUTH_ERROR');
(async () => {
  const prevKey = process.env.SARVAM_API_KEY;
  delete process.env.SARVAM_API_KEY;
  try {
    const provider = new SarvamRealtimeSttProvider({});
    const session = provider.createSession({ onError: () => {} });
    const err = await session._open().catch((e) => e);
    assert.ok(err && err.code === 'SARVAM_AUTH_ERROR', `expected SARVAM_AUTH_ERROR, got ${err?.code}`);
    console.log('  PASS  session fails fast with SARVAM_AUTH_ERROR when unconfigured');
  } catch (err) {
    console.error('  FAIL  session fails fast with SARVAM_AUTH_ERROR when unconfigured');
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
  if (prevKey !== undefined) process.env.SARVAM_API_KEY = prevKey;
  else delete process.env.SARVAM_API_KEY;
  checkCount += 1;
})();

(async () => {
  await tick(20);
  console.log(`\nAll Sarvam STT tests completed (${checkCount} async groups).`);
})();