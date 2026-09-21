/* sttService ↔ Sarvam coordinator integration tests (offline) —
 * run with: node tests/sttServiceSarvam.test.js
 *
 * Verifies the full server-side socket coordinator with an injected Sarvam
 * provider over a fake WebSocket: started event, interim/final routing with
 * the detected language + confidence, VAD speech backstop events, commit
 * behavior, stale-session rejection, and supersede handling.
 */

const assert = require('assert');
const { VoiceSttSession, bindSocket, STT_SESSION_FORMAT } = require('../services/sttService');
const { SarvamRealtimeSttProvider } = require('../services/sarvamProvider');

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeWs {
  constructor() {
    this.sentMessages = [];
    this.listeners = {};
    this.readyState = 0;
    this.closedCode = null;
  }
  on(event, cb) {
    (this.listeners[event] = this.listeners[event] || []).push(cb);
    return this;
  }
  emit(event, ...args) {
    for (const cb of this.listeners[event] || []) cb(...args);
  }
  send(text, cb) {
    this.sentMessages.push(typeof text === 'string' ? JSON.parse(text) : text);
    if (cb) cb();
    return true;
  }
  openNow() {
    this.readyState = 1;
    this.emit('open');
  }
  close(code = 1000, reason = '') {
    if (this.closedCode !== null) return;
    this.closedCode = code;
    this.emit('close', code, reason);
  }
  terminate() {
    if (this.closedCode === null) this.close(1006, 'terminate');
  }
  pushMessage(object) {
    this.emit('message', JSON.stringify(object));
  }
}

const makeSocket = () => {
  const emitting = [];
  return {
    emitting,
    emit(event, data) {
      if (event === 'voice:stt:audio') return; // server never emits audio
      emitting.push({ event, data });
    },
  };
};

const makeHarness = () => {
  const prevKey = process.env.SARVAM_API_KEY;
  const prevProvider = process.env.STT_PROVIDER;
  process.env.SARVAM_API_KEY = 'test-key';
  delete process.env.STT_PROVIDER;
  const wss = [];
  const provider = new SarvamRealtimeSttProvider({
    transport: () => { const ws = new FakeWs(); wss.push(ws); return ws; },
    commitWaitMs: 60,
  });
  const socket = makeSocket();
  const coordinator = new VoiceSttSession({ socket, provider });
  const restore = () => {
    if (prevKey !== undefined) process.env.SARVAM_API_KEY = prevKey;
    else delete process.env.SARVAM_API_KEY;
    if (prevProvider !== undefined) process.env.STT_PROVIDER = prevProvider;
    else delete process.env.STT_PROVIDER;
  };
  return { socket, coordinator, wss, restore };
};

const frameBytes = 4800;

console.log('Sarvam STT coordinator tests (offline)');
console.log('======================================');

