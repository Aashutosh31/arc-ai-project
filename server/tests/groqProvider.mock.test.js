/* Groq Provider Mock Lifecycle Tests — run with: node tests/groqProvider.mock.test.js
 *
 * These tests mock the Groq OpenAI-compatible client so the full lifecycle
 * (generate → tool call → tool result → follow-up) can be verified without
 * a live API key. They validate the provider's request/response contract.
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

async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
  } catch (err) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
}

require('dotenv').config();

// Set a mock key so isAvailable() returns true
const oldKey = process.env.GROQ_API_KEY;
process.env.GROQ_API_KEY = 'mock-test-key';

const GroqProvider = require('../lib/llm/providers/GroqProvider');

console.log('Groq Provider Mock Lifecycle Tests');
console.log('==================================');

// Replace getClient with a mock OpenAI client
const createMockClient = ({ onRequest }) => {
  return {
    chat: {
      completions: {
        create: async (params, options) => {
          return onRequest(params, options);
        }
      }
    }
  };
};

console.log('\n1. Non-streaming text generation');
checkAsync('returns correct shape', async () => {
  GroqProvider.getClient = () => createMockClient({
    onRequest: async (params, options) => {
      assert.strictEqual(params.model, 'openai/gpt-oss-120b');
      assert.strictEqual(params.stream, false);
      assert.strictEqual(params.messages[0].role, 'user');
      assert.strictEqual(params.messages[0].content, 'Hello');
      return {
        id: 'chatcmpl-mock-1',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hi there!' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
      };
    }
  });

  const result = await GroqProvider.generate({
    messages: [{ role: 'user', content: 'Hello' }],
    stream: false
  });

  assert.strictEqual(result.provider, 'groq');
  assert.strictEqual(result.model, 'openai/gpt-oss-120b');
  assert.strictEqual(result.text, 'Hi there!');
  assert.ok(result.latencyMs >= 0);
  assert.deepStrictEqual(result.usage, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
});

checkAsync('passes signal as request option not body', async () => {
  const controller = new AbortController();
  let capturedParams = null;
  let capturedOptions = null;
  GroqProvider.getClient = () => createMockClient({
    onRequest: async (params, options) => {
      capturedParams = params;
      capturedOptions = options;
      return { choices: [{ message: { content: 'ok' } }], usage: null };
    }
  });

  await GroqProvider.generate({
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    signal: controller.signal
  });

  assert.ok(!('signal' in capturedParams), 'signal must not be in the JSON body');
  assert.ok(capturedOptions.signal instanceof AbortSignal);
});

console.log('\n2. Streaming generation');
checkAsync('streams chunks', async () => {
  async function* mockStream() {
    yield {
      id: 'chatcmpl-mock-2',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }]
    };
    yield {
      id: 'chatcmpl-mock-2',
      choices: [{ index: 0, delta: { content: ' world' } }]
    };
    yield {
      id: 'chatcmpl-mock-2',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    };
  }

  GroqProvider.getClient = () => createMockClient({
    onRequest: async (params, options) => {
      assert.strictEqual(params.stream, true);
      return mockStream();
    }
  });

  const result = await GroqProvider.generate({
    messages: [{ role: 'user', content: 'hi' }],
    stream: true
  });

  const chunks = [];
  for await (const chunk of result.stream) {
    chunks.push(chunk);
  }

  assert.strictEqual(chunks[0].text, 'Hello');
  assert.strictEqual(chunks[1].text, ' world');
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0].provider, 'groq');
});

checkAsync('streams tool call deltas', async () => {
  async function* mockStream() {
    yield {
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'getTime', arguments: '' } }] } }]
    };
    yield {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"tz":' } }] } }]
    };
    yield {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"UTC"}' } }] } }]
    };
    yield {
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
    };
  }

  GroqProvider.getClient = () => createMockClient({
    onRequest: async (params, options) => mockStream()
  });

  const result = await GroqProvider.generate({
    messages: [{ role: 'user', content: 'What time is it?' }],
    stream: true
  });

  const chunks = [];
  for await (const chunk of result.stream) {
    chunks.push(chunk);
  }

  const toolCallChunk = chunks.find((c) => c.toolCalls);
  assert.ok(toolCallChunk, 'should yield assembled tool calls in stream');
  assert.strictEqual(toolCallChunk.toolCalls[0].id, 'call_1');
  assert.strictEqual(toolCallChunk.toolCalls[0].function.name, 'getTime');
  assert.deepStrictEqual(toolCallChunk.toolCalls[0].function.arguments, { tz: 'UTC' });
});

console.log('\n3. Tool calling (non-streaming)');
checkAsync('parses tool calls from response', async () => {
  GroqProvider.getClient = () => createMockClient({
    onRequest: async (params) => {
      assert.ok(Array.isArray(params.tools));
      assert.strictEqual(params.tools[0].type, 'function');
      assert.strictEqual(params.tools[0].function.name, 'getTime');
      assert.strictEqual(params.tool_choice, 'auto');
      return {
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_mock_1',
              type: 'function',
              function: { name: 'getTime', arguments: '{"tz":"UTC"}' }
            }]
          },
          finish_reason: 'tool_calls'
        }],
        usage: null
      };
    }
  });

  const result = await GroqProvider.generate({
    messages: [{ role: 'user', content: 'What time is it in UTC?' }],
    tools: [{
      type: 'function',
      function: {
        name: 'getTime',
        description: 'Get current time',
        parameters: { type: 'object', properties: { tz: { type: 'string' } } }
      }
    }],
    stream: false
  });

  assert.ok(Array.isArray(result.toolCalls));
  assert.strictEqual(result.toolCalls[0].id, 'call_mock_1');
  assert.strictEqual(result.toolCalls[0].function.name, 'getTime');
  assert.deepStrictEqual(result.toolCalls[0].function.arguments, { tz: 'UTC' });
});

console.log('\n4. Tool result follow-up');
checkAsync('sends tool results with tool_call_id', async () => {
  let capturedParams = null;
  GroqProvider.getClient = () => createMockClient({
    onRequest: async (params) => {
      capturedParams = params;
      return {
        choices: [{ index: 0, message: { role: 'assistant', content: 'The time is 14:30 UTC.' }, finish_reason: 'stop' }],
        usage: null
      };
    }
  });

  const result = await GroqProvider.generate({
    messages: [
      { role: 'user', content: 'What time is it in UTC?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_mock_2', function: { name: 'getTime', arguments: { tz: 'UTC' } } }]
      },
      { role: 'tool', toolCallId: 'call_mock_2', content: '{"time":"14:30:00"}' }
    ],
    tools: [{ type: 'function', function: { name: 'getTime', parameters: { type: 'object', properties: {} } } }],
    stream: false
  });

  assert.ok(capturedParams.messages.some((m) => m.role === 'tool'));
  const toolMsg = capturedParams.messages.find((m) => m.role === 'tool');
  assert.strictEqual(toolMsg.tool_call_id, 'call_mock_2');
  assert.strictEqual(toolMsg.content, '{"time":"14:30:00"}');

  const assistantMsg = capturedParams.messages.find((m) => m.role === 'assistant');
  assert.strictEqual(assistantMsg.tool_calls[0].id, 'call_mock_2');
  assert.strictEqual(assistantMsg.tool_calls[0].function.name, 'getTime');
  assert.strictEqual(typeof assistantMsg.tool_calls[0].function.arguments, 'string');
  assert.strictEqual(result.text, 'The time is 14:30 UTC.');
});

console.log('\n5. Request payload validation');
checkAsync('sends well-formed OpenAI chat payload', async () => {
  let capturedParams = null;
  GroqProvider.getClient = () => createMockClient({
    onRequest: async (params) => {
      capturedParams = params;
      return { choices: [{ message: { content: 'ok' } }], usage: null };
    }
  });

  await GroqProvider.generate({
    systemPrompt: 'You are a terse assistant.',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    temperature: 0.3,
    maxTokens: 100
  });

  assert.ok(capturedParams.model);
  assert.ok(Array.isArray(capturedParams.messages));
  assert.strictEqual(capturedParams.messages[0].role, 'system');
  assert.strictEqual(capturedParams.messages[1].role, 'user');
  assert.strictEqual(capturedParams.temperature, 0.3);
  assert.strictEqual(capturedParams.max_tokens, 100);
  assert.strictEqual(capturedParams.stream, false);
});

checkAsync('clamps temperature to [0,2]', async () => {
  let captured = null;
  GroqProvider.getClient = () => createMockClient({
    onRequest: async (params) => { captured = params; return { choices: [{ message: { content: 'ok' } }], usage: null }; }
  });
  await GroqProvider.generate({ messages: [{ role: 'user', content: 'x' }], temperature: 5 });
  assert.strictEqual(captured.temperature, 2);

  await GroqProvider.generate({ messages: [{ role: 'user', content: 'x' }], temperature: -5 });
  assert.strictEqual(captured.temperature, 0);
});

console.log('\n6. Error handling');
checkAsync('throws when multimodal and unsupported', async () => {
  await assert.rejects(
    GroqProvider.generate({
      messages: [{ role: 'user', content: 'look' }],
      attachments: [{ type: 'image', data: 'abc' }],
      stream: false
    }),
    (err) => {
      assert.strictEqual(err.statusCode, 400);
      return true;
    }
  );
});

// Restore original key
if (oldKey !== undefined) {
  process.env.GROQ_API_KEY = oldKey;
} else {
  delete process.env.GROQ_API_KEY;
}

console.log('\nAll Groq mock lifecycle tests completed.\n');
