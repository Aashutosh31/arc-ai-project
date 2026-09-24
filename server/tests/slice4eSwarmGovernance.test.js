'use strict';

// JARVIS Action Substrate — slice 4E item 4: DEEP-RESEARCH SWARM NESTED TOOL
// EXECUTION IS GOVERNED BY THE UNIFIED ACTION SUBSTRATE PATH.
//
// The deepResearchSwarm tool previously called webSearch/scrapeWebsite leaf
// tools DIRECTLY, bypassing capability resolution, authorization, approval,
// envelope, idempotency and credits. This suite proves the nested research
// operations now run through the SAME governed choke point
// (TaskExecutor.executeTool) with the REAL caller context (userId, socket,
// workspaceId, conversationId, signal) — never context derived from
// untrusted tool args — and that:
//   1. nested webSearch/scrapeWebsite route through the executor (args intact)
//   2. the credit path is inherited (webSearch=2, scrapeWebsite=2)
//   3. the execution envelope records each nested action (distinct identity,
//      caller workspace)
//   4. default policy allows a member's nested research tools
//   5. operator deny / guest hard-deny / workspace restriction block the
//      nested operation without any inner tool execution and without credits
//   6. nested authorization scope comes from the caller context only
//   7. nested APPROVAL_REQUIRED behaves per the 4C gate: same session, single
//      approval record, approve->execute exactly once; deny / no-session /
//      TOCTOU revocation all block before credits or side effects
//   8. parent cancellation propagates into nested execution (pre-start and
//      while a nested approval is pending: nested work stops, request cancelled)
//   9. no nested deepResearchSwarm recursion is ever issued
//  10. the swarm's public success/failure output shape is unchanged
//  11. each nested execution keeps its own idempotency/execution identity
//      (no collapse into the outer swarm execution, no invented replay)
//
// Run: cd server && node tests/slice4eSwarmGovernance.test.js

const assert = require('assert');

// ---- stub process-wide collaborators BEFORE the registry loads --------------
// (tools/index.js eagerly loads deepResearchSwarm; its require() calls must
// resolve to these controlled stubs while the REAL TaskExecutor,
// authorizationPolicy, approvalStore, idempotency and creditService paths do
// the governance work below.)

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

class FakeLLMRouter {
  async generate(opts = {}) {
    if (opts.signal && opts.signal.aborted) {
      const e = new Error('stream generation aborted');
      e.name = 'AbortError';
      throw e;
    }
    return {
      provider: 'fake-groq',
      model: 'fake-model',
      stream: { text: 'Research report draft prepared.' },
    };
  }
}
class FakeStreamingRuntime {
  consume(stream, socket, signal, onChunk) {
    const text = String((stream && stream.text) || 'Research report draft prepared.');
    if (socket) socket.emit('ai:tts:response:chunk', { chunk: text, displayText: text, isFinal: false });
    if (typeof onChunk === 'function') onChunk(text);
    if (socket) socket.emit('ai:tts:response:chunk', { chunk: '', displayText: '', isFinal: true });
    return text;
  }
}

const fakeMessage = {
  created: 0,
  async create(data) {
    fakeMessage.created += 1;
    return { _id: `msg-${fakeMessage.created}` };
  },
  async findByIdAndUpdate() { return {}; },
};
const fakeConversation = {
  async findByIdAndUpdate() { return {}; },
};

for (const [resolvePath, exports] of [
  ['../lib/llm/LLMRouter', FakeLLMRouter],
  ['../lib/llm/StreamingRuntime', FakeStreamingRuntime],
  ['../models/Message', fakeMessage],
  ['../models/Conversation', fakeConversation],
]) {
  require.cache[require.resolve(resolvePath)] = {
    id: require.resolve(resolvePath),
    filename: require.resolve(resolvePath),
    loaded: true,
    exports,
  };
}

