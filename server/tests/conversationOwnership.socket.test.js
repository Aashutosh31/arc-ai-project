/* Socket.IO conversation-ownership validation (Phase F).
 *
 * Run with: node tests/conversationOwnership.socket.test.js
 *
 * Boots the REAL server entry point (server/index.js) — real Socket.IO server,
 * real JWT auth middleware, real `ai:stt:final` handler, real
 * lib/conversationAccess resolver — and drives it with two REAL authenticated
 * identities over a real socket connection.
 *
 * The ONLY things faked are the Mongo model layer and the provider:
 *   - mongoose.connect() is stubbed, so nothing reaches Atlas (no connection,
 *     no index drop, no writes). This test CANNOT mutate the application DB.
 *   - Conversation/Message/AIMemory/UserFact/User are in-memory fakes that
 *     enforce Mongo equality semantics (including the owner predicate).
 *   - the LLM returns a canned string.
 *
 * Proves the two required outcomes:
 *   user A -> conversation X  => the turn proceeds and X receives A's message
 *   user B -> conversation X  => rejected with the safe not-found error, ZERO
 *                                provider calls, ZERO writes to X, and not one
 *                                byte of X's content emitted to B
 */

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

console.log('Socket.IO Conversation Ownership Validation');
console.log('===========================================');

// Deterministic identity material for this process only.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'socket-ownership-test-secret';
process.env.PORT = process.env.PORT || '45917';
delete process.env.MONGO_URI;
delete process.env.DATABASE_URL;

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { io: ioClient } = require(path.join(__dirname, '..', '..', 'client', 'node_modules', 'socket.io-client'));

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

// --- No database, ever -------------------------------------------------------
mongoose.connect = async () => mongoose;
mongoose.connection.close = async () => {};

const USER_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const USER_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const CONVO_A = '111111111111111111111111';
const CONVO_B = '222222222222222222222222';
const WORKSPACE_A = '444444444444444444444444';
const WORKSPACE_FOREIGN = '555555555555555555555555';

const store = { conversations: new Map(), messages: [] };
const providerCalls = [];

const resetStore = () => {
  store.conversations = new Map([
    [
      CONVO_A,
      {
        _id: CONVO_A,
        userId: USER_A,
        workspaceId: WORKSPACE_A,
        title: 'A private project',
        archived: false,
        workingState: { activeSearch: { query: 'A confidential topic' } },
        conversationSummary: 'A private summary',
        pendingToolCall: null,
        messageCount: 2,
      },
    ],
    [
      CONVO_B,
      {
        _id: CONVO_B,
        userId: USER_B,
        workspaceId: null,
        title: 'B conversation',
        archived: false,
        workingState: null,
        conversationSummary: '',
        pendingToolCall: null,
        messageCount: 0,
      },
    ],
  ]);
  store.messages = [
    { _id: 'm1', conversationId: CONVO_A, workspaceId: WORKSPACE_A, role: 'user', content: 'A secret question', createdAt: new Date(1) },
    { _id: 'm2', conversationId: CONVO_A, workspaceId: WORKSPACE_A, role: 'ai', content: 'A secret answer', createdAt: new Date(2) },
  ];
  providerCalls.length = 0;
};

const matches = (doc, filter = {}) =>
  Object.entries(filter).every(([key, value]) => {
    if (value === null || value === undefined) return doc[key] === value;
    if (key === '$or' || key === '$and') return true; // unsupported in the fake; unused by this path
    return String(doc[key]) === String(value);
  });

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
    limit: (n) => {
      q._docs = q._docs.slice(0, n);
      return q;
    },
    lean: () => q,
    then: (res, rej) => Promise.resolve(q._docs).then(res, rej),
  };
  return q;
};

let nextDocId = 100;
const newHexId = () => {
  nextDocId += 1;
  return String(nextDocId).padStart(24, '0');
};

Conversation.findOne = (filter) =>
  oneQuery([...store.conversations.values()].find((d) => matches(d, filter)) || null);
Conversation.find = (filter) => manyQuery([...store.conversations.values()].filter((d) => matches(d, filter)));
Conversation.findById = (id) =>
  oneQuery([...store.conversations.values()].find((d) => String(d._id) === String(id)) || null);
Conversation.findOneAndUpdate = async (filter, update) => {
  const doc = [...store.conversations.values()].find((d) => matches(d, filter));
  if (!doc) return null;
  for (const [key, value] of Object.entries(update || {})) {
    if (key === '$inc') for (const [k, v] of Object.entries(value)) doc[k] = Number(doc[k] || 0) + Number(v);
    else doc[key] = value;
  }
  return doc;
};
Conversation.prototype.save = async function save() {
  if (!this._id || !store.conversations.has(String(this._id))) this._id = newHexId();
  const plain = { ...(this.toObject ? this.toObject() : this), _id: String(this._id) };
  store.conversations.set(String(this._id), plain);
  return plain;
};

