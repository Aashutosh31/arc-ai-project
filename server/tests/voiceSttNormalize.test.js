// Voice Runtime 4.0 — server STT normalization + safety wiring tests.
// Run with: node tests/voiceSttNormalize.test.js
//
// Covers: normalized `voice:stt:final` payload fields, destructive-command
// gating (needsClarification), benign transcripts untouched, vocabulary hints
// reaching the provider session, exactly-one-final invariant, and no-final-on-
// cancel invariant.
const assert = require('node:assert');

const stt = require('../services/sttService');
const { buildVoiceContext } = require('../services/transcriptNormalizer');

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

const PCM = (frames = 2400) => Buffer.alloc(frames * 2);
const FORMAT = stt.STT_SESSION_FORMAT;

function fakeSocket() {
  const emits = [];
  const handlers = {};
  return {
    emits,
    emit(event, payload) { emits.push({ event, payload }); },
    on(event, fn) { handlers[event] = fn; },
    trigger(event, payload) { handlers[event]?.(payload); },
    handlers,
  };
}

// Provider that records the createSession options (to assert vocabulary hints).
function capturingProvider(inner) {
  const captured = { options: null };
  return {
    kind: inner?.kind || 'capture',
    createSession(options) {
      captured.options = options;
      return inner.createSession({ ...options });
    },
    captured,
  };
}

console.log('Voice Runtime 4.0 STT Normalization Tests');
console.log('========================================');

const main = async () => {

// ---- Final payload normalization ----
await check('destructive transcript is corrected and gated on the final event', async () => {
  const socket = fakeSocket();
  const coordinator = new stt.VoiceSttSession({ socket, provider: new stt.MockSttProvider({ transcript: 'delete the repozotory' }) });
  coordinator.open();
  const sessionId = socket.emits.find((e) => e.event === 'voice:stt:started').payload.sessionId;
  coordinator.handleAudio({ sessionId, seq: 0, format: FORMAT, audio: PCM() });
  await coordinator.commit();
  const finals = socket.emits.filter((e) => e.event === 'voice:stt:final');
  assert.strictEqual(finals.length, 1);
  const payload = finals[0].payload;
  assert.strictEqual(payload.text, 'delete the repository');
  assert.strictEqual(payload.rawText, 'delete the repozotory');
  assert.strictEqual(payload.needsClarification, true);
  assert.ok(payload.destructive, 'destructive marker must be present');
  assert.strictEqual(payload.destructive.verb, 'delete');
  assert.ok(Array.isArray(payload.corrections) && payload.corrections.length >= 1);
});

await check('clear conversation is gated with no text corruption', async () => {
  const socket = fakeSocket();
  const coordinator = new stt.VoiceSttSession({ socket, provider: new stt.MockSttProvider({ transcript: 'clear my conversation' }) });
  coordinator.open();
  const sessionId = socket.emits.find((e) => e.event === 'voice:stt:started').payload.sessionId;
  coordinator.handleAudio({ sessionId, seq: 0, format: FORMAT, audio: PCM() });
  await coordinator.commit();
  const finals = socket.emits.filter((e) => e.event === 'voice:stt:final');
  assert.strictEqual(finals[0].payload.text, 'clear my conversation');
  assert.strictEqual(finals[0].payload.needsClarification, true);
  assert.deepStrictEqual(finals[0].payload.corrections, []);
});

await check('benign transcript passes through uncorrected and un-gated', async () => {
  const socket = fakeSocket();
  const coordinator = new stt.VoiceSttSession({ socket, provider: new stt.MockSttProvider({ transcript: 'what is the weather today' }) });
  coordinator.open();
  const sessionId = socket.emits.find((e) => e.event === 'voice:stt:started').payload.sessionId;
  coordinator.handleAudio({ sessionId, seq: 0, format: FORMAT, audio: PCM() });
  await coordinator.commit();
  const finals = socket.emits.filter((e) => e.event === 'voice:stt:final');
  assert.strictEqual(finals[0].payload.text, 'what is the weather today');
  assert.strictEqual(finals[0].payload.needsClarification, false);
  assert.strictEqual(finals[0].payload.destructive, null);
});

await check('exactly-one-final invariant holds under normalization', async () => {
  const socket = fakeSocket();
  const coordinator = new stt.VoiceSttSession({ socket, provider: new stt.MockSttProvider({ transcript: 'delete the repozotory' }) });
  coordinator.open();
  const sessionId = socket.emits.find((e) => e.event === 'voice:stt:started').payload.sessionId;
  coordinator.handleAudio({ sessionId, seq: 0, format: FORMAT, audio: PCM() });
  await coordinator.commit();
  await coordinator.commit();
  coordinator.handleAudio({ sessionId, seq: 1, format: FORMAT, audio: PCM() });
  const finals = socket.emits.filter((e) => e.event === 'voice:stt:final');
  assert.strictEqual(finals.length, 1, 'normalization must not duplicate the final');
});

await check('canceled session emits no final (no message after cancel)', async () => {
  const socket = fakeSocket();
  const coordinator = new stt.VoiceSttSession({ socket, provider: new stt.MockSttProvider({ transcript: 'delete everything' }) });
  coordinator.open();
  const sessionId = socket.emits.find((e) => e.event === 'voice:stt:started').payload.sessionId;
  coordinator.handleAudio({ sessionId, seq: 0, format: FORMAT, audio: PCM() });
  coordinator.cancel('barge-in');
  await coordinator.commit();
  assert.strictEqual(socket.emits.filter((e) => e.event === 'voice:stt:final').length, 0);
});

// ---- Vocabulary hints reach the provider session ----
await check('vocabulary hints are passed into provider sessions', async () => {
  const socket = fakeSocket();
  const inner = new stt.MockSttProvider({ transcript: 'hi' });
  const capture = capturingProvider(inner);
  const context = buildVoiceContext({ tools: ['sendEmail'], maxTerms: 30 });
  const coordinator = new stt.VoiceSttSession({ socket, provider: capture, context });
  coordinator.open();
  assert.ok(Array.isArray(capture.captured.options.vocabulary));
  assert.ok(capture.captured.options.vocabulary.length >= 1);
  // The injected vocabulary must include the ARC domain terms.
  const joined = capture.captured.options.vocabulary.join(' ').toLowerCase();
  assert.ok(joined.includes('sendemail'));
});

await check('injected context is honored, otherwise a default is built', async () => {
  const socket = fakeSocket();
  const inner = new stt.MockSttProvider({ transcript: 'hi' });
  const capture = capturingProvider(inner);
  const coordinator = new stt.VoiceSttSession({ socket, provider: capture });
  coordinator.open();
  assert.ok(Array.isArray(capture.captured.options.vocabulary));
  assert.ok(capture.captured.options.vocabulary.length >= 1);
});

await check('getConfig advertises normalization + destructive-command safety', () => {
  const config = stt.getConfig();
  assert.strictEqual(config.normalization, true);
  assert.strictEqual(config.safety.destructiveCommandsRequireConfirmation, true);
});

console.log('');
for (const line of results) console.log(line);
console.log('');
if (failures > 0) {
  console.error(`${failures} Voice Runtime 4.0 STT normalization test(s) FAILED.`);
  process.exit(1);
}
console.log(`All Voice Runtime 4.0 STT normalization tests completed (${results.length} passed).\n`);
};

main().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});