'use strict';

// JARVIS Action Substrate — P0 #2 real Socket.IO validation:
// SAME-USER CROSS-SOCKET APPROVAL ISOLATION.
//
// Boots the REAL server (server/index.js: real Socket.IO server, real JWT
// middleware, real `agent:approval:resolve` handler, real approvalStore) and
// connects three real clients over localhost:
//   tabA / tabB -> the SAME authenticated user (two independent connections)
//   other       -> a different authenticated user
//
// The approval is created the way TaskExecutor creates it: through the real
// approvalStore, bound to the initiating connection's id. `socket.id` is the
// connection id shared by both ends of a Socket.IO link, so the client's own
// `socket.id` is exactly what the server holds for that connection.
//
// No database, no Atlas, no provider: mongoose.connect is neutered before the
// server boots, and every model call is stubbed. Nothing here can mutate a real
// database.
//
// Run: cd server && node tests/approvalSocketBinding.socket.test.js

const assert = require('assert');
const path = require('path');

let pass = 0;
let fail = 0;

async function check(label, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    fail += 1;
    process.exitCode = 1;
    console.error(`  FAIL  ${label}\n        ${err.message}`);
  }
}

console.log('Socket.IO Approval Socket-Binding Validation (P0 #2)');
console.log('===================================================');

// Deterministic identity material for this process only.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'approval-socket-binding-test-secret';
process.env.PORT = process.env.PORT || '45923';
delete process.env.MONGO_URI;
delete process.env.DATABASE_URL;

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { io: ioClient } = require(path.join(__dirname, '..', '..', 'client', 'node_modules', 'socket.io-client'));

// --- No database, ever -------------------------------------------------------
mongoose.connect = async () => mongoose;
mongoose.connection.close = async () => {};

const USER_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const USER_OTHER = 'cccccccccccccccccccccccc';

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const AIMemory = require('../models/AIMemory');
const UserFact = require('../models/UserFact');
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const ttsService = require('../services/ttsService');
const AIService = require('../services/AIService');
const operatorPolicySource = require('../lib/capabilities/operatorPolicySource');
const { McpToolSource } = require('../lib/mcp');
const approvalStore = require('../lib/capabilities/approvalStore');

const oneQuery = (doc) => {
  const q = { select: () => q, lean: () => q, then: (res, rej) => Promise.resolve(q._doc).then(res, rej) };
  q._doc = doc || null;
  return q;
};
const manyQuery = (docs) => {
  const q = {
    _docs: docs,
    select: () => q,
    sort: () => q,
    limit: (n) => { q._docs = q._docs.slice(0, n); return q; },
    lean: () => q,
    then: (res, rej) => Promise.resolve(q._docs).then(res, rej),
  };
  return q;
};

Conversation.findOne = () => oneQuery(null);
Conversation.find = () => manyQuery([]);
Conversation.findById = () => oneQuery(null);
Conversation.findOneAndUpdate = async () => null;
Conversation.prototype.save = async function save() { return this; };
Message.find = () => manyQuery([]);
Message.findOne = () => oneQuery(null);
Message.create = async (doc) => doc;
Message.findById = async () => null;
Message.findByIdAndUpdate = async () => null;
Message.countDocuments = async () => 0;
AIMemory.find = () => manyQuery([]);
AIMemory.prototype.save = async function save() { return this; };
UserFact.find = () => manyQuery([]);
UserFact.findOne = () => oneQuery(null);
User.findById = (id) =>
  oneQuery({ _id: id, creditsRemaining: 1000, language: 'en-US', preferences: {}, save: async () => {} });
Workspace.findOne = () => oneQuery(null);

// Runtime stubs (no provider, no TTS, no MCP discovery, no workspace).
AIService.workspaceRuntime.resolveWorkspace = async () => null;
ttsService.isServerTtsActive = () => false;
ttsService.getDefaultTtsLanguage = () => 'en-US';
AIService.llmRouter.generate = async () => ({
  text: 'ok', model: 'test-model', provider: 'test',
  tokens: { input: 1, output: 1 }, fallbackUsed: false, route: null,
});
const streamStub = { consume: async () => 'ok', emitText: async () => 'ok' };
AIService.llmRouter.streamingRuntime = streamStub;
AIService.streamingRuntime = streamStub;
McpToolSource.schemasForRequest = async () => ({ schemas: [], metadata: null, failures: [], blocked: [] });
operatorPolicySource.hydrate = async () => {};
operatorPolicySource.startRefreshTimer = () => {};
operatorPolicySource.stopRefreshTimer = () => {};

// Boot the real server (mongoose.connect already neutered above).
require('../index.js');

const URL = `http://127.0.0.1:${process.env.PORT}`;
const tokenFor = (userId) => jwt.sign({ id: userId, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '5m' });

