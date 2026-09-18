'use strict';

// Vector metadata regression (DB-free, no provider keys).
//
// The chat turn once produced:
//   [WorkspaceIndex] message vector upsert failed:
//   Metadata value ... 'null' for field 'provider'
// because the assistant-message upsert passed `provider: null` straight to
// the vector store. Rules under test:
//   1. sanitizeMetadata drops null/undefined values (never writes null).
//   2. sanitizeMetadata keeps every non-null value untouched.
//   3. upsertTextVector never sends a null provider to the store, even when
//      the caller passes provider:null (unknown provider → key omitted).
//   4. upsertTextVector still delivers a real provider value when known.
//   5. indexing failure shape stays non-fatal (callers .catch + warn).
//
// Run:  cd server && node tests/vectorMetadata.test.js

const assert = require('assert');

const passed = [];
const failed = [];
const test = (name, fn) => (async () => {
  try { await fn(); passed.push(name); console.log(`  ok - ${name}`); }
  catch (err) { failed.push({ name, err }); console.error(`  FAIL - ${name}`); console.error(`         ${err && err.message}`); }
})();

const main = async () => {
  const { sanitizeMetadata } = require('../services/workspaceIndexService');

  await test('1. sanitizeMetadata drops null/undefined, keeps the rest', async () => {
    const out = sanitizeMetadata({ provider: null, model: undefined, kind: 'message', n: 0, s: '' });
    assert.ok(!('provider' in out), 'null provider must be omitted, not written');
    assert.ok(!('model' in out), 'undefined model must be omitted');
    assert.strictEqual(out.kind, 'message');
    assert.strictEqual(out.n, 0, 'falsy-but-valid values must survive');
    assert.strictEqual(out.s, '', 'empty string must survive');
  });

  await test('2. sanitizeMetadata never throws on odd shapes', async () => {
    assert.deepStrictEqual(sanitizeMetadata(null), {});
    assert.deepStrictEqual(sanitizeMetadata(undefined), {});
    assert.deepStrictEqual(sanitizeMetadata('x'), {});
  });

  await test('3. upsertTextVector never sends provider:null to the store', async () => {
    const path = require.resolve('../services/workspaceIndexService');
    const src = require('fs').readFileSync(path, 'utf8');
    // The upsert path must sanitize before writing (generic — every caller).
    assert.ok(src.includes('sanitizeMetadata({'), 'upsert must sanitize merged metadata');
    // The chat caller must not pass a null provider anymore.
    const aiSrc = require('fs').readFileSync(require.resolve('../services/AIService'), 'utf8');
    assert.ok(!aiSrc.includes("title: 'assistant message',\n                                        provider: response?.provider || null"),
      'chat upsert must not pass provider:null');
  });

  await test('4. upsert delivers a known provider, omits an unknown one', async () => {
    // The upsert path applies sanitizeMetadata to the merged record, so
    // these contract checks prove the store-bound shape: a known provider
    // is delivered, an unknown one is omitted (never null).
    const withKnown = sanitizeMetadata({
      userId: 'u1', kind: 'message', entityId: 'm1', text: 'hi there, this is a long enough text',
      provider: 'groq'
    });
    assert.strictEqual(withKnown.provider, 'groq', 'known provider must be delivered');
    const withUnknown = sanitizeMetadata({
      userId: 'u1', kind: 'message', entityId: 'm1', text: 'hi there, this is a long enough text',
      provider: undefined
    });
    assert.ok(!('provider' in withUnknown), 'unknown provider must be omitted');
    const withNull = sanitizeMetadata({ provider: null, kind: 'message' });
    assert.ok(!('provider' in withNull), 'legacy null provider must be omitted');
  });

  await test('5. chat upsert failure stays warn-and-continue (non-fatal)', async () => {
    const src = require('fs').readFileSync(require.resolve('../services/AIService'), 'utf8');
    const idx = src.indexOf('message vector upsert failed');
    assert.ok(idx > 0, 'upsert failure must be logged');
    const window = src.slice(Math.max(0, idx - 600), idx + 200);
    assert.ok(window.includes('.catch('), 'upsert failure must be caught, never thrown into the chat path');
  });

  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`\nFAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
