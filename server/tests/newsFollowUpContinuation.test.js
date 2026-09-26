const assert = require('assert');

const AIService = require('../services/AIService');
const TaskExecutor = require('../services/TaskExecutor');
const GuestSession = require('../models/GuestSession');
const ttsService = require('../services/ttsService');
const newsTool = require('../tools/getTopNews');
const {
  buildProviderContinuationMessages,
} = require('../lib/llm/utils');
const {
  assembleBudgetedRequest,
  OUTPUT_BUDGET_DEFAULT,
} = require('../lib/llm/contextBudget');

let pass = 0;
let fail = 0;

async function check(label, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  PASS  ${label}`);
  } catch (error) {
    fail += 1;
    process.exitCode = 1;
    console.error(`  FAIL  ${label}\n        ${error.message}`);
  }
}

console.log('Current News Follow-up Tests');
console.log('============================');

async function run() {
  await check('initial current-news request selects scoped news state', () => {
    const intent = AIService.resolveNewsIntent(
      'What are the top news headlines right now?',
      null,
    );
    assert.deepStrictEqual(intent.args, {});
    assert.strictEqual(intent.state.tool, 'getTopNews');
    assert.strictEqual(intent.state.operation, 'news');
  });

  await check('region and topic refinements inherit and replace scope', () => {
    const india = AIService.resolveNewsIntent('in India', {
      tool: 'getTopNews',
      operation: 'news',
    });
    assert.deepStrictEqual(india.args, { region: 'India' });

    const us = AIService.resolveNewsIntent('what about the US?', {
      tool: 'getTopNews',
      operation: 'news',
      region: 'India',
      topic: 'technology',
    });
    assert.deepStrictEqual(us.args, {
      region: 'United States',
      topic: 'technology',
    });

    const topic = AIService.resolveNewsIntent('only technology news', {
      tool: 'getTopNews',
      operation: 'news',
      region: 'United States',
    });
    assert.deepStrictEqual(topic.args, {
      region: 'United States',
      topic: 'technology',
    });
  });

  await check('standalone and unrelated follow-ups do not become news refinements', () => {
    assert.strictEqual(AIService.resolveNewsIntent('in India', null), null);
    assert.strictEqual(
      AIService.resolveNewsIntent('What is the weather in India?', {
        tool: 'getTopNews',
        operation: 'news',
      }),
      null,
    );
  });

  await check('news schema exposes bounded optional scope parameters', () => {
    const schema = newsTool.schema.function.parameters;
    assert.deepStrictEqual(schema.required, []);
    assert.strictEqual(schema.properties.region.type, 'string');
    assert.strictEqual(schema.properties.topic.type, 'string');
    assert.strictEqual(schema.properties.limit.minimum, 1);
    assert.strictEqual(schema.properties.limit.maximum, 20);
  });

  await check('GDELT RSS client builds a scoped query and deduplicates articles', async () => {
    const originalFetch = global.fetch;
    let requestUrl = '';
    global.fetch = async (url) => {
      requestUrl = String(url);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => `
          <rss><channel>
            <item><title>First story</title><link>https://example.com/a?utm_source=test</link><pubDate>now</pubDate></item>
            <item><title>First story</title><link>https://example.com/a</link></item>
            <item><title>Second story</title><link>https://example.com/b</link></item>
            <item><title>Third story</title><link>https://example.com/c</link></item>
          </channel></rss>
        `,
      };
    };
    try {
      const result = await newsTool.execute({
        topic: 'technology',
        region: 'United States',
        limit: 2,
      });
      assert.strictEqual(result.success, true);
      assert.match(requestUrl, /api\.gdeltproject\.org/);
      assert.match(requestUrl, /sourcecountry%3AUS/);
      assert.strictEqual(result.articles.length, 2);
      assert.strictEqual(result.articles[0].title, 'First story');
      assert.strictEqual(result.articles[1].title, 'Second story');
    } finally {
      global.fetch = originalFetch;
    }
  });

  await check('news tool fails closed on an unavailable source', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: false,
      status: 503,
      headers: { get: () => null },
      text: async () => 'unavailable',
    });
    try {
      const result = await newsTool.execute({});
      assert.strictEqual(result.success, false);
      assert.match(result.error, /unavailable/i);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await check('continuation messages retain the prior current-turn transaction', () => {
    const messages = [
      { role: 'user', content: 'in India' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'news-1', function: { name: 'getTopNews', arguments: { region: 'India' } } },
        ],
      },
      { role: 'tool', name: 'getTopNews', toolCallId: 'news-1', content: '{"success":true}' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'news-2', function: { name: 'getTopNews', arguments: { region: 'United States' } } },
        ],
      },
      { role: 'tool', name: 'getTopNews', toolCallId: 'news-2', content: '{"success":true}' },
    ];
    const result = buildProviderContinuationMessages({
      messages,
      assistantMessage: messages[3],
      toolResults: [{ toolCallId: 'news-2', name: 'getTopNews', content: '{"success":true}' }],
    });
    const assistantIds = result
      .filter((message) => Array.isArray(message.toolCalls))
      .flatMap((message) => message.toolCalls.map((call) => call.id));
    assert.deepStrictEqual(assistantIds, ['news-1', 'news-2']);
    assert.strictEqual(result[1].toolCalls[0].id, 'news-1');
    assert.strictEqual(result[2].toolCallId, 'news-1');
    assert.strictEqual(result[3].toolCalls[0].id, 'news-2');
    assert.strictEqual(result[4].toolCallId, 'news-2');
    assert.ok(result.some((message) => message.toolCallId === 'news-1'));
    assert.ok(result.some((message) => message.toolCallId === 'news-2'));
  });

  await check('continuation messages drop incomplete prior tool segments', () => {
    const messages = [
      { role: 'user', content: 'in India' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'old-1', function: { name: 'getTopNews', arguments: { region: 'India' } } },
          { id: 'old-2', function: { name: 'getTopNews', arguments: { topic: 'technology' } } },
        ],
      },
      { role: 'tool', name: 'getTopNews', toolCallId: 'old-1', content: '{"success":true}' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'current', function: { name: 'getTopNews', arguments: { region: 'India' } } },
        ],
      },
      { role: 'tool', name: 'getTopNews', toolCallId: 'current', content: '{"success":true}' },
    ];
    const result = buildProviderContinuationMessages({
      messages,
      assistantMessage: messages[3],
      toolResults: [{ toolCallId: 'current', name: 'getTopNews', content: '{"success":true}' }],
    });
    assert.ok(!result.some((message) => message.toolCallId === 'old-1'));
    assert.ok(!result.some((message) => message.toolCallId === 'old-2'));
    assert.ok(result.some((message) => message.toolCallId === 'current'));
  });

  await check('news scope remains in budgeted working state', () => {
    const request = assembleBudgetedRequest({
      systemTemplate: 'SYS.__LONG_TERM_MEMORY_SLOT____RETRIEVAL_CONTEXT_SLOT__',
      baseUserText: 'what about the US?',
      docText: '',
      memoryDocs: [],
      factDocs: [],
      ragItems: [],
      selectedTools: [newsTool.schema],
      outputBudget: OUTPUT_BUDGET_DEFAULT,
      query: 'what about the US?',
      recentTurns: [],
      workingState: {
        activeSearch: {
          tool: 'getTopNews',
          operation: 'news',
          region: 'United States',
          topic: 'technology',
        },
      },
    });
    assert.strictEqual(request.ok, true);
    assert.match(request.systemPrompt, /United States/);
    assert.match(request.systemPrompt, /technology/);
  });

  await check('working-state refresh persists news region and topic', async () => {
    const originalLoad = AIService.loadWorkingState;
    const originalSave = AIService.saveWorkingState;
    let saved = null;
    AIService.loadWorkingState = async () => ({ workingState: {} });
    AIService.saveWorkingState = async (conversationId, userId, state) => {
      saved = state;
    };
    try {
      await AIService.refreshWorkingStateFromResults(
        'conversation-1',
        'user-1',
        [
          {
            name: 'getTopNews',
            content: {
              success: true,
              query: 'current news in United States about technology',
              region: 'United States',
              topic: 'technology',
              articles: [{ title: 'Story', url: 'https://example.com/story' }],
            },
          },
        ],
      );
      assert.strictEqual(saved.activeSearch.tool, 'getTopNews');
      assert.strictEqual(saved.activeSearch.operation, 'news');
      assert.strictEqual(saved.activeSearch.region, 'United States');
      assert.strictEqual(saved.activeSearch.topic, 'technology');
    } finally {
      AIService.loadWorkingState = originalLoad;
      AIService.saveWorkingState = originalSave;
    }
  });

  await check('failed news retrieval does not replace active scope', async () => {
    const originalLoad = AIService.loadWorkingState;
    const originalSave = AIService.saveWorkingState;
    let saved = null;
    AIService.loadWorkingState = async () => ({
      workingState: {
        activeSearch: {
          tool: 'getTopNews',
          operation: 'news',
          region: 'India',
          topic: 'technology',
        },
      },
    });
    AIService.saveWorkingState = async (conversationId, userId, state) => {
      saved = state;
    };
    try {
      await AIService.refreshWorkingStateFromResults(
        'conversation-1',
        'user-1',
        [{ name: 'getTopNews', content: { success: false, error: 'unavailable' } }],
      );
      assert.deepStrictEqual(saved.activeSearch, {
        tool: 'getTopNews',
        operation: 'news',
        region: 'India',
        topic: 'technology',
      });
    } finally {
      AIService.loadWorkingState = originalLoad;
      AIService.saveWorkingState = originalSave;
    }
  });

  await check('request path uses one synthetic news retrieval per turn', async () => {
    const originals = {
      findOne: GuestSession.findOne,
      resolveWorkspace: AIService.workspaceRuntime.resolveWorkspace,
      generate: AIService.llmRouter.generate,
      streamingRuntime: AIService.streamingRuntime,
      executeTool: TaskExecutor.executeTool,
      isServerTtsActive: ttsService.isServerTtsActive,
      getDefaultTtsLanguage: ttsService.getDefaultTtsLanguage,
      loadWorkingState: AIService.loadWorkingState,
      loadRecentTurns: AIService.loadRecentTurns,
      loadPendingToolCall: AIService.loadPendingToolCall,
      clearPendingToolCall: AIService.clearPendingToolCall,
      refreshWorkingStateFromResults: AIService.refreshWorkingStateFromResults,
    };
    let workingState = null;
    const executions = [];
    const generations = [];
    const socket = {
      id: 'news-test-socket',
      isInterrupted: false,
      emit: () => {},
      on: () => {},
      off: () => {},
    };
    GuestSession.findOne = async () => ({
      creditsRemaining: 20,
      save: async () => {},
    });
    AIService.workspaceRuntime.resolveWorkspace = async () => null;
    ttsService.isServerTtsActive = () => false;
    ttsService.getDefaultTtsLanguage = () => 'en-US';
    AIService.loadWorkingState = async () => ({ workingState });
    AIService.loadRecentTurns = async () => [];
    AIService.loadPendingToolCall = async () => null;
    AIService.clearPendingToolCall = async () => {};
    AIService.refreshWorkingStateFromResults = async (conversationId, userId, results) => {
      const args = executions[executions.length - 1]?.args || {};
      workingState = {
        activeSearch: {
          tool: 'getTopNews',
          operation: 'news',
          ...(args.region ? { region: args.region } : {}),
          ...(args.topic ? { topic: args.topic } : {}),
          query: 'current news',
        },
      };
    };
    TaskExecutor.executeTool = async (name, args) => {
      executions.push({ name, args });
      return {
        success: true,
        source: 'test',
        region: args.region || null,
        topic: args.topic || null,
        query: 'test',
        articles: [{ title: 'Test story', url: 'https://example.com/test' }],
      };
    };
    AIService.llmRouter.generate = async (request) => {
      generations.push(request);
      return {
        text: 'Synthesized news.',
        provider: 'test',
        model: 'test',
        tokens: { input: 1, output: 1 },
        stream: null,
      };
    };
    AIService.streamingRuntime = {
      consume: async () => 'Synthesized news.',
      emitText: async () => {},
    };
    try {
      const first = await AIService.processQuery(
        'guest_news_test',
        'What are the top news headlines right now?',
        socket,
      );
      const second = await AIService.processQuery(
        'guest_news_test',
        'in India',
        socket,
      );
      const third = await AIService.processQuery(
        'guest_news_test',
        'what about the US?',
        socket,
      );
      const fourth = await AIService.processQuery(
        'guest_news_test',
        'only technology news',
        socket,
      );
      assert.strictEqual(typeof first, 'string');
      assert.strictEqual(typeof second, 'string');
      assert.strictEqual(typeof third, 'string');
      assert.strictEqual(typeof fourth, 'string');
      assert.strictEqual(executions.length, 4);
      assert.deepStrictEqual(executions.map((entry) => entry.name), [
        'getTopNews',
        'getTopNews',
        'getTopNews',
        'getTopNews',
      ]);
      assert.strictEqual(executions[1].args.region, 'India');
      assert.strictEqual(executions[2].args.region, 'United States');
      assert.deepStrictEqual(executions[3].args, {
        region: 'United States',
        topic: 'technology',
      });
      assert.strictEqual(generations.length, 4);
      assert.ok(generations.every((request) => Array.isArray(request.tools) && request.tools.length === 0));
      assert.ok(generations.every((request) => !request.messages.some(
        (message) => Array.isArray(message.toolCalls) && message.toolCalls.length > 0,
      )));
    } finally {
      GuestSession.findOne = originals.findOne;
      AIService.workspaceRuntime.resolveWorkspace = originals.resolveWorkspace;
      AIService.llmRouter.generate = originals.generate;
      AIService.streamingRuntime = originals.streamingRuntime;
      TaskExecutor.executeTool = originals.executeTool;
      ttsService.isServerTtsActive = originals.isServerTtsActive;
      ttsService.getDefaultTtsLanguage = originals.getDefaultTtsLanguage;
      AIService.loadWorkingState = originals.loadWorkingState;
      AIService.loadRecentTurns = originals.loadRecentTurns;
      AIService.loadPendingToolCall = originals.loadPendingToolCall;
      AIService.clearPendingToolCall = originals.clearPendingToolCall;
      AIService.refreshWorkingStateFromResults = originals.refreshWorkingStateFromResults;
    }
  });

  await check('exhausted news recovery never sends an unsafe continuation', async () => {
    const originals = {
      findOne: GuestSession.findOne,
      resolveWorkspace: AIService.workspaceRuntime.resolveWorkspace,
      generate: AIService.llmRouter.generate,
      streamingRuntime: AIService.streamingRuntime,
      executeTool: TaskExecutor.executeTool,
      isServerTtsActive: ttsService.isServerTtsActive,
      getDefaultTtsLanguage: ttsService.getDefaultTtsLanguage,
      loadWorkingState: AIService.loadWorkingState,
      loadRecentTurns: AIService.loadRecentTurns,
      loadPendingToolCall: AIService.loadPendingToolCall,
      clearPendingToolCall: AIService.clearPendingToolCall,
      refreshWorkingStateFromResults: AIService.refreshWorkingStateFromResults,
    };
    const executions = [];
    const generations = [];
    const socket = {
      id: 'news-failure-socket',
      isInterrupted: false,
      emit: () => {},
      on: () => {},
      off: () => {},
    };
    GuestSession.findOne = async () => ({
      creditsRemaining: 20,
      save: async () => {},
    });
    AIService.workspaceRuntime.resolveWorkspace = async () => null;
    ttsService.isServerTtsActive = () => false;
    ttsService.getDefaultTtsLanguage = () => 'en-US';
    AIService.loadWorkingState = async () => ({ workingState: null });
    AIService.loadRecentTurns = async () => [];
    AIService.loadPendingToolCall = async () => null;
    AIService.clearPendingToolCall = async () => {};
    AIService.refreshWorkingStateFromResults = async () => {};
    TaskExecutor.executeTool = async (name, args) => {
      executions.push({ name, args });
      return {
        success: false,
        source: 'test',
        error: 'News request timed out.',
      };
    };
    AIService.llmRouter.generate = async (request) => {
      generations.push(request);
      return {
        text: '',
        provider: 'test',
        model: 'test',
        stream: null,
      };
    };
    AIService.streamingRuntime = {
      consume: async (stream) => {
        if (!stream) return '';
        let text = '';
        for await (const chunk of stream) {
          text += String(chunk?.text || chunk?.chunk || chunk?.displayText || '');
        }
        return text;
      },
      emitText: async () => {},
    };
    try {
      const result = await AIService.processQuery(
        'guest_news_failure_test',
        'find latest top news in india',
        socket,
      );
      assert.match(result, /timed out|could not retrieve|no headlines/i);
      assert.strictEqual(executions.length, 2);
      assert.ok(generations.every((request) => !(
        Array.isArray(request.tools) &&
        request.tools.length === 0 &&
        request.messages.some(
          (message) => Array.isArray(message.toolCalls) && message.toolCalls.length > 0,
        )
      )));
      assert.ok(generations.every((request) => !request.forcedTool));
    } finally {
      GuestSession.findOne = originals.findOne;
      AIService.workspaceRuntime.resolveWorkspace = originals.resolveWorkspace;
      AIService.llmRouter.generate = originals.generate;
      AIService.streamingRuntime = originals.streamingRuntime;
      TaskExecutor.executeTool = originals.executeTool;
      ttsService.isServerTtsActive = originals.isServerTtsActive;
      ttsService.getDefaultTtsLanguage = originals.getDefaultTtsLanguage;
      AIService.loadWorkingState = originals.loadWorkingState;
      AIService.loadRecentTurns = originals.loadRecentTurns;
      AIService.loadPendingToolCall = originals.loadPendingToolCall;
      AIService.clearPendingToolCall = originals.clearPendingToolCall;
      AIService.refreshWorkingStateFromResults = originals.refreshWorkingStateFromResults;
    }
  });
}

run()
  .then(() => {
    console.log(`\nResult: ${pass} pass, ${fail} fail`);
    process.exit(process.exitCode || 0);
  })
  .catch((error) => {
    console.error('Harness error:', error);
    process.exit(1);
  });
