// client/tests/approvalUiState.test.mjs
//
// JARVIS Action Substrate — slice 4D: approval UI-state matrix (pure node,
// mirrors the mcpOAuthUiState suite pattern).
//
// Run: cd client && node tests/approvalUiState.test.mjs
//
// Covers the frontend state machine against the 4C transport contract:
//   - payload whitelist (no args/credentials/outputs ever reach UI state)
//   - request upsert (duplicate event idempotent, terminal never resurrected)
//   - resolve started only from pending (double-click race guard)
//   - server ack is authoritative (approve/deny/already_resolved/expired)
//   - network failure returns to retryable pending (self-healing)
//   - invalid/unknown ack surfaces an error without claiming a result
//   - display-only local expiry (server TTL remains the authority)
//   - risk/scope/source mapping with text labels (never color-only)
import assert from 'node:assert';
import {
  SERVER_STATES,
  UI_STATES,
  applyExpiryTick,
  ackOfError,
  ackOfResponse,
  canDecide,
  displayStatus,
  formatExpiry,
  isTerminalStatus,
  listApprovals,
  normalizeAckArgs,
  normalizeApprovalRequest,
  pendingCount,
  reconcileAck,
  requestAdd,
  resolveStart,
  riskLabel,
  riskTone,
  scopeLabel,
  sourceLabel,
} from '../src/lib/approvalUi.js';

const passed = [];
const failed = [];

const test = async (name, fn) => {
  try {
    await fn();
    passed.push(name);
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed.push({ name, err });
    console.error(`  FAIL - ${name}`);
    console.error(`         ${err && err.message}`);
  }
};

const FUTURE = Date.now() + 300000;
const futurePayload = (over = {}) => ({
  approvalId: 'apr-test-1',
  executionId: 'cap-test-1',
  capabilityId: 'native:getTime',
  toolName: 'getTime',
  source: 'native',
  risk: 'high',
  scope: 'consequential',
  reason: 'Operator policy requires approval',
  expiresAt: new Date(FUTURE).toISOString(),
  state: 'PENDING',
  ...over,
});

// ---- safe-payload contract ------------------------------------------------

await test('normalize keeps only whitelisted safe metadata', () => {
  const rec = normalizeApprovalRequest({
    ...futurePayload(),
    // Anything unsafe must be dropped before it can ever re-render.
    args: { url: 'https://example.com/leak' },
    credentials: { apiKey: 'super-secret' },
    output: { emailBody: 'dropped' },
    nested: { apiKey: 'dropped' },
    auth: 'secret-token',
  });
  assert.ok(rec, 'record created');
  assert.strictEqual(rec.approvalId, 'apr-test-1');
  assert.strictEqual(rec.toolName, 'getTime');
  assert.strictEqual(rec.source, 'native');
  assert.strictEqual(rec.expiresAtMs, FUTURE);
  for (const banned of ['args', 'credentials', 'output', 'nested', 'auth']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(rec, banned), `must drop ${banned}`);
  }
});

await test('normalize rejects non-string / missing approvalId', () => {
  assert.strictEqual(normalizeApprovalRequest({ toolName: 'getTime' }), null);
  assert.strictEqual(normalizeApprovalRequest({ approvalId: 42 }), null);
  assert.strictEqual(normalizeApprovalRequest(null), null);
  assert.strictEqual(normalizeApprovalRequest('bogus'), null);
});

await test('unknown expiresAt keeps no fabricated countdown', () => {
  const rec = normalizeApprovalRequest(futurePayload({ expiresAt: 'not-a-date' }));
  assert.ok(rec);
  assert.strictEqual(rec.expiresAtMs, null);
});

// ---- request upsert --------------------------------------------------------

await test('requestAdd adds a new pending record', () => {
  const rec = normalizeApprovalRequest(futurePayload());
  const map = requestAdd({}, rec);
  assert.strictEqual(map[rec.approvalId].uiState, UI_STATES.PENDING);
});

