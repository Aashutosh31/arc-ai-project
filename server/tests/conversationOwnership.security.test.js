/* Conversation ownership / Socket.IO authorization — P0 security tests.
 *
 * Run with: node tests/conversationOwnership.security.test.js
 *
 * Proves the ownership boundary on the live Socket.IO AI path:
 *
 *   THE RULE: a conversation is reachable iff
 *     conversation._id == requested conversationId
 *     AND conversation.userId == the AUTHENTICATED actor id
 *   (workspace is attribution, never the security boundary — identical to the
 *   REST reference in conversationController)
 *
 * The fake model store below ENFORCES Mongo equality semantics, including the
 * owner predicate: a query that omits `userId` therefore cannot see a foreign
 * document. That is the whole point — a test fails if any live-path query drops
 * the owner filter, exactly as it would leak in production.
 *
 * No Mongo, no network, no Atlas. Only the models are faked; the resolver
 * (lib/conversationAccess.js), AIService, WorkspaceContextManager and the REST
 * controller are the REAL implementations.
 */

const assert = require('assert');

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

console.log('Conversation Ownership Security Tests');
console.log('======================================');

const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const AIMemory = require('../models/AIMemory');
const UserFact = require('../models/UserFact');
const User = require('../models/User');
const access = require('../lib/conversationAccess');
const WorkspaceContextManager = require('../services/WorkspaceContextManager');
const conversationController = require('../controllers/conversationController');
const AIService = require('../services/AIService');
const ttsService = require('../services/ttsService');
const TaskExecutor = require('../services/TaskExecutor');
const { McpToolSource } = require('../lib/mcp');

// ---------------------------------------------------------------- fixtures --

const USER_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const USER_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const CONVO_A = '111111111111111111111111'; // owned by USER_A
const CONVO_B = '222222222222222222222222'; // owned by USER_B
const CONVO_MISSING = '333333333333333333333333';
const WORKSPACE_A = '444444444444444444444444';
const WORKSPACE_FOREIGN = '555555555555555555555555';

const store = {
  conversations: new Map(),
  messages: [],
};

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
        pendingToolCall: { toolName: 'sendEmail', args: { to: 'a@example.com' }, missing: [] },
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
        messageCount: 1,
      },
    ],
  ]);
  store.messages = [
    { _id: 'm1', conversationId: CONVO_A, workspaceId: WORKSPACE_A, role: 'user', content: 'A secret question', createdAt: new Date(1) },
    { _id: 'm2', conversationId: CONVO_A, workspaceId: WORKSPACE_A, role: 'ai', content: 'A secret answer', createdAt: new Date(2) },
    { _id: 'm3', conversationId: CONVO_B, workspaceId: null, role: 'user', content: 'B own question', createdAt: new Date(3) },
  ];
};

// Mongo equality on the subset of fields these paths filter on. A missing
// `userId` in the filter matches every document — exactly like production,
// which is why every live-path query must carry the owner predicate.
const matches = (doc, filter = {}) =>
  Object.entries(filter).every(([key, value]) => {
    if (value === null || value === undefined) return doc[key] === value;
    return String(doc[key]) === String(value);
  });

const oneQuery = (doc) => {
  const q = {
    select: () => q,
    lean: () => q,
    then: (resolve, reject) => Promise.resolve(q._doc).then(resolve, reject),
  };
  q._doc = doc || null;
  return q;
};

// Mongoose hands back a document whose mutation only lands on save(). The
// harness mirrors that so a controller mutating a fetched doc cannot silently
// rewrite the store.
const hydrate = (doc) => {
  if (!doc) return null;
  const view = { ...doc };
  view.save = async () => {
    const { save, ...plain } = view;
    store.conversations.set(String(doc._id), plain);
    return view;
  };
  return view;
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
    then: (resolve, reject) => Promise.resolve(q._docs).then(resolve, reject),
  };
  return q;
};

const applyUpdate = (doc, update = {}) => {
  for (const [key, value] of Object.entries(update)) {
    if (key === '$inc') {
      for (const [incKey, incValue] of Object.entries(value)) {
        doc[incKey] = Number(doc[incKey] || 0) + Number(incValue);
      }
    } else if (key === '$set') {
      Object.assign(doc, value);
    } else {
      doc[key] = value;
    }
  }
  return doc;
};

// ------------------------------------------------------------------ stubs --

const stubs = [];
const patch = (target, key, fn) => {
  stubs.push({ target, key, prev: target[key] });
  target[key] = fn;
};
const restoreStubs = () => {
  for (const { target, key, prev } of stubs.reverse()) {
    if (prev === undefined) delete target[key];
    else target[key] = prev;
  }
  stubs.length = 0;
};

