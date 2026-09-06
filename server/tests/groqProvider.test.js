/* Groq Provider Unit Tests — run with: node tests/groqProvider.test.js
 *
 * These tests do NOT require a GROQ_API_KEY and validate the provider's
 * contract in isolation (abstraction, message building, tool sanitization,
 * model resolution, router integration).
 */

const assert = require('assert');

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (err) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('Groq Provider Unit Tests');
console.log('========================');

require('dotenv').config();

const GroqProvider = require('../lib/llm/providers/GroqProvider');
const { normalizeGroqToolCalls, toWellFormedUnicode } = require('../lib/llm/utils');
const LLMRouter = require('../lib/llm/LLMRouter');

console.log('\n1. Provider Contract');
check('exposes required id', () => {
  assert.strictEqual(GroqProvider.id, 'groq');
});
check('exposes name', () => {
  assert.strictEqual(typeof GroqProvider.name, 'string');
  assert.ok(GroqProvider.name.length > 0);
});
check('exposes numeric priority', () => {
  assert.strictEqual(typeof GroqProvider.priority, 'number');
  assert.ok(GroqProvider.priority > 0);
});
check('exposes aliases array', () => {
  assert.ok(Array.isArray(GroqProvider.aliases));
  assert.ok(GroqProvider.aliases.length > 0);
});
check('exposes defaultModel openai/gpt-oss-120b', () => {
  assert.strictEqual(typeof GroqProvider.defaultModel, 'string');
  assert.strictEqual(GroqProvider.defaultModel, 'openai/gpt-oss-120b');
});
check('exposes capabilities', () => {
  assert.ok(typeof GroqProvider.capabilities === 'object');
  assert.strictEqual(GroqProvider.capabilities.tools, true);
  assert.strictEqual(GroqProvider.capabilities.streaming, true);
  assert.strictEqual(GroqProvider.capabilities.multimodal, false);
});
check('has isAvailable()', () => {
  assert.strictEqual(typeof GroqProvider.isAvailable, 'function');
});
check('has resolveModel()', () => {
  assert.strictEqual(typeof GroqProvider.resolveModel, 'function');
});
check('has canHandleRequest()', () => {
  assert.strictEqual(typeof GroqProvider.canHandleRequest, 'function');
});
check('has generate()', () => {
  assert.strictEqual(typeof GroqProvider.generate, 'function');
});

console.log('\n2. Availability');
check('isAvailable returns boolean', () => {
  assert.strictEqual(typeof GroqProvider.isAvailable(), 'boolean');
});
check('isAvailable false without key', () => {
  const prev = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  assert.strictEqual(GroqProvider.isAvailable(), false);
  if (prev !== undefined) process.env.GROQ_API_KEY = prev;
});

console.log('\n3. canHandleRequest');
check('handles text requests', () => {
  assert.strictEqual(GroqProvider.canHandleRequest({
    messages: [{ role: 'user', content: 'hello' }],
    attachments: []
  }), true);
});
check('rejects image attachments', () => {
  assert.strictEqual(GroqProvider.canHandleRequest({
    messages: [{ role: 'user', content: 'hello' }],
    attachments: [{ type: 'image', data: 'abc' }]
  }), false);
});
check('handles tool requests', () => {
  assert.strictEqual(GroqProvider.canHandleRequest({
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'function' }]
  }), true);
});
check('handles empty request', () => {
  assert.strictEqual(GroqProvider.canHandleRequest({}), true);
});

console.log('\n4. resolveModel');
check('returns default model', () => {
  const prev = process.env.GROQ_MODEL;
  delete process.env.GROQ_MODEL;
  const fresh = new (Object.getPrototypeOf(GroqProvider).constructor)();
  assert.strictEqual(fresh.resolveModel({
    messages: [{ role: 'user', content: 'hi' }],
    attachments: []
  }), 'openai/gpt-oss-120b');
  if (prev !== undefined) process.env.GROQ_MODEL = prev;
});
check('honours GROQ_MODEL override', () => {
  const prev = process.env.GROQ_MODEL;
  process.env.GROQ_MODEL = 'openai/gpt-oss-20b';
  const fresh = new (Object.getPrototypeOf(GroqProvider).constructor)();
  assert.strictEqual(fresh.resolveModel({}), 'openai/gpt-oss-20b');
  if (prev !== undefined) process.env.GROQ_MODEL = prev;
  else delete process.env.GROQ_MODEL;
});

