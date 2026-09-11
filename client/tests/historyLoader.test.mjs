// Client history regression tests (Stage 2) — run with: node tests/historyLoader.test.mjs
// Plain node, no runner. Covers normalization, latest-page bootstrap, cursor
// paging, id dedupe, abort + stale protection, and retention of every
// persisted lifecycle state (completed / stale-flag completed / cancelled).
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CURSOR_PAGE_SIZE,
  HistoryLoader,
  normalizeHistoryMessage,
  normalizeHistoryPage,
  prependMessages,
  sanitizeHistoryText
} from '../src/lib/conversationHistory.js';

const __dir = dirname(fileURLToPath(import.meta.url));
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

console.log('Client History Regression Tests (Stage 2)');
console.log('=========================================');

/* Fixture: 95 ascending docs with every lifecycle state represented. */
const CID = 'conv-A';
function buildDocs(n = 95) {
  const base = Date.now() - n * 1000;
  const docs = [];
  for (let i = 0; i < n; i += 1) {
    docs.push({
      _id: `m${i}`,
      conversationId: CID,
      role: i % 2 === 0 ? 'user' : 'ai',
      content: `msg-${i}`,
      metadata: { streaming: false, interrupted: false, partial: false, state: 'final' },
      createdAt: new Date(base + i * 1000).toISOString()
    });
  }
  if (docs[10]) {
    docs[10].metadata = { streaming: true, interrupted: false, partial: true, state: 'streaming' };
    docs[10].content = 'draft-partial';
  }
  if (docs[50]) {
    docs[50].metadata = { streaming: false, interrupted: false, partial: true, state: 'streaming' };
    docs[50].content = 'completed-but-stale-flags';
  }
  if (docs[70]) {
    docs[70].metadata = { streaming: false, interrupted: true, partial: true, state: 'cancelled' };
    docs[70].content = 'cancelled-partial';
  }
  return docs;
}

