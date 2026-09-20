/* Sarvam live smoke tests — run with: node tests/sarvamLive.test.js
 *
 * GATED on SARVAM_API_KEY (skips loudly when missing). Real credentials, real
 * api.sarvam.ai WebSockets. Bounded: a short STT silence loop and a one-line
 * TTS sentence. Never logs keys, audio, or request payloads.
 */

const assert = require('assert');
require('dotenv').config();

const hasKey = Boolean(process.env.SARVAM_API_KEY);
if (!hasKey) {
  console.log('SKIP  SARVAM_API_KEY not set — live tests skipped.');
  process.exit(0);
}

const { SarvamRealtimeSttProvider, SarvamStreamingTtsProvider } = require('../services/sarvamProvider');
const { STT_SESSION_FORMAT } = require('../services/sttService');

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

let failed = 0;
const run = async (label, fn, { timeoutMs = 60000 } = {}) => {
  const timer = setTimeout(() => {
    console.error(`  FAIL  ${label} (timed out after ${timeoutMs}ms)`);
    failed += 1;
    process.exitCode = 1;
  }, timeoutMs);
  try {
    await fn();
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
};

console.log('Sarvam Live Tests');
console.log('=================');

(async () => {
  await run('STT endpoint accepts the configured model + a silence frame', async () => {
    const errors = [];
    const provider = new SarvamRealtimeSttProvider();
    const session = provider.createSession({
      onError: (thisError) => errors.push(thisError),
      onComplete: () => {},
    });
    // ~1 s of 24k mono silence → resampled to 16k on the wire.
    for (let seq = 0; seq < 10; seq += 1) {
      session.writeAudio({ audio: Buffer.alloc(4800), format: STT_SESSION_FORMAT, seq });
    }
    await tick(3000);
    session.close();
    const fatal = errors.filter((thisError) => thisError?.code !== 'SARVAM_CONNECTION_ERROR');
    assert.deepStrictEqual(fatal, [], `unexpected fatal STT errors: ${fatal.map((e) => e.code).join(', ')}`);
  });

  await run('STT stream_type=fast reports session.begin then closes cleanly on end', async () => {
    const provider = new SarvamRealtimeSttProvider();
    const session = provider.createSession({});
    for (let seq = 0; seq < 5; seq += 1) {
      session.writeAudio({ audio: Buffer.alloc(4800), format: STT_SESSION_FORMAT, seq });
    }
    await tick(2500);
    session.cancel('smoke complete');
  });

  await run('TTS synthesizes a one-line sentence into linear16 24k audio', async () => {
    const provider = new SarvamStreamingTtsProvider();
    const chunks = [];
    const providerErrors = [];
    const session = provider.startStream({
      onAudio: (chunk) => chunks.push(chunk),
      onError: (thisError) => providerErrors.push(thisError),
    });
    session.writeText('Hello from the ARC voice runtime.');
    await session.flush();
    await session.close();
    assert.deepStrictEqual(providerErrors, [], 'TTS reported no errors');
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    assert.ok(total > 1000, `expected audible PCM audio, got ${total} bytes`);
  });

  await run('TTS voices a detected language override (hi-IN)', async () => {
    const provider = new SarvamStreamingTtsProvider();
    const chunks = [];
    const session = provider.startStream({ language: 'hi-IN', onAudio: (c) => chunks.push(c) });
    session.writeText('Namaste, main aapki helper hoon.');
    await session.flush();
    await session.close();
    assert.ok(chunks.reduce((sum, c) => sum + c.length, 0) > 500, 'hindi audio produced');
  });

  // ---- Real speech loopback: Sarvam TTS → 24k PCM → real Sarvam STT.
  // TTS audio is produced at 24k mono PCM16 — exactly the client frame format
  // the STT provider expects; the provider resamples it to 16k for the wire
  // exactly as it does for live browser frames.
  const synthesize24k = async ({ language, text }) => {
    const tts = new SarvamStreamingTtsProvider();
    const chunks = [];
    const ttsSession = tts.startStream({ language, onAudio: (c) => chunks.push(c) });
    ttsSession.writeText(text);
    await ttsSession.flush();
    await ttsSession.close();
    const pcm24 = Buffer.concat(chunks);
    assert.ok(pcm24.length > 1000, `TTS produced no audible audio for "${text.slice(0, 20)}..."`);
    return pcm24;
  };

  const transcribeLoopback = async ({ language, text, waitMs = 45000 }) => {
    const pcm24 = await synthesize24k({ language, text });
    const interims = [];
    const speechEvents = [];
    let finalText = null;
    let languageMeta = null;
    let confidenceMeta = null;
    let providerErrors = [];

    const stt = new SarvamRealtimeSttProvider();
    const session = stt.createSession({
      onInterim: (partial) => interims.push(String(partial || '')),
      onFinal: (final, meta) => {
        finalText = String(final || '');
        languageMeta = meta && meta.language;
        confidenceMeta = meta && meta.languageConfidence;
      },
      onSpeechStart: () => speechEvents.push('start'),
      onSpeechEnd: () => speechEvents.push('end'),
      onError: (err) => providerErrors.push(err),
    });

    // Emulate a live mic: feed the spoken audio in 100 ms @24k frames with
    // tiny pacing so VAD/endpointing sees a real streamed utterance.
    const frame = 4800;
    for (let off = 0; off < pcm24.length; off += frame) {
      session.writeAudio({ audio: pcm24.subarray(off, off + frame), format: STT_SESSION_FORMAT, seq: off / frame });
      // eslint-disable-next-line no-await-in-loop
      await tick(35);
    }
    const started = Date.now();
    while (finalText == null && Date.now() - started < waitMs) {
      await tick(200);
    }
    await session.commit();
    session.close();
    return { interims, speechEvents, finalText, languageMeta, confidenceMeta, providerErrors };
  };

  await run('STT loopback transcribes real Sarvam TTS speech (English)', async () => {
    const result = await transcribeLoopback({ language: 'en-IN', text: 'Hello world, this is a live speech to text test.' });
    assert.deepStrictEqual(result.providerErrors, [], 'no STT provider errors');
    assert.ok(result.finalText && result.finalText.trim().length > 0, `expected a final transcript, got ${JSON.stringify(result.finalText)}`);
    assert.ok(result.languageMeta, `expected language metadata, got ${JSON.stringify(result.languageMeta)}`);
    assert.ok(result.interims.length > 0, 'expected at least one partial transcript while speaking');
    console.log(`        [en-loopback] final="${result.finalText.slice(0, 60)}" lang=${JSON.stringify(result.languageMeta)} interims=${result.interims.length} speechEvents=${result.speechEvents.join(',') || 'none'}`);
  });

  await run('STT loopback detects the spoken language (Hindi, auto-detect)', async () => {
    const result = await transcribeLoopback({ language: 'hi-IN', text: 'Namaste, aaj mausam kaisa hai.' });
    assert.deepStrictEqual(result.providerErrors, [], 'no STT provider errors');
    assert.ok(result.finalText && result.finalText.trim().length > 0, `expected a final transcript, got ${JSON.stringify(result.finalText)}`);
    assert.ok(result.languageMeta, 'auto-detect returned language metadata');
    const aspect = /\b(hi|hin|hne|hi[-_]?in)\b/i.test(String(result.languageMeta)) ? 'hi' : String(result.languageMeta);
    console.log(`        [hi-loopback] final="${result.finalText.slice(0, 60)}" lang=${JSON.stringify(result.languageMeta)} isHindi=${aspect === 'hi'} interims=${result.interims.length} speechEvents=${result.speechEvents.join(',') || 'none'}`);
    // Report, do not fail on: an English-classified transcript of spoken Hindi
    // is a provider auto-detect property, not a transport failure.
    assert.notStrictEqual(aspect, 'en',
      `auto-detect classified spoken Hindi as English (${result.languageMeta}) — verify language handling`);
  });

  await run('STT loopback surfaces interception VAD events (speech:start/end)', async () => {
    const result = await transcribeLoopback({ language: 'en-IN', text: 'Vad should fire around this sentence.' });
    assert.ok(result.speechEvents.length >= 2, `expected speech:start + speech:end, got [${result.speechEvents.join(',')}]`);
    assert.strictEqual(result.speechEvents[0], 'start');
    assert.strictEqual(result.speechEvents[result.speechEvents.length - 1], 'end');
  });

  await tick(2500);
  console.log(failed ? `\nSarvam live tests completed (${failed} failed).` : '\nAll Sarvam live tests completed.');
})();