// forceNew: true guarantees an INDEPENDENT connection (a separate engine.io
// session), which is exactly the "second tab" case under test.
const connectAs = (userId) =>
  new Promise((resolve, reject) => {
    const socket = ioClient(URL, { auth: { token: tokenFor(userId) }, transports: ['websocket'], forceNew: true });
    const timer = setTimeout(() => reject(new Error(`socket connect timeout for ${userId}`)), 8000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve({ socket, userId });
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

const ask = (client, payload) =>
  new Promise((resolve) => {
    client.socket.emit('agent:approval:resolve', payload, (ack) => resolve(ack));
  });

// The exact call TaskExecutor makes, with the initiating connection bound.
const raiseApprovalFor = (initiatingSocketId, overrides = {}) =>
  approvalStore.create({
    executionId: 'cap-33333333-3333-3333-3333-333333333333',
    userId: USER_A,
    workspaceId: 'ws-a',
    capabilityId: 'native:sendEmail',
    initiatingSocketId,
    source: 'native',
    toolName: 'sendEmail',
    risk: 'high',
    scope: 'consequential',
    reason: 'consequential-default',
    ...overrides,
  });

(async () => {
  const clients = [];
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    approvalStore._reset();

    const tabA = await connectAs(USER_A);
    const tabB = await connectAs(USER_A);
    const other = await connectAs(USER_OTHER);
    clients.push(tabA, tabB, other);

    await check('S1. two independent connections for one user get distinct socket ids', async () => {
      assert.notStrictEqual(tabA.socket.id, tabB.socket.id, 'each connection has its own id');
      assert.strictEqual(tabA.userId, tabB.userId, 'precondition: same authenticated user');
    });

    await check('S2. the initiating connection can resolve its own approval', async () => {
      const approval = raiseApprovalFor(tabA.socket.id);
      const ack = await ask(tabA, { approvalId: approval.approvalId, decision: 'approve' });
      assert.strictEqual(ack.ok, true, `expected ok, got ${JSON.stringify(ack)}`);
      assert.strictEqual(ack.state, 'APPROVED');
      assert.strictEqual(approvalStore.read(approval.approvalId).state, 'APPROVED');
    });

    await check('S3. the SAME USER on a different socket is rejected: socket_mismatch', async () => {
      const approval = raiseApprovalFor(tabA.socket.id);
      const ack = await ask(tabB, { approvalId: approval.approvalId, decision: 'approve' });
      assert.strictEqual(ack.ok, false, 'cross-socket approve must be refused');
      assert.strictEqual(ack.reason, 'socket_mismatch', 'repo-convention reason');
      assert.strictEqual(ack.state, 'PENDING', 'the record is untouched');
      assert.strictEqual(approvalStore.read(approval.approvalId).state, 'PENDING',
        'the sibling socket did not consume the approval');
      // ...and the real initiator is still able to resolve it.
      const ownerAck = await ask(tabA, { approvalId: approval.approvalId, decision: 'approve' });
      assert.strictEqual(ownerAck.ok, true, 'tab A remains able to resolve');
    });

    await check('S4. a different USER is rejected and cannot learn the socket id', async () => {
      const approval = raiseApprovalFor(tabA.socket.id);
      const ack = await ask(other, { approvalId: approval.approvalId, decision: 'approve' });
      assert.strictEqual(ack.ok, false);
      assert.strictEqual(ack.reason, 'user_mismatch', 'the user check precedes the socket check');
      assert.ok(!JSON.stringify(ack).includes(tabA.socket.id),
        'the ack never discloses the initiating socket id');
      assert.strictEqual(approvalStore.read(approval.approvalId).state, 'PENDING');
    });

    await check('S5. a client-supplied socketId cannot bypass or re-target the binding', async () => {
      const approval = raiseApprovalFor(tabA.socket.id);
      const forged = await ask(tabB, {
        approvalId: approval.approvalId,
        decision: 'approve',
        socketId: tabA.socket.id, // tab B claims to be tab A
      });
      assert.strictEqual(forged.ok, false, 'a forged payload socketId is ignored, not honoured');
      assert.strictEqual(forged.reason, 'socket_mismatch');
      assert.strictEqual(approvalStore.read(approval.approvalId).state, 'PENDING');

      // The genuine initiator is unaffected by the same forged field.
      const ownerAck = await ask(tabA, {
        approvalId: approval.approvalId,
        decision: 'approve',
        socketId: 'attacker-controlled',
      });
      assert.strictEqual(ownerAck.ok, true, 'payload socketId never overrides the server socket');
    });

    await check('S6. payload identity fields are ignored entirely, never re-targeted', async () => {
      // A sibling socket that also forges `userId` to match the owner still
      // fails on the socket binding: the payload cannot help it.
      const forSib = raiseApprovalFor(tabA.socket.id);
      const sibAck = await ask(tabB, {
        approvalId: forSib.approvalId,
        decision: 'approve',
        userId: USER_A,
        executionId: 'cap-44444444-4444-4444-4444-444444444444',
        workspaceId: 'ws-forged',
        capabilityId: 'native:deleteEverything',
      });
      assert.strictEqual(sibAck.ok, false, 'forging userId does not help a sibling socket');
      assert.strictEqual(sibAck.reason, 'socket_mismatch');

      // For the genuine initiator the handler does not forward those fields at
      // all, so the stored binding is simply the one decided at request time —
      // the client can neither retarget nor veto it.
      const ack = await ask(tabA, {
        approvalId: forSib.approvalId,
        decision: 'approve',
        executionId: 'cap-44444444-4444-4444-4444-444444444444',
        workspaceId: 'ws-forged',
        capabilityId: 'native:deleteEverything',
      });
      assert.strictEqual(ack.ok, true, 'forged binding fields are ignored, not honoured');
      const record = approvalStore.read(forSib.approvalId);
      assert.strictEqual(record.executionId, 'cap-33333333-3333-3333-3333-333333333333',
        'the approval stayed bound to the original execution');
      assert.strictEqual(record.workspaceId, 'ws-a', 'workspace binding unchanged');
      assert.strictEqual(record.capabilityId, 'native:sendEmail', 'capability binding unchanged');
    });

    await check('S7. duplicate resolve from the owning socket stays single-use', async () => {
      const approval = raiseApprovalFor(tabA.socket.id);
      const first = await ask(tabA, { approvalId: approval.approvalId, decision: 'approve' });
      assert.strictEqual(first.ok, true);
      const second = await ask(tabA, { approvalId: approval.approvalId, decision: 'approve' });
      assert.strictEqual(second.ok, false);
      assert.strictEqual(second.reason, 'already_resolved');
      const sibling = await ask(tabB, { approvalId: approval.approvalId, decision: 'approve' });
      assert.strictEqual(sibling.ok, false);
      assert.strictEqual(sibling.reason, 'socket_mismatch', 'socket check precedes the terminal check');
    });

    await check('S8. a reconnecting connection cannot resolve the pre-reconnect approval', async () => {
      const approval = raiseApprovalFor(tabA.socket.id, { ttlMs: 300 });
      const replacement = await connectAs(USER_A);
      clients.push(replacement);
      assert.notStrictEqual(replacement.socket.id, tabA.socket.id,
        'a reconnect is a new connection with a new id');
      const ack = await ask(replacement, { approvalId: approval.approvalId, decision: 'approve' });
      assert.strictEqual(ack.ok, false, 'the replacement connection is not the one that was asked');
      assert.strictEqual(ack.reason, 'socket_mismatch');
      // Documented semantics: the request fails closed at its own TTL.
      const settled = await Promise.race([
        approvalStore.waitForDecision(approval.approvalId),
        new Promise((res) => setTimeout(() => res(approvalStore.read(approval.approvalId)), 400)),
      ]);
      assert.strictEqual(settled.state, 'EXPIRED', 'a mid-prompt reconnect never resolves');
    });

    await check('S9. unauthenticated sockets never reach the approval handler', async () => {
      await assert.rejects(
        () =>
          new Promise((resolve, reject) => {
            const socket = ioClient(URL, { transports: ['websocket'], forceNew: true });
            const timer = setTimeout(() => reject(new Error('unauthenticated socket was not refused')), 5000);
            socket.on('connect', () => { clearTimeout(timer); resolve(); socket.close(); });
            socket.on('connect_error', (err) => { clearTimeout(timer); reject(err); });
          }),
        'no token -> refused before any handler runs',
      );
    });

    await check('S10. the approval record itself is never handed to the client', async () => {
      const approval = raiseApprovalFor(tabA.socket.id);
      const ack = await ask(tabB, { approvalId: approval.approvalId, decision: 'approve' });
      assert.ok(!JSON.stringify(ack).includes(tabA.socket.id), 'no socket id anywhere in the ack');
      assert.strictEqual(Object.prototype.hasOwnProperty.call(ack, 'record'), true,
        'the 4C/4D ack shape is unchanged (record still echoed for the owner)');
      assert.ok(!Object.keys(ack.record).some((k) => /socket/i.test(k)),
        'the echoed record carries no socket identity');
    });
  } finally {
    approvalStore._reset();
    for (const c of clients) {
      try { c.socket.close(); } catch { /* already closed */ }
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
  process.exit(process.exitCode || 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
