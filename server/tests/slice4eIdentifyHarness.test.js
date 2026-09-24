'use strict';

// JARVIS Action Substrate — slice 4E: WORKSPACE IDENTITY + SEEDED GUEST
// HARD-DENY + APPROVAL TOCTOU REVALIDATION.
//
// Proves:
//   1.  WorkspaceRuntimeManager.getWorkspaceById is owner-scoped when a
//       requester is supplied (forged/cross-user workspaceId -> null).
//   2.  resolveWorkspace never resolves a workspace the user does not own
//       (falls through to default/null instead of returning the forged doc).
//   3.  index.js ai:stt:final now gates an incoming workspaceId on ownership.
//   4.  TaskPlanner.executePlan refuses to run an execution owned by a
//       different user even when a matching workspaceId is supplied.
//   5.  Seeded base policy hard-denies guests the external/consequential
//       natives by default (no operator configuration required).
//   6.  Seeding never mutates the frozen DEFAULT_POLICY of the pure engine.
//   7.  Guest hard-deny is enforced through the real TaskExecutor boundary.
//   8.  Approval TOCTOU: authority revoked between approval-creation and
//       approval-resolution aborts the execution before credits/side effects.
//
// Run: cd server && node tests/slice4eIdentifyHarness.test.js

const assert = require('assert');
const path = require('path');

// ---- stub the credit service before TaskExecutor loads ----------------------
const creditMock = {
  log: [],
  consumeCredits: async (actorId, amount = 1, reason = 'usage') => {
    creditMock.log.push({ actorId, amount, reason });
    return { success: true, creditsRemaining: 990, consumed: amount };
  },
  isGuestActorId: (id) => String(id || '').startsWith('guest_'),
};
require.cache[require.resolve('../services/creditService.js')] = {
  id: require.resolve('../services/creditService.js'),
  filename: require.resolve('../services/creditService.js'),
  loaded: true,
  exports: creditMock,
};

const caps = require('../lib/capabilities');
const TaskExecutor = require('../services/TaskExecutor');
const toolRegistry = require('../tools');
const approvalStore = require('../lib/capabilities/approvalStore');
const idemStore = require('../lib/capabilities/idempotencyStore');
const { authorizeCapability, DEFAULT_POLICY } = caps.authorizationPolicy;

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
    console.error(`  FAIL  ${label}\n        ${err && err.stack ? err.message : String(err)}`);
  }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const resetEverything = () => {
  idemStore._reset();
  approvalStore._reset();
  creditMock.log.length = 0;
  caps.operatorPolicy.resetOperatorPolicy();
};

const waitForApproval = async (predicate = () => true, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = approvalStore.list().filter((a) => a.state === 'PENDING' && predicate(a));
    if (list.length >= 1) return list[0];
    await tick(5);
  }
  throw new Error('approval not requested in time');
};

const approvalPolicy = (capabilityId, reason = 'approve-first') => ({
  entries: [{ id: capabilityId, action: 'approval_required', reason }],
  guestDenied: [],
  workspaceRestricted: [],
});

const denyPolicy = (capabilityId, reason = 'operator-revoked') => ({
  entries: [{ id: capabilityId, action: 'deny', reason }],
  guestDenied: [],
  workspaceRestricted: [],
});

const fakeSocket = (uid) => ({
  userId: uid,
  emitted: [],
  emit(event, payload) {
    this.emitted.push({ event, payload });
    return this;
  },
});

const PLAIN_OPTS = {
  workspaceId: 'ws-4e',
  skipCreditCharge: true,
  conversationId: 'conv-4e',
};

let toolCalls = 0;
const installNativeCounter = (name, cb) => {
  const tool = toolRegistry.tools[name];
  const original = tool.execute;
  tool.execute = async (args, context) => {
    toolCalls += 1;
    if (cb) {
      const out = await cb(args, context, original);
      if (out !== undefined) return out;
    }
    return { success: true, name, count: toolCalls };
  };
  return () => { tool.execute = original; };
};

