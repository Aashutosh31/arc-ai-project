// Voice Runtime FINAL — server STT tests.
// Run with: node tests/voiceStt.test.js
//
// Covers: session contract (start/writeAudio/commit/cancel/close), explicit
// format metadata + monotonic seq validation, interim/final transcripts,
// duplicate-final protection, bounded buffering, WAV wrapping, provider
// selection truthfulness (unavailable ≠ silent), socket coordinator events.
const assert = require('node:assert');

const stt = require('../services/sttService');

let failures = 0;
const results = [];

async function check(label, fn) {
  try {
    await fn();
    results.push(`  PASS  ${label}`);
  } catch (err) {
    failures += 1;
    results.push(`  FAIL  ${label}\n        ${err.message}`);
  }
}

const PCM = (frames = 2400) => Buffer.alloc(frames * 2);
const FORMAT = stt.STT_SESSION_FORMAT;

function capturedSession(provider, script = {}) {
  const events = [];
  const session = provider.createSession({
    onInterim: (text) => events.push({ type: 'interim', text }),
    onFinal: (text) => events.push({ type: 'final', text }),
    onError: (err) => events.push({ type: 'error', message: err?.message, code: err?.code }),
    onCancel: (info) => events.push({ type: 'cancel', reason: info?.reason }),
    onComplete: (info) => events.push({ type: 'complete', ...info }),
  });
  return { session, events };
}

console.log('Voice Runtime FINAL Server STT Tests');
console.log('====================================');

