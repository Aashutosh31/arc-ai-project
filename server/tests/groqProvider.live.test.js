/* Groq Provider Integration Tests (LIVE) — run with: node tests/groqProvider.live.test.js
 *
 * These tests require GROQ_API_KEY to be set in the environment.
 * Each test calls the Groq API directly via the provider.
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
  const startedAt = Date.now();
  try {
    await fn();
    console.log(`  PASS  ${label} (${Date.now() - startedAt}ms)`);
  } catch (err) {
    console.error(`  FAIL  ${label} (${Date.now() - startedAt}ms)`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
}

require('dotenv').config();

if (!process.env.GROQ_API_KEY) {
  console.log('GROQ_API_KEY is not set. Skipping live integration tests.');
  console.log('Add GROQ_API_KEY to server/.env and re-run.');
  process.exit(0);
}

const GroqProvider = require('../lib/llm/providers/GroqProvider');
const LLMRouter = require('../lib/llm/LLMRouter');
const toolRegistry = require('../tools');

console.log('Groq Provider Live Integration Tests');
console.log('====================================');
console.log('Groq API key configured: YES');

console.log('\n1. Availability Check');
check('Groq is available', () => {
  assert.strictEqual(GroqProvider.isAvailable(), true);
});

console.log('\n2. Plain Text Generation');
checkAsync('generates text response', async () => {
  const result = await GroqProvider.generate({
    messages: [{ role: 'user', content: 'Say hello in exactly 5 words.' }],
    stream: false,
    temperature: 0.3
  });
  assert.ok(result.text && result.text.length > 0, 'text should not be empty');
  assert.strictEqual(result.provider, 'groq');
  assert.ok(result.model);
  assert.ok(result.latencyMs >= 0);
});

console.log('\n3. Streaming Generation');
checkAsync('streams text tokens', async () => {
  const result = await GroqProvider.generate({
    messages: [{ role: 'user', content: 'Count from 1 to 10, one per line.' }],
    stream: true,
    temperature: 0.3
  });
  assert.ok(result.stream, 'stream should be an async generator');
  let chunks = 0;
  let fullText = '';
  for await (const chunk of result.stream) {
    chunks++;
    fullText += chunk.text || '';
  }
  assert.ok(chunks > 0, 'should receive at least 1 stream chunk');
  assert.ok(fullText.length > 0, 'streamed text should not be empty');
});

console.log('\n4. System Prompts + Assistant Messages');
checkAsync('respects system prompt and conversation history', async () => {
  const result = await GroqProvider.generate({
    systemPrompt: 'You are a terse AI. Respond in one word only.',
    messages: [
      { role: 'user', content: 'What is the capital of France?' },
      { role: 'assistant', content: 'Paris.' },
      { role: 'user', content: 'What is the capital of Japan?' }
    ],
    stream: false,
    temperature: 0.1
  });
  assert.ok(result.text && result.text.length > 0);
  assert.ok(result.text.toLowerCase().includes('tokyo'), `expected Tokyo in response: "${result.text}"`);
});

console.log('\n5. Single Tool Call');
const weatherTool = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get weather for a location',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name' }
      },
      required: ['location']
    }
  }
}];

checkAsync('requests tool call for weather', async () => {
  const result = await GroqProvider.generate({
    messages: [{ role: 'user', content: 'What is the weather in San Francisco?' }],
    tools: weatherTool,
    stream: false,
    temperature: 0.1
  });
  assert.ok(Array.isArray(result.toolCalls) && result.toolCalls.length > 0,
    'should have at least one tool call');
  const call = result.toolCalls[0];
  assert.strictEqual(call.function.name, 'get_weather');
  assert.ok(call.function.arguments.location);
  assert.ok(call.id, 'tool call should have an id');
});

console.log('\n6. All 22 Tools Request');
checkAsync('sends all 22 tools', async () => {
  const schemas = toolRegistry.getSchemas();
  assert.strictEqual(schemas.length, 22);
  const result = await GroqProvider.generate({
    messages: [{ role: 'user', content: 'What time is it right now? Use a tool to find out.' }],
    tools: schemas,
    stream: false,
    temperature: 0.1
  });
  // Should either select getTime tool or respond directly
  const hasToolCall = Array.isArray(result.toolCalls) && result.toolCalls.length > 0;
  assert.ok(hasToolCall || (result.text && result.text.length > 0),
    'should either call a tool or respond with text');
});

console.log('\n7. Tool Call → Tool Result → Follow-up');
checkAsync('completes tool call lifecycle', async () => {
  // First call: model requests getTime
  const first = await GroqProvider.generate({
    messages: [{ role: 'user', content: 'What time is it? Use the get_time tool.' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_time',
        description: 'Get current time',
        parameters: { type: 'object', properties: { tz: { type: 'string' } } }
      }
    }],
    stream: false,
    temperature: 0.1
  });
  assert.ok(Array.isArray(first.toolCalls) && first.toolCalls.length > 0,
    'first call should request get_time');
  const toolCall = first.toolCalls[0];
  assert.strictEqual(toolCall.function.name, 'get_time');

  // Second call: provide tool result and get final answer
  const messages = [
    { role: 'user', content: 'What time is it? Use the get_time tool.' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [toolCall]
    },
    {
      role: 'tool',
      toolCallId: toolCall.id,
      content: JSON.stringify({ time: '14:30:00', timezone: 'UTC' })
    }
  ];

  const second = await GroqProvider.generate({
    messages,
    tools: [{
      type: 'function',
      function: {
        name: 'get_time',
        description: 'Get current time',
        parameters: { type: 'object', properties: { tz: { type: 'string' } } }
      }
    }],
    stream: false,
    temperature: 0.1
  });
  assert.ok(second.text && second.text.length > 0,
    'follow-up should produce a text response');
  assert.ok(second.text.toLowerCase().includes('14:30') || second.text.includes('2:30'),
    `follow-up should reference tool result, got: "${second.text}"`);
});

console.log('\n8. Unicode Surrogate Test');
checkAsync('handles Unicode surrogate chars', async () => {
  const result = await GroqProvider.generate({
    messages: [{ role: 'user', content: 'Test unicode \uD800emoji handling' }],
    stream: false,
    temperature: 0.1
  });
  assert.ok(result.text, 'should handle request with surrogates');
});

console.log('\n9. Abort/Cancellation');
checkAsync('aborts in-flight request', async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  setTimeout(() => controller.abort(), 100);

  await assert.rejects(
    GroqProvider.generate({
      messages: [{ role: 'user', content: 'Write a very long essay about AI, at least 5000 words.' }],
      stream: false,
      signal,
      temperature: 0.8
    }),
    (err) => {
      console.log(`    Abort error: ${err.name || err.message || err}`);
      return true;
    }
  );
});

console.log('\n10. Router Fallback to Gemini');
check('router routes to Groq when configured', async () => {
  const router = new LLMRouter();
  const providerId = router.choosePrimaryProvider({
    messages: [{ role: 'user', content: 'debug this architecture' }],
    tools: [],
    attachments: []
  }).providerId;
  assert.strictEqual(providerId, 'groq');
});

console.log('\n11. Usage / Latency Metadata');
checkAsync('returns latency and usage metadata', async () => {
  const result = await GroqProvider.generate({
    messages: [{ role: 'user', content: 'Say something short.' }],
    stream: false,
    temperature: 0.1
  });
  assert.strictEqual(typeof result.latencyMs, 'number');
  assert.ok(result.latencyMs >= 0);
  assert.ok(result.usage, 'usage metadata should exist');
});

console.log('\n12. Model Resolution');
check('default model is openai/gpt-oss-120b', () => {
  assert.strictEqual(GroqProvider.defaultModel, 'openai/gpt-oss-120b');
});

console.log('\nAll Groq live integration tests completed.\n');