/* Fake server implementing the Stage 1 contract (skip anchor + before). */
function makeServer(docs) {
  const calls = [];
  const fetchPage = async (conversationId, { limit, skip = 0, before, signal } = {}) => {
    calls.push({ conversationId, limit, skip, before: before ?? null });
    if (signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (conversationId !== CID) {
      const e = new Error('Conversation not found');
      e.code = 'CONVERSATION_NOT_FOUND';
      throw e;
    }
    if (before) {
      const idx = docs.findIndex((d) => String(d._id) === String(before));
      if (idx < 0) {
        const e = new Error('Cursor message not found.');
        e.code = 'CURSOR_NOT_FOUND';
        throw e;
      }
      const pool = docs.slice(0, idx);
      const page = pool.slice(Math.max(0, pool.length - limit));
      const hasMore = pool.length > limit;
      return {
        messages: page, total: docs.length, hasMore,
        page: { nextBefore: page.length > 0 ? page[0]._id : null, hasMore }
      };
    }
    const page = docs.slice(skip, skip + limit);
    const hasMore = skip + limit < docs.length;
    return { messages: page, total: docs.length, hasMore, page: null };
  };
  return { calls, fetchPage };
}

const ids = (list) => list.map((m) => m.id);

await check('sanitizer mirrors ChatContext (no drift)', () => {
  const libSrc = readFileSync(join(__dir, '../src/lib/conversationHistory.js'), 'utf8');
  const ctxSrc = readFileSync(join(__dir, '../src/contexts/ChatContext.jsx'), 'utf8');
  const grab = (src, name) => {
    const start = src.indexOf(name);
    assert.ok(start >= 0, `${name} found`);
    const end = src.indexOf('};', start);
    return src.slice(start, end).replace(/\s+/g, '');
  };
  const norm = (s) => s.replace(/sanitize\w+|text|t\b/g, '');
  assert.strictEqual(
    norm(grab(libSrc, 'sanitizeHistoryText')),
    norm(grab(ctxSrc, 'sanitizeForDisplay')),
    'sanitizer bodies must stay identical'
  );
  // Markdown structure survives: tables, fences, lists intact.
  const md = '| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\ncode  \n```\n\n- item';
  assert.strictEqual(sanitizeHistoryText(md), md.replace('  \n', '\n'));
});

await check('1. normalization preserves _id as id (history + socket shapes)', () => {
  const h = normalizeHistoryMessage({ _id: 'abc', role: 'user', content: ' hi\r\n' });
  assert.deepStrictEqual([h.id, h.sender, h.text, h.isStreaming], ['abc', 'user', 'hi', false]);
  const s = normalizeHistoryMessage({ sender: 'ai', text: 'live' });
  assert.strictEqual(s.id, null);
  assert.strictEqual(s.sender, 'ai');
  assert.strictEqual(normalizeHistoryMessage(null), null);
  assert.strictEqual(normalizeHistoryMessage({ role: 'ai' }), null, 'contentless+idless is invalid');
  const withId = normalizeHistoryMessage({ _id: 'x', role: 'ai', content: '' });
  assert.strictEqual(withId.id, 'x', 'server doc with empty content is still valid history');
});

await check('no lifecycle state is ever filtered by normalization', () => {
  const docs = buildDocs();
  for (const i of [10, 50, 70]) {
    const m = normalizeHistoryMessage(docs[i]);
    assert.ok(m, `doc ${i} (${docs[i].content}) retained`);
    assert.strictEqual(m.id, `m${i}`);
  }
  assert.strictEqual(normalizeHistoryMessage(docs[70]).interrupted, true);
});

await check('2. initial latest-page load, small conversation = single request', async () => {
  const docs = buildDocs(20);
  const { calls, fetchPage } = makeServer(docs);
  const loader = new HistoryLoader(fetchPage);
  const res = await loader.loadLatest(CID);
  assert.strictEqual(calls.length, 1, 'one request when history fits a page');
  assert.deepStrictEqual(ids(res.messages), docs.map((d) => d._id));
  assert.strictEqual(res.hasMore, false);
  assert.strictEqual(res.oldestId, 'm0');
  assert.strictEqual(loader.oldestId, 'm0');
});

await check('large conversation bootstrap anchors latest page from total', async () => {
  const docs = buildDocs(95);
  const { calls, fetchPage } = makeServer(docs);
  const loader = new HistoryLoader(fetchPage);
  const res = await loader.loadLatest(CID);
  assert.strictEqual(calls.length, 2, 'probe + anchored latest page');
  assert.deepStrictEqual(calls[0], { conversationId: CID, limit: 40, skip: 0, before: null });
  assert.deepStrictEqual(calls[1], { conversationId: CID, limit: 40, skip: 55, before: null });
  assert.deepStrictEqual(ids(res.messages), docs.slice(55).map((d) => d._id));
  assert.strictEqual(res.hasMore, true);
  assert.strictEqual(res.oldestId, 'm55');
  assert.strictEqual(res.total, 95);
});

await check('empty conversation resolves empty without cursor', async () => {
  const { calls, fetchPage } = makeServer([]);
  const loader = new HistoryLoader(fetchPage);
  const res = await loader.loadLatest(CID);
  assert.deepStrictEqual(res.messages, []);
  assert.strictEqual(res.oldestId, null);
  assert.strictEqual(res.hasMore, false);
  assert.strictEqual(calls.length, 1);
});

await check('3. cursor older-page requests before=<oldestId>', async () => {
  const docs = buildDocs(95);
  const { calls, fetchPage } = makeServer(docs);
  const loader = new HistoryLoader(fetchPage);
  await loader.loadLatest(CID);
  const older = await loader.loadOlder([{ id: 'm55' }]);
  const last = calls[calls.length - 1];
  assert.strictEqual(last.before, 'm55');
  assert.strictEqual(last.limit, 40);
  assert.deepStrictEqual(ids(older.messages), docs.slice(15, 55).map((d) => d._id));
  assert.strictEqual(older.hasMore, true);
  assert.strictEqual(older.oldestId, 'm15');
});

await check('4+5. full backward walk == ascending history, chronological', async () => {
  const docs = buildDocs(95);
  const { fetchPage } = makeServer(docs);
  const loader = new HistoryLoader(fetchPage);
  const latest = await loader.loadLatest(CID);
  const collected = [...latest.messages];
  let guard = 0;
  while (loader.hasMore) {
    guard += 1;
    if (guard > 10) throw new Error('walk did not terminate');
    const page = await loader.loadOlder(collected);
    collected.unshift(...page.messages);
  }
  assert.deepStrictEqual(ids(collected), docs.map((d) => d._id));
  assert.strictEqual(new Set(ids(collected)).size, 95);
});

await check('6. _id dedupe on overlap (prependMessages + loadOlder)', async () => {
  const docs = buildDocs(95);
  const { fetchPage } = makeServer(docs);
  const loader = new HistoryLoader(fetchPage);
  await loader.loadLatest(CID); // m55..m94
  // Simulate current list already containing part of the incoming page.
  const current = normalizeHistoryPage(docs.slice(40, 95)); // m40..m94
  const older = await loader.loadOlder(current); // server page m15..m54
  const merged = prependMessages(current, older.messages);
  // Overlap m40..m54 deduped: 25 novel (m15..m39) + 55 current = 80.
  assert.strictEqual(merged.length, 80, 'no duplicates after overlap');
  assert.deepStrictEqual(ids(merged), docs.slice(15, 95).map((d) => d._id));
  // Pure helper: id-less live messages always survive a prepend.
  const withLive = prependMessages([{ id: null, sender: 'ai', text: 'streaming…' }], [{ id: 'a', sender: 'user', text: 'old' }]);
  assert.strictEqual(withLive.length, 2);
  assert.strictEqual(withLive[1].text, 'streaming…');
});

await check('7. terminal page: hasMore false, NO_MORE without cursor', async () => {
  const docs = buildDocs(30);
  const { fetchPage } = makeServer(docs);
  const loader = new HistoryLoader(fetchPage);
  const res = await loader.loadLatest(CID);
  assert.strictEqual(res.hasMore, false);
  await assert.rejects(() => loader.loadOlder(res.messages), (e) => e.code === 'NO_MORE');
});

await check('8. AbortController: abort() rejects in-flight with AbortError', async () => {
  let onAbort = null;
  const fetchPage = (_cid, { signal } = {}) => new Promise((_res, rej) => {
    onAbort = () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      rej(e);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const loader = new HistoryLoader(fetchPage);
  const p = loader.loadLatest(CID);
  loader.abort();
  await assert.rejects(() => p, (e) => e.name === 'AbortError');
  // External signal propagates into the request.
  const ctrl = new AbortController();
  const { fetchPage: srv } = makeServer(buildDocs(10));
  const loader2 = new HistoryLoader((cid, opts) => new Promise((resolve, reject) => {
    const onAbort = () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    };
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    srv(cid, opts).then(
      (v) => { opts.signal?.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { opts.signal?.removeEventListener('abort', onAbort); reject(e); }
    );
  }));
  const p2 = loader2.loadLatest(CID, { signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(() => p2, (e) => e.name === 'AbortError');
});

await check('9. stale sequence: late first response throws STALE', async () => {
  const resolvers = [];
  const fetchPage = () => new Promise((res) => resolvers.push(res));
  const loader = new HistoryLoader(fetchPage);
  const first = loader.loadLatest(CID);
  const second = loader.loadLatest(CID);
  // Resolve out of order: second (current) first.
  resolvers[1]({ messages: [{ _id: 'b', role: 'user', content: 'B' }], total: 1, hasMore: false });
  const r2 = await second;
  assert.strictEqual(r2.messages[0].id, 'b');
  resolvers[0]({ messages: [{ _id: 'a', role: 'user', content: 'A' }], total: 1, hasMore: false });
  await assert.rejects(() => first, (e) => e.code === 'STALE');
});

await check('10. A→B: late A response cannot overwrite B', async () => {
  const resolvers = [];
  const fetchPage = (cid) => new Promise((res) => resolvers.push({ cid, res }));
  const loader = new HistoryLoader(fetchPage);
  const reqA = loader.loadLatest('conv-A');
  const reqB = loader.loadLatest('conv-B');
  assert.strictEqual(loader.conversationId, 'conv-B');
  resolvers[1].res({ messages: [{ _id: 'mb', role: 'user', content: 'B' }], total: 1, hasMore: false });
  const rB = await reqB;
  assert.strictEqual(rB.messages[0].id, 'mb');
  resolvers[0].res({ messages: [{ _id: 'ma', role: 'user', content: 'A' }], total: 1, hasMore: false });
  await assert.rejects(() => reqA, (e) => e.code === 'STALE');
});

await check('11. A→B older-page cannot prepend into B', async () => {
  const docs = buildDocs(95);
  const { fetchPage } = makeServer(docs);
  const loader = new HistoryLoader(fetchPage);
  await loader.loadLatest(CID); // A loaded, hasMore true
  // Older-page fetch for A hangs in flight…
  let releaseOlder = null;
  loader.fetchPage = (cid, opts) => {
    if (opts.before) return new Promise((res) => { releaseOlder = res; });
    return fetchPage(cid, opts);
  };
  const olderP = loader.loadOlder([{ id: 'm55' }]);
  // …then the user switches conversation: the B latest-load supersedes it.
  loader.fetchPage = fetchPage;
  const reqB = loader.loadLatest('conv-B-does-not-exist').catch((e) => e);
  releaseOlder({ messages: [], total: 95, hasMore: false });
  await assert.rejects(() => olderP, (e) => e.code === 'STALE');
  const rB = await reqB;
  assert.strictEqual(rB.code, 'CONVERSATION_NOT_FOUND', 'fetch errors still propagate');
  assert.strictEqual(loader.conversationId, 'conv-B-does-not-exist');
});

await check('12+13+14. completed, stale-flag, cancelled retained through walk', async () => {
  const docs = buildDocs(95);
  const { fetchPage } = makeServer(docs);
  const loader = new HistoryLoader(fetchPage);
  const latest = await loader.loadLatest(CID);
  const all = [...latest.messages];
  while (loader.hasMore) {
    const page = await loader.loadOlder(all);
    all.unshift(...page.messages);
  }
  const texts = all.map((m) => m.text);
  assert.ok(texts.includes('completed-but-stale-flags'), 'stale-flag completed retained');
  assert.ok(texts.includes('cancelled-partial'), 'cancelled retained');
  assert.ok(texts.includes('draft-partial'), 'streaming draft not filtered');
  assert.ok(texts.includes('msg-0') && texts.includes('msg-94'), 'boundaries intact');
});

await check('15. new message append with partial history: no dupes, tail kept', async () => {
  const docs = buildDocs(95);
  const { fetchPage } = makeServer(docs);
  const loader = new HistoryLoader(fetchPage);
  const latest = await loader.loadLatest(CID); // m55..m94
  // User sends a message: optimistic + streamed tail (no ids yet).
  const view = [...latest.messages,
    { id: null, sender: 'user', text: 'new question' },
    { id: null, sender: 'ai', text: 'new answer', isStreaming: false }];
  const older = await loader.loadOlder(view);
  const merged = prependMessages(view, older.messages);
  assert.strictEqual(merged.length, 40 + 40 + 2);
  assert.strictEqual(merged[merged.length - 1].text, 'new answer', 'live tail kept');
  assert.strictEqual(merged[merged.length - 2].text, 'new question');
  assert.deepStrictEqual(ids(merged.slice(0, 80)), docs.slice(15, 95).map((d) => d._id));
});

await check('CURSOR_PAGE_SIZE is 40', () => {
  assert.strictEqual(CURSOR_PAGE_SIZE, 40);
});

console.log(`\nResult: ${pass} pass, ${fail} fail`);
process.exit(process.exitCode || 0);
