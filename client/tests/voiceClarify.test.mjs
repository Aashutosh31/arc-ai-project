/* Voice Runtime 4.0 — clarification gate tests (headless).
 * Run with: node tests/voiceClarify.test.mjs
 *
 * Covers: the §15/§17 transcript-gating decision, `voice:stt:final` field
 * passthrough through the streaming channel (corrections, needsClarification,
 * destructive), exactly-one-final counting, and end/cancel session reset
 * invariants on the client side.
 */
import assert from 'node:assert';

import {
  StreamingSttChannel,
  _resetSttChannelForTests,
} from '../src/utils/sttChannel.js';
import {
  shouldGateTranscript,
  transcriptGateReason,
} from '../src/utils/voiceTranscriptGate.js';

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

console.log('Voice Runtime 4.0 Clarification Gate Tests');
console.log('==========================================');

// ---- Gating decision (pure) ----
await check('destructive transcripts are always gated', () => {
  assert.strictEqual(
    shouldGateTranscript({ text: 'delete the repository', needsClarification: true, destructive: { verb: 'delete' } }),
    true
  );
  assert.strictEqual(transcriptGateReason({ text: 'delete the repository', needsClarification: true, destructive: { verb: 'delete' } }), 'destructive-command:delete');
});

await check('low-confidence transcripts with needsClarification are gated', () => {
  assert.strictEqual(shouldGateTranscript({ text: 'clear it all', needsClarification: true, reason: 'destructive-command:clear' }), true);
});

await check('plain transcripts are never gated', () => {
  assert.strictEqual(shouldGateTranscript('what is the weather today'), false);
  assert.strictEqual(shouldGateTranscript({ text: 'hello', needsClarification: false }), false);
  assert.strictEqual(shouldGateTranscript(''), false);
});

// ---- Channel passthrough ----
await check('voice:stt:final passthrough preserves normalization fields', () => {
  _resetSttChannelForTests();
  const channel = new StreamingSttChannel();
  const received = [];
  channel.onEvent((type, data) => { if (type === 'final') received.push(data); });
  channel.handleServerEvent('voice:stt:final', {
    sessionId: 's1', seq: 1, text: 'delete the repository',
    rawText: 'delete the repozotory',
    corrections: [{ from: 'repozotory', to: 'repository', confidence: 0.8 }],
    needsClarification: true,
    lowConfidence: false,
    destructive: { verb: 'delete', target: 'repository', confidence: 0.9 },
    reason: 'destructive-command:delete',
  });
  assert.strictEqual(received.length, 1);
  const payload = received[0];
  assert.strictEqual(payload.text, 'delete the repository');
  assert.strictEqual(payload.needsClarification, true);
  assert.ok(payload.destructive && payload.destructive.verb === 'delete');
  assert.deepStrictEqual(payload.corrections, [{ from: 'repozotory', to: 'repository', confidence: 0.8 }]);
  assert.strictEqual(payload.rawText, 'delete the repozotory');
});

await check('exactly-one-final counting: each final increments counters.finals once', () => {
  const channel = new StreamingSttChannel();
  channel.handleServerEvent('voice:stt:final', { text: 'one' });
  channel.handleServerEvent('voice:stt:final', { text: 'two' });
  assert.strictEqual(channel.counters.finals, 2);
});

await check('end resets the active session (stale audio cannot start a new turn)', () => {
  const channel = new StreamingSttChannel();
  channel.sessionId = 's-live';
  channel.active = true;
  channel.handleServerEvent('voice:stt:end', {});
  assert.strictEqual(channel.sessionId, null);
  assert.strictEqual(channel.active, false);
});

await check('cancelled resets the session and reports the reason', () => {
  const channel = new StreamingSttChannel();
  channel.sessionId = 's-live';
  channel.active = true;
  const events = [];
  channel.onEvent((type, data) => events.push(type));
  channel.handleServerEvent('voice:stt:cancelled', { reason: 'barge-in' });
  assert.strictEqual(events.includes('cancelled'), true);
  assert.strictEqual(channel.sessionId, null);
  assert.strictEqual(channel.active, false);
});

await check('interim routing still maps to { text } for the UI preview', () => {
  const channel = new StreamingSttChannel();
  const received = [];
  channel.onEvent((type, data) => { if (type === 'interim') received.push(data); });
  channel.handleServerEvent('voice:stt:interim', { text: 'partial' });
  assert.deepStrictEqual(received, [{ text: 'partial' }]);
});

console.log('');
for (const line of results) console.log(line);
console.log('');
if (failures > 0) {
  console.error(`${failures} Voice Runtime 4.0 clarification gate test(s) FAILED.`);
  process.exit(1);
}
console.log(`All Voice Runtime 4.0 clarification gate tests completed (${results.length} passed).\n`);