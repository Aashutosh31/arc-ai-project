/* StreamingRuntime latency regression tests — run with: node tests/streamingRuntime.test.js
 *
 * Covers: default 0ms delay (nullish logic), explicit overrides, non-blocking
 * persistence callbacks, interrupt lifecycle, timing hooks, Unicode safety.
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

const StreamingRuntime = require('../lib/llm/StreamingRuntime');

const makeSocket = () => {
  const emits = [];
  return {
    emits,
    isInterrupted: false,
    emit(event, data) {
      emits.push({ event, data, at: Date.now() });
    }
  };
};

console.log('StreamingRuntime Latency Tests');
console.log('==============================');

console.log('\n1. Delay configuration');
check('defaults to 0ms when env is unset', () => {
  const prev = process.env.LLM_STREAM_CHUNK_DELAY_MS;
  delete process.env.LLM_STREAM_CHUNK_DELAY_MS;
  const runtime = new StreamingRuntime();
  assert.strictEqual(runtime.chunkDelayMs, 0);
  if (prev !== undefined) process.env.LLM_STREAM_CHUNK_DELAY_MS = prev;
});
check('explicit 0 stays 0 (nullish logic, not ||)', () => {
  const prev = process.env.LLM_STREAM_CHUNK_DELAY_MS;
  process.env.LLM_STREAM_CHUNK_DELAY_MS = '0';
  const runtime = new StreamingRuntime();
  assert.strictEqual(runtime.chunkDelayMs, 0);
  if (prev !== undefined) process.env.LLM_STREAM_CHUNK_DELAY_MS = prev;
  else delete process.env.LLM_STREAM_CHUNK_DELAY_MS;
});
check('explicit 20 still works (simulated typing opt-in)', () => {
  const runtime = new StreamingRuntime({ chunkDelayMs: 20 });
  assert.strictEqual(runtime.chunkDelayMs, 20);
});
check('invalid values fall back to 0', () => {
  const runtime = new StreamingRuntime({ chunkDelayMs: 'not-a-number' });
  assert.strictEqual(runtime.chunkDelayMs, 0);
});

console.log('\n2. emitText delivery speed');
checkAsync('500-word response emits without artificial slowdown', async () => {
  const runtime = new StreamingRuntime();
  const socket = makeSocket();
  const text = Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ');
  const startedAt = Date.now();
  const out = await runtime.emitText(socket, text);
  const elapsed = Date.now() - startedAt;
  const chunks = socket.emits.filter((e) => e.event === 'ai:tts:response:chunk' && !e.data.isFinal);
  const finals = socket.emits.filter((e) => e.event === 'ai:tts:response:chunk' && e.data.isFinal);
  assert.strictEqual(chunks.length, 500);
  assert.strictEqual(finals.length, 1);
  assert.ok(out.length > 0);
  // Old behavior: 500 words x 20ms = ~10s. New: must be well under 1.5s.
  assert.ok(elapsed < 1500, `took ${elapsed}ms, expected < 1500ms`);
  console.log(`    measured 500-word emitText: ${elapsed}ms (was ~10000ms before)`);
});
checkAsync('explicit delay still applies when configured', async () => {
  const runtime = new StreamingRuntime({ chunkDelayMs: 20 });
  const socket = makeSocket();
  const startedAt = Date.now();
  await runtime.emitText(socket, 'one two three');
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 50, `expected >= 50ms with 20ms x 3 words, got ${elapsed}ms`);
});

console.log('\n3. Non-blocking persistence callbacks');
checkAsync('slow onChunk does not delay socket emits', async () => {
  const runtime = new StreamingRuntime();
  const socket = makeSocket();
  const startedAt = Date.now();
  await runtime.emitText(socket, 'alpha beta gamma delta', null, async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const lastEmitAt = socket.emits[socket.emits.length - 1].at;
  const deliveryMs = lastEmitAt - startedAt;
  // 4 chunks x 50ms persistence = 200ms of DB work, but delivery must be fast.
  assert.ok(deliveryMs < 120, `delivery took ${deliveryMs}ms despite slow persistence`);
});
checkAsync('onChunk rejection never breaks delivery', async () => {
  const runtime = new StreamingRuntime();
  const socket = makeSocket();
  const out = await runtime.emitText(socket, 'hello world', null, async () => {
    throw new Error('simulated DB failure');
  });
  assert.strictEqual(out, 'hello world');
  const finals = socket.emits.filter((e) => e.data.isFinal);
  assert.strictEqual(finals.length, 1);
});
checkAsync('onChunk calls stay ordered', async () => {
  const runtime = new StreamingRuntime();
  const socket = makeSocket();
  const seen = [];
  await runtime.emitText(socket, 'a b c', null, async (chunk) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(chunk.trim());
  });
  assert.deepStrictEqual(seen, ['a', 'b', 'c']);
});

console.log('\n4. Interrupt lifecycle');
checkAsync('interrupted emitText stops early but still sends isFinal', async () => {
  const runtime = new StreamingRuntime({ chunkDelayMs: 5 });
  const socket = makeSocket();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 15);
  const out = await runtime.emitText(socket, Array.from({ length: 100 }, (_, i) => `w${i}`).join(' '), controller.signal);
  const words = out ? out.split(' ').length : 0;
  assert.ok(words < 100, `expected early stop, got ${words} words`);
  const finals = socket.emits.filter((e) => e.data.isFinal);
  assert.strictEqual(finals.length, 1);
});
checkAsync('consume respects socket.isInterrupted and sends isFinal', async () => {
  const runtime = new StreamingRuntime();
  const socket = makeSocket();
  async function* stream() {
    yield { text: 'first ' };
    socket.isInterrupted = true;
    yield { text: 'second ' };
  }
  const out = await runtime.consume(stream(), socket, null);
  assert.strictEqual(out, 'first ');
  const finals = socket.emits.filter((e) => e.data.isFinal);
  assert.strictEqual(finals.length, 1);
});

console.log('\n5. consume() behavior');
checkAsync('streams provider chunks immediately with hooks', async () => {
  const runtime = new StreamingRuntime();
  const socket = makeSocket();
  let firstFired = false;
  let lastFired = false;
  async function* stream() {
    yield { text: 'Hello ' };
    yield { text: 'world' };
  }
  const out = await runtime.consume(stream(), socket, null, null, {
    onFirstChunk: () => { firstFired = true; },
    onLastChunk: () => { lastFired = true; }
  });
  assert.strictEqual(out, 'Hello world');
  assert.ok(firstFired && lastFired);
  const texts = socket.emits.filter((e) => !e.data.isFinal).map((e) => e.data.chunk);
  assert.deepStrictEqual(texts, ['Hello ', 'world']);
});
checkAsync('empty stream sends isFinal and returns empty', async () => {
  const runtime = new StreamingRuntime();
  const socket = makeSocket();
  async function* stream() {}
  const out = await runtime.consume(stream(), socket, null);
  assert.strictEqual(out, '');
  assert.strictEqual(socket.emits.filter((e) => e.data.isFinal).length, 1);
});
checkAsync('missing socket returns empty with isFinal skipped safely', async () => {
  const runtime = new StreamingRuntime();
  const out = await runtime.emitText(null, 'hello');
  assert.strictEqual(out, '');
});

console.log('\n6. Unicode safety');
checkAsync('lone surrogates pass through without throwing', async () => {
  const runtime = new StreamingRuntime();
  const socket = makeSocket();
  const out = await runtime.emitText(socket, 'emoji test \uD800 done');
  assert.ok(out.length > 0);
  assert.strictEqual(socket.emits.filter((e) => e.data.isFinal).length, 1);
});

console.log('\nAll StreamingRuntime latency tests completed.\n');
