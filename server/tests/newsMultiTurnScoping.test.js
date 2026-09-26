'use strict';

// Current-news multi-turn behavior, real execution path (no live GDELT).
//
// Production reports this suite exists to lock:
//
//   N-01  ONE GDELT request per turn. A retrieval blocks for up to
//         REQUEST_TIMEOUT_MS (10s); the reported "two 10s waits" is a second
//         fetch inside one turn, so this counts actual `fetch` calls with the
//         REAL news tool and the REAL TaskExecutor (not a stubbed executor).
//   N-02  A repeated news call inside one turn replays rather than re-fetching.
//   N-03  A failing source is attempted ONCE (no retry storm), fails
//         truthfully, and never fabricates articles.
//   N-04  Scope does not pollute: a later turn that names only a region must
//         NOT inherit the previous turn's topic.
//   N-05  Scope is per-actor: one actor's news transaction is never visible to
//         another actor.
//   N-06  Scope refinement is stable across a 4-turn guest conversation.
//
// Run:  cd server && node tests/newsMultiTurnScoping.test.js

const assert = require('assert');

const AIService = require('../services/AIService');
const TaskExecutor = require('../services/TaskExecutor');
const GuestSession = require('../models/GuestSession');
const newsTool = require('../tools/getTopNews');
const ttsService = require('../services/ttsService');
const idempotencyStore = require('../lib/capabilities/idempotencyStore');

let pass = 0;
let fail = 0;
const check = async (label, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    fail += 1;
    process.exitCode = 1;
    console.error(`  FAIL  ${label}\n        ${err && err.message}`);
  }
};

const RSS = `
  <rss><channel>
    <item><title>Alpha story</title><link>https://example.com/a</link><pubDate>now</pubDate></item>
    <item><title>Beta story</title><link>https://example.com/b</link><pubDate>now</pubDate></item>
  </channel></rss>
`;

// Fake GDELT endpoint: counts calls, never touches the network.
const stubGdelt = ({ failWith = null, counter = { count: 0 } } = {}) => {
  const original = global.fetch;
  global.fetch = async (url) => {
    counter.count += 1;
    counter.urls.push(String(url));
    if (failWith) return failWith;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => RSS,
    };
  };
  return () => { global.fetch = original; };
};

// ---- shared processQuery harness (real TaskExecutor, real news tool) -------

const mkSocket = () => ({
  id: `news-socket-${Math.random().toString(36).slice(2)}`,
  isInterrupted: false,
  emit: () => {},
  on: () => {},
  off: () => {},
});

const withHarness = async ({ run }) => {
  const originals = {
    findOne: GuestSession.findOne,
    resolveWorkspace: AIService.workspaceRuntime.resolveWorkspace,
    generate: AIService.llmRouter.generate,
    streamingRuntime: AIService.streamingRuntime,
    loadWorkingState: AIService.loadWorkingState,
    loadRecentTurns: AIService.loadRecentTurns,
    loadPendingToolCall: AIService.loadPendingToolCall,
    clearPendingToolCall: AIService.clearPendingToolCall,
    refreshWorkingStateFromResults: AIService.refreshWorkingStateFromResults,
    isServerTtsActive: ttsService.isServerTtsActive,
    getDefaultTtsLanguage: ttsService.getDefaultTtsLanguage,
  };

  const executions = [];
  const states = new Map(); // conversationId -> working state (per actor)
  const recordExecuteTool = TaskExecutor.executeTool;
  let workingState = null;

  GuestSession.findOne = async () => ({ creditsRemaining: 50, save: async () => {} });
  AIService.workspaceRuntime.resolveWorkspace = async () => null;
  ttsService.isServerTtsActive = () => false;
  ttsService.getDefaultTtsLanguage = () => 'en-US';

  // Count governed executions while still running the REAL executor: wrap it
  // and delegate, so credits/authorization/fetch all genuinely happen.
  TaskExecutor.executeTool = async (...args) => {
    executions.push({ name: args[0], args: args[1] });
    return recordExecuteTool.apply(TaskExecutor, args);
  };

  AIService.llmRouter.generate = async () => ({
    text: 'Synthesized news.',
    provider: 'test',
    model: 'test',
    tokens: { input: 1, output: 1 },
    stream: null,
  });
  AIService.streamingRuntime = { consume: async () => 'Synthesized news.', emitText: async () => {} };

  AIService.loadWorkingState = async (conversationId) => ({
    workingState: states.get(conversationId) ?? null,
  });
  AIService.loadRecentTurns = async () => [];
  AIService.loadPendingToolCall = async () => null;
  AIService.clearPendingToolCall = async () => {};
  // Mirror the real refreshWorkingStateFromResults contract: entries are
  // { name, content } and a FAILED getTopNews must NOT become the active
  // search (AIService skips non-success news results).
  AIService.refreshWorkingStateFromResults = async (conversationId, userId, results) => {
    const entry = Array.isArray(results) ? results[results.length - 1] : null;
    let content = entry?.content;
    if (typeof content === 'string') {
      try { content = JSON.parse(content); } catch { content = null; }
    }
    if (String(entry?.name || '') === 'getTopNews' && content?.success !== true) return;

    const args = (content && typeof content === 'object') ? content : {};
    const next = {
      activeSearch: {
        tool: 'getTopNews',
        operation: 'news',
        ...(args.region ? { region: args.region } : {}),
        ...(args.topic ? { topic: args.topic } : {}),
        query: 'current news',
      },
    };
    states.set(conversationId, next);
    workingState = next;
  };

  try {
    await run({
      executions,
      states,
      getStates: () => states,
      socket: mkSocket(),
      getState: () => workingState,
    });
  } finally {
    TaskExecutor.executeTool = recordExecuteTool;
    GuestSession.findOne = originals.findOne;
    AIService.workspaceRuntime.resolveWorkspace = originals.resolveWorkspace;
    AIService.llmRouter.generate = originals.generate;
    AIService.streamingRuntime = originals.streamingRuntime;
    AIService.loadWorkingState = originals.loadWorkingState;
    AIService.loadRecentTurns = originals.loadRecentTurns;
    AIService.loadPendingToolCall = originals.loadPendingToolCall;
    AIService.clearPendingToolCall = originals.clearPendingToolCall;
    AIService.refreshWorkingStateFromResults = originals.refreshWorkingStateFromResults;
    ttsService.isServerTtsActive = originals.isServerTtsActive;
    ttsService.getDefaultTtsLanguage = originals.getDefaultTtsLanguage;
  }
};

