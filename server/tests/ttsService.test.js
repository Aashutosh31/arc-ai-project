/* TTS service unit tests — run with: node tests/ttsService.test.js
 *
 * No API key or network needed: synthesis is mocked via injection, and the
 * WAV/segmenter logic is pure. Live synthesis is exercised only when
 * TTS_PROVIDER=gemini + GEMINI_API_KEY are configured (not here).
 */

const assert = require('assert');

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

async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
  } catch (err) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
}

const ttsService = require('../services/ttsService');

const makeSocket = () => {
  const emits = [];
  return {
    emits,
    emit(event, data) {
      emits.push({ event, data });
    }
  };
};

console.log('TTS Service Tests');
console.log('=================');

console.log('\n1. Activation defaults');
check('server TTS is off by default', () => {
  const prevProvider = process.env.TTS_PROVIDER;
  const prevKey = process.env.GEMINI_API_KEY;
  delete process.env.TTS_PROVIDER;
  process.env.GEMINI_API_KEY = 'dummy';
  assert.strictEqual(ttsService.isServerTtsActive(), false);
  if (prevProvider !== undefined) process.env.TTS_PROVIDER = prevProvider;
  if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
  else delete process.env.GEMINI_API_KEY;
});
check('server TTS requires an API key even when enabled', () => {
  const prevProvider = process.env.TTS_PROVIDER;
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.TTS_PROVIDER = 'gemini';
  delete process.env.GEMINI_API_KEY;
  assert.strictEqual(ttsService.isServerTtsActive(), false);
  if (prevProvider !== undefined) process.env.TTS_PROVIDER = prevProvider;
  else delete process.env.TTS_PROVIDER;
  if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
});
check('server TTS activates with provider + key', () => {
  const prevProvider = process.env.TTS_PROVIDER;
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.TTS_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'dummy';
  assert.strictEqual(ttsService.isServerTtsActive(), true);
  if (prevProvider !== undefined) process.env.TTS_PROVIDER = prevProvider;
  else delete process.env.TTS_PROVIDER;
  if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
  else delete process.env.GEMINI_API_KEY;
});

console.log('\n2. Speech segmentation');
check('splits sentences at natural boundaries', () => {
  const segments = ttsService.splitIntoSpeechSegments('Hello there. How are you today? I am fine.');
  assert.deepStrictEqual(segments, ['Hello there.', 'How are you today?', 'I am fine.']);
});
check('caps long segments without cutting words', () => {
  const long = `Start. ${'word '.repeat(120)} End.`;
  const segments = ttsService.splitIntoSpeechSegments(long, { maxLength: 100 });
  assert.ok(segments.length > 2);
  for (const segment of segments) {
    assert.ok(segment.length <= 110, `segment too long: ${segment.length}`);
    assert.ok(!segment.endsWith('wo'), 'must not cut mid-word');
  }
  assert.ok(segments.join(' ').includes('End.'));
});
check('strips code blocks, links and markdown', () => {
  const segments = ttsService.splitIntoSpeechSegments('Run `npm test` now. See [docs](https://example.com/x) for details. ```code();``` Done.');
  const joined = segments.join(' ');
  assert.ok(!joined.includes('`'), 'backticks must be stripped');
  assert.ok(!joined.includes('https://'), 'URLs must be stripped');
  assert.ok(!joined.includes('code();'), 'code blocks must be stripped');
});
check('handles Unicode and empty input', () => {
  assert.deepStrictEqual(ttsService.splitIntoSpeechSegments(''), []);
  assert.deepStrictEqual(ttsService.splitIntoSpeechSegments('   '), []);
  const segments = ttsService.splitIntoSpeechSegments('Emoji \u{1F600} test. Lone \uD800 surrogate here.');
  assert.ok(segments.length >= 1);
});

