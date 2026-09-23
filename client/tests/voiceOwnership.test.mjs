/* Voice playback ownership arbitration tests (headless).
 *
 * Guards the intra-tab double-voice regression: one assistant response
 * carries BOTH a legacy `ai:tts:audio` WAV queue and the AudioWorklet PCM
 * stream, and a single tab must play exactly one of them regardless of
 * arrival order. The legacy queue installs + plays synchronously while the
 * worklet path holds audio behind its pre-roll, so a WAV segment can already
 * be open when the worklet's first chunk lands.
 *
 * Run:  cd client && node tests/voiceOwnership.test.mjs
 */
import assert from 'node:assert';
import { createVoiceOwnership } from '../src/audio/voiceOwnership.js';

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

console.log('Voice Playback Ownership Tests');
console.log('==============================');

// Legacy WAV opens first, then the worklet delivers its first chunk.
await check('WAV-first: worklet first chunk preempts live legacy exactly once', () => {
  const own = createVoiceOwnership();
  assert.strictEqual(own.workletOwns(), false, 'fresh machine must not own');
  // Legacy segment 1 arrives and is enqueued before any worklet audio.
  assert.strictEqual(own.legacyShouldPlay(), true, 'legacy must be allowed before worklet');
  own.markLegacyLive();
  // Legacy segment 2 chains behind it (still allowed).
  assert.strictEqual(own.legacyShouldPlay(), true, 'legacy chain allowed while worklet silent');
  own.markLegacyLive();

  // Worklet first chunk: ownership flips AND legacy must be preempted.
  const first = own.onWorkletChunk();
  assert.strictEqual(first.first, true);
  assert.strictEqual(first.preemptLegacy, true, 'live WAV was not preempted → double voice');
  assert.strictEqual(own.workletOwns(), true);

  // Trailing worklet chunks must not re-preempt (single resetAudio call).
  const second = own.onWorkletChunk();
  assert.strictEqual(second.first, false, 'should only report one first chunk');
  assert.strictEqual(second.preemptLegacy, false, 'repeated preempt would flush a live engine');

  // Late legacy segments are dropped outright.
  assert.strictEqual(own.legacyShouldPlay(), false, 'legacy enqueued after hand-off');
});

await check('WAV-first with staged (pre-activation) worklet audio preempts too', () => {
  const own = createVoiceOwnership();
  own.markLegacyLive();
  const r = own.onWorkletChunk();
  assert.strictEqual(r.preemptLegacy, true, 'staged first chunk must preempt legacy');
  assert.strictEqual(own.workletOwns(), true);
});

// Worklet delivers first: legacy either arrives later (dropped) or the worklet
// delivers before a plain conversational turn (nothing to preempt).
await check('worklet-first: legacy is dropped from the start, no preempt needed', () => {
  const own = createVoiceOwnership();
  const first = own.onWorkletChunk();
  assert.strictEqual(first.preemptLegacy, false, 'nothing live to preempt');
  assert.strictEqual(own.workletOwns(), true);
  assert.strictEqual(own.legacyShouldPlay(), false, 'legacy must never open once worklet owns');
});

await check('mixed: legacy admitted then dropped, reset restores both orders', () => {
  const own = createVoiceOwnership();
  // Response A: full hand-off.
  own.markLegacyLive();
  own.onWorkletChunk();
  assert.strictEqual(own.legacyShouldPlay(), false);
  // New response B: reset → a fresh no-owner machine.
  own.reset();
  assert.strictEqual(own.workletOwns(), false, 'reset must clear worklet ownership');
  assert.strictEqual(own.legacyShouldPlay(), true, 'legacy fallback must return after reset');
  // Response C: legacy never opens (worklet wins immediately).
  own.onWorkletChunk();
  assert.strictEqual(own.legacyShouldPlay(), false);
});

await check('legacy admitted only when enqueue succeeded (markLegacyLive gating)', () => {
  const own = createVoiceOwnership();
  // Data.onChunk may fail (autoplay blocked) → nothing live → later worklet
  // arrival must NOT report a preempt against nothing.
  assert.strictEqual(own.legacyShouldPlay(), true);
  const r = own.onWorkletChunk();
  assert.strictEqual(r.preemptLegacy, false, 'phantom preempt when legacy never enqueued');
  assert.strictEqual(own.workletOwns(), true);
});

console.log(results.join('\n'));
console.log(`\n${results.length} tests, ${results.length - failures} passed, ${failures} failed`);
if (failures) process.exitCode = 1;