let failed = 0;
const run = async (label, fn) => {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err.message}`);
  }
};

(async () => {
  await run('started event advertises explicit wire format', async () => {
    const { socket, coordinator, wss, restore } = makeHarness();
    try {
      const id = coordinator.open();
      assert.ok(id, 'session id returned');
      const started = socket.emitting.find((e) => e.event === 'voice:stt:started');
      assert.ok(started, 'voice:stt:started emitted');
      assert.strictEqual(started.data.format.sampleRate, STT_SESSION_FORMAT.sampleRate);
      assert.strictEqual(started.data.format.encoding, 'pcm16');
      coordinator.close();
    } finally { restore(); }
  });

  await run('interim + final route with detected language/confidence', async () => {
    const { socket, coordinator, wss, restore } = makeHarness();
    try {
      const id = coordinator.open();
      coordinator.handleAudio({ sessionId: id, seq: 0, format: STT_SESSION_FORMAT, audio: Buffer.alloc(frameBytes) });
      wss[0].openNow();
      await tick(20);
      wss[0].pushMessage({ event: 'vad.speech_start' });
      wss[0].pushMessage({ event: 'transcript.partial', transcript: 'namaste', language: 'hi-IN' });
      wss[0].pushMessage({ event: 'vad.speech_end' });
      wss[0].pushMessage({ event: 'transcript.final', transcript: 'namaste', language: 'hi-IN', language_confidence: 0.9 });
      await tick(20);
      const interim = socket.emitting.find((e) => e.event === 'voice:stt:interim');
      assert.ok(interim, 'interim emitted');
      assert.strictEqual(interim.data.text, 'namaste');
      const final = socket.emitting.find((e) => e.event === 'voice:stt:final');
      assert.ok(final, 'final emitted');
      assert.strictEqual(final.data.text, 'namaste');
      // Sarvam auto-language lands on the final payload (additive).
      assert.strictEqual(final.data.language, 'hi-IN');
      assert.strictEqual(final.data.languageConfidence, 0.9);
      // Bounded: confidence normalized to [0,1].
      const speechStart = socket.emitting.find((e) => e.event === 'voice:stt:speech:start');
      assert.ok(speechStart, 'voice:stt:speech:start emitted (VAD backstop)');
      const speechEnd = socket.emitting.find((e) => e.event === 'voice:stt:speech:end');
      assert.ok(speechEnd, 'voice:stt:speech:end emitted');
      assert.ok(socket.emitting.some((e) => e.event === 'voice:stt:end'), 'end emitted after final');
      coordinator.close();
    } finally { restore(); }
  });

  await run('commit mid-utterance finalizes from the freshest partial', async () => {
    const { socket, coordinator, wss, restore } = makeHarness();
    try {
      const id = coordinator.open();
      coordinator.handleAudio({ sessionId: id, seq: 0, format: STT_SESSION_FORMAT, audio: Buffer.alloc(frameBytes) });
      wss[0].openNow();
      await tick(20);
      wss[0].pushMessage({ event: 'transcript.partial', transcript: 'a fresh partial', language: 'en-IN' });
      await tick(20);
      await coordinator.commit();
      await tick(20);
      const finals = socket.emitting.filter((e) => e.event === 'voice:stt:final');
      assert.strictEqual(finals.length, 1, 'one final only');
      assert.strictEqual(finals[0].data.text, 'a fresh partial');
      // A late server final after commit is suppressed (no double submit).
      wss[0].pushMessage({ event: 'transcript.final', transcript: 'late server final', language: 'en-IN' });
      await tick(20);
      assert.strictEqual(socket.emitting.filter((e) => e.event === 'voice:stt:final').length, 1);
      coordinator.close();
    } finally { restore(); }
  });

  await run('provider error surfaces as voice:stt:error with Sarvam code', async () => {
    const { socket, coordinator, wss, restore } = makeHarness();
    try {
      const id = coordinator.open();
      coordinator.handleAudio({ sessionId: id, seq: 0, format: STT_SESSION_FORMAT, audio: Buffer.alloc(frameBytes) });
      wss[0].openNow();
      await tick(20);
      wss[0].pushMessage({ event: 'error', code: 4005, is_fatal: true, message: 'quota exceeded' });
      await tick(20);
      const error = socket.emitting.find((e) => e.event === 'voice:stt:error');
      assert.ok(error, 'voice:stt:error emitted');
      assert.strictEqual(error.data.code, 'SARVAM_QUOTA_ERROR');
      coordinator.close();
    } finally { restore(); }
  });

  await run('stale audio (unknown session) is rejected, never crashes the socket', async () => {
    const { socket, coordinator, wss, restore } = makeHarness();
    try {
      coordinator.open();
      const ok = coordinator.handleAudio({ sessionId: 'stale', seq: 0, format: STT_SESSION_FORMAT, audio: Buffer.alloc(frameBytes) });
      assert.strictEqual(ok, false);
      const stale = socket.emitting.find((e) => e.event === 'voice:stt:error');
      assert.ok(stale && stale.data.code === 'VOICE_STT_STALE', 'stale rejection emitted');
      coordinator.close();
    } finally { restore(); }
  });

  await run('supersede bound: new open() cancels the prior session', async () => {
    const { socket, coordinator, wss, restore } = makeHarness();
    try {
      const first = coordinator.open();
      // The socket only opens after the first audio frame; open the aggregate.
      coordinator.handleAudio({ sessionId: first, seq: 0, format: STT_SESSION_FORMAT, audio: Buffer.alloc(frameBytes) });
      wss[0].openNow();
      await tick(10);
      let cancelled = false;
      const session = coordinator.session;
      session.onCancel = () => { cancelled = true; };
      const second = coordinator.open();
      assert.notStrictEqual(first, second);
      assert.ok(cancelled, 'prior session cancelled on supersede');
      await tick(10);
      coordinator.close();
    } finally { restore(); }
  });

  await run('voice:stt:cancel routes through the coordinator', async () => {
    const { socket, coordinator, wss, restore } = makeHarness();
    try {
      const id = coordinator.open();
      coordinator.handleAudio({ sessionId: id, seq: 0, format: STT_SESSION_FORMAT, audio: Buffer.alloc(frameBytes) });
      wss[0].openNow();
      await tick(10);
      coordinator.cancel('barge-in');
      await tick(10);
      const cancelled = socket.emitting.find((e) => e.event === 'voice:stt:cancelled');
      assert.ok(cancelled, 'voice:stt:cancelled emitted');
      assert.strictEqual(cancelled.data.reason, 'barge-in');
      coordinator.close();
    } finally { restore(); }
  });

  await run('bindSocket wires the same coordinator to live socket events', async () => {
    const prevProvider = process.env.STT_PROVIDER;
    const prevKey = process.env.SARVAM_API_KEY;
    process.env.STT_PROVIDER = 'sarvam';
    process.env.SARVAM_API_KEY = 'test-key';
    const wss = [];
    const socketBus = [];
    const socketLike = {
      emit: (event, data) => { socketBus.push({ event, data }); },
      on: (event, cb) => { socketLike.handlers[event] = cb; return socketLike; },
      handlers: {},
    };
    const injected = new SarvamRealtimeSttProvider({ transport: () => { const ws = new FakeWs(); wss.push(ws); return ws; } });
    const coordinator = bindSocket(socketLike, { provider: injected });
    try {
      socketLike.handlers['voice:stt:start']();
      await tick(10);
      const started = socketBus.find((e) => e.event === 'voice:stt:started');
      assert.ok(started, 'voice:stt:started from live socket event');
      const id = started.data.sessionId;
      const audio = Buffer.alloc(frameBytes);
      socketLike.handlers['voice:stt:audio']({ sessionId: id, seq: 0, format: STT_SESSION_FORMAT, audio });
      socketLike.handlers['voice:stt:commit']({ sessionId: id });
      socketLike.handlers['voice:stt:cancel']({ reason: 'user cancel' });
      socketLike.handlers['voice:stt:close']();
      coordinator.close();
    } finally {
      if (prevProvider !== undefined) process.env.STT_PROVIDER = prevProvider;
      else delete process.env.STT_PROVIDER;
      if (prevKey !== undefined) process.env.SARVAM_API_KEY = prevKey;
      else delete process.env.SARVAM_API_KEY;
    }
  });

  await tick(20);
  console.log(`\nAll Sarvam STT coordinator tests completed${failed ? ` (${failed} failed)` : ''}.`);
})();