'use strict';

// JARVIS Action Substrate — slice 4C: APPROVAL STORE tests.
//
// The server-authoritative, single-use, TTL-protected, identity-bound
// approval state model. Pure store tests — no sockets, no executor:
//   1. create pending
//   2. approve once
//   3. deny once
//   4. expiry
//   5. cancellation
//   6. single-use
//   7. duplicate approve
//   8. approve-after-deny
//   9. approve-after-expiry
//  10. user binding
//  11. execution binding
//  12. workspace binding
//  13. capability binding
//
// Run: cd server && node tests/approvalStore.test.js

const assert = require('assert');
const approvalStore = require('../lib/capabilities/approvalStore');

const { STATES } = approvalStore;

let pass = 0;
let fail = 0;

async function test(label, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    fail += 1;
    process.exitCode = 1;
    console.error(`  FAIL  ${label}\n        ${err && err.message ? err.message : String(err)}`);
  }
}

const ctx = () => ({
  executionId: 'cap-11111111-1111-1111-1111-111111111111',
  userId: 'u-1',
  workspaceId: 'ws-1',
  capabilityId: 'native:sendEmail',
  source: 'native',
  toolName: 'sendEmail',
  risk: 'high',
  scope: 'consequential',
  reason: 'consequential-default',
});

const mk = (over = {}) => approvalStore.create({ ...ctx(), ...over });
const resolve = (over = {}) => {
  const record = over.approvalId || mk();
  return { record, out: approvalStore.resolve({
    approvalId: record.approvalId,
    decision: 'approve',
    userId: 'u-1',
    ...over.opts,
  }) };
};