const main = async () => {

// ---- Item 3: seeded guest hard-deny defaults --------------------------------

await test('seeded base guestDenied lists verified external/consequential natives', () => {
  resetEverything();
  const policy = caps.operatorPolicy.getOperatorPolicy();
  const seeded = caps.operatorPolicy.GUEST_DENY_DEFAULTS;
  for (const id of ['native:webSearch', 'native:scrapeWebsite', 'native:deepResearchSwarm', 'native:sendEmail', 'native:memorize', 'native:storeUserFact']) {
    assert.ok(seeded.includes(id), `GUEST_DENY_DEFAULTS includes ${id}`);
    assert.ok(policy.guestDenied.includes(id), `active operator base denies ${id} for guests`);
  }
  // every seeded id resolves to a real registered native capability
  for (const id of seeded) {
    const wire = id.replace(/^native:/, '');
    assert.ok(toolRegistry.tools[wire], `seeded id ${id} maps to registered native tool ${wire}`);
  }
});

await test('seeding does NOT mutate the frozen DEFAULT_POLICY', () => {
  resetEverything();
  assert.ok(Object.isFrozen(DEFAULT_POLICY));
  assert.ok(Object.isFrozen(DEFAULT_POLICY.entries));
  assert.ok(Object.isFrozen(DEFAULT_POLICY.guestDenied));
  assert.ok(Array.isArray(DEFAULT_POLICY.guestDenied) && DEFAULT_POLICY.guestDenied.length === 0,
    'pure-engine DEFAULT_POLICY guestDenied stays empty');
});

await test('pure engine: guestDenied on the seeded base denies a guest and allows a user', () => {
  resetEverything();
  const capability = { id: 'native:webSearch', source: 'native', name: 'webSearch', wireName: 'webSearch', risk: 'low', scope: 'read' };
  const denied = authorizeCapability(capability, { userId: 'guest_1', isGuest: true }, { policy: caps.operatorPolicy.getOperatorPolicy() });
  assert.strictEqual(denied.allowed, false);
  assert.strictEqual(denied.reason, 'guest-denied');
  const allowed = authorizeCapability(capability, { userId: 'user-1', isGuest: false }, { policy: caps.operatorPolicy.getOperatorPolicy() });
  assert.strictEqual(allowed.allowed, true);
});

await test('TaskExecutor refuses a guest webSearch by default through the real boundary', async () => {
  resetEverything();
  const restore = installNativeCounter('webSearch');
  try {
    const r = await TaskExecutor.executeTool('webSearch', { query: 'x' }, 'guest_4e', null, PLAIN_OPTS);
    assert.strictEqual(toolCalls, 0, 'guest webSearch must not reach the tool body');
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.authorization.reason, 'guest-denied');
    assert.strictEqual(creditMock.log.length, 0, 'no credit charge for a denied guest');
  } finally { restore(); }
  resetEverything();
});

// ---- Item 1: workspace identity --------------------------------------------