const caps = require('../lib/capabilities');
const toolRegistry = require('../tools');
const TaskExecutor = require('../services/TaskExecutor');
const approvalStore = require('../lib/capabilities/approvalStore');
const idemStore = require('../lib/capabilities/idempotencyStore');

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

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const CANONICAL_SUCCESS = {
  success: true,
  message: "The Multi-Agent Swarm successfully wrote the report and streamed it directly to the user's screen. Do NOT repeat the report. Just ask the user if they need any revisions.",
};

// ---- swarm leaf tool instrumentation ----------------------------------------

const calls = { web: 0, scrape: 0 };
const lastNestedArgs = { web: null, scrape: null };
const lastNestedCtx = { web: null, scrape: null };
const ability = { webHold: null, webResponse: null, scrapeResponse: null };

const DEFAULT_WEB_CONTENT = 'Journal article at https://example.com/report covering the latest quantum computing developments.';

const installLeafTools = () => {
  toolRegistry.tools.webSearch = {
    schema: {
      type: 'function',
      function: {
        name: 'webSearch',
        description: 'Search the web.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    },
    execute: async (args, context) => {
      calls.web += 1;
      lastNestedArgs.web = { query: args.query };
      lastNestedCtx.web = {
        userId: context && context.userId !== undefined ? context.userId : null,
        signal: context && context.signal ? context.signal : null,
        workspaceId: context && context.workspaceId !== undefined ? context.workspaceId : null,
        conversationId: context && context.conversationId !== undefined ? context.conversationId : null,
      };
      if (ability.webHold) await ability.webHold;
      if (context && context.signal && context.signal.aborted) {
        return { success: false, cancelled: true, error: 'aborted by upstream' };
      }
      return ability.webResponse || { success: true, content: DEFAULT_WEB_CONTENT };
    },
  };
  toolRegistry.tools.scrapeWebsite = {
    schema: {
      type: 'function',
      function: {
        name: 'scrapeWebsite',
        description: 'Scrape a website.',
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      },
    },
    execute: async (args, context) => {
      calls.scrape += 1;
      lastNestedArgs.scrape = { url: args.url };
      lastNestedCtx.scrape = {
        userId: context && context.userId !== undefined ? context.userId : null,
        signal: context && context.signal ? context.signal : null,
        workspaceId: context && context.workspaceId !== undefined ? context.workspaceId : null,
        conversationId: context && context.conversationId !== undefined ? context.conversationId : null,
      };
      if (context && context.signal && context.signal.aborted) {
        return { success: false, cancelled: true, error: 'aborted by upstream' };
      }
      return ability.scrapeResponse || { success: true, content: `Scraped body of ${args.url}` };
    },
  };
};

const resetEverything = () => {
  calls.web = 0;
  calls.scrape = 0;
  lastNestedArgs.web = null;
  lastNestedArgs.scrape = null;
  lastNestedCtx.web = null;
  lastNestedCtx.scrape = null;
  ability.webHold = null;
  ability.webResponse = null;
  ability.scrapeResponse = null;
  fakeMessage.created = 0;
  idemStore._reset();
  approvalStore._reset();
  creditMock.log.length = 0;
  caps.operatorPolicy.resetOperatorPolicy();
  installLeafTools();
};

// ---- helpers -----------------------------------------------------------------

const fakeSocket = (uid, opts = {}) => ({
  userId: uid,
  emitted: [],
  isInterrupted: Boolean(opts.isInterrupted),
  emit(event, payload) {
    this.emitted.push({ event, payload });
    return this;
  },
});

const runSwarm = (opts = {}) => {
  const uid = opts.userId || 'u-swarm';
  const socket = opts.socket || fakeSocket(uid);
  return TaskExecutor.executeTool(
    'deepResearchSwarm',
    { topic: opts.topic || 'quantum computing' },
    uid,
    socket,
    {
      workspaceId: opts.workspaceId || 'ws-1',
      conversationId: opts.conversationId || 'conv-1',
      signal: opts.signal === undefined ? null : opts.signal,
      skipCreditCharge: opts.charge !== true,
    }
  );
};

const runSwarmToolDirect = (context, socket) =>
  toolRegistry.tools.deepResearchSwarm.execute({ topic: 'quantum computing' }, context, socket);

const approvalPolicy = (capabilityId, reason = 'approve-nested') => ({
  entries: [{ id: capabilityId, action: 'approval_required', reason }],
  guestDenied: [],
  workspaceRestricted: [],
});

const denyPolicy = (capabilityId, reason = 'operator-revoked') => ({
  entries: [{ id: capabilityId, action: 'deny', reason }],
  guestDenied: [],
  workspaceRestricted: [],
});

const captureLog = async (fn) => {
  const lines = [];
  const original = console.log;
  console.log = (...a) => {
    lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  };
  try {
    await fn();
    await tick(25); // flush observability microtasks
  } finally {
    console.log = original;
  }
  return lines.join('\n');
};

const startedEvents = (logText) => {
  const re = /\[Capability\] capability\.execution\.started (\{.*?\})\s*(?=\[Capability\]|\n|$)/g;
  const out = [];
  let m;
  while ((m = re.exec(logText)) !== null) {
    try { out.push(JSON.parse(m[1])); } catch { /* skip malformed */ }
  }
  return out;
};

const waitUntil = async (predicate, label, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  let found = null;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      found = value;
      break;
    }
    await tick(5);
  }
  if (found) return found;
  throw new Error(`timeout waiting for ${label}`);
};