console.log('\n3. WAV framing');
check('produces a valid WAV header', () => {
  const pcm = Buffer.alloc(160, 0).toString('base64');
  const wavBase64 = ttsService.pcm16ToWavBase64(pcm, { sampleRate: 24000, channels: 1 });
  const wav = Buffer.from(wavBase64, 'base64');
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(wav.toString('ascii', 12, 16), 'fmt ');
  assert.strictEqual(wav.toString('ascii', 36, 40), 'data');
  assert.strictEqual(wav.readUInt32LE(24), 24000);
  assert.strictEqual(wav.readUInt16LE(20), 1);
  assert.strictEqual(wav.length, 44 + 160);
});

console.log('\n4. Stream buffer ordering');
checkAsync('emits audio segments in order then isFinal', async () => {
  const socket = makeSocket();
  const buffer = new ttsService.TtsStreamBuffer({
    socket,
    synthesize: async (segment) => ({
      audioBase64: Buffer.from(`wav:${segment}`).toString('base64'),
      mimeType: 'audio/wav'
    })
  });
  buffer.push('First sentence here. Second sentence here.');
  await buffer.flush();
  const audioEvents = socket.emits.filter((e) => e.event === 'ai:tts:audio' && !e.data.isFinal);
  assert.strictEqual(audioEvents.length, 2);
  assert.strictEqual(audioEvents[0].data.index, 0);
  assert.strictEqual(audioEvents[1].data.index, 1);
  const finals = socket.emits.filter((e) => e.event === 'ai:tts:audio' && e.data.isFinal);
  assert.strictEqual(finals.length, 1);
});
checkAsync('skips a failed segment and keeps the queue moving', async () => {
  const socket = makeSocket();
  let calls = 0;
  const buffer = new ttsService.TtsStreamBuffer({
    socket,
    synthesize: async (segment) => {
      calls += 1;
      if (calls === 1) throw new Error('simulated TTS outage');
      return { audioBase64: Buffer.from(`wav:${segment}`).toString('base64'), mimeType: 'audio/wav' };
    }
  });
  buffer.push('One bad sentence here. One good sentence here.');
  await buffer.flush();
  const audioEvents = socket.emits.filter((e) => e.event === 'ai:tts:audio' && !e.data.isFinal);
  assert.strictEqual(audioEvents.length, 1);
  const finals = socket.emits.filter((e) => e.event === 'ai:tts:audio' && e.data.isFinal);
  assert.strictEqual(finals.length, 1);
});
checkAsync('stop() halts synthesis and emits audio:stop', async () => {
  const socket = makeSocket();
  let synthCalls = 0;
  const buffer = new ttsService.TtsStreamBuffer({
    socket,
    synthesize: async () => {
      synthCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { audioBase64: 'AAA=', mimeType: 'audio/wav' };
    }
  });
  buffer.push('A fairly long first sentence for the test. Another sentence here.');
  buffer.stop();
  await buffer.flush();
  const stops = socket.emits.filter((e) => e.event === 'ai:tts:audio:stop');
  assert.strictEqual(stops.length, 1);
  const audioEvents = socket.emits.filter((e) => e.event === 'ai:tts:audio' && !e.data.isFinal);
  assert.strictEqual(audioEvents.length, 0, 'no audio may emit after stop');
  assert.ok(synthCalls <= 1);
});
checkAsync('aborted signal suppresses audio delivery', async () => {
  const socket = makeSocket();
  const controller = new AbortController();
  controller.abort();
  const buffer = new ttsService.TtsStreamBuffer({
    socket,
    signal: controller.signal,
    synthesize: async () => ({ audioBase64: 'AAA=', mimeType: 'audio/wav' })
  });
  buffer.push('Hello world. How are you?');
  await buffer.flush();
  const audioEvents = socket.emits.filter((e) => e.event === 'ai:tts:audio' && !e.data.isFinal);
  assert.strictEqual(audioEvents.length, 0);
});

console.log('\n5. Safe errors');
checkAsync('synthesize without key throws a configured error (no live call)', async () => {
  const prevKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  // Reset the cached client by re-requiring is not possible; instead assert
  // the guard directly: synthesis must fail closed without a key.
  await assert.rejects(
    ttsService.synthesizeSegment('Hello world.'),
    (err) => {
      assert.ok(/not configured/i.test(err.message));
      return true;
    }
  );
  if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
});

console.log('\nAll TTS service tests completed.\n');