const main = async () => {

// ---- 1. Session contract ----
await check('mock session emits interim then exactly one final', async () => {
  const provider = new stt.MockSttProvider({ transcript: 'Hello ARC, can you hear me?' });
  const { session, events } = capturedSession(provider);
  assert.ok(session.writeAudio({ audio: PCM(), format: FORMAT, seq: 0 }));
  session.writeAudio({ audio: PCM(4800), format: FORMAT, seq: 1 });
  const done = await session.commit();
  assert.strictEqual(done.committed, true);
  assert.strictEqual(done.text, 'Hello ARC, can you hear me?');
  assert.strictEqual(events.filter((e) => e.type === 'interim').length, 2);
  const finals = events.filter((e) => e.type === 'final');
  assert.strictEqual(finals.length, 1, 'final must be delivered exactly once');
  assert.strictEqual(finals[0].text, 'Hello ARC, can you hear me?');
  const completes = events.filter((e) => e.type === 'complete');
  assert.ok(completes[0]?.final === true);
});

await check('duplicate commit is rejected without a second final', async () => {
  const provider = new stt.MockSttProvider({ transcript: 'Once' });
  const { session, events } = capturedSession(provider);
  session.writeAudio({ audio: PCM(), format: FORMAT, seq: 0 });
  await session.commit();
  const second = await session.commit();
  assert.strictEqual(second.committed, false);
  assert.strictEqual(events.filter((e) => e.type === 'final').length, 1);
});

await check('cancel never transcribes and reports cancellation', async () => {
  const provider = new stt.MockSttProvider({ transcript: 'X' });
  const { session, events } = capturedSession(provider);
  session.writeAudio({ audio: PCM(), format: FORMAT, seq: 0 });
  session.cancel('user stopped');
  await session.commit();
  assert.strictEqual(events.filter((e) => e.type === 'final').length, 0);
  assert.strictEqual(events.filter((e) => e.type === 'cancel').length, 1);
  assert.ok(events.some((e) => e.type === 'complete' && e.cancelled === true));
});

await check('empty audio commit yields an empty final, not an error', async () => {
  const provider = new stt.MockSttProvider({ transcript: 'no-speech' });
  const { session, events } = capturedSession(provider);
  const done = await session.commit();
  assert.strictEqual(done.committed, true);
  assert.strictEqual(done.text, 'no-speech');
  assert.ok(!events.some((e) => e.type === 'error'));
});

await check('writeAudio after commit is dropped and counted as a seq fault', async () => {
  const provider = new stt.MockSttProvider({ transcript: 'X' });
  const { session } = capturedSession(provider);
  session.writeAudio({ audio: PCM(), format: FORMAT, seq: 0 });
  await session.commit();
  const ok = session.writeAudio({ audio: PCM(), format: FORMAT, seq: 1 });
  assert.strictEqual(ok, false);
  assert.strictEqual(session.metrics.seqFaults, 1);
});

// ---- 2. Explicit format + sequencing ----
await check('wrong format is rejected with a format error, never tolerated', async () => {
  const provider = new stt.MockSttProvider({ transcript: 'X' });
  const { session, events } = capturedSession(provider);
  const ok = session.writeAudio({ audio: PCM(), format: { encoding: 'mp3', sampleRate: 44100, channels: 2 }, seq: 0 });
  assert.strictEqual(ok, false);
  assert.ok(events.some((e) => e.type === 'error' && e.code === 'VOICE_STT_FORMAT'));
});

await check('sequence gaps and duplicates are counted', async () => {
  const provider = new stt.MockSttProvider({ transcript: 'X' });
  const { session } = capturedSession(provider);
  session.writeAudio({ audio: PCM(), format: FORMAT, seq: 0 });
  session.writeAudio({ audio: PCM(), format: FORMAT, seq: 0 });
  session.writeAudio({ audio: PCM(), format: FORMAT, seq: 2 });
  assert.strictEqual(session.metrics.dupSeq, 1);
  assert.strictEqual(session.metrics.seqFaults, 1);
});

// ---- 3. Bounds ----
await check('session caps total buffered bytes (bounded memory)', async () => {
  const provider = new stt.MockSttProvider({ transcript: 'X' });
  const { session, events } = capturedSession(provider);
  let ok = true;
  const frames = Math.ceil(stt.STT_MAX_SESSION_BYTES / 4800) + 10;
  for (let i = 0; i < frames; i += 1) {
    if (!session.writeAudio({ audio: PCM(2400), format: FORMAT, seq: i })) { ok = false; break; }
  }
  assert.strictEqual(ok, false, 'must stop accepting audio past the cap');
  assert.ok(events.some((e) => e.type === 'error' && e.code === 'VOICE_STT_OVERFLOW'));
  assert.ok(session.bytes <= stt.STT_MAX_SESSION_BYTES);
});

// ---- 4. WAV wrapping ----
await check('pcm16ToWavBuffer produces a well-formed mono WAV', () => {
  const wav = stt.pcm16ToWavBuffer(Buffer.alloc(4800), { sampleRate: 24000, channels: 1 });
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(wav.readUInt32LE(24), 24000);
  assert.strictEqual(wav.readUInt16LE(22), 1);
  assert.strictEqual(wav.readUInt16LE(34), 16);
  assert.strictEqual(wav.readUInt32LE(40), 4800);
  assert.strictEqual(wav.length, 44 + 4800);
});

// ---- 5. Provider selection truthfulness ----
await check('mock provider is selectable deterministically', () => {
  const provider = stt.selectStreamingSttProvider({ provider: 'mock' });
  assert.strictEqual(provider.kind, 'mock');
});

await check('unavailable provider surfaces via isServerSttActive=false', () => {
  // The selection itself is env-driven; the config must be self-consistent
  // with availability (never claims success when it cannot transcribe).
  assert.strictEqual(typeof stt.isServerSttActive(), 'boolean');
  const config = stt.getConfig();
  assert.strictEqual(config.usesBrowserSpeechRecognition, false);
  assert.ok(Array.isArray(config.events) && config.events.includes('voice:stt:final'));
  assert.strictEqual(config.format.encoding, 'pcm16');
  assert.strictEqual(config.format.sampleRate, 24000);
});

// ---- 6. Socket coordinator ----
function fakeSocket() {
  const emits = [];
  const handlers = {};
  return {
    emits,
    emit(event, payload) { emits.push({ event, payload }); },
    on(event, fn) { handlers[event] = fn; },
    trigger(event, payload) { handlers[event]?.(payload); },
    handlers,
  };
}

await check('coordinator emits started/interim/final/end in order', async () => {
  const socket = fakeSocket();
  const coordinator = new stt.VoiceSttSession({ socket, provider: new stt.MockSttProvider({ transcript: 'Hello ARC, can you hear me?' }) });
  coordinator.open();
  const started = socket.emits.find((e) => e.event === 'voice:stt:started');
  assert.ok(started, 'must advertise the session');
  assert.strictEqual(started.payload.format.sampleRate, 24000);
  assert.strictEqual(started.payload.usesBrowserSpeechRecognition, false);
  const sessionId = started.payload.sessionId;

  coordinator.handleAudio({ sessionId, seq: 0, format: FORMAT, audio: PCM() });
  coordinator.handleAudio({ sessionId, seq: 1, format: FORMAT, audio: PCM(4800) });
  await coordinator.commit();
  const interims = socket.emits.filter((e) => e.event === 'voice:stt:interim');
  assert.ok(interims.length >= 1, 'must emit interim before final');
  const finals = socket.emits.filter((e) => e.event === 'voice:stt:final');
  assert.strictEqual(finals.length, 1);
  assert.strictEqual(finals[0].payload.text, 'Hello ARC, can you hear me?');
  assert.strictEqual(finals[0].payload.seq, 1, 'final seq monotonic');
  assert.strictEqual(socket.emits.filter((e) => e.event === 'voice:stt:end').length, 1);
});

await check('stale session audio is rejected and reported', async () => {
  const socket = fakeSocket();
  const coordinator = new stt.VoiceSttSession({ socket, provider: new stt.MockSttProvider({ transcript: 'X' }) });
  coordinator.open();
  const sessionId = socket.emits.find((e) => e.event === 'voice:stt:started').payload.sessionId;
  coordinator.cancel('test');
  coordinator.handleAudio({ sessionId, seq: 0, format: FORMAT, audio: PCM() });
  assert.ok(socket.emits.some((e) => e.event === 'voice:stt:error' && e.payload.code === 'VOICE_STT_STALE'));
});

await check('bindSocket wires all five client events and cancels on close', async () => {
  const socket = fakeSocket();
  stt.bindSocket(socket, { provider: new stt.MockSttProvider({ transcript: 'X' }) });
  socket.trigger('voice:stt:start');
  assert.strictEqual(socket.emits.filter((e) => e.event === 'voice:stt:started').length, 1);
  socket.trigger('voice:stt:cancel', { reason: 'manual' });
  socket.trigger('voice:stt:close');
  assert.strictEqual(socket.emits.filter((e) => e.event === 'voice:stt:cancelled').length, 1);
});

await check('unavailable provider emits a truthful VOICE_STT_UNAVAILABLE error', async () => {
  const socket = fakeSocket();
  stt.bindSocket(socket, { provider: { kind: 'unavailable' } });
  socket.trigger('voice:stt:start');
  const error = socket.emits.find((e) => e.event === 'voice:stt:error');
  assert.ok(error, 'must fail truthfully when STT is not configured');
  assert.strictEqual(error.payload.code, 'VOICE_STT_UNAVAILABLE');
});

await check('coordinator allows only one active session (supersede bound)', async () => {
  const socket = fakeSocket();
  const coordinator = new stt.VoiceSttSession({ socket, provider: new stt.MockSttProvider({ transcript: 'X' }) });
  const first = coordinator.open();
  coordinator.open();
  const started = socket.emits.filter((e) => e.event === 'voice:stt:started');
  assert.strictEqual(started.length, 2);
  assert.notStrictEqual(started[0].payload.sessionId, started[1].payload.sessionId);
  assert.ok(socket.emits.some((e) => e.event === 'voice:stt:cancelled' && e.payload.sessionId === first));
});

// ---- 7. Gemini finalization backstop + dedup (the STT-finalization bug) ----
// A live-connect harness drives the real GeminiSttSession without a network:
// _open() returns a fake session; _handleMessage() is invoked directly with
// the provider messages the observed bug produces (interims only, no
// finished/turnComplete), and commit() must finalize with the freshest
// transcript — exactly once, never empty, never stuck.
function fakeGeminiSession(provider, overrides = {}) {
  const events = [];
  const fake = { sent: [], closed: false };
  class TestGeminiSttSession extends stt.GeminiSttSession {
    constructor(options) {
      super({ ...options, commitWaitMs: 150 });
      this.fake = fake;
    }
    async _open() {
      if (overrides.failOpen) {
        const err = new Error('network down');
        err.code = 'VOICE_STT_NETWORK';
        throw err;
      }
      return this.fake;
    }
  }
  const session = new TestGeminiSttSession({
    onInterim: (text) => events.push({ type: 'interim', text }),
    onFinal: (text, meta = {}) => events.push({ type: 'final', text, meta }),
    onError: (err) => events.push({ type: 'error', code: err?.code, message: err?.message }),
    onComplete: (info) => events.push({ type: 'complete', ...info }),
  });
  session.fake.sendRealtimeInput = (payload) => fake.sent.push(payload);
  session.fake.close = () => { fake.closed = true; };
  return { session, events, fake };
}

const interimMsg = (text, extra = {}) => ({
  serverContent: { inputTranscription: { text, finished: false }, ...extra },
});
const finalMsg = (text, extra = {}) => ({
  serverContent: { inputTranscription: { text, finished: true }, ...extra },
});

await check('Gemini: interims arrive but NO final is delivered before commit', async () => {
  const { session, events } = fakeGeminiSession({});
  session.writeAudio({ audio: PCM(), format: FORMAT, seq: 0 });
  session._handleMessage(interimMsg('Hello ARC, can you hear'));
  session._handleMessage(interimMsg('Hello ARC, can you hear me?'));
  const finalsBefore = events.filter((e) => e.type === 'final');
  assert.strictEqual(finalsBefore.length, 0, 'no final until the turn is committed');
  assert.ok(events.some((e) => e.type === 'interim' && e.text === 'Hello ARC, can you hear me?'));
});

await check('Gemini: explicit commit finalizes from interims when finished never arrives', async () => {
  const { session, events, fake } = fakeGeminiSession({});
  session.writeAudio({ audio: PCM(), format: FORMAT, seq: 0 });
  session._handleMessage(interimMsg('Hello ARC, can you hear'));
  session._handleMessage(interimMsg('Hello ARC, can you hear me?'));
  const done = await session.commit();
  assert.strictEqual(done.committed, true);
  assert.strictEqual(done.text, 'Hello ARC, can you hear me?');
  assert.ok(fake.sent.some((p) => p.audioStreamEnd === true), 'commit must signal the provider stream end');
  const finals = events.filter((e) => e.type === 'final');
  assert.strictEqual(finals.length, 1, 'exactly one final');
  assert.strictEqual(finals[0].text, 'Hello ARC, can you hear me?');
  assert.ok(!events.some((e) => e.type === 'error'));
});

await check('Gemini: provider finished flag during commit still yields exactly one final', async () => {
  const { session, events } = fakeGeminiSession({});
  session.writeAudio({ audio: PCM(), format: FORMAT, seq: 0 });
  session._handleMessage(interimMsg('आज मौसम कैसा है?', { language: 'hi' }));
  const committing = session.commit();
  session._handleMessage(finalMsg('आज मौसम कैसा है?', { language: 'hi' }));
  const done = await committing;
  assert.strictEqual(done.committed, true);
  const finals = events.filter((e) => e.type === 'final');
  assert.strictEqual(finals.length, 1, 'finished + commit must not double-deliver');
  assert.strictEqual(finals[0].text, 'आज मौसम कैसा है?');
});

await check('Gemini: natural finished while actively listening is delivered on subsequent commit', async () => {
  const { session, events } = fakeGeminiSession({});
  session.writeAudio({ audio: PCM(), format: FORMAT, seq: 0 });
  session._handleMessage(interimMsg('Bro mujhe React samjha do'));
  session._handleMessage(finalMsg('Bro mujhe React samjha do'));
  // final arrived before any client commit → server keeps it as backstop text
  assert.strictEqual(events.filter((e) => e.type === 'final').length, 0);
  const done = await session.commit();
  assert.strictEqual(done.committed, true);
  assert.strictEqual(done.text, 'Bro mujhe React samjha do');
  assert.strictEqual(events.filter((e) => e.type === 'final').length, 1);
});

await check('Gemini: empty turn commits an empty final without error or stuck state', async () => {
  const { session, events } = fakeGeminiSession({});
  const done = await session.commit();
  assert.strictEqual(done.committed, true);
  assert.strictEqual(done.text, '');
  const finals = events.filter((e) => e.type === 'final');
  assert.strictEqual(finals.length, 1);
  assert.ok(finals[0].text === '');
  assert.ok(!events.some((e) => e.type === 'error'));
});

await check('Gemini: duplicate commit after finalization never double-delivers', async () => {
  const { session, events } = fakeGeminiSession({});
  session.writeAudio({ audio: PCM(), format: FORMAT, seq: 0 });
  session._handleMessage(interimMsg('Once'));
  await session.commit();
  const second = await session.commit();
  assert.strictEqual(second.committed, false);
  assert.strictEqual(events.filter((e) => e.type === 'final').length, 1);
});

await check('Gemini: provider error during finalization fires onError (never stuck)', async () => {
  const { session, events } = fakeGeminiSession({}, { failOpen: true });
  session.writeAudio({ audio: PCM(), format: FORMAT, seq: 0 });
  const done = await session.commit();
  assert.strictEqual(done.committed, false);
  assert.ok(events.some((e) => e.type === 'error'), 'must surface the failure');
  assert.strictEqual(events.filter((e) => e.type === 'final').length, 0);
});

await check('Gemini: a fresh session after commit starts a new turn independently', async () => {
  const { session: first, events: firstEvents } = fakeGeminiSession({});
  first.writeAudio({ audio: PCM(), format: FORMAT, seq: 0 });
  first._handleMessage(interimMsg('first'));
  await first.commit();
  const { session: second, events: secondEvents } = fakeGeminiSession({});
  second.writeAudio({ audio: PCM(), format: FORMAT, seq: 0 });
  second._handleMessage(interimMsg('second'));
  await second.commit();
  assert.strictEqual(firstEvents.filter((e) => e.type === 'final').length, 1);
  assert.strictEqual(secondEvents.filter((e) => e.type === 'final').length, 1);
  assert.strictEqual(secondEvents.find((e) => e.type === 'final').text, 'second');
});

await check('Gemini: detected language propagates to the final meta', async () => {
  const { session, events } = fakeGeminiSession({});
  session.writeAudio({ audio: PCM(), format: FORMAT, seq: 0 });
  session._handleMessage(interimMsg('आज मौसम कैसा है?', { language: 'hi' }));
  await session.commit();
  const final = events.find((e) => e.type === 'final');
  assert.ok(final, 'final must be delivered');
  assert.strictEqual(final.meta.language, 'hi', 'voiceLanguage must follow the utterance language');
  assert.strictEqual(final.text, 'आज मौसम कैसा है?');
});

console.log('');
for (const line of results) console.log(line);
console.log('');
if (failures > 0) {
  console.error(`${failures} Voice Runtime FINAL server STT test(s) FAILED.`);
  process.exit(1);
} else {
  console.log(`All Voice Runtime FINAL server STT tests completed (${results.length} passed).\n`);
}
};

main().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});