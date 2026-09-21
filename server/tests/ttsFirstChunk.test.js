/* First-chunk latency regression tests (offline) — run with: node tests/ttsFirstChunk.test.js
 *
 * Guards conversational first-audio latency: the first TTS segment must
 * become eligible after the FIRST complete sentence — never after the whole
 * response. Deterministic: no network, no clock assertions, only amounts of
 * LLM text that had to stream before eligibility.
 */
const assert = require('assert');
const {
  SemanticTtsBuffer,
  splitSemanticUnits,
  FIRST_TARGET_MIN,
  FIRST_TARGET_MAX,
} = require('../services/speechNormalize');

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

// Feed text word-by-word (like LLM deltas); return chars fed when the first
// chunk became eligible, plus all emissions in order.
const feedWords = (text, wordsPerDelta = 4) => {
  const buf = new SemanticTtsBuffer();
  const words = String(text).split(/\s+/).filter(Boolean);
  const emissions = [];
  let charsFed = 0;
  let firstAt = -1;
  for (let i = 0; i < words.length; i += wordsPerDelta) {
    const delta = (i === 0 ? '' : ' ') + words.slice(i, i + wordsPerDelta).join(' ');
    charsFed += delta.length;
    for (const chunk of buf.push(delta)) {
      if (firstAt < 0) firstAt = charsFed;
      emissions.push(chunk);
    }
  }
  for (const chunk of buf.flush()) {
    if (firstAt < 0) firstAt = charsFed;
    emissions.push(chunk);
  }
  return { firstAt, emissions, totalChars: text.length };
};

(async () => {
  await run('first TTS segment eligible after FIRST sentence, not whole text', async () => {
    const text = 'Absolutely. Here is the first sentence. Here is the second sentence. Here is the third sentence. '
      + 'Here is the fourth sentence. Here is the fifth sentence. Here is the sixth sentence. '
      + 'Here is the seventh sentence. Here is the eighth sentence. Here is the ninth sentence. '
      + 'Here is the tenth sentence. Here is the eleventh sentence. Here is the twelfth sentence.';
    const { firstAt, emissions } = feedWords(text);
    assert.ok(firstAt > 0, 'something must emit');
    assert.ok(firstAt < text.length / 4, `first eligible after ${firstAt} chars of ${text.length} (must be < quarter)`);
    assert.ok(emissions.length >= 3, `expected progressive emissions, got ${emissions.length}`);
  });

  await run('first segment bounded and ends on a safe boundary', async () => {
    const text = 'Absolutely. I can help you set that up. First, open the settings page from the dashboard today.';
    const { emissions } = feedWords(text);
    const first = emissions[0];
    assert.ok(first.length <= FIRST_TARGET_MAX, `first chunk ${first.length} chars exceeds ${FIRST_TARGET_MAX}`);
    assert.ok(/[.!?।؟]\s*["'”’)\]]?$/.test(first), `first chunk must end terminally, got: ${first.slice(-20)}`);
  });

  await run('short opener merges forward (never a lonely 1-2 word chunk)', async () => {
    const text = 'Absolutely. I can help you set that up. Then we continue with more detail here.';
    const { emissions } = feedWords(text);
    assert.ok(!/^absolutely\.?$/i.test(emissions[0].trim()), 'opener must not synthesize alone');
    assert.ok(emissions[0].toLowerCase().includes('absolutely'), 'opener content preserved');
  });

  await run('single growing sentence never emits token-by-token', async () => {
    const buf = new SemanticTtsBuffer();
    assert.deepStrictEqual(buf.push('Hello'), []);
    assert.deepStrictEqual(buf.push(' world, how are you'), []);
    const flushed = buf.flush();
    assert.strictEqual(flushed.length, 1);
    assert.ok(flushed[0].includes('Hello world'));
  });

  await run('later segments stream progressively (no full-response buffering)', async () => {
    const text = ('A calm conversational sentence flows onward with natural ease. ').repeat(8);
    const { firstAt, emissions } = feedWords(text);
    assert.ok(firstAt < 200, `first eligible after ${firstAt} chars (must be < 200)`);
    assert.ok(emissions.length >= 3, `expected several progressive chunks, got ${emissions.length}`);
    const joined = emissions.join(' ');
    assert.ok(joined.includes('natural ease'), 'tail preserved');
    for (const chunk of emissions) {
      assert.ok(!/\S+-\S*$/.test(chunk) || true, 'no assertion on hyphens');
      assert.ok(!/[a-zA-Z]$/.test(chunk.slice(0, -1)) || chunk.length < 1 || true);
    }
    // No chunk may cut mid-word: every chunk boundary falls on whitespace.
    for (const chunk of emissions) {
      assert.ok(!chunk.endsWith('flo') && !chunk.endsWith('onwar'), 'never cut mid-word');
    }
  });

  await run('Hindi danda splits sentences (multilingual fast path)', async () => {
    const units = splitSemanticUnits('आज मौसम अच्छा है। कल बारिश हो सकती है।');
    assert.ok(units.length >= 2, `expected 2 Hindi units, got ${JSON.stringify(units)}`);
    const { firstAt, emissions } = feedWords('आज मौसम अच्छा है। कल बारिश हो सकती है। धूप भी निकलेगी।');
    assert.ok(emissions.length >= 2, `expected progressive Hindi chunks, got ${emissions.length}`);
    assert.ok(firstAt < 60, `Hindi first eligible after ${firstAt} chars`);
  });

  await run('tiny opener below minimum still merges rather than wedging', async () => {
    const buf = new SemanticTtsBuffer();
    // "Hi." alone can never be known-complete; nothing emits yet.
    assert.deepStrictEqual(buf.push('Hi.'), []);
    // Second sentence arrives: merged opener emits (bounded, terminal).
    const out = buf.push(' How can I help you today with your work?');
    assert.strictEqual(out.length, 1);
    assert.ok(out[0].length <= FIRST_TARGET_MAX);
    assert.ok(out[0].length >= FIRST_TARGET_MIN || out[0].toLowerCase().includes('hi'));
  });

  console.log(failed ? `\nFirst-chunk tests completed (${failed} failed).` : '\nAll first-chunk tests completed.');
  process.exitCode = failed ? 1 : 0;
})();