const waitForApproval = (predicate = () => true, timeoutMs = 5000) =>
  waitUntil(
    () => {
      const list = approvalStore.list().filter((a) => a.state === 'PENDING' && predicate(a));
      return list.length >= 1 ? list[0] : null;
    },
    'approval request',
    timeoutMs
  );

const hold = () => {
  let resolveFn;
  const promise = new Promise((res) => { resolveFn = res; });
  return { promise, resolve: () => resolveFn() };
};

const main = async () => {

await test('nested webSearch routes through the governed executor and keeps its query', async () => {
  resetEverything();
  const r = await runSwarm();
  assert.strictEqual(calls.web, 1, 'webSearch invoked exactly once');
  assert.strictEqual(lastNestedArgs.web.query, 'quantum computing latest news comprehensive overview');
  assert.strictEqual(calls.scrape, 1, 'scrapeWebsite invoked once after the URL was found');
  assert.strictEqual(r.success, true);
});

await test('nested scrapeWebsite routes through the governed executor and keeps its URL', async () => {
  resetEverything();
  await runSwarm();
  assert.strictEqual(calls.scrape, 1);
  assert.strictEqual(lastNestedArgs.scrape.url, 'https://example.com/report');
  assert.strictEqual(calls.web, 1);
});

await test('nested executions inherit the credit path with their own costs', async () => {
  resetEverything();
  await runSwarm({ charge: true }); // outer charged too, so nested charges are auditable
  const web = creditMock.log.find((c) => c.reason === 'webSearch');
  const scrape = creditMock.log.find((c) => c.reason === 'scrapeWebsite');
  assert.ok(web, 'nested webSearch charged');
  assert.strictEqual(web.amount, 2);
  assert.strictEqual(web.actorId, 'u-swarm');
  assert.ok(scrape, 'nested scrapeWebsite charged');
  assert.strictEqual(scrape.amount, 2);
  assert.strictEqual(scrape.actorId, 'u-swarm');
});

await test('each nested action is wrapped in its own execution envelope (distinct identity, caller workspace)', async () => {
  resetEverything();
  const log = await captureLog(() => runSwarm());
  const started = startedEvents(log);
  const web = started.find((e) => e.toolName === 'webSearch');
  const scrape = started.find((e) => e.toolName === 'scrapeWebsite');
  const swarm = started.find((e) => e.toolName === 'deepResearchSwarm');
  assert.ok(swarm, 'outer swarm execution envelope recorded');
  assert.ok(web, 'nested webSearch envelope recorded');
  assert.ok(scrape, 'nested scrapeWebsite envelope recorded');
  const ids = new Set([swarm.executionId, web.executionId, scrape.executionId]);
  assert.strictEqual(ids.size, 3, 'three distinct execution identities');
  assert.strictEqual(web.workspaceId, 'ws-1');
  assert.strictEqual(scrape.workspaceId, 'ws-1');
  assert.strictEqual(web.capabilityId, 'native:webSearch');
  assert.strictEqual(scrape.capabilityId, 'native:scrapeWebsite');
});

await test('default operator policy allows a member nested webSearch end-to-end', async () => {
  resetEverything();
  const log = await captureLog(() => runSwarm());
  assert.strictEqual(calls.web, 1);
  assert.strictEqual(calls.scrape, 1);
  assert.ok(/capability\.authorization\.allowed/.test(log), 'AUTH_ALLOWED observed for the nested path');
  assert.ok(!/capability\.authorization\.denied/.test(log), 'no nested denial under the default policy');
});

await test('operator deny on native:webSearch blocks the nested operation before any inner call', async () => {
  resetEverything();
  caps.operatorPolicy.setOperatorPolicy(denyPolicy('native:webSearch'));
  const log = await captureLog(() => runSwarm());
  assert.strictEqual(calls.web, 0, 'denied nested webSearch never reaches the tool body');
  assert.strictEqual(creditMock.log.length, 0, 'no credit charge for a denied nested execution');
  assert.ok(/\[Tool: deepResearchSwarm\] \{"event":"tool\.failure","tool":"webSearch"/.test(log),
    'swarm logs the nested webSearch failure');
});

await test('guest hard-deny blocks nested webSearch without credits or inner execution', async () => {
  resetEverything();
  // Outer TaskExecutor already gatekeeps a guest (deepResearchSwarm is
  // guest-denied at the outer boundary — proved in slice4e). Here we invoke
  // the swarm tool directly so ONLY the nested guest-deny path is in scope.
  const sock = fakeSocket('guest_swarm');
  const log = await captureLog(() =>
    runSwarmToolDirect({ userId: 'guest_swarm', workspaceId: 'ws-1', conversationId: 'conv-1', signal: null }, sock)
  );
  assert.strictEqual(calls.web, 0, 'guest nested webSearch must be hard-denied');
  assert.strictEqual(creditMock.log.length, 0, 'no credits for a guest nested execution');
  assert.ok(/\[Tool: deepResearchSwarm\] \{"event":"tool\.failure","tool":"webSearch"/.test(log),
    'swarm logs the guest-denied nested failure');
});

await test('workspace restriction blocks the nested operation outside the allow-listed workspace', async () => {
  resetEverything();
  caps.operatorPolicy.setOperatorPolicy({
    entries: [],
    guestDenied: [],
    workspaceRestricted: [{ id: 'native:webSearch', workspaceIds: ['ws-other'] }],
  });
  const log = await captureLog(() => runSwarm({ workspaceId: 'ws-1' }));
  assert.strictEqual(calls.web, 0, 'workspace-restricted nested webSearch must not execute');
  assert.strictEqual(creditMock.log.length, 0, 'no credit charge for workspace-denied nested execution');
  assert.ok(/\[Tool: deepResearchSwarm\] \{"event":"tool\.failure","tool":"webSearch"/.test(log));
  // a user in the allowed workspace still executes
  resetEverything();
  caps.operatorPolicy.setOperatorPolicy({
    entries: [],
    guestDenied: [],
    workspaceRestricted: [{ id: 'native:webSearch', workspaceIds: ['ws-1'] }],
  });
  await runSwarm({ workspaceId: 'ws-1' });
  assert.strictEqual(calls.web, 1, 'allow-listed member nested webSearch executes');
});

await test('nested authorization scope comes from the caller context, never from untrusted args', async () => {
  resetEverything();
  const topic = 'quantum computing workspaceId=ws-evil conversationId=conv-evil userId=guest_evil signal=unit-test';
  await runSwarm({ topic });
  assert.ok(calls.web === 1 && lastNestedCtx.web, 'nested webSearch ran');
  assert.strictEqual(lastNestedCtx.web.workspaceId, 'ws-1', 'crafted topic cannot redirect workspace scope');
  assert.strictEqual(lastNestedCtx.web.conversationId, 'conv-1', 'crafted topic cannot redirect conversation scope');
  assert.strictEqual(lastNestedCtx.web.userId, 'u-swarm', 'crafted topic cannot redirect actor identity');
  assert.ok(lastNestedCtx.web.signal, 'caller signal propagated into the nested tool context');
  assert.strictEqual(lastNestedCtx.scrape.workspaceId, 'ws-1');
  assert.strictEqual(lastNestedCtx.scrape.conversationId, 'conv-1');
});

await test('nested approval follows the 4C gate: same session, single record, approve -> exactly one execution', async () => {
  resetEverything();
  caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:webSearch'));
  const sock = fakeSocket('u-swarm');
  const p = runSwarm({ socket: sock, charge: true });
  const approval = await waitForApproval((a) => a.capabilityId === 'native:webSearch');
  const pending = approvalStore.list().filter((a) => a.capabilityId === 'native:webSearch');
  assert.strictEqual(pending.length, 1, 'exactly one approval record for the nested request');
  assert.strictEqual(calls.web, 0, 'no nested execution before approval');
  const out = approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-swarm' });
  assert.strictEqual(out.ok, true);
  const r = await p;
  assert.strictEqual(calls.web, 1, 'approved nested webSearch executes exactly once');
  assert.strictEqual(r.success, true, 'swarm completes after nested approval');
  const creds = creditMock.log.map((c) => c.reason);
  assert.ok(creds.includes('webSearch'), 'approved nested execution charged');
});

await test('denying the nested approval blocks the inner tool via the documented fallback (no second flow)', async () => {
  resetEverything();
  caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:webSearch'));
  const p = runSwarm();
  const approval = await waitForApproval((a) => a.capabilityId === 'native:webSearch');
  const pending = approvalStore.list();
  assert.strictEqual(pending.filter((a) => a.capabilityId === 'native:webSearch').length, 1,
    'single nested approval record; no unrelated approval state');
  assert.strictEqual(pending.filter((a) => a.capabilityId === 'native:scrapeWebsite').length, 0,
    'no recursive/unrelated approval requested');
  const out = approvalStore.resolve({ approvalId: approval.approvalId, decision: 'deny', userId: 'u-swarm' });
  assert.strictEqual(out.ok, true);
  const r = await p;
  assert.strictEqual(calls.web, 0, 'denied nested webSearch never executes');
  assert.strictEqual(creditMock.log.length, 0, 'no credits for the denied nested request');
  assert.ok(r.success === true || (r.diagnostic && r.diagnostic.cause === 'abort_signal'),
    'swarm reaches its documented fallback/completion path');
});

await test('nested approval fails closed without an authenticated matching session', async () => {
  resetEverything();
  caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:webSearch'));
  const sockMismatch = fakeSocket('someone-else'); // socket identity != userId
  const r = await runSwarm({ socket: sockMismatch });
  assert.strictEqual(calls.web, 0, 'no-session nested approval must not execute');
  assert.strictEqual(creditMock.log.length, 0, 'no credits without a session');
  assert.ok(r.success === true || (r.diagnostic && r.diagnostic.cause === 'abort_signal'),
    'swarm reaches its documented fallback/completion path');
});

await test('nested approval TOCTOU: authority revoked while pending blocks before credits/execution', async () => {
  resetEverything();
  caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:webSearch'));
  const p = runSwarm();
  const approval = await waitForApproval((a) => a.capabilityId === 'native:webSearch');
  assert.strictEqual(calls.web, 0);

  caps.operatorPolicy.setOperatorPolicy(denyPolicy('native:webSearch'));

  const out = approvalStore.resolve({ approvalId: approval.approvalId, decision: 'approve', userId: 'u-swarm' });
  assert.strictEqual(out.ok, true);
  const r = await p;
  assert.strictEqual(calls.web, 0, 'TOCTOU: revoked-after-approval nested webSearch must not execute');
  assert.strictEqual(creditMock.log.length, 0, 'TOCTOU: no credit charge');
  assert.ok(r.success !== undefined, 'swarm still returns a bounded result');
});

await test('parent cancellation propagates into nested execution and stops downstream nested work', async () => {
  resetEverything();
  const ac = new AbortController();
  const h = hold();
  ability.webHold = h.promise;
  const p = runSwarm({ signal: ac.signal });
  await waitUntil(() => calls.web === 1, 'nested webSearch to start');
  ac.abort();
  h.resolve();
  const r = await p;
  assert.strictEqual(calls.scrape, 0, 'upstream abort while webSearch in flight prevents the downstream scrape');
  assert.strictEqual(lastNestedCtx.web.signal.aborted, true, 'the aborted caller signal reached the nested tool context');
  assert.ok(r.success === false, 'interrupted swarm returns a failure result');
  assert.strictEqual(r.diagnostic && r.diagnostic.cause, 'abort_signal', 'swarm classifies the abort correctly');
});

await test('abort while a nested approval is pending cancels the nested request and prevents execution', async () => {
  resetEverything();
  caps.operatorPolicy.setOperatorPolicy(approvalPolicy('native:webSearch'));
  const ac = new AbortController();
  const p = runSwarm({ signal: ac.signal });
  const approval = await waitForApproval((a) => a.capabilityId === 'native:webSearch');
  ac.abort();
  const r = await p;
  assert.strictEqual(calls.web, 0, 'aborted nested approval never executes');
  const after = approvalStore.read(approval.approvalId);
  assert.strictEqual(after && after.state, 'CANCELLED', 'pending approval is cancelled on abort');
  assert.ok(!r.success, 'swarm stops after the cancelled nested request');
  assert.strictEqual(r.diagnostic && r.diagnostic.cause, 'abort_signal');
});

await test('no nested deepResearchSwarm recursion is ever issued', async () => {
  resetEverything();
  await runSwarm();
  const reasons = creditMock.log.map((c) => c.reason);
  assert.ok(reasons.length === 2 && reasons.includes('webSearch') && reasons.includes('scrapeWebsite'),
    `only webSearch + scrapeWebsite are issued as nested executions (got: ${JSON.stringify(reasons)})`);
  assert.ok(!reasons.includes('deepResearchSwarm'), 'the swarm never recursively invokes itself');
});

await test('successful swarm output shape is unchanged', async () => {
  resetEverything();
  const sock = fakeSocket('u-swarm');
  const r = await runSwarm({ socket: sock });
  assert.deepStrictEqual(r, CANONICAL_SUCCESS);
  const statuses = sock.emitted.filter((e) => e.event === 'ai:agent:status').map((e) => e.payload);
  assert.ok(statuses.length >= 2, 'swarm emitted live agent status progress');
  assert.deepStrictEqual(statuses[statuses.length - 1], { status: null }, 'swarm clears the status on completion');
});

await test('nested executions keep distinct idempotency/execution identity (no collapse, no invented replay)', async () => {
  resetEverything();
  const log = await captureLog(() => runSwarm());
  assert.strictEqual(calls.web, 1, 'nested webSearch actually executed (not replayed)');
  assert.strictEqual(calls.scrape, 1, 'nested scrapeWebsite actually executed (not replayed)');
  const started = startedEvents(log);
  const names = new Set(started.filter((e) => e.toolName).map((e) => e.toolName));
  ['deepResearchSwarm', 'webSearch', 'scrapeWebsite'].forEach((n) => assert.ok(names.has(n), `${n} executed`));
  assert.ok(!/capability\.idempotency\.duplicatePrevented/.test(log),
    'no idempotency replay invented between outer and nested executions');
});

console.log(`\n${pass + fail} tests, ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});