await test('duplicate request event is idempotent (keeps arrival order)', () => {
  const rec = normalizeApprovalRequest(futurePayload());
  const map = requestAdd({}, rec);
  const second = normalizeApprovalRequest(futurePayload({ reason: 'refreshed reason' }));
  const dup = requestAdd(map, second);
  assert.strictEqual(dup['apr-test-1'].receivedAt, map['apr-test-1'].receivedAt, 'arrival order preserved');
  assert.strictEqual(dup['apr-test-1'].reason, 'refreshed reason', 'preview metadata refreshed');
  assert.strictEqual(dup['apr-test-1'].uiState, UI_STATES.PENDING);
});

await test('a resolved card is never resurrected by a stale repeat', () => {
  const rec = normalizeApprovalRequest(futurePayload());
  const atOnce = requestAdd({}, rec);
  const approved = reconcileAck(atOnce, 'apr-test-1', { ok: true, state: SERVER_STATES.APPROVED });
  const repeated = requestAdd(approved, rec);
  assert.strictEqual(repeated['apr-test-1'].uiState, UI_STATES.APPROVED);
  assert.strictEqual(repeated['apr-test-1'].pendingDecision, null);
});

// ---- resolve-start race guard ---------------------------------------------

await test('resolveStart marks only pending records busy', () => {
  const rec = normalizeApprovalRequest(futurePayload());
  const map = requestAdd({}, rec);
  const mid = resolveStart(map, 'apr-test-1', 'approve');
  assert.strictEqual(mid['apr-test-1'].uiState, UI_STATES.BUSY);
  assert.strictEqual(mid['apr-test-1'].pendingDecision, 'approve');
  // A second click while busy is ignored (client half of the race guard).
  const again = resolveStart(mid, 'apr-test-1', 'deny');
  assert.strictEqual(again['apr-test-1'].pendingDecision, 'approve');
});

await test('resolveStart ignores unknown ids and bad decisions', () => {
  const rec = normalizeApprovalRequest(futurePayload());
  const map = requestAdd({}, rec);
  assert.strictEqual(resolveStart(map, 'apr-nope', 'approve'), map);
  assert.strictEqual(resolveStart(map, 'apr-test-1', 'maybe'), map);
});

// ---- ack reconciliation (server authoritative) ------------------------------

await test('ack ok:true APPROVED lands an approved card', () => {
  const rec = normalizeApprovalRequest(futurePayload());
  const map = resolveStart(requestAdd({}, rec), 'apr-test-1', 'approve');
  const done = reconcileAck(map, 'apr-test-1', { ok: true, state: SERVER_STATES.APPROVED });
  assert.strictEqual(done['apr-test-1'].uiState, UI_STATES.APPROVED);
  assert.strictEqual(done['apr-test-1'].pendingDecision, null);
  assert.ok(isTerminalStatus(UI_STATES.APPROVED));
});

await test('ack ok:true DENIED lands a denied card', () => {
  const rec = normalizeApprovalRequest(futurePayload());
  const map = resolveStart(requestAdd({}, rec), 'apr-test-1', 'deny');
  const done = reconcileAck(map, 'apr-test-1', { ok: true, state: SERVER_STATES.DENIED });
  assert.strictEqual(done['apr-test-1'].uiState, UI_STATES.DENIED);
});

await test('too-late approve with a served state reconciles to that state', () => {
  // Server resolves when we did not: already_resolved / expired come back
  // with a state even though ok is false — the served status wins.
  const rec = normalizeApprovalRequest(futurePayload());
  const map = resolveStart(requestAdd({}, rec), 'apr-test-1', 'approve');
  const stale = reconcileAck(map, 'apr-test-1', { ok: false, reason: 'already_resolved', state: SERVER_STATES.APPROVED });
  assert.strictEqual(stale['apr-test-1'].uiState, UI_STATES.APPROVED);
  const expired = reconcileAck(map, 'apr-test-1', { ok: false, reason: 'expired', state: SERVER_STATES.EXPIRED });
  assert.strictEqual(expired['apr-test-1'].uiState, UI_STATES.EXPIRED);
});

