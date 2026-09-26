'use strict';

// Governed execution paths (DB-free, no provider keys, no network).
//
// Production failure found in the Phase 1 closure audit: the WhatsApp socket
// handler `whatsapp:send` called `clientManager.sendMessage` directly. That is
// an alternate execution path around the single governed TaskExecutor choke
// point, so a real external message could be sent with NO authorization, NO
// approval, NO idempotency, NO execution envelope and NO observability — and
// the bypass was reachable by ANY authenticated socket, including a guest.
//
// This suite locks the north-star invariant "no capability bypasses the
// governed boundary via an alternate path":
//
//   G-01 structural: provider socket handlers never call the WhatsApp
//        clientManager side-effect directly
//   G-02 structural: provider socket handlers reach TaskExecutor instead
//   G-03 behavioral: `whatsapp:send` delegates to executeTool with the
//        authoritative capability name and the caller's identity/socket
//   G-04 behavioral: a guest socket is DENIED by the real TaskExecutor and
//        the tool body never runs (no side effect, no credits)
//   G-05 behavioral: the guest denial is reported as a failure, not a
//        successful send
//
// Run:  cd server && node tests/governedExecutionPaths.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const passed = [];
const failed = [];
const test = async (name, fn) => {
  try {
    await fn();
    passed.push(name);
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed.push({ name, err });
    process.exitCode = 1;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${err && err.message}`);
  }
};

const PROVIDER = path.join(__dirname, '..', 'providers', 'whatsapp', 'index.js');

// ---- helpers ----------------------------------------------------------------

// Drive the real provider init() with a minimal fake Socket.IO server so the
// actual registered `whatsapp:send` handler is exercised verbatim.
const mountProvider = () => {
  const handlers = new Map();
  const emitted = [];
  let onConnection = null;

  const io = {
    on(event, fn) {
      if (event === 'connection') onConnection = fn;
    },
  };

  const socket = {
    userId: null,
    on(event, fn) {
      handlers.set(event, fn);
    },
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };

  require(PROVIDER).init(io);
  assert.strictEqual(typeof onConnection, 'function', 'provider did not register a connection handler');
  onConnection(socket);

  return { socket, handlers, emitted, send: handlers.get('whatsapp:send') };
};

const main = async () => {
  // ---- G-01 / G-02: structural -------------------------------------------

  await test('G-01 provider socket handlers never call the clientManager send side-effect directly', async () => {
    const src = fs.readFileSync(PROVIDER, 'utf8');
    const directSends = src.match(/clientManager\s*\.\s*sendMessage\s*\(/g) || [];
    assert.deepStrictEqual(
      directSends,
      [],
      `providers/whatsapp/index.js calls clientManager.sendMessage() directly ${directSends.length}x; ` +
        'every send must go through TaskExecutor.executeTool("sendWhatsAppMessage", ...)',
    );
  });

  await test('G-02 provider socket handlers reach the governed TaskExecutor', async () => {
    const src = fs.readFileSync(PROVIDER, 'utf8');
    assert.ok(
      /require\(['"]\.\.\/\.\.\/services\/TaskExecutor['"]\)/.test(src),
      'provider must resolve the shared TaskExecutor',
    );
    assert.ok(
      /executeTool\s*\(/.test(src),
      'provider must execute capabilities via executeTool',
    );
    // The executor must be resolved lazily: requiring it at module load would
    // put providers/whatsapp on the TaskExecutor -> tools/index ->
    // sendWhatsAppMessage require path during boot.
    const lazy = /const getTaskExecutor = \(\) => require\(/;
    assert.ok(lazy.test(src), 'TaskExecutor must be resolved lazily to keep the require graph acyclic');
  });

  // ---- G-03: delegation ---------------------------------------------------

  await test('G-03 whatsapp:send delegates to executeTool with the authoritative capability', async () => {
    const TaskExecutor = require('../services/TaskExecutor');
    const { socket, handlers, emitted } = mountProvider();
    socket.userId = 'user-1';

    const calls = [];
    const original = TaskExecutor.executeTool;
    TaskExecutor.executeTool = async (...args) => {
      calls.push(args);
      return { success: true, status: 'sent', contact: { name: 'Ada' } };
    };

    try {
      assert.strictEqual(typeof handlers.get('whatsapp:send'), 'function', 'whatsapp:send not registered');
      const ack = [];
      await handlers.get('whatsapp:send')({ recipientName: 'Ada', message: 'hi' }, (e, r) => ack.push([e, r]));

      assert.strictEqual(calls.length, 1, 'executeTool must be called exactly once');
      const [toolName, args, userId, socketArg] = calls[0];
      assert.strictEqual(toolName, 'sendWhatsAppMessage', 'must use the governed capability name');
      assert.deepStrictEqual(args, { recipientName: 'Ada', message: 'hi' });
      assert.strictEqual(userId, 'user-1', 'must pass the authenticated socket identity');
      assert.strictEqual(socketArg, socket, 'must pass the initiating socket for approval binding');
      assert.ok(
        emitted.some((e) => e.event === 'whatsapp:message_sent'),
        'must still emit the client-visible success event',
      );
    } finally {
      TaskExecutor.executeTool = original;
    }
  });

  // ---- G-04 / G-05: guest denial, real TaskExecutor ------------------------

  await test('G-04 a guest socket cannot send WhatsApp; the tool body never runs', async () => {
    const operatorPolicy = require('../lib/capabilities/operatorPolicy');
    const toolRegistry = require('../tools');
    const clientManager = require('../providers/whatsapp/clientManager');
    const previous = operatorPolicy.getOperatorPolicy();
    operatorPolicy.setOperatorPolicy(operatorPolicy.SEEDED_BASE);

    // Spy on BOTH side-effect layers. Stubbing the clientManager is what makes
    // this test meaningful: a reintroduced direct bypass calls it, and without
    // the stub that call would merely throw "client not initialized" and the
    // test would pass vacuously.
    const tool = toolRegistry.getTool('sendWhatsAppMessage');
    assert.ok(tool, 'sendWhatsAppMessage must be registered');
    let bodyRan = 0;
    const originalExecute = tool.execute;
    tool.execute = async () => {
      bodyRan += 1;
      return { success: true, status: 'sent' };
    };
    let transportSends = 0;
    const originalSend = clientManager.sendMessage;
    clientManager.sendMessage = async () => {
      transportSends += 1;
      return { success: true, status: 'sent', contact: { name: 'Ada' } };
    };

    const { socket, handlers, emitted } = mountProvider();
    socket.userId = 'guest_abc123';

    try {
      await handlers.get('whatsapp:send')({ recipientName: 'Ada', message: 'hi' }, () => {});

      assert.strictEqual(transportSends, 0, 'guest reached the WhatsApp transport directly');
      assert.strictEqual(bodyRan, 0, 'guest reached the WhatsApp send side effect');
      assert.ok(
        !emitted.some((e) => e.event === 'whatsapp:message_sent'),
        'guest must not receive a successful-send event',
      );
    } finally {
      tool.execute = originalExecute;
      clientManager.sendMessage = originalSend;
      operatorPolicy.setOperatorPolicy(previous);
    }
  });

  await test('G-05 guest denial is surfaced as a failure, never as a sent message', async () => {
    const operatorPolicy = require('../lib/capabilities/operatorPolicy');
    const toolRegistry = require('../tools');
    const clientManager = require('../providers/whatsapp/clientManager');
    const previous = operatorPolicy.getOperatorPolicy();
    operatorPolicy.setOperatorPolicy(operatorPolicy.SEEDED_BASE);

    const tool = toolRegistry.getTool('sendWhatsAppMessage');
    const originalExecute = tool.execute;
    tool.execute = async () => ({ success: true, status: 'sent' });
    // Stub the transport too, so a direct bypass would succeed and surface as
    // whatsapp:message_sent rather than throwing "client not initialized".
    const originalSend = clientManager.sendMessage;
    clientManager.sendMessage = async () => ({ success: true, status: 'sent', contact: { name: 'Ada' } });

    const { socket, handlers, emitted } = mountProvider();
    socket.userId = 'guest_abc123';

    try {
      await handlers.get('whatsapp:send')({ recipientName: 'Ada', message: 'hi' }, () => {});

      // The handler treats any non-success result as a failure path and never
      // emits whatsapp:message_sent.
      assert.ok(
        !emitted.some((e) => e.event === 'whatsapp:message_sent'),
        'guest produced a sent event',
      );
      assert.ok(
        emitted.some((e) => e.event === 'whatsapp:message_failed' || e.event === 'whatsapp:recipient_not_found'),
        `expected a failure event, got ${emitted.map((e) => e.event).join(', ')}`,
      );
    } finally {
      tool.execute = originalExecute;
      clientManager.sendMessage = originalSend;
      operatorPolicy.setOperatorPolicy(previous);
    }
  });

  // ---- report -------------------------------------------------------------

  console.log(`\n${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`  - ${f.name}: ${f.err && f.err.message}`);
    process.exitCode = 1;
  }
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
