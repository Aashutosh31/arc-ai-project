/* Sarvam bulbul:v3 streaming TTS unit tests (offline) — run with: node tests/sarvamTts.test.js
 *
 * Exercises the streaming TTS provider (config-first, text/flush, completion
 * event, connection reuse, cancel-tears-down) against an injected fake
 * WebSocket transport. No network, no real credentials.
 */

const assert = require('assert');
const { SarvamStreamingTtsProvider } = require('../services/sarvamProvider');

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeWs {
  constructor() {
    this.sent = [];
    this.listeners = {};
    this.readyState = 0;
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

const audioEvent = (bytes) => ({
  type: 'audio',
  data: { audio: Buffer.alloc(bytes).toString('base64'), content_type: 'audio/linear16;rate=24000', request_id: 'r-test' },
});
const finalEvent = { type: 'event', data: { event_type: 'final' } };

// Auto-answer each `flush` with audio + the completion event so any number of
// semantic chunks resolve promptly — mirrors the real bulbul completion flow.
const wireAutoReply = (ws) => {
  const originalSend = ws.send.bind(ws);
  ws.send = (text, cb) => {
    originalSend(text, cb);
    const parsed = typeof text === 'string' ? JSON.parse(text) : text;
    if (parsed.type === 'flush') {
      setImmediate(() => { ws.pushMessage(audioEvent(4800 * 2)); ws.pushMessage(finalEvent); });
    }
  };
};

const setupEnv = () => {
  const prev = process.env.SARVAM_API_KEY;
  process.env.SARVAM_API_KEY = 'test-key';
  return () => {
    if (prev !== undefined) process.env.SARVAM_API_KEY = prev;
    else delete process.env.SARVAM_API_KEY;
  };
};

const restore = setupEnv(); // default-on for the whole file (each test resets after)

let failed = 0;
const run = async (label, fn) => {
  const spawn = setupEnv();
  try {
    await fn();
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err.message}`);
  }
  spawn();
};

console.log('Sarvam TTS Tests (offline)');
console.log('==========================');

// Long enough that SemanticTtsBuffer (target 480) emits on push(); short texts
// are flushed explicitly per test.
const LONG_TEXT = (
  'Hello there. This is a fairly normal conversational greeting. ' +
  'How are you today? I hope everything is going well with your work. '
).repeat(6); // ~ 960 chars → several semantic units immediately

(async () => {
  await run('config-first protocol + text/flush + completion event', async () => {
    const wss = [];
    const provider = new SarvamStreamingTtsProvider({
      transport: () => { const ws = new FakeWs(); wss.push(ws); return ws; },
    });
    const audio = [];
    const providerErrors = [];
    const session = provider.startStream({
      onAudio: (chunk) => audio.push(chunk),
      onError: (error) => providerErrors.push(error),
    });
    session.writeText(LONG_TEXT);
    await tick(20);
    assert.strictEqual(wss.length, 1, 'one connection opened');
    const ws = wss[0];
    wireAutoReply(ws);
    ws.openNow();
    await tick(20);
    // Config must be the first outbound message.
    assert.strictEqual(ws.sent[0].type, 'config', 'config is first message');
    const config = ws.sent[0].data;
    assert.strictEqual(config.speaker, 'shubh');
    assert.strictEqual(config.language_code, 'en-IN');
    assert.strictEqual(config.output_audio_codec, 'linear16');
    assert.strictEqual(config.speech_sample_rate, '24000');
    assert.ok(ws.sent.some((m) => m.type === 'text' && m.data.text), 'text sent');
    assert.ok(ws.sent.some((m) => m.type === 'flush'), 'flush sent');
    await session.flush();
    assert.strictEqual(providerErrors.length, 0, 'no provider errors');
    const total = audio.reduce((sum, b) => sum + b.length, 0);
    assert.ok(total > 0, `expected pcm bytes, got ${total}`);
    await session.close();
    assert.notStrictEqual(ws.closedCode, null, 'connection closed on close()');
  });

  await run('reuses ONE connection across sequential chunks', async () => {
    const wss = [];
    const provider = new SarvamStreamingTtsProvider({
      transport: () => { const ws = new FakeWs(); wss.push(ws); return ws; },
    });
    const audio = [];
    const session = provider.startStream({ onAudio: (chunk) => audio.push(chunk) });
    session.writeText(LONG_TEXT + ' One more trailing thought for good measure here.');
    await tick(20);
    const ws = wss[0];
    wireAutoReply(ws);
    ws.openNow();
    await tick(20);
    await session.flush();
    assert.strictEqual(wss.length, 1, 'single persistent connection for all chunks');
    assert.ok(audio.length >= 1, 'audio delivered');
    await session.close();
  });

  await run('language override selects the Bulbul code (hi → hi-IN)', async () => {
    const wss = [];
    const provider = new SarvamStreamingTtsProvider({
      transport: () => { const ws = new FakeWs(); wss.push(ws); return ws; },
    });
    const session = provider.startStream({ language: 'hi' });
    session.writeText('Namaste. Ap kaise hain? Pariksa');
    // Short text buffers in SemanticTtsBuffer until flush() — start the flush,
    // then drive the connection to completion.
    const flushing = session.flush();
    await tick(20);
    assert.strictEqual(wss.length, 1);
    const ws = wss[0];
    wireAutoReply(ws);
    ws.openNow();
    await tick(20);
    await flushing;
    assert.strictEqual(ws.sent[0].data.language_code, 'hi-IN');
    await session.close();
  });

  await run('unsupported language falls back to en-IN (never a rejected code)', async () => {
    const wss = [];
    const provider = new SarvamStreamingTtsProvider({
      transport: () => { const ws = new FakeWs(); wss.push(ws); return ws; },
    });
    const session = provider.startStream({ language: 'fr-FR' });
    session.writeText('The reserved voice language is always speakable.');
    const flushing = session.flush();
    await tick(20);
    const ws = wss[0];
    wireAutoReply(ws);
    ws.openNow();
    await tick(20);
    await flushing;
    assert.strictEqual(ws.sent[0].data.language_code, 'en-IN');
    await session.close();
  });

  await run('barge-in cancel closes the socket immediately (no in-band cancel)', async () => {
    const wss = [];
    const provider = new SarvamStreamingTtsProvider({
      transport: () => { const ws = new FakeWs(); wss.push(ws); return ws; },
    });
    const session = provider.startStream({});
    session.writeText(LONG_TEXT);
    await tick(20);
    const ws = wss[0];
    wireAutoReply(ws);
    ws.openNow();
    await tick(20);
    session.cancel();
    assert.notStrictEqual(ws.closedCode, null, 'socket closed on cancel');
    await tick(10);
  });

  await run('missing key → SARVAM_AUTH_ERROR', async () => {
    const prevKey = process.env.SARVAM_API_KEY;
    delete process.env.SARVAM_API_KEY;
    try {
      const provider = new SarvamStreamingTtsProvider({});
      await assert.rejects(
        provider._openConnection({ voice: 'shubh', language: 'en-IN' }),
        (error) => error.code === 'SARVAM_AUTH_ERROR'
      );
    } finally {
      if (prevKey !== undefined) process.env.SARVAM_API_KEY = prevKey;
      else delete process.env.SARVAM_API_KEY;
    }
  });

  await tick(20);
  restore();
  console.log(`\nAll Sarvam TTS tests completed${failed ? ` (${failed} failed)` : ''}.`);
})();