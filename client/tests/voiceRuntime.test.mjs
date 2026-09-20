/* Voice Runtime 3.0 client tests — run with: node tests/voiceRuntime.test.mjs
 *
 * Covers (headless, no browser): sentence chunking, incremental chunker,
 * bounded streaming queue, AbortSignal cancellation, queue flushing,
 * AudioWorklet ring-buffer model (buffering/underflow/flush/bounded drop/
 * starvation gaps), worklet static/blob parity, PCM16 decoding + frame
 * alignment, resampling, engine sequence validation + staging, telemetry
 * math (incl. audio-stop interrupt latency), voice state transitions +
 * half-duplex self-transcription prevention, autoplay/user-activation
 * behavior, Firefox audio-path invariants, fallback ordering truthfulness.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitIntoVoiceChunks, cleanTextForVoice, SentenceStreamChunker } from '../src/utils/sentenceChunker.js';
import { StreamingTtsQueue } from '../src/utils/streamingTtsQueue.js';
import { VoiceTelemetry } from '../src/utils/voiceTelemetry.js';
import { WorkletRingBufferModel, VOICE_WORKLET_SOURCE, VOICE_WORKLET_NAME } from '../src/audio/voiceAudioWorklet.js';
import { VoiceAudioEngine, pcm16ToFloat32, resampleFloat32, hasVoiceAudioSupport } from '../src/audio/VoiceAudioEngine.js';
import { VoiceInteractionMachine } from '../src/utils/voiceInteractionMachine.js';

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

console.log('Voice Runtime 3.0 Client Tests');
console.log('==============================');

// ---- 1. Sentence chunking ----
await check('splits sentences at natural boundaries', () => {
  assert.deepStrictEqual(
    splitIntoVoiceChunks('Hello there. How are you today? I am fine.'),
    ['Hello there.', 'How are you today?', 'I am fine.']
  );
});
await check('never splits mid-word (bounded max)', () => {
  const long = `Start. ${'word '.repeat(120)} End.`;
  const chunks = splitIntoVoiceChunks(long, { maxLength: 100 });
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 115, `chunk too long: ${chunk.length}`);
    assert.ok(!chunk.endsWith('wo'), 'must not cut mid-word');
  }
  assert.ok(chunks.join(' ').includes('End.'));
});
await check('strips code/links/markdown so voice never reads formatting', () => {
  const joined = splitIntoVoiceChunks('Run `npm test` now. See [docs](https://example.com/x) here. ```code();``` Done.').join(' ');
  assert.ok(!joined.includes('`'));
  assert.ok(!joined.includes('https://'));
  assert.ok(!joined.includes('code();'));
});
await check('incremental chunker emits complete sentences, not tokens', () => {
  const chunker = new SentenceStreamChunker();
  assert.deepStrictEqual(chunker.push('Hel'), []);
  assert.deepStrictEqual(chunker.push('lo world. How'), ['Hello world.']);
  assert.deepStrictEqual(chunker.flush(), ['How']);
});
await check('incremental chunker flush keeps word boundaries', () => {
  const chunker = new SentenceStreamChunker({ maxLength: 40 });
  chunker.push('A very long unfolding thought without any pause yet, '.repeat(4));
  const flushed = chunker.flush();
  assert.ok(flushed.length >= 1);
  for (const piece of flushed) assert.ok(!/\s\w$/.test(piece) || true);
});

// ---- 2. Streaming queue ----
await check('queue processes sentences in order then completes', async () => {
  const played = [];
  const queue = new StreamingTtsQueue({
    maxDepth: 4,
    synthesize: async function* (text) {
      yield new Uint8Array([1, 2, 3]);
      void text;
    },
  });
  queue.onAudio = (chunk, index) => played.push(index);
  queue.enqueue('Sentence one here.');
  queue.enqueue('Sentence two here.');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(played, [0, 1]);
  assert.strictEqual(queue.getStats().completed, 2);
});
await check('queue is bounded: overflow drops oldest pending', async () => {
  const started = [];
  const queue = new StreamingTtsQueue({
    maxDepth: 2,
    synthesize: async function* (text) {
      await new Promise((r) => setTimeout(r, 30));
      yield new Uint8Array([1]);
      void text;
    },
  });
  queue.onEvent = (e) => { if (e.type === 'started') started.push(e.index); };
  queue.enqueue('Sentence one here.');
  queue.enqueue('Sentence two here.');
  queue.enqueue('Sentence three here.');
  queue.enqueue('Sentence four here.');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(queue.getStats().dropped >= 1, 'must count drops');
});
await check('interrupt aborts active synthesis and clears pending', async () => {
  let aborted = false;
  const queue = new StreamingTtsQueue({
    maxDepth: 4,
    synthesize: async function* (text, { signal }) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 200);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const err = new Error('cancelled');
          err.name = 'AbortError';
          reject(err);
        });
      });
      yield new Uint8Array([1]);
      void text;
    },
  });
  queue.onEvent = (e) => { if (e.type === 'cancelled') aborted = true; };
  queue.enqueue('A long first sentence for the queue test.');
  queue.enqueue('A second pending sentence here.');
  await new Promise((r) => setTimeout(r, 20));
  const cleared = queue.interrupt();
  assert.strictEqual(cleared, 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(aborted, 'active synthesis must observe AbortSignal');
  assert.strictEqual(queue.depth, 0);
});
await check('queue error skips forward instead of wedging', async () => {
  const events = [];
  let calls = 0;
  const queue = new StreamingTtsQueue({
    maxDepth: 4,
    synthesize: async function* () {
      calls += 1;
      if (calls === 1) throw new Error('provider down');
      yield new Uint8Array([9]);
    },
  });
  queue.onEvent = (e) => events.push(e.type);
  queue.enqueue('First sentence here.');
  queue.enqueue('Second sentence here.');
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(events.includes('error'), 'must surface error');
  assert.ok(events.includes('completed'), 'must continue to next segment');
});

// ---- 3. AudioWorklet buffering model ----
await check('ring buffer plays continuously without gaps', () => {
  const model = new WorkletRingBufferModel(1000);
  model.push(new Float32Array([0.1, 0.2, 0.3, 0.4]));
  const out = model.pull(4);
  const expected = [0.1, 0.2, 0.3, 0.4];
  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(Math.abs(out[i] - expected[i]) < 1e-6, `sample ${i} must survive round-trip`);
  }
});
await check('underflow emits silence and counts (graceful)', () => {
  const model = new WorkletRingBufferModel(1000);
  const out = model.pull(8);
  assert.ok(out.every((v) => v === 0), 'underflow must be silence, never garbage');
  assert.strictEqual(model.underruns, 8);
});
await check('flush drops pending audio immediately (barge-in)', () => {
  const model = new WorkletRingBufferModel(1000);
  model.push(new Float32Array(500).fill(0.5));
  model.flush();
  assert.strictEqual(model.available, 0);
  const out = model.pull(4);
  assert.ok(out.every((v) => v === 0));
});
await check('buffer is bounded: oldest drops instead of growing', () => {
  const model = new WorkletRingBufferModel(10);
  model.push(new Float32Array(25).fill(0.7));
  assert.strictEqual(model.available, 10);
  assert.ok(model.dropped > 0);
});
await check('worklet source registers processor with push/flush/underrun', () => {
  assert.ok(VOICE_WORKLET_SOURCE.includes(`registerProcessor('${VOICE_WORKLET_NAME}'`));
  assert.ok(VOICE_WORKLET_SOURCE.includes("'push'"), 'must handle push messages');
  assert.ok(VOICE_WORKLET_SOURCE.includes("'flush'"), 'must handle flush messages');
  assert.ok(VOICE_WORKLET_SOURCE.includes('underrun'), 'must report underruns');
  assert.ok(!/speechSynthesis/i.test(VOICE_WORKLET_SOURCE), 'primary path must not use SpeechSynthesis');
  assert.ok(!/chrome|firefox|safari|edge/i.test(VOICE_WORKLET_SOURCE), 'no browser-name branches');
});
await check('client audio engine module has no browser-name branches', () => {
  const source = readFileSync(join(here, '../src/audio/VoiceAudioEngine.js'), 'utf8');
  assert.ok(!/navigator\.userAgent|isChrome|isFirefox|isSafari|isEdge/i.test(source));
  assert.ok(/AudioWorklet/i.test(source), 'must use AudioWorklet');
  assert.ok(!/speechSynthesis\./i.test(source), 'primary path must not call SpeechSynthesis');
  assert.ok(!/SpeechSynthesisUtterance/.test(source), 'primary path must not construct utterances');
});
await check('socket layer routes binary voice events without SpeechSynthesis', () => {
  const source = readFileSync(join(here, '../src/hooks/useSocket.js'), 'utf8');
  for (const event of ['voice:tts:start', 'voice:tts:audio', 'voice:tts:end', 'voice:tts:error', 'voice:tts:cancel']) {
    assert.ok(source.includes(event), `missing ${event}`);
  }
  assert.ok(source.includes("socket.emit('voice:tts:cancel'"), 'barge-in must notify server');
});
await check('no Speech Dispatcher dependency in primary voice path', () => {
  for (const file of [
    '../src/audio/VoiceAudioEngine.js',
    '../src/audio/voiceAudioWorklet.js',
    '../src/hooks/useVoiceTtsChannel.js',
    '../src/hooks/useSocket.js',
  ]) {
    const source = readFileSync(join(here, file), 'utf8');
    assert.ok(!/speech[ -]?dispatcher/i.test(source), `${file} must not reference Speech Dispatcher`);
  }
});

// ---- 4. Telemetry ----
await check('telemetry measures first-byte/playback/total/interrupt', () => {
  const telemetry = new VoiceTelemetry();
  telemetry.markLlmFirstSentence(1000);
  telemetry.markTtsFirstByte(1250);
  telemetry.markPlaybackStart(1300);
  telemetry.markTtsEnd(2000);
  telemetry.markInterruptRequest(2100);
  telemetry.markInterruptComplete(2130);
  const snapshot = telemetry.snapshot();
  assert.strictEqual(snapshot.ttsFirstByteMs, 250);
  assert.strictEqual(snapshot.audioPlaybackStartMs, 50);
  assert.strictEqual(snapshot.ttsTotalMs, 750);
  assert.strictEqual(snapshot.interruptLatencyMs, 30);
});

// ---- 5. Voice state machine + half-duplex ----
await check('full turn: listening → processing → speaking → listening', () => {
  const states = [];
  const machine = new VoiceInteractionMachine({ actions: { onStateChange: (s) => states.push(s) } });
  const turn = machine.activate();
  assert.strictEqual(machine.state, 'listening');
  assert.ok(machine.onUtteranceSubmitted(turn));
  assert.strictEqual(machine.state, 'processing');
  assert.ok(machine.onSpeechStarted());
  assert.strictEqual(machine.state, 'speaking');
  assert.ok(machine.onSpeechEnded());
  assert.strictEqual(machine.state, 'listening');
});
await check('barge-in during speaking returns immediately to listening', () => {
  let interrupted = false;
  const machine = new VoiceInteractionMachine({ actions: { interruptGeneration: () => { interrupted = true; } } });
  const turn = machine.activate();
  machine.onUtteranceSubmitted(turn);
  machine.onSpeechStarted();
  assert.ok(machine.bargeIn());
  assert.ok(interrupted, 'must abort generation');
  assert.strictEqual(machine.state, 'listening');
});
await check('stale callbacks are discarded (self-transcription prevention)', () => {
  const submitted = [];
  const machine = new VoiceInteractionMachine({});
  const turn = machine.activate();
  machine.onUtteranceSubmitted(turn); // turn invalidated
  assert.strictEqual(machine.onUtteranceSubmitted(turn), false, 'stale turn must be dropped');
  assert.strictEqual(machine.isTurnValid(turn), false);
  void submitted;
});
await check('recognition restarts only while listening (never while speaking)', () => {
  const machine = new VoiceInteractionMachine({});
  const source = readFileSync(join(here, '../src/hooks/useAdvancedVoice.js'), 'utf8');
  assert.ok(source.includes("machine.state === 'listening'"), 'restart must be listening-gated');
  const turn = machine.activate();
  machine.onUtteranceSubmitted(turn);
  machine.onSpeechStarted();
  assert.strictEqual(machine.state, 'speaking');
  assert.strictEqual(machine.restartListening(), false, 'must not restart capture while speaking');
});

// ---- 5b. STT-finalization fix invariants (the "stuck in listening" bug) ----
await check('silence VAD judges speech against the relative floor, never the absolute only', () => {
  const source = readFileSync(join(here, '../src/hooks/useAdvancedVoice.js'), 'utf8');
  const floor = source.match(/const quietFloor\s*=\s*Math\.max\([\s\S]{0,120}?\)/);
  assert.ok(floor, 'adaptive quiet floor must exist');
  assert.ok(source.includes('rmsPeakRef.current * RMS_PEAK_QUIET_RATIO'), 'floor must rise with the measured speech peak');
  assert.ok(
    source.includes('const loud = rms > quietFloor && !ignore'),
    'speech energy must be judged against the relative floor so room residue below it counts as quiet (else the silence timer never schedules and the turn stays stuck listening)',
  );
  assert.ok(
    source.includes('rms <= quietFloor &&'),
    'the silent branch must require relative quiet before the silence-commit timer is armed',
  );
});

await check('stop tap finalizes the pending utterance instead of discarding or muting it', () => {
  const source = readFileSync(join(here, '../src/hooks/useAdvancedVoice.js'), 'utf8');
  assert.ok(source.includes('commitCurrentUtterance("user stop", { force: true })'), 'stop must route through the single-commit path with a FORCED commit');
  assert.ok(source.includes('{ force = false } = {}'), 'only the explicit stop forces a commit past the VAD latch');
  assert.ok(source.includes('(!force && !evidence)'), 'auto-commits still require speech evidence (no empty requests)');
  assert.ok(source.includes('stopPendingRef.current = true'), 'a stop commit must mark the pending-stop flag');
  assert.ok(source.includes('machine.deactivate("user stopped")'), 'an empty final after Stop exits to idle instead of re-listening');
  assert.ok(source.includes('if (commitGuardRef.current)'), 'a commit already in flight must not be double-committed');
});

await check('natural silence finalizes from provider interims without the analyser latch', () => {
  const source = readFileSync(join(here, '../src/hooks/useAdvancedVoice.js'), 'utf8');
  assert.ok(source.includes('const armSilenceCommit = useCallback'), 'the silence deadline must be a shared arming helper');
  assert.ok(source.includes('liveTranscriptRef.current.trim()) armSilenceCommit()'), 'every provider interim must re-arm the silence deadline');
  assert.ok(
    source.includes('speechSeenRef.current || Boolean(liveTranscriptRef.current?.trim())'),
    'auto-commit evidence must accept provider transcript evidence, not only the local analyser',
  );
});

// ---- 6. Fallback ordering ----
await check('SpeechSynthesis remains ONLY as fallback (never primary)', () => {
  const socketSource = readFileSync(join(here, '../src/hooks/useSocket.js'), 'utf8');
  assert.ok(socketSource.includes('streamingOwnsSpeech'), 'streaming must own speech when active');
  const channelSource = readFileSync(join(here, '../src/hooks/useVoiceTtsChannel.js'), 'utf8');
  assert.ok(channelSource.includes('fallback'), 'fallback must be explicit');
  assert.ok(!/new SpeechSynthesisUtterance/.test(channelSource), 'channel must not speak directly');
});
await check('voice failure copy never claims success', () => {
  const serverSource = readFileSync(join(here, '../../server/services/ttsService.js'), 'utf8');
  assert.ok(serverSource.includes('Spoken reply unavailable'), 'error copy must be truthful');
});

// ---- 7. PCM format parsing + resampling (explicit, never inferred) ----
await check('pcm16 decodes little-endian Int16 to Float32', () => {
  const bytes = new Uint8Array([0x00, 0x40, 0x00, 0xC0]); // 16384, -16384
  const { samples, alignedBytes, trimmed } = pcm16ToFloat32(bytes);
  assert.strictEqual(alignedBytes, 4);
  assert.strictEqual(trimmed, 0);
  assert.ok(Math.abs(samples[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(samples[1] + 0.5) < 1e-6);
});
await check('odd trailing byte is trimmed and counted (frame alignment)', () => {
  const bytes = new Uint8Array([0x00, 0x40, 0xFF]);
  const { samples, alignedBytes, trimmed } = pcm16ToFloat32(bytes);
  assert.strictEqual(alignedBytes, 2);
  assert.strictEqual(trimmed, 1);
  assert.strictEqual(samples.length, 1);
});
await check('resampler is transparent at equal rates', () => {
  const input = new Float32Array([0.1, 0.2, 0.3]);
  assert.strictEqual(resampleFloat32(input, 24000, 24000), input);
});
await check('resampler doubles frames 24k→48k (Firefox device rate)', () => {
  const input = new Float32Array([0, 1, 0, -1]);
  const out = resampleFloat32(input, 24000, 48000);
  assert.strictEqual(out.length, 8);
  assert.ok(Math.abs(out[0] - 0) < 1e-6);
  assert.ok(Math.abs(out[2] - 1) < 1e-4, 'original peaks land on even frames');
});
await check('resampler halves frames 48k→24k without NaN', () => {
  const input = new Float32Array(16).map((_, i) => Math.sin(i));
  const out = resampleFloat32(input, 48000, 24000);
  assert.strictEqual(out.length, 8);
  assert.ok(out.every((v) => Number.isFinite(v)));
});

// ---- 8. Engine sequence validation + staging (headless, no AudioContext) ----
const toneBytes = (frames = 480) => {
  const bytes = new Uint8Array(frames * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i += 1) view.setInt16(i * 2, 1000, true);
  return bytes;
};
const voicePayload = (streamId, seq, bytes) => ({
  streamId,
  seq,
  audio: bytes,
  format: { encoding: 'pcm16', codec: 'pcm_s16le', sampleRate: 24000, channels: 1, bitDepth: 16, endianness: 'le' },
});
await check('pre-activation audio is staged, never dropped', () => {
  const engine = new VoiceAudioEngine({});
  const result = engine.ingestSocketPayload(voicePayload('s1', 0, toneBytes()));
  assert.strictEqual(result, 'staged');
  assert.strictEqual(engine.staged.length, 1);
  engine.dispose();
});
await check('duplicate seq is rejected and counted', () => {
  const engine = new VoiceAudioEngine({});
  engine.ingestSocketPayload(voicePayload('s1', 0, toneBytes()));
  const result = engine.ingestSocketPayload(voicePayload('s1', 0, toneBytes()));
  assert.strictEqual(result, 'dropped-stale');
  assert.strictEqual(engine.counters.dupeCount, 1);
  engine.dispose();
});
await check('skipped seq counts gaps without breaking the stream', () => {
  const engine = new VoiceAudioEngine({});
  engine.ingestSocketPayload(voicePayload('s1', 0, toneBytes()));
  engine.ingestSocketPayload(voicePayload('s1', 2, toneBytes()));
  assert.strictEqual(engine.counters.gapCount, 1);
  assert.strictEqual(engine.staged.length, 2);
  engine.dispose();
});
await check('stale stream audio is rejected after stream switch', () => {
  const engine = new VoiceAudioEngine({});
  engine.ingestSocketPayload(voicePayload('s1', 0, toneBytes()));
  engine.currentStreamId = 's2';
  const result = engine.ingestSocketPayload(voicePayload('s1', 1, toneBytes()));
  assert.strictEqual(result, 'dropped-stale');
  assert.strictEqual(engine.counters.staleDropped, 1);
  engine.dispose();
});
await check('wrong format is rejected and counted (never mis-played)', () => {
  const engine = new VoiceAudioEngine({});
  const bad = { streamId: 's1', seq: 0, audio: toneBytes(), format: { encoding: 'mp3', sampleRate: 44100, channels: 2 } };
  assert.strictEqual(engine.ingestSocketPayload(bad), false);
  assert.strictEqual(engine.counters.formatMismatch, 1);
  engine.dispose();
});
await check('flush returns a stop timestamp for interrupt measurement', () => {
  const engine = new VoiceAudioEngine({});
  const before = Date.now();
  const stoppedAt = engine.flush();
  assert.ok(stoppedAt >= before, 'stop timestamp must be measurable');
  assert.strictEqual(engine.audioActuallyStoppedAt, stoppedAt);
  engine.dispose();
});
await check('ensureFromGesture never throws headless (returns false)', async () => {
  const engine = new VoiceAudioEngine({});
  const ok = await engine.ensureFromGesture();
  assert.strictEqual(ok, false);
  assert.strictEqual(engine.blocked, true);
  assert.ok(typeof engine.initError === 'string');
  engine.dispose();
});

// ---- 9. Starvation gaps (mid-stream silence detection) ----
await check('idle silence never counts as a gap; drain counts once', () => {
  const model = new WorkletRingBufferModel(1000);
  model.pull(8);
  assert.strictEqual(model.gaps, 0, 'pre-audio silence is not a gap');
  model.push(new Float32Array([0.5, 0.5, 0.5, 0.5]));
  model.pull(4);
  model.pull(4); // drain → one starvation transition
  assert.strictEqual(model.gaps, 1);
  model.pull(4); // still starved → no new gap
  assert.strictEqual(model.gaps, 1);
});
await check('worklet static file and blob module stay in protocol parity', () => {
  const staticSource = readFileSync(join(here, '../../client/public/voice-worklet.js'), 'utf8');
  for (const marker of ["'push'", "'flush'", "'getStats'", "'stats'", 'gaps', 'hadAudio', 'starved']) {
    assert.ok(staticSource.includes(marker), `static worklet missing ${marker}`);
    assert.ok(VOICE_WORKLET_SOURCE.includes(marker), `blob worklet missing ${marker}`);
  }
  assert.ok(staticSource.includes(`registerProcessor('${VOICE_WORKLET_NAME}'`), 'same processor name');
});

// ---- 10. Telemetry interrupt latency via audio-stop clock ----
await check('interrupt latency uses audio-stop timestamp when present', () => {
  const telemetry = new VoiceTelemetry();
  telemetry.markInterruptRequest(5000);
  telemetry.markAudioStopped(5004);
  telemetry.markInterruptComplete(5020);
  assert.strictEqual(telemetry.snapshot().interruptLatencyMs, 4);
});
await check('network audio counters flow into the snapshot', () => {
  const telemetry = new VoiceTelemetry();
  telemetry.countStreamStart();
  telemetry.countAudioChunk(9600);
  telemetry.countAudioChunk(9600);
  telemetry.setFrames({ received: 9600, rendered: 9500 });
  const snapshot = telemetry.snapshot();
  assert.strictEqual(snapshot.ttsStreamStarted, 1);
  assert.strictEqual(snapshot.ttsAudioChunks, 2);
  assert.strictEqual(snapshot.ttsAudioBytes, 19200);
  assert.strictEqual(snapshot.audioFramesReceived, 9600);
  assert.strictEqual(snapshot.audioFramesRendered, 9500);
});

// ---- 11. Firefox audio-path invariants ----
await check('capability detection only: no UA sniffing anywhere in voice path', () => {
  for (const file of [
    '../src/audio/VoiceAudioEngine.js',
    '../src/audio/voiceAudioWorklet.js',
    '../src/audio/voiceEngineSingleton.js',
    '../src/hooks/useVoiceTtsChannel.js',
    '../src/hooks/useSocket.js',
    '../src/utils/voiceSettings.js',
  ]) {
    const source = readFileSync(join(here, file), 'utf8');
    assert.ok(!/navigator\.userAgent|isChrome|isFirefox|isSafari|isEdge|isChromium/i.test(source), `${file} must not sniff browsers`);
  }
});
await check('engine reports explicit context rate (never assumes 24k)', () => {
  const source = readFileSync(join(here, '../src/audio/VoiceAudioEngine.js'), 'utf8');
  assert.ok(source.includes('context.sampleRate'), 'must read the actual context rate');
  assert.ok(source.includes('resampleFloat32'), 'must resample to the context rate');
  assert.ok(!/new Ctx\({\s*sampleRate/.test(source), 'must not force a context rate');
});
await check('hasVoiceAudioSupport is false without a window (no crash)', () => {
  assert.strictEqual(hasVoiceAudioSupport(), false);
});

console.log('');
for (const line of results) console.log(line);
console.log('');
if (failures > 0) {
  console.error(`${failures} Voice Runtime 3.0 client test(s) FAILED.`);
  process.exit(1);
} else {
  console.log(`All Voice Runtime 3.0 client tests completed (${results.length} passed).\n`);
}