let nextDocId = 0;
const newHexId = () => {
  nextDocId += 1;
  return String(nextDocId).padStart(24, '0');
};

const installModelStubs = () => {
  patch(Conversation, 'findOne', (filter) =>
    oneQuery(hydrate([...store.conversations.values()].find((d) => matches(d, filter)) || null)),
  );
  patch(Conversation, 'find', (filter) =>
    manyQuery([...store.conversations.values()].filter((d) => matches(d, filter))),
  );
  patch(Conversation, 'findById', (id) =>
    oneQuery(hydrate([...store.conversations.values()].find((d) => String(d._id) === String(id)) || null)),
  );
  patch(Conversation, 'findOneAndUpdate', async (filter, update) => {
    const doc = [...store.conversations.values()].find((d) => matches(d, filter));
    if (!doc) return null;
    return applyUpdate(doc, update);
  });
  patch(Conversation.prototype, 'save', async function save() {
    if (!this._id || !store.conversations.has(String(this._id))) {
      this._id = newHexId();
    }
    const plain = { ...this.toObject ? this.toObject() : this, _id: String(this._id) };
    store.conversations.set(String(this._id), plain);
    return plain;
  });

  patch(Message, 'find', (filter) =>
    manyQuery(store.messages.filter((d) => matches(d, filter))),
  );
  patch(Message, 'findOne', (filter) =>
    oneQuery(store.messages.find((d) => matches(d, filter)) || null),
  );
  patch(Message, 'create', async (doc) => {
    const created = { _id: newHexId(), ...doc, conversationId: String(doc.conversationId) };
    store.messages.push(created);
    return created;
  });
  patch(Message, 'findById', async (id) => store.messages.find((m) => String(m._id) === String(id)) || null);
  patch(Message, 'findByIdAndUpdate', async (id, update) => {
    const doc = store.messages.find((m) => String(m._id) === String(id));
    return doc ? applyUpdate(doc, update) : null;
  });
  patch(Message, 'countDocuments', async (filter) =>
    store.messages.filter((d) => matches(d, filter)).length,
  );

  patch(AIMemory, 'find', () => manyQuery([]));
  patch(AIMemory.prototype, 'save', async function save() { return this; });
  patch(UserFact, 'find', () => manyQuery([]));
  patch(UserFact, 'findOne', () => oneQuery(null));
};

const installRuntimeStubs = () => {
  patch(User, 'findById', async () => ({
    _id: USER_B,
    creditsRemaining: 1000,
    save: async () => {},
  }));
  patch(AIService.workspaceRuntime, 'resolveWorkspace', async () => null);
  patch(ttsService, 'isServerTtsActive', () => false);
  patch(ttsService, 'getDefaultTtsLanguage', () => 'en-US');
  patch(AIService.llmRouter, 'generate', async () => ({
    text: 'ok',
    model: 'test-model',
    provider: 'test',
    tokens: { input: 2, output: 3 },
    fallbackUsed: false,
    route: null,
  }));
  const streamStub = { consume: async () => 'ok', emitText: async () => 'ok' };
  patch(AIService.llmRouter, 'streamingRuntime', streamStub);
  patch(AIService, 'streamingRuntime', streamStub);
  patch(McpToolSource, 'schemasForRequest', async () => ({
    schemas: [],
    metadata: null,
    failures: [],
    blocked: [],
  }));
};

const makeSocket = (userId, type = 'user') => ({
  id: `sock-${userId}`,
  userId,
  actor: { type, id: userId },
  isInterrupted: false,
  emitted: [],
  emit(event, payload) {
    this.emitted.push({ event, payload });
    return true;
  },
  on: () => {},
  off: () => {},
});

const fakeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
};

const restGet = async (actorId, conversationId, workspaceId) => {
  const res = fakeRes();
  await conversationController.getConversation(
    {
      actor: { type: 'user', id: actorId },
      params: { conversationId },
      query: workspaceId ? { workspaceId } : {},
      body: {},
    },
    res,
  );
  return res;
};

// ------------------------------------------------------------------- tests --