await test('network failure returns to retryable pending (never fabricates)', () => {
  const rec = normalizeApprovalRequest(futurePayload());
  const map = resolveStart(requestAdd({}, rec), 'apr-test-1', 'approve');
  const retryable = reconcileAck(map, 'apr-test-1', ackOfError(new Error('timeout')));
  assert.strictEqual(retryable['apr-test-1'].uiState, UI_STATES.PENDING);
  assert.match(retryable['apr-test-1'].error, /retry/i);
  assert.ok(canDecide(retryable['apr-test-1'], Date.now()), 'retry must be possible');
});

await test('unknown / invalid ack surfaces an error, never a result', () => {
  const rec = normalizeApprovalRequest(futurePayload());
  const map = resolveStart(requestAdd({}, rec), 'apr-test-1', 'approve');
  const bad = reconcileAck(map, 'apr-test-1', { ok: false, reason: 'invalid_decision', state: null });
  assert.strictEqual(bad['apr-test-1'].uiState, UI_STATES.ERROR);
  assert.ok(!isTerminalStatus(bad['apr-test-1'].uiState), 'error must not look terminal');
  assert.match(bad['apr-test-1'].error, /invalid_decision/);
  assert.ok(!canDecide(bad['apr-test-1'], Date.now()), 'blocked from acting on an errored card');
});

await test('normalizeAckArgs: server ack object (approve) is authoritative', () => {
  const ack = normalizeAckArgs([{ ok: true, state: SERVER_STATES.APPROVED }]);
  assert.deepStrictEqual(ack, { ok: true, reason: null, state: SERVER_STATES.APPROVED });
});

await test('normalizeAckArgs: already_resolved / deny ack still lands the status', () => {
  const ack = normalizeAckArgs([{ ok: false, reason: 'already_resolved', state: SERVER_STATES.APPROVED }]);
  assert.strictEqual(ack.ok, false);
  assert.strictEqual(ack.state, SERVER_STATES.APPROVED);
  const deny = normalizeAckArgs([{ ok: true, state: SERVER_STATES.DENIED }]);
  assert.strictEqual(deny.state, SERVER_STATES.DENIED);
});

await test('normalizeAckArgs: multi/single arg twice-fired acks settle on the first object', () => {
  const once = normalizeAckArgs([{ ok: false, reason: 'user_mismatch', state: null }]);
  assert.strictEqual(once.ok, false);
  assert.strictEqual(once.reason, 'user_mismatch');
});

await test('normalizeAckArgs: no ack / non-object args => retryable no-ack', () => {
  assert.deepStrictEqual(normalizeAckArgs([]), { ok: false, reason: 'no-ack' });
  assert.deepStrictEqual(normalizeAckArgs([undefined]), { ok: false, reason: 'no-ack' });
  assert.deepStrictEqual(normalizeAckArgs(['string']), { ok: false, reason: 'no-ack' });
  assert.deepStrictEqual(normalizeAckArgs([null]), { ok: false, reason: 'no-ack' });
  const map = requestAdd({}, normalizeApprovalRequest(futurePayload()));
  const retryable = reconcileAck(map, 'apr-test-1', normalizeAckArgs([]));
  assert.strictEqual(retryable['apr-test-1'].uiState, UI_STATES.PENDING, 'lost ack reverts to pending');
  assert.ok(canDecide(retryable['apr-test-1'], Date.now()), 'lost ack stays retryable');
  assert.match(retryable['apr-test-1'].error, /retry/i);
});

// ---- display-only expiry ----------------------------------------------------

await test('applyExpiryTick flips only past-due pending cards', () => {
  const future = normalizeApprovalRequest(futurePayload({ approvalId: 'apr-future', expiresAt: new Date(Date.now() + 60000).toISOString() }));
  const past = normalizeApprovalRequest(futurePayload({ approvalId: 'apr-past', expiresAt: new Date(Date.now() - 5000).toISOString() }));
  let map = requestAdd(requestAdd({}, future), past);
  map = applyExpiryTick(map, Date.now());
  assert.strictEqual(map['apr-future'].uiState, UI_STATES.PENDING);
  assert.strictEqual(map['apr-past'].uiState, UI_STATES.EXPIRED);
});

