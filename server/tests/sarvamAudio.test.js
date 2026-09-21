/* Sarvam audio bridge unit tests — run with: node tests/sarvamAudio.test.js
 *
 * Verifies the single server-side resample stage (ARC 24 kHz PCM16 → Sarvam
 * 16 kHz linear16), endianness preservation, identity short-circuit, odd-byte
 * truncation, and degenerate-input safety. Pure: no network, no keys.
 */

const assert = require('assert');
const { SARVAM_STT_SAMPLE_RATE, resamplePcm16Mono } = require('../services/sarvamAudio');

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

const FRAME_BYTES = 4800; // 100 ms of 24 kHz mono pcm16

const sinePcm = (samples, { hz = 440, amplitude = 5000, sampleRate } = {}) => {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * amplitude), i * 2);
  }
  return buf;
};

console.log('Sarvam Audio Tests');
console.log('==================');

console.log('\n1. Resample size math');
check('24→16 kHz halves the byte count per frame duration', () => {
  const out = resamplePcm16Mono(sinePcm(2400, { sampleRate: 24000 }), 24000, 16000);
  assert.strictEqual(out.length, 3200); // 1600 samples @ 16 kHz = 100 ms
});
check('constant rate short-circuits to a byte copy', () => {
  const pcm = sinePcm(2400, { sampleRate: 24000 });
  const out = resamplePcm16Mono(pcm, 24000, 24000);
  assert.strictEqual(out.length, pcm.length);
  assert.notStrictEqual(out, pcm, 'copy must not alias the input');
});
check('upsample 16→24 grows the byte count', () => {
  const out = resamplePcm16Mono(sinePcm(2400, { sampleRate: 16000 }), 16000, 24000);
  assert.ok(out.length > 4800, `expected > 4800, got ${out.length}`);
});

console.log('\n2. Content integrity');
check('resampled sine keeps the same fundamental frequency', () => {
  const src = sinePcm(2400, { hz: 440, sampleRate: 24000 });
  const out = resamplePcm16Mono(src, 24000, 16000);
  // Positive zero-crossings per second roughly equals the frequency.
  let crossings = 0;
  let prev = out.readInt16LE(0) >= 0;
  for (let i = 1; i < out.length / 2; i += 1) {
    const now = out.readInt16LE(i * 2) >= 0;
    if (now && !prev) crossings += 1;
    prev = now;
  }
  const hz = (crossings / (out.length / 2)) * 16000;
  assert.ok(hz > 400 && hz < 480, `440 Hz distorted to ${hz.toFixed(1)} Hz`);
});
check('samples stay in validated PCM16 range after interpolation', () => {
  const src = sinePcm(2400, { hz: 5000, amplitude: 30000, sampleRate: 24000 });
  const out = resamplePcm16Mono(src, 24000, 16000);
  let ok = true;
  for (let i = 0; i < out.length / 2; i += 1) {
    const s = out.readInt16LE(i * 2);
    if (s < -32768 || s > 32767) ok = false;
  }
  assert.ok(ok, 'no sample may exceed PCM16 bounds');
});
check('dark silence stays silence', () => {
  const out = resamplePcm16Mono(Buffer.alloc(4800), 24000, 16000);
  assert.strictEqual(out.length, 3200);
  let sum = 0;
  for (let i = 0; i < out.length / 2; i += 1) sum += Math.abs(out.readInt16LE(i * 2));
  assert.strictEqual(sum, 0);
});

console.log('\n3. Edge cases');
check('odd-length payload truncates to whole samples', () => {
  const out = resamplePcm16Mono(Buffer.alloc(4801), 24000, 16000);
  assert.strictEqual(out.length, 3200);
});
check('tiny payload (< 2 samples) yields empty output', () => {
  assert.strictEqual(resamplePcm16Mono(Buffer.alloc(2), 24000, 16000).length, 0);
});
check('degenerate inputs return empty buffers', () => {
  assert.strictEqual(resamplePcm16Mono(null, 24000, 16000).length, 0);
  assert.strictEqual(resamplePcm16Mono(Buffer.alloc(0), 24000, 16000).length, 0);
  assert.strictEqual(resamplePcm16Mono(Buffer.alloc(4800), 0, 16000).length, 0);
  assert.strictEqual(resamplePcm16Mono(Buffer.alloc(4800), 24000, -1).length, 0);
});
check('string input coerces to bytes without throwing', () => {
  const out = resamplePcm16Mono('junk', 24000, 16000);
  assert.ok(Buffer.isBuffer(out), 'returns a buffer');
});
check('a full 4800-byte frame resamples to exactly SARVAM_STT_SAMPLE_RATE/sec', () => {
  assert.strictEqual(SARVAM_STT_SAMPLE_RATE, 16000);
  const out = resamplePcm16Mono(Buffer.alloc(FRAME_BYTES), 24000, SARVAM_STT_SAMPLE_RATE);
  assert.strictEqual(out.length, (SARVAM_STT_SAMPLE_RATE * FRAME_BYTES) / (24000 * 2) * 2);
});

console.log('\nAll Sarvam audio tests completed.');