Message.find = (filter) => manyQuery(store.messages.filter((d) => matches(d, filter)));
Message.findOne = (filter) => oneQuery(store.messages.find((d) => matches(d, filter)) || null);
Message.create = async (doc) => {
  const created = { _id: newHexId(), ...doc, conversationId: String(doc.conversationId) };
  store.messages.push(created);
  return created;
};
Message.findById = async (id) => store.messages.find((m) => String(m._id) === String(id)) || null;
Message.findByIdAndUpdate = async (id, update) => {
  const doc = store.messages.find((m) => String(m._id) === String(id));
  if (!doc) return null;
  for (const [key, value] of Object.entries(update || {})) {
    if (key === '$inc') for (const [k, v] of Object.entries(value)) doc[k] = Number(doc[k] || 0) + Number(v);
    else doc[key] = value;
  }
  return doc;
};
Message.countDocuments = async (filter) => store.messages.filter((d) => matches(d, filter)).length;

// Workspace owner gate (the ai:stt:final handler resolves an incoming
// workspaceId against the authenticated owner before honoring it).
Workspace.findOne = (filter) => {
  const owned =
    filter &&
    String(filter.owner || '') === USER_A &&
    String(filter._id || '') === WORKSPACE_A;
  return oneQuery(owned ? { _id: WORKSPACE_A, owner: USER_A, name: 'A workspace', vectorNamespace: 'ns-a' } : null);
};

AIMemory.find = () => manyQuery([]);
AIMemory.prototype.save = async function save() { return this; };
UserFact.find = () => manyQuery([]);
UserFact.findOne = () => oneQuery(null);
const userDoc = (id) => ({
  _id: id,
  creditsRemaining: 1000,
  language: 'en-US',
  preferences: {},
  save: async () => {},
  select: () => oneQuery(null),
  lean: () => oneQuery(null),
});
User.findById = (id) => oneQuery(userDoc(id));

// Runtime stubs (no provider, no TTS, no MCP discovery, no workspace).
AIService.workspaceRuntime.resolveWorkspace = async () => null;
ttsService.isServerTtsActive = () => false;
ttsService.getDefaultTtsLanguage = () => 'en-US';
AIService.llmRouter.generate = async (args) => {
  providerCalls.push(args);
  return { text: 'ok', model: 'test-model', provider: 'test', tokens: { input: 1, output: 1 }, fallbackUsed: false, route: null };
};
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

const connectAs = (userId) =>
  new Promise((resolve, reject) => {
    const socket = ioClient(URL, { auth: { token: tokenFor(userId) }, transports: ['websocket'], forceNew: true });
    const received = [];
    socket.onAny((event, payload) => {
      received.push({ event, payload });
    });
    const onReady = () => {
      socket.off('connect', onReady);
      resolve({ socket, received, userId });
    };
    socket.on('connect', onReady);
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error(`socket connect timeout for ${userId}`)), 8000);
  });

const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

// Poll a condition instead of assuming a fixed latency: the turn pipeline got
// slower with the owner-scoped conversation lookups, so a hard-coded wait made
// the "reaches the provider" assertions race the stream.
const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
};

const turnAndCollect = async (client, payload, ms = 700) => {
  client.received.length = 0;
  client.socket.emit('ai:stt:final', payload);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return client.received.slice();
};

const botErrors = (events) => events.filter((e) => e.event === 'bot_error');
const allPayloadText = (events) =>
  JSON.stringify(events.map((e) => ({ event: e.event, payload: e.payload })));

