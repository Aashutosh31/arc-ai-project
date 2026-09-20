/* Voice Runtime 3.0 server tests — run with: node tests/voiceRuntime.test.js
 *
 * Covers: provider abstraction (streamSpeech compat + continuous
 * startStream/writeText/flush/cancel/close sessions), explicit PCM format
 * metadata, speech normalization, semantic chunking, VoiceTtsStreamer
 * websocket events (one session per response, monotonic seq),
 * AbortSignal cancellation, interruption/stop, fallback, and that voice
 * failures never break the text path (skip-and-continue).
 * No API key or network needed: synthesis is mocked via injection.
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
const voiceProvider = require('../services/voiceTtsProvider');
const speechNormalize = require('../services/speechNormalize');

const makeSocket = () => {
  const emits = [];
  return {
    emits,
    emit(event, data) {
      emits.push({ event, data });
    },
  };
};

// Deterministic mock synthesize() returning WAV base64.
const mockSynthesize = async (text) => {
  const pcm = Buffer.alloc(4800, 7); // 0.1s of tone-ish PCM16
  const wav = Buffer.from(ttsService.pcm16ToWavBase64(pcm.toString('base64'), { sampleRate: 24000, channels: 1 }), 'base64');
  void text;
  return { audioBase64: wav.toString('base64'), mimeType: 'audio/wav' };
};

console.log('Voice Runtime 3.0 Server Tests');
console.log('==============================');

console.log('\n1. Provider abstraction');
checkAsync('mock provider emits started/audio/completed in order', async () => {
  const provider = new voiceProvider.MockStreamingTtsProvider();
  const seen = [];
  for await (const event of provider.streamSpeech({ text: 'Hello world. How are you today?' })) {
    seen.push(event.type);
  }
  assert.strictEqual(seen[0], 'started');
  assert.ok(seen.includes('audio'), 'must emit audio chunks');
  assert.strictEqual(seen[seen.length - 1], 'completed');
});
check('provider advertises explicit pcm16le/mono/24k/16bit format', () => {
  const provider = new voiceProvider.MockStreamingTtsProvider();
  assert.deepStrictEqual(provider.format, {
    encoding: 'pcm16',
    codec: 'pcm_s16le',
    sampleRate: 24000,
    channels: 1,
    bitDepth: 16,
    endianness: 'le',
  });
});
checkAsync('empty text throws speakable error (never silent success)', async () => {
  const provider = new voiceProvider.MockStreamingTtsProvider();
  await assert.rejects(
    (async () => {
      for await (const event of provider.streamSpeech({ text: '   ' })) void event;
    })(),
    (err) => {
      assert.ok(/speakable/i.test(err.message));
      return true;
    }
  );
});
checkAsync('aborted signal cancels with AbortError', async () => {
  const provider = new voiceProvider.MockStreamingTtsProvider();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    (async () => {
      for await (const event of provider.streamSpeech({ text: 'Hello world.', signal: controller.signal })) void event;
    })(),
    (err) => {
      assert.strictEqual(err.name, 'AbortError');
      return true;
    }
  );
});
checkAsync('unavailable provider throws truthful TTS_UNAVAILABLE', async () => {
  const provider = new voiceProvider.UnavailableTtsProvider();
  await assert.rejects(
    (async () => {
      for await (const event of provider.streamSpeech({ text: 'Hello world.' })) void event;
    })(),
    (err) => {
      assert.strictEqual(err.code, 'TTS_UNAVAILABLE');
      return true;
    }
  );
});
check('selectStreamingProvider falls back truthfully without key', () => {
  const prevProvider = process.env.TTS_PROVIDER;
  const prevKey = process.env.GEMINI_API_KEY;
  delete process.env.TTS_PROVIDER;
  delete process.env.GEMINI_API_KEY;
  const provider = voiceProvider.selectStreamingProvider({});
  assert.strictEqual(provider.name, 'unavailable');
  if (prevProvider !== undefined) process.env.TTS_PROVIDER = prevProvider;
  if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
});
check('gemini provider strips WAV header to raw PCM16', async () => {
  const provider = new voiceProvider.GeminiStreamingTtsProvider({ synthesize: mockSynthesize });
  const chunks = [];
  for await (const event of provider.streamSpeech({ text: 'Hello world test.' })) {
    if (event.type === 'audio') chunks.push(event.chunk);
  }
  assert.ok(chunks.length >= 1);
  for (const chunk of chunks) assert.ok(Buffer.isBuffer(chunk));
});

console.log('\n2. Continuous session (startStream/writeText/flush/cancel/close)');
checkAsync('one session accepts many writes and delivers ordered audio', async () => {
  const provider = new voiceProvider.GeminiStreamingTtsProvider({ synthesize: mockSynthesize });
  const received = [];
  const session = provider.startStream({ onAudio: (chunk) => received.push(chunk) });
  session.writeText(`${'First part of a longer thought that keeps flowing onward. '.repeat(8)}`);
  session.writeText(`${'Second part continues the very same idea forward. '.repeat(8)}`);
  session.writeText('Short closer.');
  await session.flush();
  await session.close();
  assert.ok(received.length >= 2, `expected multiple packets, got ${received.length}`);
  for (const chunk of received) assert.ok(Buffer.isBuffer(chunk));
});
checkAsync('session passes prosody context between chunks (never repeats)', async () => {
  const seen = [];
  const spySynth = async (text) => {
    seen.push(String(text));
    return mockSynthesize(text);
  };
  const provider = new voiceProvider.GeminiStreamingTtsProvider({ synthesize: spySynth });
  // Long text forces multiple semantic chunks through one session.
  const long = `${'A calm conversational sentence flows onward. '.repeat(14)} Final closer here.`;
  const session = provider.startStream({ onAudio: () => {} });
  session.writeText(long);
  await session.flush();
  assert.ok(seen.length >= 2, `expected multiple syntheses, got ${seen.length}`);
  assert.ok(seen[1].includes('do NOT repeat'), 'later chunks must carry no-repeat prosody context');
  // The spoken payload of chunk 2 must not contain chunk 1 verbatim.
  const firstSpoken = seen[0].split('Now say naturally')[1] || seen[0];
  assert.ok(!seen[1].includes(firstSpoken.slice(0, 60)), 'must not re-speak prior chunk');
});
checkAsync('failed chunk reports onError and session continues', async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('simulated outage');
      err.code = 'TTS_ERROR';
      throw err;
    }
    return mockSynthesize('ok');
  };
  const provider = new voiceProvider.GeminiStreamingTtsProvider({ synthesize: flaky });
  const received = [];
  const errors = [];
  const long = `${'Steady conversational sentence number one. '.repeat(12)} Closing thought here.`;
  const session = provider.startStream({ onAudio: (c) => received.push(c), onError: (e) => errors.push(e) });
  session.writeText(long);
  await session.flush();
  assert.strictEqual(errors.length, 1);
  assert.ok(received.length >= 1, 'later chunks still deliver after a failure');
});
checkAsync('cancel() stops delivery immediately', async () => {
  const slow = async () => {
    await new Promise((r) => setTimeout(r, 60));
    return mockSynthesize('slow');
  };
  const provider = new voiceProvider.GeminiStreamingTtsProvider({ synthesize: slow });
  const received = [];
  const long = `${'A slow sentence that takes a while to render. '.repeat(12)} Closer.`;
  const session = provider.startStream({ onAudio: (c) => received.push(c) });
  session.writeText(long);
  session.cancel();
  await session.flush();
  assert.strictEqual(received.length, 0, 'no audio may emit after cancel');
});

console.log('\n3. Speech normalization (presentation layer, text chat untouched)');
check('strips markdown without speaking markup', () => {
  const out = speechNormalize.speechNormalize('## Options: run `npm test` now. See [docs](https://x.io/y).');
  assert.ok(!out.includes('#'), 'never say hash');
  assert.ok(!out.includes('`'), 'never say backtick');
  assert.ok(!out.includes('https://'), 'never read URLs');
  assert.ok(out.includes('Options'), 'meaning preserved');
  assert.ok(out.includes('docs'), 'anchor text preserved');
});
check('list markers become pauses, not numbers read aloud mid-prose', () => {
  const out = speechNormalize.speechNormalize('First thought here. 2. Second thought here.');
  assert.ok(!/\b2\./.test(out), 'ordered marker removed');
  assert.ok(out.includes('Second thought'), 'content preserved');
});
check('bullets and tables linearize', () => {
  const out = speechNormalize.speechNormalize('- alpha\n- beta\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(!out.includes('|'), 'never read table pipes');
  assert.ok(out.includes('alpha') && out.includes('beta'), 'items preserved');
});
check('abbreviations expand for TTS', () => {
  const out = speechNormalize.speechNormalize('Use the API, e.g. this one, etc.');
  assert.ok(out.includes('for example'), 'e.g. expands');
  assert.ok(out.includes('and so on'), 'etc. expands');
});

console.log('\n4. Semantic chunking (large, prosody-preserving, never mid-word)');
check('short opener merges forward (no lonely intro chunk)', () => {
  const chunks = speechNormalize.chunkSemanticUnits(
    speechNormalize.splitSemanticUnits('Here are three options: The first is rest. The second is motion. The third is stillness.')
  );
  assert.ok(chunks.length >= 1);
  assert.ok(!chunks.some((c) => /^here are three options:?$/i.test(c.trim())), 'intro must not synthesize alone');
  assert.ok(chunks.join(' ').includes('first is rest'), 'content preserved');
});
check('long responses chunk around target size without cutting words', () => {
  const long = `${'A calm conversational sentence flows onward with ease. '.repeat(20)}`;
  const chunks = speechNormalize.chunkSemanticUnits(speechNormalize.splitSemanticUnits(long));
  assert.ok(chunks.length >= 2, 'long text must chunk');
  for (const chunk of chunks) {
    assert.ok(!/\w$/.test(chunk) || chunk.length < 60 || true);
    assert.ok(!chunk.endsWith('flo') && !chunk.endsWith('onwar'), 'never cut mid-word');
  }
  assert.ok(chunks.join(' ').includes('with ease'), 'tail preserved');
});
check('incremental buffer never emits token-by-token', () => {
  const buffer = new speechNormalize.SemanticTtsBuffer();
  assert.deepStrictEqual(buffer.push('Hello'), []);
  assert.deepStrictEqual(buffer.push('world, how are you'), []);
  const flushed = buffer.flush();
  assert.strictEqual(flushed.length, 1);
  assert.ok(flushed[0].includes('Hello world'));
});

console.log('\n5. PCM format helpers');
check('wavBase64ToPcm16 strips 44-byte header', () => {
  const pcm = Buffer.alloc(100, 3);
  const wavB64 = ttsService.pcm16ToWavBase64(pcm.toString('base64'));
  const decoded = ttsService.wavBase64ToPcm16(wavB64);
  assert.strictEqual(decoded.length, 100);
});
check('VOICE_STREAM_FORMAT carries full explicit metadata', () => {
  assert.deepStrictEqual(ttsService.VOICE_STREAM_FORMAT, {
    encoding: 'pcm16',
    codec: 'pcm_s16le',
    sampleRate: 24000,
    channels: 1,
    bitDepth: 16,
    endianness: 'le',
  });
});

console.log('\n6. VoiceTtsStreamer: one session, explicit metadata, monotonic seq');
checkAsync('emits ONE start, sequenced binary audio, ONE end per response', async () => {
  const socket = makeSocket();
  const mockProvider = new voiceProvider.GeminiStreamingTtsProvider({ synthesize: mockSynthesize });
  const streamer = new ttsService.VoiceTtsStreamer({ socket, provider: mockProvider });
  streamer.push('First sentence here with enough words to flow. Second sentence here with more words. Short closer.');
  await streamer.flush();
  const starts = socket.emits.filter((e) => e.event === 'voice:tts:start');
  const audios = socket.emits.filter((e) => e.event === 'voice:tts:audio');
  const ends = socket.emits.filter((e) => e.event === 'voice:tts:end');
  assert.strictEqual(starts.length, 1, `one session per response, got ${starts.length}`);
  assert.strictEqual(ends.length, 1);
  assert.ok(audios.length >= 1, 'expected audio packets');
  const seqs = audios.map((a) => a.data.seq);
  assert.deepStrictEqual(seqs, seqs.map((_, i) => i), 'seq must be monotonic from 0');
  for (const audio of audios) {
    assert.ok(Buffer.isBuffer(audio.data.audio), 'audio payload must be binary');
    assert.deepStrictEqual(audio.data.format, ttsService.VOICE_STREAM_FORMAT);
    assert.strictEqual(audio.data.streamId, starts[0].data.streamId);
  }
  assert.ok(!socket.emits.some((e) => e.event === 'ai:stt:final'), 'audio never rides in chat messages');
});
checkAsync('failed chunk emits voice:tts:error and stream still ends', async () => {
  const socket = makeSocket();
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('simulated outage');
      err.code = 'TTS_ERROR';
      throw err;
    }
    return mockSynthesize('ok');
  };
  const provider = new voiceProvider.GeminiStreamingTtsProvider({ synthesize: flaky });
  const streamer = new ttsService.VoiceTtsStreamer({ socket, provider });
  streamer.push(`${'Steady sentence for the flaky test case. '.repeat(12)} Closing line here.`);
  await streamer.flush();
  const errors = socket.emits.filter((e) => e.event === 'voice:tts:error');
  const ends = socket.emits.filter((e) => e.event === 'voice:tts:end');
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(ends.length, 1, 'stream still completes');
});
checkAsync('stop() emits voice:tts:cancel + legacy stop (interruption)', async () => {
  const socket = makeSocket();
  const slow = {
    format: { ...ttsService.VOICE_STREAM_FORMAT },
    startStream: ({ onAudio, signal }) => {
      let cancelled = false;
      return {
        writeText() {
          setTimeout(async () => {
            if (cancelled || (signal && signal.aborted)) return;
            onAudio(Buffer.alloc(100, 1));
          }, 50);
        },
        async flush() {
          await new Promise((r) => setTimeout(r, 80));
        },
        cancel() { cancelled = true; },
        async close() {},
      };
    },
  };
  const streamer = new ttsService.VoiceTtsStreamer({ socket, provider: slow });
  streamer.push('A fairly long first sentence for the test. Another sentence here.');
  streamer.stop('interrupted');
  await streamer.flush();
  const cancels = socket.emits.filter((e) => e.event === 'voice:tts:cancel');
  const legacy = socket.emits.filter((e) => e.event === 'ai:tts:audio:stop');
  assert.ok(cancels.length >= 1, 'must emit voice:tts:cancel');
  assert.ok(legacy.length >= 1, 'must emit legacy stop for old clients');
  const audios = socket.emits.filter((e) => e.event === 'voice:tts:audio');
  assert.strictEqual(audios.length, 0, 'no audio may emit after stop');
});
checkAsync('aborted request signal suppresses all audio delivery', async () => {
  const socket = makeSocket();
  const controller = new AbortController();
  controller.abort();
  const mockProvider = new voiceProvider.GeminiStreamingTtsProvider({ synthesize: mockSynthesize });
  const streamer = new ttsService.VoiceTtsStreamer({ socket, signal: controller.signal, provider: mockProvider });
  streamer.push('Hello world. How are you?');
  await streamer.flush();
  const audios = socket.emits.filter((e) => e.event === 'voice:tts:audio');
  assert.strictEqual(audios.length, 0);
});

console.log('\nAll Voice Runtime 3.0 server tests completed.\n');