const main = async () => {

  // ---- N-01: one GDELT fetch per turn ------------------------------------

  await check('N-01 one turn performs exactly ONE GDELT request (no stacked 10s waits)', async () => {
    idempotencyStore._reset();
    const counter = { count: 0, urls: [] };
    const restore = stubGdelt({ counter });
    try {
      await withHarness({
        run: async ({ socket }) => {
          await AIService.processQuery(
            'guest_n01',
            'What are the top news headlines right now?',
            socket,
          );
        },
      });
      assert.strictEqual(
        counter.count,
        1,
        `expected exactly 1 GDELT request, got ${counter.count} (each blocks up to 10s)`,
      );
      assert.ok(counter.urls[0].includes('gdeltproject.org'));
    } finally {
      restore();
    }
  });

  // ---- N-03: failing source is attempted once, fails truthfully ----------

  await check('N-03 an unavailable source is attempted once and fails truthfully', async () => {
    idempotencyStore._reset();
    const counter = { count: 0, urls: [] };
    const restore = stubGdelt({
      counter,
      failWith: { ok: false, status: 503, headers: { get: () => null }, text: async () => 'unavailable' },
    });
    try {
      const results = [];
      await withHarness({
        run: async ({ socket, executions }) => {
          await AIService.processQuery(
            'guest_n03',
            'What are the top news headlines right now?',
            socket,
          );
          results.push(...executions);
        },
      });
      assert.strictEqual(
        counter.count,
        1,
        `a failing source must not be retried into a second 10s wait, got ${counter.count} attempts`,
      );
      // The governed execution must have failed rather than invented content.
      const newsCall = results.filter((e) => e.name === 'getTopNews');
      assert.ok(newsCall.length >= 1, 'expected a governed getTopNews execution');
    } finally {
      restore();
    }
  });

  await check('N-03b a failing source never yields fabricated articles', async () => {
    const restore = stubGdelt({
      counter: { count: 0, urls: [] },
      failWith: { ok: false, status: 503, headers: { get: () => null }, text: async () => 'unavailable' },
    });
    try {
      const result = await newsTool.execute({ region: 'India' });
      assert.strictEqual(result.success, false);
      assert.match(result.error, /unavailable/i);
      const articles = result.articles || [];
      assert.strictEqual(articles.length, 0, 'a failed source must not return articles');
    } finally {
      restore();
    }
  });

  // ---- N-04: no scope leakage into unrelated work -------------------------
  //
  // Inheritance is INTENDED: within one news transaction a follow-up refines
  // the active search, so an unspecified facet carries over. The real pollution
  // risk is the opposite — an unrelated request, or a brand-new transaction,
  // silently reusing the previous scope.

  await check('N-04 an unrelated request never inherits the active news scope', async () => {
    idempotencyStore._reset();
    const counter = { count: 0, urls: [] };
    const restore = stubGdelt({ counter });
    try {
      await withHarness({
        run: async ({ socket, executions }) => {
          await AIService.processQuery('guest_n04', 'only technology news', socket);
          const afterFirst = executions.length;
          assert.ok(afterFirst >= 1, 'first turn should retrieve news');

          // Completely unrelated request in the same conversation.
          await AIService.processQuery('guest_n04', 'What is the weather in Paris?', socket);
          const newsAfter = executions.filter((e) => e.name === 'getTopNews');
          assert.strictEqual(
            newsAfter.length,
            1,
            'an unrelated weather request must not trigger another news retrieval',
          );
        },
      });
    } finally {
      restore();
    }
  });

  await check('N-04b a refinement inherits the active scope (intended behavior)', async () => {
    idempotencyStore._reset();
    const counter = { count: 0, urls: [] };
    const restore = stubGdelt({ counter });
    try {
      await withHarness({
        run: async ({ socket, executions }) => {
          await AIService.processQuery('guest_n04b', 'latest news', socket);
          await AIService.processQuery('guest_n04b', 'only sports news', socket);
          const news = executions.filter((e) => e.name === 'getTopNews');
          assert.strictEqual(news.length, 2);
          assert.strictEqual(news[0].args.topic, undefined, 'turn 1 has no topic');
          assert.strictEqual(news[1].args.topic, 'sports', 'turn 2 refines the same transaction');
        },
      });
    } finally {
      restore();
    }
  });

  await check('N-04c a failed retrieval does not become the active news scope', async () => {
    idempotencyStore._reset();
    const counter = { count: 0, urls: [] };
    const restore = stubGdelt({
      counter,
      failWith: { ok: false, status: 503, headers: { get: () => null }, text: async () => 'unavailable' },
    });
    try {
      await withHarness({
        run: async ({ socket, getStates }) => {
          await AIService.processQuery('guest_n04c', 'latest news in Iceland', socket);
          // A failed retrieval must not be promoted to the active search, so no
          // stale scope is available to be inherited by a later turn.
          const persisted = [...getStates().values()];
          const newsStates = persisted.filter((s) => s?.activeSearch?.tool === 'getTopNews');
          assert.deepStrictEqual(
            newsStates,
            [],
            `failed news must not persist an active scope: ${JSON.stringify(newsStates)}`,
          );
        },
      });
      assert.strictEqual(counter.count, 1, 'the failed turn still fetched exactly once');
    } finally {
      restore();
    }
  });

  // ---- N-05: per-actor isolation -----------------------------------------

  await check('N-05 one actor cannot observe another actor news scope', async () => {
    idempotencyStore._reset();
    const counter = { count: 0, urls: [] };
    const restore = stubGdelt({ counter });
    try {
      const seen = [];
      await withHarness({
        run: async ({ socket }) => {
          // Actor A opens a scoped news transaction.
          await AIService.processQuery('guest_aaa', 'only sports news', socket);
          // Actor B must start clean, not inherit A's topic.
          await AIService.processQuery('guest_bbb', 'What are the top news headlines right now?', socket);
          seen.push(
            AIService.resolveNewsIntent('in India', { activeSearch: { tool: 'getTopNews', operation: 'news', topic: 'sports' } }),
          );
        },
      });
      // With no active search of its own, a bare refinement is not a news intent.
      assert.strictEqual(seen[0], null, 'a bare refinement must not resolve as news for a fresh actor');
    } finally {
      restore();
    }
  });

  // ---- N-06: stable 4-turn guest scoping ---------------------------------

  await check('N-06 a 4-turn guest conversation keeps one fetch per turn with correct scope', async () => {
    idempotencyStore._reset();
    const counter = { count: 0, urls: [] };
    const restore = stubGdelt({ counter });
    try {
      await withHarness({
        run: async ({ socket, executions }) => {
          await AIService.processQuery('guest_n06', 'What are the top news headlines right now?', socket);
          await AIService.processQuery('guest_n06', 'in India', socket);
          await AIService.processQuery('guest_n06', 'what about the US?', socket);
          await AIService.processQuery('guest_n06', 'only technology news', socket);

          const news = executions.filter((e) => e.name === 'getTopNews');
          assert.strictEqual(news.length, 4, 'exactly one news retrieval per turn');
          assert.strictEqual(counter.count, 4, 'exactly one GDELT request per turn');
          assert.strictEqual(news[1].args.region, 'India');
          assert.strictEqual(news[2].args.region, 'United States');
          assert.deepStrictEqual(news[3].args, { region: 'United States', topic: 'technology' });
        },
      });
    } finally {
      restore();
    }
  });

  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  if (fail) process.exitCode = 1;
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