await test('WorkspaceRuntimeManager.getWorkspaceById is owner-scoped when requester supplied', async () => {
  const mongoose = require('mongoose');
  const ownedOid = new mongoose.Types.ObjectId();
  const forgedOid = new mongoose.Types.ObjectId();
  const REQUIRED = {
    _id: ownedOid.toString(),
    owner: 'user-owner',
    name: 'Owner WS',
    vectorNamespace: `workspace_${ownedOid}`,
  };
  const FAKE_WS = {
    findOne: (filter) => {
      const idStr = filter._id ? String(filter._id) : null;
      const ownerStr = filter.owner ? String(filter.owner) : null;
      let doc = null;
      // mimic owner + archive filtering performed by the real model query:
      // a doc only resolves when BOTH the id and the owner filter match.
      if (!ownerStr && idStr === forgedOid.toString()) {
        // unscoped lookup (getWorkspaceById without requester) returns the doc
        doc = { _id: forgedOid, owner: 'user-evil', name: 'Forged' };
      } else if (ownerStr === 'user-owner' && idStr === ownedOid.toString()) {
        doc = REQUIRED;
      } else if (ownerStr === 'user-evil' && idStr === forgedOid.toString()) {
        doc = { _id: forgedOid, owner: 'user-evil', name: 'Forged' };
      }
      // real model returns a Query (findOne never returns null); .lean() yields doc|null
      return { lean: async () => doc };
    },
  };
  require.cache[require.resolve('../models/Workspace')] = {
    id: require.resolve('../models/Workspace'),
    filename: require.resolve('../models/Workspace'),
    loaded: true,
    exports: FAKE_WS,
  };
  const WorkspaceRuntimeManager = require('../services/WorkspaceRuntimeManager');
  const mgr = new WorkspaceRuntimeManager({ logger: { info: () => {} } });
  try {
    // own workspace resolves
    const own = await mgr.getWorkspaceById(ownedOid.toString(), { ownerUserId: 'user-owner' });
    assert.ok(own, 'owner-scoped lookup returns the owned workspace');
    assert.strictEqual(own.name, 'Owner WS');
    // the FORGED doc (owner user-evil) must NOT resolve for user-owner
    const forged = await mgr.getWorkspaceById(forgedOid.toString(), { ownerUserId: 'user-owner' });
    assert.strictEqual(forged, null, 'forged/cross-user workspace must not resolve');
    // without owner scope the forged doc would leak — prove the gate matters
    const unscoped = await mgr.getWorkspaceById(forgedOid.toString());
    assert.ok(unscoped, 'unscoped lookup returns the doc (gate is meaningful)');
    assert.strictEqual(unscoped._id.toString(), forgedOid.toString());
  } finally {
    delete require.cache[require.resolve('../models/Workspace')];
    delete require.cache[require.resolve('../services/WorkspaceRuntimeManager')];
  }
  await new mongoose.Types.ObjectId(); // keep mongoose referenced
});

await test('resolveWorkspace never returns an unowned explicit workspaceId', async () => {
  const mongoose = require('mongoose');
  const ownOid = new mongoose.Types.ObjectId();
  const evilOid = new mongoose.Types.ObjectId();
  const FAKE_WS = {
    findOne: (filter) => {
      const queries = {};
      const docFor = (() => {
        if (filter._id?.toString && filter._id.toString() === evilOid.toString()) {
          // forged doc exists but belongs to another user
          return (filter.owner && String(filter.owner) === 'user-evil')
            ? { _id: evilOid, owner: 'user-evil', name: 'Evil', vectorNamespace: `workspace_${evilOid}` }
            : null;
        }
        return (filter.owner && String(filter.owner) === 'user-owner')
          ? { _id: ownOid, owner: 'user-owner', name: 'Owned', vectorNamespace: `workspace_${ownOid}` }
          : null;
      })();
      const q = { lean: async () => docFor };
      q.sort = () => q; // default-workspace path calls .sort().lean()
      return q;
    },
    updateOne: async () => ({ modifiedCount: 1 }),
  };
  require.cache[require.resolve('../models/Workspace')] = {
    id: require.resolve('../models/Workspace'),
    filename: require.resolve('../models/Workspace'),
    loaded: true,
    exports: FAKE_WS,
  };
  const WorkspaceRuntimeManager = require('../services/WorkspaceRuntimeManager');
  const mgr = new WorkspaceRuntimeManager({ logger: { info: () => {}, workspaceResolved: () => {} } });
  try {
    const res = await mgr.resolveWorkspace({ userId: 'user-owner', workspaceId: evilOid.toString() });
    assert.ok(!res || String(res._id) !== String(evilOid), 'owner cannot resolve the forged workspace');
    const own = await mgr.resolveWorkspace({ userId: 'user-owner', workspaceId: ownOid.toString() });
    assert.ok(own, 'owner resolves their own workspace');
  } finally {
    delete require.cache[require.resolve('../models/Workspace')];
    delete require.cache[require.resolve('../services/WorkspaceRuntimeManager')];
  }
});

await test('index.js ai:stt:final owner-gates an incoming workspaceId', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const block = src.slice(src.indexOf("socket.on('ai:stt:final'"), src.indexOf("socket.on('disconnect'"));
  assert.ok(/Workspace\.findOne\(\{ _id: incomingWorkspaceId, owner: userId \}\)/.test(block),
    'stt:final validates incoming workspace ownership');
  assert.ok(/falls back to the socket's active workspace|socket\.activeWorkspaceId/.test(block),
    'stt:final falls back to the socket active workspace');
});