console.log('\n5. Message building');
check('builds system message with Unicode sanitization', () => {
  const messages = GroqProvider.buildMessages({
    systemPrompt: 'System \uD800prompt',
    messages: []
  });
  assert.strictEqual(messages[0].role, 'system');
  assert.strictEqual(messages[0].content.includes('\uFFFD'), true);
});
check('builds user message', () => {
  const messages = GroqProvider.buildMessages({
    messages: [{ role: 'user', content: 'Hello world' }]
  });
  assert.strictEqual(messages[0].role, 'user');
  assert.strictEqual(messages[0].content, 'Hello world');
});
check('builds assistant message', () => {
  const messages = GroqProvider.buildMessages({
    messages: [{ role: 'assistant', content: 'Hi there' }]
  });
  assert.strictEqual(messages[0].role, 'assistant');
  assert.strictEqual(messages[0].content, 'Hi there');
});
check('builds tool message with tool_call_id', () => {
  const messages = GroqProvider.buildMessages({
    messages: [{
      role: 'tool',
      toolCallId: 'call_123',
      content: '{ "result": "ok" }'
    }]
  });
  assert.strictEqual(messages[0].role, 'tool');
  assert.strictEqual(messages[0].tool_call_id, 'call_123');
});
check('builds assistant tool_calls message', () => {
  const messages = GroqProvider.buildMessages({
    messages: [{
      role: 'assistant',
      content: '',
      toolCalls: [{
        id: 'call_1',
        function: { name: 'getTime', arguments: {} }
      }]
    }]
  });
  assert.strictEqual(messages[0].role, 'assistant');
  assert.ok(Array.isArray(messages[0].tool_calls));
  assert.strictEqual(messages[0].tool_calls[0].id, 'call_1');
  assert.strictEqual(messages[0].tool_calls[0].function.name, 'getTime');
  assert.strictEqual(typeof messages[0].tool_calls[0].function.arguments, 'string');
});
check('sanitizes all message content with Unicode', () => {
  const messages = GroqProvider.buildMessages({
    systemPrompt: 'System',
    messages: [
      { role: 'user', content: 'User \uD800text' },
      { role: 'assistant', content: 'Assist \uD800answer' }
    ]
  });
  assert.ok(messages[1].content.includes('\uFFFD'));
  assert.ok(messages[2].content.includes('\uFFFD'));
});

console.log('\n6. Tool schema sanitization');
const sampleTools = [{
  type: 'function',
  function: {
    name: 'testTool',
    description: 'A test tool',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name field' },
        count: { type: 'number', minimum: 0, maximum: 10 },
        nested: {
          type: 'object',
          properties: {
            inner: { type: 'string', enum: ['a', 'b'] }
          },
          required: ['inner']
        },
        list: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['fast', 'slow'] }
      },
      required: ['name']
    }
  }
}];

check('normalizes tool names', () => {
  const tools = GroqProvider.buildTools({ tools: sampleTools });
  assert.ok(Array.isArray(tools));
  assert.strictEqual(tools[0].function.name, 'testTool');
});
check('preserves tool descriptions', () => {
  const tools = GroqProvider.buildTools({ tools: sampleTools });
  assert.strictEqual(tools[0].function.description, 'A test tool');
});
check('preserves parameters schema', () => {
  const tools = GroqProvider.buildTools({ tools: sampleTools });
  assert.strictEqual(tools[0].function.parameters.type, 'object');
  assert.ok(tools[0].function.parameters.properties.name);
});
check('preserves required fields', () => {
  const tools = GroqProvider.buildTools({ tools: sampleTools });
  assert.deepStrictEqual(tools[0].function.parameters.required, ['name']);
});
check('preserves nested structures', () => {
  const tools = GroqProvider.buildTools({ tools: sampleTools });
  const nested = tools[0].function.parameters.properties.nested;
  assert.ok(nested.properties.inner);
  assert.deepStrictEqual(nested.required, ['inner']);
});
check('preserves array items', () => {
  const tools = GroqProvider.buildTools({ tools: sampleTools });
  const arr = tools[0].function.parameters.properties.list;
  assert.strictEqual(arr.items.type, 'string');
});
check('filters invalid tool names', () => {
  const badTools = GroqProvider.buildTools({ tools: [{ type: 'function', function: { name: 'bad name!@#', description: 'x' } }] });
  assert.strictEqual(badTools, undefined);
});
check('normalizes schema.function format', () => {
  const tools = GroqProvider.buildTools({ tools: [{
    schema: {
      function: {
        name: 'altTool',
        description: 'Alt',
        parameters: { type: 'object', properties: {} }
      }
    }
  }] });
  assert.strictEqual(tools[0].function.name, 'altTool');
});
check('returns undefined for empty tools', () => {
  assert.strictEqual(GroqProvider.buildTools({}), undefined);
  assert.strictEqual(GroqProvider.buildTools({ tools: [] }), undefined);
  assert.strictEqual(GroqProvider.buildTools({ tools: null }), undefined);
});

