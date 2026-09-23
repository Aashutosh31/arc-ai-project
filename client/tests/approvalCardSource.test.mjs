// client/tests/approvalCardSource.test.mjs
//
// JARVIS Action Substrate — slice 4D: source-level regression guards for the
// approval UI. Plain node, no runner (mirrors executionPanel.test.mjs).
//
// Run: cd client && node tests/approvalCardSource.test.mjs
//
// Guards the presentation-only contract end to end:
//   - the card renders only safe metadata, never args/credentials/outputs
//   - the card never auto-approves and never touches the socket
//   - only the ApprovalContext emits `agent:approval:resolve`
//   - the resolve payload is exactly { approvalId, decision } (no client id)
//   - approval listener registration is direct, never in the refcounted
//     useSocket SOCKET_EVENTS teardown scope
//   - non-blocking, a11y-friendly (noc autoFocus, aria-live, real buttons)
import assert from 'node:assert';
import { readFileSync as readFs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;

async function check(label, fn) {
  try { await fn(); pass += 1; console.log(`  PASS  ${label}`); }
  catch (err) { fail += 1; process.exitCode = 1; console.error(`  FAIL  ${label}\n        ${err.message}`); }
}

console.log('Client Approval Card Source Regression Tests');
console.log('=============================================');

const cardSrc = readFs(join(__dir, '..', 'src', 'components', 'ApprovalCard.jsx'), 'utf8');
const ctxSrc = readFs(join(__dir, '..', 'src', 'contexts', 'ApprovalContext.jsx'), 'utf8');
const chatSrc = readFs(join(__dir, '..', 'src', 'components', 'ChatInterface.jsx'), 'utf8');

await check('card asks permission, never claims execution', () => {
  assert.ok(cardSrc.includes('requesting permission'), 'must ask permission to run');
  assert.ok(cardSrc.includes('Nothing runs before you decide'), 'waiting copy must be explicit');
  assert.ok(cardSrc.includes('will not run'), 'denied copy must never imply execution');
  assert.ok(cardSrc.includes('no decision was received'), 'expired/cancelled copy is neutral');
});

await check('card renders safe metadata only (no args/credentials/outputs)', () => {
  for (const banned of ['.args', 'credentials=', 'apiKey=', 'password=', '.output=', 'authorization:']) {
    assert.ok(!cardSrc.includes(banned), `card must not render ${banned}`);
  }
  assert.ok(!cardSrc.includes('approval.args'), 'no raw payload passthrough');
  assert.ok(cardSrc.includes('approval.toolName'), 'card renders the tool name');
  assert.ok(cardSrc.includes('approval.reason'), 'card may render the operator reason');
});

await check('card never auto-approves and never emits on the socket', () => {
  for (const banned of ['autoApprove', 'socket.emit', 'agent:approval:resolve', 'ai:stt:final', 'resolveApproval(']) {
    assert.ok(!cardSrc.includes(banned), `card must not ${banned}`);
  }
  assert.ok(!cardSrc.includes('useSocket'), 'card must not pull the socket hook');
});

await check('card is keyboard-safe and live-announces status', () => {
  assert.ok(!/autoFocus/.test(cardSrc), 'card must never steal focus');
  assert.ok(cardSrc.includes('aria-live="polite"'), 'status must be a polite live region');
  assert.ok(cardSrc.includes('role="status"'), 'status must be announced');
  assert.ok(cardSrc.includes('actionable'), 'buttons guarded by a can-decide condition');
  assert.ok(cardSrc.includes('disabled={!actionable}'), 'buttons disabled once non-actionable');
  assert.ok(/onResolve\?\.\(approval.approvalId, 'approve'\)/.test(cardSrc), 'approve wired via onResolve');
  assert.ok(/onResolve\?\.\(approval.approvalId, 'deny'\)/.test(cardSrc), 'deny wired via onResolve');
});

await check('context is the single resolve emitter with the exact 4C payload', () => {
  const emitMatch = ctxSrc.match(/socket\.emit\('agent:approval:resolve', \{ approvalId, decision \}, ([^)]*)\)/);
  assert.ok(emitMatch, 'emit payload must be exactly { approvalId, decision } with an ack callback');
  assert.ok(/normalizeAckArgs\(args\)|settle\(normalizeAckArgs\(args\)\)/.test(ctxSrc), 'ack must be normalized from raw socket.io args');
  assert.ok(ctxSrc.includes('no userId, no executionId'), 'contract comment must document server-bound identity');
  assert.ok(!ctxSrc.includes('socket.userId'), 'identity is never read from the client payload');
  assert.ok(!ctxSrc.includes('autoAppro'), 'context must never auto-approve');
});

await check('requested listener is registered directly, not in useSocket teardown scope', () => {
  assert.ok(ctxSrc.includes("socket.on('agent:approval:requested', onRequested)"), 'must subscribe on mount');
  assert.ok(ctxSrc.includes('socket.off'), 'must unsubscribe on unmount');
  assert.ok(!ctxSrc.includes("from '../hooks/useSocket'"), 'must not depend on the refcounted teardown scope');
});

await check('context delegates all transitions to the pure helper', () => {
  for (const helper of ['normalizeApprovalRequest', 'resolveStart', 'reconcileAck', 'applyExpiryTick', 'requestAdd']) {
    assert.ok(ctxSrc.includes(helper), `must use ${helper}`);
  }
});

await check('chat renders the approval stack inline and binds resolve', () => {
  assert.ok(chatSrc.includes("useApprovals"), 'chat must consume the approvals context');
  assert.ok(chatSrc.includes('<ApprovalCard'), 'chat must render approval cards inline');
  assert.ok(chatSrc.includes('onResolve={resolveApproval}'), 'chat must bind the resolve action');
  assert.ok(chatSrc.includes('approval.approvalId'), 'keys are per-approval-id');
});

console.log(`\n${pass + fail} tests, ${pass} passed, ${fail} failed`);