const main = async () => {
  console.log('Approval store (slice 4C)');
  console.log('=========================');

  // 1. create pending
  await test('create produces a PENDING, TTL-protected, identity-bound record', async () => {
    approvalStore._reset();
    const r = mk();
    assert.ok(r.approvalId.startsWith('apr-'), 'server-generated approval id prefix');
    assert.notStrictEqual(r.approvalId, r.executionId, 'approvalId !== executionId');
    assert.strictEqual(r.state, STATES.PENDING);
    assert.strictEqual(r.executionId, 'cap-11111111-1111-1111-1111-111111111111');
    assert.strictEqual(r.userId, 'u-1');
    assert.strictEqual(r.workspaceId, 'ws-1');
    assert.strictEqual(r.capabilityId, 'native:sendEmail');
    assert.strictEqual(r.source, 'native');
    assert.ok(r.createdAt > 0 && r.expiresAt > r.createdAt, 'expiresAt after createdAt');
    assert.strictEqual(r.decision, null);
    assert.strictEqual(r.resolvedAt, null);
    approvalStore._reset();
  });

  // 2. approve once
  await test('approve transitions PENDING -> APPROVED exactly once', async () => {
    approvalStore._reset();
    const r = mk();
    const out = approvalStore.resolve({ approvalId: r.approvalId, decision: 'approve', userId: 'u-1' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.state, STATES.APPROVED);
    assert.strictEqual(out.record.decision, 'approve');
    assert.ok(out.record.resolvedAt >= out.record.createdAt, 'resolvedAt recorded');
    assert.strictEqual(approvalStore.read(r.approvalId).state, STATES.APPROVED);
    approvalStore._reset();
  });

  // 3. deny once
  await test('deny transitions PENDING -> DENIED', async () => {
    approvalStore._reset();
    const r = mk();
    const out = approvalStore.resolve({ approvalId: r.approvalId, decision: 'deny', userId: 'u-1' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.state, STATES.DENIED);
    assert.strictEqual(out.record.decision, 'deny');
    approvalStore._reset();
  });

  // 4. expiry
  await test('expiry transitions PENDING -> EXPIRED and blocks approval', async () => {
    approvalStore._reset();
    const r = mk({ ttlMs: 30 });
    await new Promise((res) => setTimeout(res, 70));
    assert.strictEqual(approvalStore.read(r.approvalId).state, STATES.EXPIRED, 'TTL timer expired the record');
    const out = approvalStore.resolve({ approvalId: r.approvalId, decision: 'approve', userId: 'u-1' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'expired');
    approvalStore._reset();
  });

  // 5. cancellation
  await test('cancel transitions PENDING -> CANCELLED (user-bound)', async () => {
    approvalStore._reset();
    const r = mk();
    const out = approvalStore.cancel({ approvalId: r.approvalId, userId: 'u-1' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.state, STATES.CANCELLED);
    approvalStore._reset();
  });

  // 6. single-use
  await test('a resolved approval cannot be re-transitioned (single-use)', async () => {
    approvalStore._reset();
    const r = mk();
    assert.strictEqual(approvalStore.resolve({ approvalId: r.approvalId, decision: 'approve', userId: 'u-1' }).ok, true);
    const again = approvalStore.resolve({ approvalId: r.approvalId, decision: 'approve', userId: 'u-1' });
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.reason, 'already_resolved');
    assert.strictEqual(approvalStore.read(r.approvalId).state, STATES.APPROVED);
    approvalStore._reset();
  });

  // 7. duplicate approve
  await test('duplicate approve: only the first wins', async () => {
    approvalStore._reset();
    const r = mk();
    const first = approvalStore.resolve({ approvalId: r.approvalId, decision: 'approve', userId: 'u-1' });
    const second = approvalStore.resolve({ approvalId: r.approvalId, decision: 'approve', userId: 'u-1' });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(approvalStore.read(r.approvalId).state, STATES.APPROVED);
    approvalStore._reset();
  });

  // 8. approve-after-deny
  await test('approve after a deny is rejected', async () => {
    approvalStore._reset();
    const r = mk();
    assert.strictEqual(approvalStore.resolve({ approvalId: r.approvalId, decision: 'deny', userId: 'u-1' }).ok, true);
    const late = approvalStore.resolve({ approvalId: r.approvalId, decision: 'approve', userId: 'u-1' });
    assert.strictEqual(late.ok, false);
    assert.strictEqual(late.reason, 'already_resolved');
    assert.strictEqual(approvalStore.read(r.approvalId).state, STATES.DENIED);
    approvalStore._reset();
  });

  // 9. approve-after-expiry
  await test('approve after expiry is rejected and never resurrects', async () => {
    approvalStore._reset();
    const r = mk({ ttlMs: 30 });
    await new Promise((res) => setTimeout(res, 70));
    const out = approvalStore.resolve({ approvalId: r.approvalId, decision: 'approve', userId: 'u-1' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'expired');
    assert.strictEqual(approvalStore.read(r.approvalId).state, STATES.EXPIRED);
    approvalStore._reset();
  });

  // 10. user binding
  await test('wrong authenticated user cannot resolve an approval', async () => {
    approvalStore._reset();
    const r = mk();
    const wrongUser = approvalStore.resolve({ approvalId: r.approvalId, decision: 'approve', userId: 'u-evil' });
    assert.strictEqual(wrongUser.ok, false);
    assert.strictEqual(wrongUser.reason, 'user_mismatch');
    assert.strictEqual(approvalStore.read(r.approvalId).state, STATES.PENDING);

    const wrongCancel = approvalStore.cancel({ approvalId: r.approvalId, userId: 'u-evil' });
    assert.strictEqual(wrongCancel.ok, false);
    assert.strictEqual(wrongCancel.reason, 'user_mismatch');
    assert.strictEqual(approvalStore.read(r.approvalId).state, STATES.PENDING);
    approvalStore._reset();
  });

  // 11. execution binding
  await test('wrong executionId cannot resolve an approval', async () => {
    approvalStore._reset();
    const r = mk();
    const out = approvalStore.resolve({
      approvalId: r.approvalId,
      decision: 'approve',
      userId: 'u-1',
      executionId: 'cap-99999999-9999-9999-9999-999999999999',
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'execution_mismatch');
    assert.strictEqual(approvalStore.read(r.approvalId).state, STATES.PENDING);
    approvalStore._reset();
  });

  // 12. workspace binding
  await test('wrong workspaceId cannot resolve an approval', async () => {
    approvalStore._reset();
    const r = mk();
    const out = approvalStore.resolve({
      approvalId: r.approvalId,
      decision: 'approve',
      userId: 'u-1',
      workspaceId: 'ws-other',
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'workspace_mismatch');
    assert.strictEqual(approvalStore.read(r.approvalId).state, STATES.PENDING);
    approvalStore._reset();
  });

  // 13. capability binding
  await test('wrong capabilityId cannot resolve an approval', async () => {
    approvalStore._reset();
    const r = mk();
    const out = approvalStore.resolve({
      approvalId: r.approvalId,
      decision: 'approve',
      userId: 'u-1',
      capabilityId: 'native:changeTheme',
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'capability_mismatch');
    assert.strictEqual(approvalStore.read(r.approvalId).state, STATES.PENDING);
    approvalStore._reset();
  });

  // Extra safety: unknown approvalId + malformed decision
  await test('malformed decision and unknown approvalId are rejected', async () => {
    approvalStore._reset();
    const unknown = approvalStore.resolve({ approvalId: 'apr-nonexistent', decision: 'approve', userId: 'u-1' });
    assert.strictEqual(unknown.ok, false);
    assert.strictEqual(unknown.reason, 'unknown');

    const r = mk();
    const malformed = approvalStore.resolve({ approvalId: r.approvalId, decision: 'maybe', userId: 'u-1' });
    assert.strictEqual(malformed.ok, false);
    assert.strictEqual(malformed.reason, 'invalid_decision');
    assert.strictEqual(approvalStore.read(r.approvalId).state, STATES.PENDING);
    approvalStore._reset();
  });

  approvalStore._reset();
  console.log(`\n${pass + fail} tests, ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});