(async () => {
  installModelStubs();
  installRuntimeStubs();

  try {
    // 1 -------------------------------------------------------------- own access
    await check('1. user A resolves and reads their OWN conversation', async () => {
      resetStore();
      const sockA = makeSocket(USER_A);
      const res = await access.resolveSocketConversation({
        socket: sockA,
        conversationId: CONVO_A,
        workspaceId: WORKSPACE_A,
      });
      assert.strictEqual(res.ok, true, 'owner must be allowed');
      assert.strictEqual(res.conversationId, CONVO_A, 'verified id returned');

      const turns = await AIService.loadRecentTurns(CONVO_A, USER_A, 10);
      assert.ok(turns.length >= 1, 'owner sees their own history');
      const state = await AIService.loadWorkingState(CONVO_A, USER_A);
      assert.ok(state?.workingState, 'owner loads their own working state');
    });

    // 2 ------------------------------------------------------------- cross-actor read
    await check('2. user B cannot READ user A conversation (history, working state, pending, RAG context)', async () => {
      resetStore();
      assert.deepStrictEqual(await AIService.loadRecentTurns(CONVO_A, USER_B, 10), [], 'no history leak');
      assert.strictEqual(await AIService.loadWorkingState(CONVO_A, USER_B), null, 'no working-state leak');
      assert.strictEqual(await AIService.loadPendingToolCall(CONVO_A, USER_B), null, 'no pending-tool leak');
      assert.deepStrictEqual(
        await WorkspaceContextManager.getShortTermContext(USER_B, CONVO_A, WORKSPACE_A),
        [],
        'no short-term/RAG snippet leak',
      );
      assert.strictEqual(
        await WorkspaceContextManager.inferActiveProject(USER_B, CONVO_A, WORKSPACE_A),
        null,
        "no project-title leak from A's conversation",
      );
    });

    // 3 ------------------------------------------------------------- cross-actor write
    await check('3. user B cannot WRITE user A conversation (working state, pending tool)', async () => {
      resetStore();
      await AIService.saveWorkingState(CONVO_A, USER_B, { activeSearch: { query: 'HIJACKED' } }, 'hijacked summary');
      await AIService.savePendingToolCall(CONVO_A, USER_B, { toolName: 'sendEmail', args: { to: 'evil@x.com' } });
      await AIService.clearPendingToolCall(CONVO_A, USER_B);

      const convo = store.conversations.get(CONVO_A);
      assert.deepStrictEqual(
        convo.workingState,
        { activeSearch: { query: 'A confidential topic' } },
        "A's working state must be untouched",
      );
      assert.strictEqual(convo.conversationSummary, 'A private summary', "A's summary must be untouched");
      assert.strictEqual(convo.pendingToolCall.toolName, 'sendEmail', "A's pending tool must survive");
      assert.strictEqual(convo.pendingToolCall.args.to, 'a@example.com', "A's pending args must be untouched");
    });

    // 4 ------------------------------------------------------------- forged id
    await check('4. forged cross-actor conversationId is rejected at the socket boundary', async () => {
      resetStore();
      const res = await access.resolveSocketConversation({
        socket: makeSocket(USER_B),
        conversationId: CONVO_A,
        workspaceId: WORKSPACE_A,
      });
      assert.strictEqual(res.ok, false, 'forged id must be denied');
      assert.strictEqual(res.conversationId, null, 'no conversation id is handed downstream');
      assert.strictEqual(res.code, access.CONVERSATION_NOT_FOUND_CODE, 'uniform not-found code');
    });

    // 5 ------------------------------------------------------- malformed + forged workspace
    await check('5. malformed and forged-workspace ids are denied identically (no existence leak)', async () => {
      resetStore();
      const sockB = makeSocket(USER_B);
      const forged = await access.resolveSocketConversation({ socket: sockB, conversationId: CONVO_A });
      const malformed = await access.resolveSocketConversation({ socket: sockB, conversationId: 'not-an-object-id' });
      const missing = await access.resolveSocketConversation({ socket: sockB, conversationId: CONVO_MISSING });
      const forgedWorkspace = await access.resolveSocketConversation({
        socket: sockB,
        conversationId: CONVO_A,
        workspaceId: WORKSPACE_FOREIGN,
      });

      for (const [label, res] of [
        ['cross-actor', forged],
        ['malformed', malformed],
        ['nonexistent', missing],
        ['forged-workspace', forgedWorkspace],
      ]) {
        assert.strictEqual(res.ok, false, `${label} must be denied`);
        assert.strictEqual(res.error, access.CONVERSATION_NOT_FOUND_MESSAGE, `${label} must use the same message`);
        assert.strictEqual(res.code, access.CONVERSATION_NOT_FOUND_CODE, `${label} must use the same code`);
        assert.ok(
          !JSON.stringify(res).includes(USER_A) && !JSON.stringify(res).includes(CONVO_A),
          `${label} denial must not echo the owner or requested id`,
        );
      }

      // The owner is unaffected by a foreign workspace: workspace is
      // attribution, not the boundary (identical to the REST fallback).
      const ownerRes = await access.resolveSocketConversation({
        socket: makeSocket(USER_A),
        conversationId: CONVO_A,
        workspaceId: WORKSPACE_FOREIGN,
      });
      assert.strictEqual(ownerRes.ok, true, 'owner keeps access; workspace never widens or narrows ownership');
    });

    // 6 --------------------------------------------------------------- missing
    await check('6. nonexistent conversation behaves safely (denied, no data, no write)', async () => {
      resetStore();
      const res = await access.resolveSocketConversation({
        socket: makeSocket(USER_A),
        conversationId: CONVO_MISSING,
      });
      assert.strictEqual(res.ok, false, 'nonexistent is denied like any other miss');
      assert.deepStrictEqual(await AIService.loadRecentTurns(CONVO_MISSING, USER_A, 10), []);
      assert.strictEqual(await AIService.loadWorkingState(CONVO_MISSING, USER_A), null);
      await AIService.saveWorkingState(CONVO_MISSING, USER_A, { activeSearch: { query: 'ghost' } });
      assert.strictEqual(store.conversations.has(CONVO_MISSING), false, 'no phantom document written');
    });

    // 7 ------------------------------------------------------------- continuation
    await check('7. continuation path cannot bypass ownership (pending tool + working state)', async () => {
      resetStore();
      const pending = await AIService.loadPendingToolCall(CONVO_A, USER_B);
      assert.strictEqual(pending, null, 'foreign pending tool never loads');
      await AIService.savePendingToolCall(CONVO_A, USER_B, { toolName: 'executeCode', args: {} });
      assert.strictEqual(
        store.conversations.get(CONVO_A).pendingToolCall.toolName,
        'sendEmail',
        'foreign continuation cannot overwrite pending state',
      );
      await AIService.clearPendingToolCall(CONVO_A, USER_B);
      assert.ok(
        store.conversations.get(CONVO_A).pendingToolCall,
        'foreign continuation cannot clear the owner pending state',
      );
    });

    // 8 ----------------------------------------------------------------- history
    await check('8. history/context loading cannot bypass ownership (budget pipeline input)', async () => {
      resetStore();
      const { assembleBudgetedRequest, compactRecentTurns } = require('../lib/llm/contextBudget');
      const turns = await AIService.loadRecentTurns(CONVO_A, USER_B, 10);
      const compacted = compactRecentTurns(turns);
      const rendered = JSON.stringify(compacted);
      assert.ok(!rendered.includes('A secret'), "A's message content must not reach the provider payload");
      const assembled = assembleBudgetedRequest({
        systemTemplate: 'SYS',
        baseUserText: 'hello',
        docText: '',
        memoryDocs: [],
        factDocs: [],
        ragItems: [],
        selectedTools: [],
        outputBudget: 512,
        query: 'hello',
        recentTurns: turns,
      });
      assert.ok(
        !JSON.stringify(assembled).includes('A secret'),
        'assembled provider request must not contain foreign turns',
      );
    });

    // 9 ------------------------------------------------------------- persistence
    await check('9. persistence cannot bypass ownership (real processQuery with a forged id)', async () => {
      resetStore();
      const execCalls = [];
      patch(TaskExecutor, 'executeTool', async (...args) => {
        execCalls.push(args);
        return { status: 'SUCCESS', result: { success: true, output: 'x' } };
      });

      const result = await AIService.processQuery(
        USER_B,
        'hello',
        makeSocket(USER_B),
        null,
        null,
        CONVO_A, // forged: belongs to USER_A
        null,
        null,
      );
      await new Promise((resolve) => setImmediate(resolve));

      assert.strictEqual(typeof result, 'string', 'turn still completes safely');

      const foreignMessages = store.messages.filter(
        (m) => String(m.conversationId) === CONVO_A && m.content === 'hello',
      );
      assert.strictEqual(foreignMessages.length, 0, "no message may be written into A's conversation");
      assert.strictEqual(
        store.conversations.get(CONVO_A).messageCount,
        2,
        "A's conversation metadata must be untouched",
      );

      const created = [...store.conversations.values()].filter(
        (c) => c.userId === USER_B && String(c._id) !== CONVO_A && String(c._id) !== CONVO_B,
      );
      assert.strictEqual(created.length, 1, 'the turn gets its own conversation owned by the caller');
      assert.notStrictEqual(String(created[0]._id), CONVO_A, 'the forged id is never reused');

      for (const call of execCalls) {
        const conversationId = call[5]?.conversationId;
        if (conversationId) {
          const doc = store.conversations.get(String(conversationId));
          assert.ok(doc && doc.userId === USER_B, 'planner/tool execution only ever carries an owned conversation');
        }
      }
      restoreStubs();
      installModelStubs();
      installRuntimeStubs();
    });

    // 10 ------------------------------------------------- planner / conv context
    await check('10. planner/conversation context cannot bypass ownership', async () => {
      resetStore();
      const ctx = await WorkspaceContextManager.getActiveContext({
        userId: USER_B,
        conversationId: CONVO_A,
        query: 'what did we decide',
        limit: 10,
        workspaceId: WORKSPACE_A,
      });
      assert.deepStrictEqual(ctx.shortTerm, [], 'no foreign short-term context');
      assert.ok(
        !JSON.stringify(ctx).includes('A secret'),
        "A's conversation content must not enter active context",
      );
      const ownCtx = await WorkspaceContextManager.getActiveContext({
        userId: USER_A,
        conversationId: CONVO_A,
        query: 'what did we decide',
        limit: 10,
        workspaceId: WORKSPACE_A,
      });
      assert.ok(ownCtx.shortTerm.length > 0, 'the owner still gets their own context');
    });

    // 11 ----------------------------------------------------- socket vs REST
    await check('11. Socket.IO and REST enforce equivalent ownership semantics', async () => {
      resetStore();

      const restOwn = await restGet(USER_A, CONVO_A, WORKSPACE_A);
      const sockOwn = await access.resolveSocketConversation({
        socket: makeSocket(USER_A),
        conversationId: CONVO_A,
        workspaceId: WORKSPACE_A,
      });
      assert.strictEqual(restOwn.statusCode, 200, 'REST allows the owner');
      assert.strictEqual(sockOwn.ok, true, 'socket allows the owner');

      for (const [actorId, conversationId, label] of [
        [USER_B, CONVO_A, 'cross-actor'],
        [USER_A, CONVO_MISSING, 'nonexistent'],
        [USER_A, 'not-an-object-id', 'malformed'],
      ]) {
        const rest = await restGet(actorId, conversationId);
        const sock = await access.resolveSocketConversation({
          socket: makeSocket(actorId),
          conversationId,
        });
        assert.strictEqual(rest.statusCode, 404, `REST 404s a ${label} conversation`);
        assert.strictEqual(rest.body.code, access.CONVERSATION_NOT_FOUND_CODE, `REST code for ${label}`);
        assert.strictEqual(sock.ok, false, `socket denies a ${label} conversation`);
        assert.strictEqual(
          sock.code,
          rest.body.code,
          `identical code for ${label} across transports`,
        );
        assert.strictEqual(
          sock.error,
          rest.body.error,
          `identical message for ${label} across transports`,
        );
      }

      // Cursor/malformed id handling in REST is unchanged.
      const invalidWorkspaceRes = fakeRes();
      await conversationController.getConversation(
        {
          actor: { type: 'user', id: USER_A },
          params: { conversationId: CONVO_A },
          query: { workspaceId: 'nope' },
          body: {},
        },
        invalidWorkspaceRes,
      );
      const restInvalidWorkspace = invalidWorkspaceRes;
      assert.strictEqual(restInvalidWorkspace.statusCode, 400, 'REST still rejects malformed workspace ids');
    });

    // Guest behavior must be preserved: guests own no conversation documents,
    // so an id they send is dropped rather than resolved (and never read).
    await check('12. guest conversationId is ignored, never resolved', async () => {
      resetStore();
      const res = await access.resolveSocketConversation({
        socket: makeSocket('guest_abc123', 'guest'),
        conversationId: CONVO_A,
      });
      assert.strictEqual(res.ok, true, 'guest turn is not rejected outright');
      assert.strictEqual(res.conversationId, null, 'guest conversation id is dropped');
    });

    await check('13. resolver rejects ids that are not valid ObjectIds', async () => {
      assert.strictEqual(access.isValidConversationId(CONVO_A), true);
      assert.strictEqual(access.isValidConversationId('not-an-object-id'), false);
      assert.strictEqual(access.isValidConversationId(''), false);
      assert.strictEqual(access.isValidConversationId(null), false);
      assert.strictEqual(mongoose.Types.ObjectId.isValid(CONVO_A), true, 'fixture ids are real ObjectIds');
    });
  } finally {
    restoreStubs();
  }

  console.log('\nResult: ' + pass + ' pass, ' + fail + ' fail');
  process.exitCode = fail > 0 ? 1 : 0;
})();
