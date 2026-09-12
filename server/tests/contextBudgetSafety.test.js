/* Context-budget safety tests — run with: node tests/contextBudgetSafety.test.js
 *
 * First safety layer for unbounded LLM context (shared master/perf defect):
 *  1. 413 / context-length / token-limit failures classify explicitly.
 *  2. Oversized identical requests are NOT retried or failed over.
 *  3. classifyProviderFailure contract otherwise unchanged (happy path safe).
 *
 * Plain node, no runner. Router failover is tested with stubbed providers
 * (require.cache) against the REAL LLMRouter code. No DB, no provider calls.
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

console.log('Context-Budget Safety Tests');
console.log('===========================');

const {
  classifyProviderFailure,
  normalizeProviderError
} = require('../lib/llm/utils');

// Exact observed Groq 413 shape (status + TPM message), content-free.
const groq413 = () => {
  const err = new Error(
    'Request too large for model `openai/gpt-oss-120b` on service tier `on_demand` ' +
    'on tokens per minute (TPM): Limit 8000, Requested 8551'
  );
  err.statusCode = 413;
  return err;
};

async function run() {
  await check('Groq 413 classifies as context-budget, never transient/rate-limit', () => {
    const f = classifyProviderFailure(groq413());
    assert.strictEqual(f.isContextBudget, true);
    assert.strictEqual(f.isTransient, false);
    assert.strictEqual(f.isRateLimit, false);
    assert.strictEqual(f.status, 413);
  });

  await check('context-length variants classify without status code', () => {
    for (const msg of [
      'context_length_exceeded: maximum context length',
      'This model maximum context length is 8192 tokens',
      'request_too_large: payload exceeds limit',
      'Request too large for model `x`',
      'rate_limit_exceeded: TPM Limit 8000, Requested 8551'
    ]) {
      const f = classifyProviderFailure(new Error(msg));
      assert.strictEqual(f.isContextBudget, true, msg);
      assert.strictEqual(f.isTransient, false, msg);
    }
  });

  await check('existing classes unchanged: 429, 500, 400-model, generic', () => {
    const r429 = classifyProviderFailure(Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 }));
    assert.strictEqual(r429.isRateLimit, true);
    assert.strictEqual(r429.isTransient, true);
    assert.strictEqual(r429.isContextBudget, false);

    const r500 = classifyProviderFailure(Object.assign(new Error('boom'), { statusCode: 500 }));
    assert.strictEqual(r500.isTransient, true);
    assert.strictEqual(r500.isContextBudget, false);

    const r400 = classifyProviderFailure(Object.assign(new Error('invalid_model: foo'), { statusCode: 400 }));
    assert.strictEqual(r400.isModelError, true);
    assert.strictEqual(r400.isContextBudget, false);

    const rNet = classifyProviderFailure(new Error('network timeout'));
    assert.strictEqual(rNet.isTransient, true);
    assert.strictEqual(rNet.isContextBudget, false);

    const rBoring = classifyProviderFailure(new Error('weird failure'));
    assert.strictEqual(rBoring.isTransient, false);
    assert.strictEqual(rBoring.isContextBudget, false);
  });

  await check('normalizeProviderError stamps budget provider codes', () => {
    const e1 = normalizeProviderError(groq413(), 'groq');
    assert.strictEqual(e1.statusCode, 413);
    const e2 = normalizeProviderError(new Error('context_length_exceeded'));
    assert.strictEqual(e2.providerCode, 'context_length_exceeded');
  });

  await check('router does NOT fail over a context-budget failure (identical payload)', async () => {
    const registryPath = require.resolve('../lib/llm/providers');
    const realRegistry = require(registryPath);
    const savedKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'test-key'; // force groq primary (choosePrimaryProvider reads env)
    const seen = [];
    const throwing = (id) => ({
      id,
      priority: 1,
      defaultModel: `${id}-model`,
      isAvailable: () => true,
      resolveModel: () => `${id}-model`,
      generate: async () => {
        seen.push(id);
        throw groq413();
      }
    });
    require.cache[registryPath] = {
      id: registryPath, filename: registryPath, loaded: true,
      exports: { getAvailableProviders: () => [throwing('groq'), throwing('mistral')] }
    };
    delete require.cache[require.resolve('../lib/llm/LLMRouter')];
    const LLMRouter = require('../lib/llm/LLMRouter');
    const router = new LLMRouter();
    const request = {
      messages: [{ role: 'user', content: 'Explain encapsulation' }],
      systemPrompt: 'sys',
      tools: [],
      stream: false
    };
    let thrown = null;
    try {
      await router.generate(request);
    } catch (e) {
      thrown = e;
    } finally {
      delete require.cache[require.resolve('../lib/llm/LLMRouter')];
      require.cache[registryPath] = { id: registryPath, filename: registryPath, loaded: true, exports: realRegistry };
      if (savedKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = savedKey;
    }
    assert.ok(thrown, 'error propagates');
    assert.strictEqual(thrown.statusCode, 413, 'original error preserved, not wrapped');
    assert.deepStrictEqual(seen, ['groq'], 'fallback provider never attempted');
  });

  await check('router still fails over transient 429 (happy-path fallback intact)', async () => {
    const registryPath = require.resolve('../lib/llm/providers');
    const realRegistry = require(registryPath);
    const savedKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'test-key';
    const seen = [];
    const providers = {
      groq: {
        id: 'groq', priority: 1, defaultModel: 'g', isAvailable: () => true,
        resolveModel: () => 'g',
        generate: async () => {
          seen.push('groq');
          throw Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 });
        }
      },
      mistral: {
        id: 'mistral', priority: 1, defaultModel: 'm', isAvailable: () => true,
        resolveModel: () => 'm',
        generate: async () => {
          seen.push('mistral');
          return { text: 'ok', toolCalls: [], tokens: { input: 1, output: 1 } };
        }
      }
    };
    require.cache[registryPath] = {
      id: registryPath, filename: registryPath, loaded: true,
      exports: { getAvailableProviders: () => [providers.groq, providers.mistral] }
    };
    delete require.cache[require.resolve('../lib/llm/LLMRouter')];
    const LLMRouter = require('../lib/llm/LLMRouter');
    let result = null;
    try {
      result = await new LLMRouter().generate({ messages: [{ role: 'user', content: 'hi' }], stream: false });
    } finally {
      delete require.cache[require.resolve('../lib/llm/LLMRouter')];
      require.cache[registryPath] = { id: registryPath, filename: registryPath, loaded: true, exports: realRegistry };
      if (savedKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = savedKey;
    }
    assert.strictEqual(result.text, 'ok');
    assert.deepStrictEqual(seen, ['groq', 'mistral'], 'transient still fails over');
  });
}

run().then(() => {
  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  process.exit(process.exitCode || 0);
}).catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