console.log('\n7. Tool call normalization');
check('normalizes OpenAI-style tool calls with string args', () => {
  const calls = normalizeGroqToolCalls({
    tool_calls: [{
      id: 'call_1',
      type: 'function',
      function: { name: 'getTime', arguments: '{"tz":"UTC"}' }
    }]
  });
  assert.strictEqual(calls[0].id, 'call_1');
  assert.strictEqual(calls[0].function.name, 'getTime');
  assert.deepStrictEqual(calls[0].function.arguments, { tz: 'UTC' });
});
check('normalizes tool calls with object args', () => {
  const calls = normalizeGroqToolCalls({
    tool_calls: [{
      id: 'call_2',
      function: { name: 'getWeather', arguments: { city: 'SF' } }
    }]
  });
  assert.deepStrictEqual(calls[0].function.arguments, { city: 'SF' });
});
check('normalizes tool calls with invalid JSON args', () => {
  const calls = normalizeGroqToolCalls({
    tool_calls: [{
      id: 'call_3',
      function: { name: 'bad', arguments: '{invalid json' }
    }]
  });
  assert.deepStrictEqual(calls[0].function.arguments, {});
});
check('falls back to groq-tool-call-N id', () => {
  const calls = normalizeGroqToolCalls({
    tool_calls: [{
      function: { name: 'test', arguments: '{}' }
    }]
  });
  assert.strictEqual(calls[0].id, 'groq-tool-call-0');
});

console.log('\n8. Unicode utility');
check('toWellFormedUnicode handles lone surrogates', () => {
  assert.strictEqual(toWellFormedUnicode('a\uD800b'), 'a\uFFFDb');
});
check('toWellFormedUnicode handles valid pairs', () => {
  const valid = 'emoji: \u{1F600} done';
  assert.strictEqual(toWellFormedUnicode(valid), valid);
});

console.log('\n9. Router integration');
check('router loads groq provider', () => {
  const providerRegistry = require('../lib/llm/providers');
  const groq = providerRegistry.getProvider('groq');
  assert.ok(groq);
  assert.strictEqual(groq.id, 'groq');
});
check('router detects groq priority', () => {
  const providerRegistry = require('../lib/llm/providers');
  const groq = providerRegistry.getProvider('groq');
  assert.ok(groq.priority === 90);
});
check('router has no zai provider', () => {
  const providerRegistry = require('../lib/llm/providers');
  assert.strictEqual(providerRegistry.getProvider('zai'), undefined);
});
check('routing with GROQ key routes to groq for reasoning', () => {
  const prev = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-key';
  const router = new LLMRouter();
  const { providerId } = router.choosePrimaryProvider({
    messages: [{ role: 'user', content: 'debug this architecture and analyze this security vulnerability' }],
    tools: [],
    attachments: []
  });
  assert.strictEqual(providerId, 'groq');
  if (prev !== undefined) process.env.GROQ_API_KEY = prev;
  else delete process.env.GROQ_API_KEY;
});
check('routing with GROQ key routes to gemini for multimodal', () => {
  const prev = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-key';
  const router = new LLMRouter();
  const { providerId } = router.choosePrimaryProvider({
    messages: [{ role: 'user', content: 'analyze this image' }],
    tools: [],
    attachments: [{ type: 'image' }]
  });
  assert.strictEqual(providerId, 'gemini');
  if (prev !== undefined) process.env.GROQ_API_KEY = prev;
  else delete process.env.GROQ_API_KEY;
});
check('routing with LLM_PRIMARY_PROVIDER=groq uses groq', () => {
  const prevPrimary = process.env.LLM_PRIMARY_PROVIDER;
  const prevKey = process.env.GROQ_API_KEY;
  process.env.LLM_PRIMARY_PROVIDER = 'groq';
  process.env.GROQ_API_KEY = 'test-key';
  const router = new LLMRouter();
  const { providerId } = router.choosePrimaryProvider({
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    attachments: []
  });
  assert.strictEqual(providerId, 'groq');
  if (prevPrimary !== undefined) process.env.LLM_PRIMARY_PROVIDER = prevPrimary;
  else delete process.env.LLM_PRIMARY_PROVIDER;
  if (prevKey !== undefined) process.env.GROQ_API_KEY = prevKey;
  else delete process.env.GROQ_API_KEY;
});
check('routing without GROQ falls back to existing providers', () => {
  const prev = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  const router = new LLMRouter();
  const { providerId } = router.choosePrimaryProvider({
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    attachments: []
  });
  assert.strictEqual(providerId, 'mistral');
  if (prev !== undefined) process.env.GROQ_API_KEY = prev;
});

console.log('\n10. Fallback behavior');
check('provider order with GROQ key: groq first', () => {
  const prev = process.env.GROQ_API_KEY;
  const prevGemini = process.env.GEMINI_API_KEY;
  process.env.GROQ_API_KEY = 'test-key';
  if (prevGemini === undefined) process.env.GEMINI_API_KEY = 'test-gemini-key';
  const router = new LLMRouter();
  const order = router.buildProviderOrder(
    { messages: [{ role: 'user', content: 'hi' }], tools: [], attachments: [] },
    'groq'
  );
  assert.strictEqual(order[0].id, 'groq');
  if (prev !== undefined) process.env.GROQ_API_KEY = prev;
  else delete process.env.GROQ_API_KEY;
  if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
});

console.log('\nAll Groq provider unit tests completed.\n');