await test('TaskPlanner.executePlan refuses a cross-user execution even with matching workspaceId', async () => {
  const ExecutionStub = {
    findById: async () => ({
      _id: 'exec-4e',
      userId: 'user-victim',
      workspaceId: 'ws-4e',
      status: 'PLANNED',
      steps: [],
      save: async () => {},
    }),
  };
  require.cache[require.resolve('../models/Execution')] = {
    id: require.resolve('../models/Execution'),
    filename: require.resolve('../models/Execution'),
    loaded: true,
    exports: ExecutionStub,
  };
  const TaskPlanner = require('../services/TaskPlanner');
  try {
    const sock = fakeSocket('user-evil');
    let threw = null;
    try {
      await TaskPlanner.executePlan('exec-4e', sock, { workspaceId: 'ws-4e' });
    } catch (err) { threw = err; }
    assert.ok(threw, 'cross-user executePlan must throw');
    assert.strictEqual(threw.message, 'Execution not found');
  } finally {
    delete require.cache[require.resolve('../models/Execution')];
    delete require.cache[require.resolve('../services/TaskPlanner')];
  }
});

await test('TaskPlanner.executePlan lets the owner run their execution', async () => {
  const ExecutionStub = {
    findById: async () => ({
      _id: 'exec-4e',
      userId: 'user-owner',
      workspaceId: 'ws-4e',
      status: 'PLANNED',
      steps: [],
      save: async () => {},
    }),
  };
  require.cache[require.resolve('../models/Execution')] = {
    id: require.resolve('../models/Execution'),
    filename: require.resolve('../models/Execution'),
    loaded: true,
    exports: ExecutionStub,
  };
  const TaskPlanner = require('../services/TaskPlanner');
  try {
    const sock = fakeSocket('user-owner');
    let threw = null;
    try {
      await TaskPlanner.executePlan('exec-4e', sock, { workspaceId: 'ws-4e' });
    } catch (err) { threw = err; }
    assert.strictEqual(threw, null, 'owner execution passes the identity gate');
  } finally {
    delete require.cache[require.resolve('../models/Execution')];
    delete require.cache[require.resolve('../services/TaskPlanner')];
  }
});

// ---- Item 5: approval TOCTOU revalidation -----------------------------------

await test('TOCTOU: authority revoked while approval pending blocks before side effects', async () => {
  resetEverything();
  const restore = installNativeCounter('getTime');
  const sock = fakeSocket('u-4e');
  caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
  try {
    const p = TaskExecutor.executeTool('getTime', {}, 'u-4e', sock, PLAIN_OPTS);
    const approval = await waitForApproval((a) => a.capabilityId === 'native:getTime');
    assert.strictEqual(toolCalls, 0, 'no execution before approval resolution');

    // The operator revokes authority WHILE the human decision is pending.
    caps.operatorPolicy.setOperatorPolicy(denyPolicy('native:getTime'));

    const out = approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-4e' });
    assert.strictEqual(out.ok, true);
    const r = await p;
    assert.strictEqual(r.success, false, 'revoked-after-approval must not execute');
    assert.strictEqual(toolCalls, 0, 'TOCTOU gap closed: tool body never runs');
    assert.strictEqual(creditMock.log.length, 0, 'TOCTOU gap closed: no credit charge');
    assert.strictEqual(r.blocked, true);
    assert.strictEqual(r.authorization.reason, 'operator-revoked');
  } finally { restore(); }
  resetEverything();
});

await test('approval still continues normally when authority is unchanged', async () => {
  resetEverything();
  const restore = installNativeCounter('getTime');
  const sock = fakeSocket('u-4e');
  caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:getTime'));
  try {
    const p = TaskExecutor.executeTool('getTime', {}, 'u-4e', sock, PLAIN_OPTS);
    const approval = await waitForApproval((a) => a.capabilityId === 'native:getTime');
    assert.strictEqual(toolCalls, 0);
    const out = approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-4e' });
    assert.strictEqual(out.ok, true);
    const r = await p;
    assert.strictEqual(r.success, true, 'unchanged authority still executes after approval');
    assert.strictEqual(toolCalls, 1, 'exactly one execution');
  } finally { restore(); }
  resetEverything();
});

console.log(`\n${pass + fail} tests, ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});