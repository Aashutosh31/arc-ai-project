/* Voice Runtime FINAL client STT tests — run with: node tests/voiceSttClient.test.mjs
 *
 * Headless (no browser): microphone framing + injection hook, worklet static /
 * blob source parity, streaming STT channel lifecycle (begin/audio/commit/cancel/
 * reset, interim/final routing, seq dedupe, format gate, local bounds), and the
 * "no browser SpeechRecognition" invariants across the whole primary client path.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VoiceMicCapture, VOICE_MIC_FORMAT } from '../src/audio/VoiceMicCapture.js';
import {
  VOICE_MIC_WORKLET_SOURCE,
  VOICE_MIC_WORKLET_NAME,
} from '../src/audio/voiceMicWorklet.js';
import {
  StreamingSttChannel,
  getSharedSttChannel,
  _resetSttChannelForTests,
} from '../src/utils/sttChannel.js';
import { getVoiceMode, hasUserMediaAudio } from '../src/utils/voiceCapabilities.js';

const here = dirname(fileURLToPath(import.meta.url));
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

console.log('Voice Runtime FINAL client STT Tests');
console.log('====================================');

const pcm16Bytes = (frames = 2400) => {
  const bytes = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) bytes[i] = 1000;
  return bytes;
};

const makeSocket = (handlers = {}) => {
  const socket = {
    connected: true,
    emits: [],
    on() {},
    off() {},
    emit(event, payload) {
      this.emits.push({ event, payload });
    },
    receive(event, payload) {
      handlers.receive?.(event, payload);
    },
  };
  return socket;
};

// ---- 1. Worklet source parity -------------------------------------------
await check('mic worklet static file and blob module are identical', () => {
  const staticSource = readFileSync(join(here, '../public/voice-mic-worklet.js'), 'utf8');
  assert.strictEqual(staticSource, VOICE_MIC_WORKLET_SOURCE, 'static and blob sources must match byte-for-byte');
});

await check('mic worklet registers processor with explicit 24k PCM16 framing', () => {
  for (const marker of [
    `registerProcessor('${VOICE_MIC_WORKLET_NAME}'`,
    'TARGET_RATE = 24000',
    'pcm16',
    'pcm_s16le',
    'sampleRate: TARGET_RATE',
    'channels: 1',
    'bitDepth: 16',
    'seq',
    'postMessage',
  ]) {
    assert.ok(VOICE_MIC_WORKLET_SOURCE.includes(marker), `mic worklet source missing ${marker}`);
  }
  assert.ok(!/SpeechRecognition|webkitSpeechRecognition|MediaRecorder|speechSynthesis|chrome|firefox|safari|edge/i.test(VOICE_MIC_WORKLET_SOURCE), 'no browser STT or UA branches in the worklet');
});

// ---- 2. Mic framing via the injection hook ------------------------------
await check('injected 24k frames become exact PCM16 packets (4800 bytes, explicit format)', () => {
  const mic = new VoiceMicCapture({ allowInject: true });
  const received = [];
  mic._onFrame = (packet) => received.push(packet);
  const ok = mic.__injectFloat24k(new Float32Array(2400).fill(0.25));
  assert.strictEqual(ok, true);
  assert.strictEqual(received.length, 1);
  const frame = received[0];
  assert.strictEqual(frame.bytes.byteLength, 4800, '2400 samples x int16');
  assert.strictEqual(frame.seq, 0);
  assert.deepStrictEqual(frame.format, VOICE_MIC_FORMAT, 'explicit format metadata');
  assert.strictEqual(frame.sourceRate, undefined); // inject path carries no context rate
});

await check('injected resistance: disabled framing never emits', () => {
  const mic = new VoiceMicCapture({ allowInject: true });
  mic.setFramingEnabled(false);
  let emitted = false;
  mic._onFrame = () => { emitted = true; };
  mic.__injectFloat24k(new Float32Array(2400).fill(0.5));
  assert.strictEqual(emitted, false, 'framing off must drop frames (speaking/transport guard)');
});

// ---- 3. Streaming STT channel lifecycle ----------------------------------
const SRV = 'voice:stt:start|voice:stt:audio|voice:stt:commit|voice:stt:cancel|voice:stt:close'.split('|');
const authority = (socket) => socket.emits.filter((e) => SRV.includes(e.event));

await check('channel begin → started → frames → interim/final routing', async () => {
  const events = [];
  const socket = makeSocket();
  const channel = new StreamingSttChannel();
  channel.configure(socket);
  const off = channel.onEvent((type, data) => events.push([type, data]));

  const beginPromise = channel.begin();
  assert.ok(authority(socket).some((e) => e.event === 'voice:stt:start'), 'begin must emit start');
  channel.handleServerEvent('voice:stt:started', { sessionId: 's1', format: VOICE_MIC_FORMAT });
  const sessionId = await beginPromise;
  assert.strictEqual(sessionId, 's1');

  assert.ok(channel.sendFrame({ seq: 0, bytes: pcm16Bytes(), format: VOICE_MIC_FORMAT }));
  const audio = authority(socket).filter((e) => e.event === 'voice:stt:audio');
  assert.ok(audio.length >= 1, 'frames must reach the socket');
  assert.strictEqual(audio[0].payload.sessionId, 's1');
  assert.strictEqual(audio[0].payload.seq, 0);
  assert.strictEqual(audio[0].payload.format.sampleRate, 24000);
  assert.ok(audio[0].payload.audio.byteLength === 4800, 'binary PCM16 frame travels');

  channel.handleServerEvent('voice:stt:interim', { sessionId: 's1', seq: 1, text: 'Hello ARC…' });
  assert.deepStrictEqual(events.filter((e) => e[0] === 'interim').map((e) => e[1].text), ['Hello ARC…']);

  channel.handleServerEvent('voice:stt:final', { sessionId: 's1', seq: 1, text: 'Hello ARC, can you hear me?' });
  assert.deepStrictEqual(events.filter((e) => e[0] === 'final').map((e) => e[1].text), ['Hello ARC, can you hear me?']);

  channel.handleServerEvent('voice:stt:end', { sessionId: 's1' });
  assert.strictEqual(channel.activeSession, false, 'end must close the session');
  off();
});

await check('channel commit, cancel and reset emit + clear state', () => {
  const socket = makeSocket();
  const channel = new StreamingSttChannel();
  channel.configure(socket);
  channel.begin().then(() => {}).catch(() => {});
  channel.handleServerEvent('voice:stt:started', { sessionId: 's2' });

  channel.commit();
  assert.ok(authority(socket).some((e) => e.event === 'voice:stt:commit' && e.payload.sessionId === 's2'));
  assert.strictEqual(channel.active, false);

  channel.handleServerEvent('voice:stt:started', { sessionId: 's3' });
  channel.cancel('barge-in');
  assert.ok(authority(socket).some((e) => e.event === 'voice:stt:cancel' && e.payload.reason === 'barge-in'));
  assert.strictEqual(channel.sessionId, null);

  channel.reset();
  assert.strictEqual(channel.active, false);
  assert.strictEqual(channel.sessionId, null);
});

await check('duplicate seq and wrong format are dropped locally', async () => {
  const socket = makeSocket();
  const channel = new StreamingSttChannel();
  channel.configure(socket);
  const session = channel.begin();
  channel.handleServerEvent('voice:stt:started', { sessionId: 's4' });
  await session;

  assert.ok(channel.sendFrame({ seq: 3, bytes: pcm16Bytes(), format: VOICE_MIC_FORMAT }));
  assert.strictEqual(channel.sendFrame({ seq: 3, bytes: pcm16Bytes(), format: VOICE_MIC_FORMAT }), false, 'duplicate seq must drop');
  assert.strictEqual(channel.sendFrame({ seq: 4, bytes: pcm16Bytes(), format: { encoding: 'mp3', sampleRate: 44100, channels: 2 } }), false, 'wrong format must drop');
  assert.strictEqual(channel.sendFrame({ seq: 4, bytes: pcm16Bytes(), format: VOICE_MIC_FORMAT }), true, 'next valid frame still flows');
});

await check('client bounds: 1200 frames then drop, never unbounded', async () => {
  const socket = makeSocket();
  const channel = new StreamingSttChannel();
  channel.configure(socket);
  const session = channel.begin();
  channel.handleServerEvent('voice:stt:started', { sessionId: 's5' });
  await session;
  let sent = 0;
  for (let i = 0; i < 1210; i += 1) {
    if (channel.sendFrame({ seq: i, bytes: new Int16Array(1), format: VOICE_MIC_FORMAT })) sent += 1;
  }
  assert.strictEqual(sent, 1200, 'frame bound must stop at 1200');
  assert.ok(channel.counters.droppedFrames >= 10, 'overflow must be counted');
});

await check('begin without a connection fails truthfully (VOICE_STT_DISCONNECTED)', async () => {
  const socket = makeSocket();
  socket.connected = false;
  const channel = new StreamingSttChannel();
  channel.configure(socket);
  let recovered = null;
  channel.onEvent((type, data) => { if (type === 'error') recovered = data; });
  await assert.rejects(channel.begin(), (err) => err?.code === 'VOICE_STT_DISCONNECTED');
  assert.ok(!recovered, 'synchronous disconnect must not leave a phantom error event');
});

// ---- 4. No browser SpeechRecognition in the primary client path ----------
await check('primary client STT path has zero SpeechRecognition / MediaRecorder references', () => {
  for (const file of [
    '../src/hooks/useAdvancedVoice.js',
    '../src/utils/voiceCapabilities.js',
    '../src/utils/sttChannel.js',
    '../src/audio/VoiceMicCapture.js',
    '../src/audio/voiceMicWorklet.js',
  ]) {
    const source = readFileSync(join(here, file), 'utf8');
    assert.ok(!/SpeechRecognition|webkitSpeechRecognition|MediaRecorder|speechSynthesis|navigator\.userAgent|isChrome|isFirefox|isSafari|isEdge/i.test(source), `${file} must hold zero browser-STT / UA references`);
  }
});

await check('useSocket routes all voice:stt server events to the shared channel', () => {
  const source = readFileSync(join(here, '../src/hooks/useSocket.js'), 'utf8');
  assert.ok(source.includes('STT_CHANNEL_EVENTS'), 'useSocket must subscribe to the STT event list');
  assert.ok(source.includes('getSharedSttChannel()'), 'socket must forward to the STT channel');
  assert.ok(source.includes('handleServerEvent'), 'events must reach the channel router');
});

await check('capability detection is headless-safe and never enables browser STT', () => {
  assert.strictEqual(hasUserMediaAudio(), false);
  assert.strictEqual(getVoiceMode(), 'unsupported');
});

await check('shared channel resets back to a clean singleton for tests', async () => {
  _resetSttChannelForTests();
  const a = getSharedSttChannel();
  const b = getSharedSttChannel();
  assert.strictEqual(a, b, 'singleton semantics');
  assert.strictEqual(a.activeSession, false);
});

console.log('');
for (const line of results) console.log(line);
console.log('');
if (failures > 0) {
  console.error(`${failures} Voice Runtime FINAL client STT test(s) FAILED.`);
  process.exit(1);
} else {
  console.log(`All Voice Runtime FINAL client STT tests completed (${results.length} passed).\n`);
}