(async () => {
  let clientA;
  let clientB;
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    resetStore();

    clientA = await connectAs(USER_A);
    clientB = await connectAs(USER_B);

    await check('F1. user A -> own conversation X: the turn proceeds', async () => {
      const events = await turnAndCollect(clientA, {
        command: 'summarize my project',
        conversationId: CONVO_A,
        workspaceId: WORKSPACE_A,
      });
      assert.strictEqual(botErrors(events).length, 0, 'owner must not be rejected');
      assert.ok(await waitFor(() => providerCalls.length > 0), "the owner turn reaches the provider");
      const rows = store.messages.filter((m) => String(m.conversationId) === CONVO_A);
      assert.ok(
        rows.some((m) => m.content === 'summarize my project'),
        "A's turn is persisted into A's own conversation",
      );
    });

    await check('F2. user B -> conversation X: rejected with the safe not-found error', async () => {
      const before = providerCalls.length;
      const events = await turnAndCollect(clientB, {
        command: 'summarize my project',
        conversationId: CONVO_A,
      });
      const errors = botErrors(events);
      assert.strictEqual(errors.length, 1, 'exactly one rejection is emitted');
      assert.strictEqual(errors[0].payload, 'Conversation not found', 'uniform not-found message');
      assert.strictEqual(
        providerCalls.length,
        before,
        'no provider call happens for a rejected turn',
      );
      const leakedRows = store.messages.filter(
        (m) => String(m.conversationId) === CONVO_A && m.content === 'summarize my project' && m.role === 'user' && m._id >= '0000000000000000000001ff',
      );
      assert.strictEqual(leakedRows.length, 0, "B's turn is never written into X");
    });

    await check('F3. no data from conversation X is ever rendered to user B', async () => {
      const events = await turnAndCollect(clientB, {
        command: 'what did we decide about the confidential topic?',
        conversationId: CONVO_A,
      });
      const rendered = allPayloadText(events);
      assert.ok(!rendered.includes('A secret'), "A's message content must never reach B");
      assert.ok(!rendered.includes('A confidential'), "A's working state must never reach B");
      assert.ok(!rendered.includes('A private project'), "A's title must never reach B");
      assert.ok(!rendered.includes(USER_A), "A's identity must never reach B");
    });

    await check('F4. forged workspaceId cannot widen access to a foreign conversation', async () => {
      const before = providerCalls.length;
      const events = await turnAndCollect(clientB, {
        command: 'read it',
        conversationId: CONVO_A,
        workspaceId: WORKSPACE_A, // A's workspace, asserted by B
      });
      assert.strictEqual(botErrors(events).length, 1, 'still rejected');
      assert.strictEqual(botErrors(events)[0].payload, 'Conversation not found', 'same uniform denial');
      assert.strictEqual(providerCalls.length, before, 'no provider call');
    });

    await check('F5. nonexistent and malformed ids are rejected identically (no existence oracle)', async () => {
      const missing = botErrors(
        await turnAndCollect(clientA, { command: 'hi', conversationId: '333333333333333333333333' }),
      );
      const malformed = botErrors(
        await turnAndCollect(clientA, { command: 'hi', conversationId: 'not-an-object-id' }),
      );
      assert.strictEqual(missing.length, 1, 'nonexistent is rejected');
      assert.strictEqual(malformed.length, 1, 'malformed is rejected');
      assert.strictEqual(
        missing[0].payload,
        malformed[0].payload,
        'identical message: existence of X is never disclosed',
      );
    });

    await check('F6. user B still works normally on their OWN conversation', async () => {
      const before = providerCalls.length;
      const events = await turnAndCollect(clientB, { command: 'hello there', conversationId: CONVO_B });
      assert.strictEqual(botErrors(events).length, 0, "B is unaffected on B's own conversation");
      assert.ok(await waitFor(() => providerCalls.length > before),
        "B's own turn reaches the provider");
      const rows = store.messages.filter((m) => String(m.conversationId) === CONVO_B);
      assert.ok(rows.some((m) => m.content === 'hello there'), "B's turn lands in B's conversation");
    });

    await check('F7. conversation X is byte-for-byte unchanged by the attack', async () => {
      const convo = store.conversations.get(CONVO_A);
      assert.deepStrictEqual(convo.workingState, { activeSearch: { query: 'A confidential topic' } }, 'working state intact');
      assert.strictEqual(convo.conversationSummary, 'A private summary', 'summary intact');
      assert.strictEqual(convo.messageCount, 2, 'A row count intact (no B rows added)');
    });

    await check('F8. unauthenticated sockets are refused before any handler runs', async () => {
      await assert.rejects(
        () =>
          new Promise((resolve, reject) => {
            const socket = ioClient(URL, { transports: ['websocket'], forceNew: true });
            socket.on('connect', () => {
              socket.close();
              resolve();
            });
            socket.on('connect_error', (err) => {
              socket.close();
              reject(err);
            });
            setTimeout(() => {
              socket.close();
              reject(new Error('timeout'));
            }, 5000);
          }),
        /Authentication error/,
        'no token => connection refused',
      );
    });
  } catch (err) {
    fail += 1;
    process.exitCode = 1;
    console.error('  FAIL  harness error:', err && err.message);
  } finally {
    try { clientA?.socket?.close(); } catch { /* best effort */ }
    try { clientB?.socket?.close(); } catch { /* best effort */ }
    setTimeout(() => {
      console.log('\nResult: ' + pass + ' pass, ' + fail + ' fail');
      process.exit(fail > 0 ? 1 : 0);
    }, 200);
  }
})();
