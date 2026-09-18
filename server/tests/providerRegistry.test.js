'use strict';

// Provider registry: Mistral is completely removed; Groq is active.
//
//   P-01 no registered provider id or alias mentions mistral
//   P-02 auto-routing never selects mistral (any profile, keys or not)
//   P-03 buildProviderOrder never contains mistral
//   P-04 explicit mistral preference degrades to an available provider
//   P-05 title-generation path prefers groq (no MCP tools attached)
//   P-06 no Mistral environment variable is required for routing
//   P-07 the Mistral SDK package is no longer resolvable
//   P-08 embeddings degrade gracefully without keys (no Mistral call)
//
// Run:  cd server && node tests/providerRegistry.test.js

const assert = require('assert');

const passed = [];
const failed = [];
const test = (name, fn) => (async () => {
  try { await fn(); passed.push(name); console.log(`  ok - ${name}`); }
  catch (err) { failed.push({ name, err }); console.error(`  FAIL - ${name}`); console.error(`         ${err && err.message}`); }
})();

const withEnv = async (overrides, fn) => {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  // Fresh router instance reads env at construction; registry reads live.
  delete require.cache[require.resolve('../lib/llm/LLMRouter')];
  try {
    return await fn(require('../lib/llm/LLMRouter'));
  } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve('../lib/llm/LLMRouter')];
  }
};

const PROFILES = [
  { messages: [{ role: 'user', content: 'hello' }], tools: [], attachments: [] },
  { messages: [{ role: 'user', content: 'explain quantum tunneling in depth with math' }], tools: [], attachments: [] },
  { messages: [{ role: 'user', content: 'do it' }], tools: [{ type: 'function', function: { name: 'x', description: 'y', parameters: {} } }], attachments: [] },
  { messages: [{ role: 'user', content: 'analyze this image' }], tools: [], attachments: [{ type: 'image' }] }
];

const main = async () => {
  await test('P-01 no registered provider id or alias mentions mistral', async () => {
    const registry = require('../lib/llm/providers');
    for (const p of registry.listProviders()) {
      assert.ok(!String(p?.id || '').toLowerCase().includes('mistral'), `registered: ${p?.id}`);
      for (const a of (p?.aliases || [])) {
        assert.ok(!String(a || '').toLowerCase().includes('mistral'), `alias: ${a}`);
      }
    }
    assert.strictEqual(registry.getProvider('mistral'), undefined, 'mistral still resolvable');
    assert.strictEqual(registry.getProvider('mistral-ai'), undefined, 'mistral alias still resolvable');
  });

  await test('P-02 auto-routing never selects mistral', async () => {
    for (const env of [
      { GROQ_API_KEY: 'k', GEMINI_API_KEY: 'k', MISTRAL_API_KEY: undefined },
      { GROQ_API_KEY: undefined, GEMINI_API_KEY: 'k', MISTRAL_API_KEY: undefined },
      { GROQ_API_KEY: 'k', GEMINI_API_KEY: undefined, MISTRAL_API_KEY: undefined }
    ]) {
      await withEnv(env, async (LLMRouter) => {
        const router = new LLMRouter();
        for (const req of PROFILES) {
          let id = null;
          try {
            id = router.choosePrimaryProvider(req).providerId;
          } catch (e) {
            // No-key multimodal may throw availability error; never mistral.
            assert.ok(!/mistral/i.test(e?.message || ''), `threw mistral: ${e?.message}`);
            continue;
          }
          assert.ok(id === 'groq' || id === 'gemini', `selected ${id}`);
        }
      });
    }
  });

  await test('P-03 buildProviderOrder never contains mistral', async () => {
    await withEnv({ GROQ_API_KEY: 'k', GEMINI_API_KEY: 'k' }, async (LLMRouter) => {
      const router = new LLMRouter();
      const order = router.buildProviderOrder(
        { messages: [{ role: 'user', content: 'hi' }], tools: [], attachments: [] }, 'groq');
      assert.ok(order.length > 0);
      assert.strictEqual(order[0].id, 'groq');
      assert.ok(!order.some((p) => String(p?.id || '').includes('mistral')), 'mistral in order');
    });
  });

  await test('P-04 explicit mistral preference degrades gracefully', async () => {
    await withEnv({ GROQ_API_KEY: 'k', GEMINI_API_KEY: 'k' }, async (LLMRouter) => {
      const router = new LLMRouter();
      const order = router.buildProviderOrder(
        { messages: [{ role: 'user', content: 'hi' }], tools: [], attachments: [], preferredProvider: 'mistral' }, null);
      assert.ok(order.length > 0);
      assert.ok(!order.some((p) => String(p?.id || '').includes('mistral')));
      assert.ok(['groq', 'gemini'].includes(order[0].id), `fell to ${order[0].id}`);
    });
  });

  await test('P-05 title-generation path prefers groq with no tools', async () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../controllers/conversationController'), 'utf8');
    assert.ok(/preferredProvider:\s*'groq'/.test(src), 'title gen does not prefer groq');
    assert.ok(!/preferredProvider:\s*'mistral'/.test(src), 'title gen still prefers mistral');
    assert.ok(!/['"]mistral['"]/i.test(src.match(/generateConversationTitle[\s\S]{0,2000}/)?.[0] || ''), 'mistral near title gen');
  });

  await test('P-06 routing works with zero Mistral variables set', async () => {
    await withEnv({ GROQ_API_KEY: 'k', MISTRAL_API_KEY: undefined, MISTRAL_MODEL: undefined }, async (LLMRouter) => {
      const router = new LLMRouter();
      const { providerId } = router.choosePrimaryProvider({
        messages: [{ role: 'user', content: 'short title please' }], tools: [], attachments: []
      });
      assert.strictEqual(providerId, 'groq');
    });
  });

  await test('P-07 the Mistral SDK package is no longer resolvable', async () => {
    let resolved = null;
    try { resolved = require.resolve('@mistralai/mistralai'); } catch { resolved = null; }
    assert.strictEqual(resolved, null, `@mistralai still resolvable at ${resolved}`);
    const pkg = require('../package.json');
    assert.ok(!pkg.dependencies?.['@mistralai/mistralai'], 'dependency still declared');
    assert.ok(!pkg.devDependencies?.['@mistralai/mistralai'], 'devDependency still declared');
  });

  await test('P-08 embeddings degrade gracefully without keys (no Mistral call)', async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const { getEmbedding } = require('../services/embeddingService');
      const v = await getEmbedding('hello world');
      assert.strictEqual(v, null, 'expected graceful null without key');
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });

  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`\nFAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