await test('busy and terminal cards are not locally expired', () => {
  const rec = normalizeApprovalRequest(futurePayload({ approvalId: 'apr-busy', expiresAt: new Date(Date.now() - 5000).toISOString() }));
  let map = requestAdd({}, rec);
  map = resolveStart(map, 'apr-busy', 'approve');
  map = applyExpiryTick(map, Date.now());
  assert.strictEqual(map['apr-busy'].uiState, UI_STATES.BUSY, 'in-flight decision wins over display expiry');
});

await test('displayStatus and canDecide honor expiry', () => {
  const rec = normalizeApprovalRequest(futurePayload({ expiresAt: new Date(Date.now() + 20000).toISOString() }));
  const map = requestAdd({}, rec);
  assert.strictEqual(displayStatus(map['apr-test-1'], Date.now()), UI_STATES.PENDING);
  assert.ok(canDecide(map['apr-test-1'], Date.now()));
  assert.strictEqual(displayStatus(map['apr-test-1'], Date.now() + 30000), UI_STATES.EXPIRED);
  assert.ok(!canDecide(map['apr-test-1'], Date.now() + 30000));
});

await test('formatExpiry builds countdown then Expired', () => {
  const rec = normalizeApprovalRequest(futurePayload({ expiresAt: new Date(Date.now() + 9000).toISOString() }));
  const map = requestAdd({}, rec);
  assert.match(formatExpiry(map['apr-test-1'], Date.now()), /Expires in/);
  assert.strictEqual(formatExpiry(map['apr-test-1'], Date.now() + 12000), 'Expired');
});

// ---- list / count -----------------------------------------------------------

await test('listApprovals sorts newest-first with status attached', () => {
  const a = normalizeApprovalRequest(futurePayload({ approvalId: 'apr-a' }));
  const b = normalizeApprovalRequest(futurePayload({ approvalId: 'apr-b' }));
  let map = requestAdd(requestAdd({}, a), b);
  map = reconcileAck(map, 'apr-a', { ok: true, state: SERVER_STATES.APPROVED });
  const list = listApprovals(map, Date.now());
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[1].approvalId, 'apr-b', 'chronological fill order');
  assert.strictEqual(list.find((r) => r.approvalId === 'apr-a').status, UI_STATES.APPROVED);
  assert.strictEqual(pendingCount(map, Date.now()), 1);
});

// ---- mapping helpers (text labels are never color-only) ----------------------

await test('risk / scope / source mapping carries text labels', () => {
  assert.strictEqual(riskTone('high'), 'destructive');
  assert.strictEqual(riskTone('medium'), 'warning');
  assert.strictEqual(riskTone('low'), 'default');
  assert.strictEqual(riskLabel('high'), 'High risk');
  assert.strictEqual(riskLabel('medium'), 'Moderate risk');
  assert.strictEqual(riskLabel('low'), 'Low risk');
  assert.strictEqual(riskLabel(undefined), 'Risk unknown');
  assert.strictEqual(scopeLabel('read'), 'Reads data only');
  assert.strictEqual(scopeLabel('reversible'), 'Reversible action');
  assert.strictEqual(scopeLabel('consequential'), 'Has lasting external effects');
  assert.strictEqual(scopeLabel('bogus'), null);
  assert.strictEqual(sourceLabel('native'), 'Native tool');
  assert.strictEqual(sourceLabel('mcp'), 'MCP tool');
  assert.strictEqual(sourceLabel('other'), 'other');
});

// ---- ack normalizers ---------------------------------------------------------

await test('ack normalizers cover success, reject and network', () => {
  assert.deepStrictEqual(ackOfResponse({ ok: true, state: SERVER_STATES.APPROVED }), { ok: true, reason: null, state: 'APPROVED' });
  assert.deepStrictEqual(ackOfResponse({ ok: false, reason: 'already_resolved', state: SERVER_STATES.DENIED }), { ok: false, reason: 'already_resolved', state: 'DENIED' });
  assert.deepStrictEqual(ackOfError(new Error('x')), { ok: false, reason: 'network' });
  assert.deepStrictEqual(ackOfResponse(undefined), { ok: false, reason: 'no-ack' });
});

console.log(`\nApproval UI state: ${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);