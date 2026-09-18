'use strict';

// Target-resolution chaining tests — run with: node tests/mcpTargetResolution.test.js
//
// Covers the generic MCP write-capability fix: when the model calls an MCP
// write/update tool with ONLY identifier-shaped args missing (a title was
// named, no ID yet) and SEARCH/READ resolvers are exposed, the agent
// resolves the target in-turn instead of asking the user for an internal
// ID. Fully vendor-neutral: synthetic `mcp_x_*` schemas, capability
// declarations + identifier-shaped param names only. No DB, no provider.
//
// Stages proven here:
//  1. identifier param recognition + URL/UUID/hex extraction (pendingArgs)
//  2. pasted-URL pending advance -> execute (no clarification loop)
//  3. resolve round (search -> retry update) via stubbed router + executor
//  4. direct retry, no-resolver / non-identifier / invalid-retry fallbacks
//  5. deny-wins: denied resolvers never enter the resolve round
//  6. production-shaped: 43 real Notion schemas, write survives budget +
//     continuation under memory/history pressure

const assert = require('assert');

let pass = 0;
let fail = 0;
const ok = (label, fn) => {
  const run = async () => {
    try { await fn(); pass++; console.log(`  ok - ${label}`); }
    catch (e) { fail++; console.error(`  FAIL - ${label}`); console.error('    ', e.message); }
  };
  return run();
};

console.log('MCP Target Resolution Tests');
console.log('===========================');

const {
  isIdentifierParam,
  extractIdentifierValue,
  extractArgValues,
  advancePending,
  createPending,
  requiredParams
} = require('../lib/llm/pendingArgs');
const { declareToolCapabilities, selectContinuationTools } = require('../lib/llm/toolSelection');
const { assembleBudgetedRequest, OUTPUT_BUDGET_DEFAULT } = require('../lib/llm/contextBudget');

// Synthetic generic MCP shapes (NOT Notion): update needs a target id +
// a content payload; search/fetch resolve targets.
const updateSchema = () => ({
  type: 'function',
  function: {
    name: 'mcp_x_update-page',
    description: 'Update a page properties or content. Provide the page identifier and the new content.',
    parameters: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Target page identifier' },
        content: { type: 'string', description: 'New content to append' }
      },
      required: ['page_id', 'content']
    }
  }
});
const searchSchema = () => ({
  type: 'function',
  function: {
    name: 'mcp_x_search',
    description: 'Search workspace pages by keyword or title.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  }
});
const fetchSchema = () => ({
  type: 'function',
  function: {
    name: 'mcp_x_fetch',
    description: 'Fetch and retrieve a page by its identifier.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  }
});
const deniedSearchSchema = () => ({
  type: 'function',
  function: {
    name: 'mcp_x_blocked-search',
    description: 'Search workspace pages by keyword.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  }
});

const URL = 'https://app.notion.com/p/3dad784862fc811f8517d4ace58eadba?pvs=204';
const UUID = '3dad7848-62fc-811f-8517-d4ace58eadba';
const HEX32 = '3dad784862fc811f8517d4ace58eadba';

async function run() {
  // ---- 1. identifier recognition ----
  await ok('T-01 isIdentifierParam matches target refs, rejects prose fields', () => {
    for (const n of ['page_id', 'id', 'source_url', 'discussion_id', 'user_id', 'pageId', 'sourceUrl', 'url']) {
      assert.ok(isIdentifierParam(n), `${n} should match`);
    }
    for (const n of ['content', 'title', 'query', 'markdown', 'valid', 'invalid', 'identifier_text', 'pageid', '']) {
      assert.ok(!isIdentifierParam(n), `${n} must NOT match`);
    }
  });

  await ok('T-02 extractIdentifierValue pulls URL/UUID/hex, ignores prose', () => {
    // A Notion URL embeds the 32-hex page ID: the bare ID wins for id
    // params (cleaner than the tracking-suffixed URL).
    assert.strictEqual(extractIdentifierValue(`here: ${URL}`, 'page_id'), HEX32);
    assert.strictEqual(extractIdentifierValue(`id ${UUID} ok`, 'page_id'), UUID);
    assert.strictEqual(extractIdentifierValue(`id ${HEX32} ok`, 'page_id'), HEX32);
    assert.strictEqual(extractIdentifierValue(`see ${URL}`, 'source_url'), URL);
    assert.strictEqual(extractIdentifierValue('see https://example.com/notes', 'page_id'), 'https://example.com/notes');
    assert.strictEqual(extractIdentifierValue('ARC-AI MCP Live Test', 'page_id'), undefined);
    assert.strictEqual(extractIdentifierValue('', 'page_id'), undefined);
  });

  await ok('T-03 extractArgValues fills page_id from pasted URL, never from title', () => {
    const params = requiredParams(updateSchema());
    const fromUrl = extractArgValues(`Use this page ${URL}`, params.filter((p) => p.name === 'page_id'));
    assert.strictEqual(fromUrl.page_id, HEX32);
    assert.strictEqual(fromUrl.content, undefined);
    const fromTitle = extractArgValues('ARC-AI MCP Live Test', params.filter((p) => p.name === 'page_id'));
    assert.strictEqual(fromTitle.page_id, undefined);
  });

  // ---- 2. pasted-URL pending advance ----
  await ok('T-04 pending update + pasted URL advances to execute', () => {
    const schema = updateSchema();
    const pend = createPending('mcp_x_update-page', { content: '## State\nok' }, schema);
    assert.deepStrictEqual(pend.missing, ['page_id']);
    const next = advancePending(pend, `The page is ${URL}`, schema);
    assert.strictEqual(next.action, 'execute', `got ${next.action}`);
    assert.strictEqual(next.args.page_id, HEX32);
    assert.strictEqual(next.args.content, '## State\nok');
  });

  await ok('T-05 pending update + bare title stays ask (title is not an ID)', () => {
    const schema = updateSchema();
    const pend = createPending('mcp_x_update-page', { content: '## State\nok' }, schema);
    const next = advancePending(pend, 'ARC-AI MCP Live Test', schema);
    assert.strictEqual(next.action, 'ask');
  });

  // ---- 3-5. resolve round with stubbed router + executor ----
  const ai = require('../services/AIService');
  const TaskExecutor = require('../services/TaskExecutor');
  const realGenerate = ai.llmRouter.generate;
  const realExecute = TaskExecutor.executeTool;
  const restore = () => { ai.llmRouter.generate = realGenerate; TaskExecutor.executeTool = realExecute; };

  const baseResolveArgs = (mcpSchemas, intent = ['UPDATE']) => ({
    originalCall: {
      id: 'call-1',
      function: { name: 'mcp_x_update-page', arguments: JSON.stringify({ content: '## ARC-AI Current State\nsupports X' }) }
    },
    execName: 'mcp_x_update-page',
    argSchema: updateSchema(),
    missing: ['page_id'],
    intentCaps: new Set(intent),
    messages: [{ role: 'user', content: 'Open the page ARC-AI MCP Live Test. Add a section called ARC-AI Current State.' }],
    systemPrompt: 'SYS',
    mcpSchemas,
    maxTokens: 500,
    userId: 'guest:test',
    isGuest: true,
    calendarIntent: { type: 'none' },
    requestKey: 'test',
    signal: null,
    conversationId: null,
    workspaceId: null,
    socket: null
  });

  await ok('T-06 resolve round: search -> retry update with resolved id', async () => {
    const seenTools = [];
    ai.llmRouter.generate = async (req) => {
      seenTools.push((req.tools || []).map((t) => t?.function?.name));
      const names = (req.tools || []).map((t) => t?.function?.name);
      if (names.includes('mcp_x_search') && names.includes('mcp_x_update-page')) {
        return { text: '', toolCalls: [{ id: 's1', function: { name: 'mcp_x_search', arguments: { query: 'ARC-AI MCP Live Test' } } }] };
      }
      // Round 2: original-only tools; resolver evidence must be in context.
      assert.deepStrictEqual(names, ['mcp_x_update-page']);
      const joined = JSON.stringify(req.messages);
      assert.ok(joined.includes('page-123'), 'resolver evidence missing from retry context');
      return {
        text: 'done',
        toolCalls: [{ id: 'u1', function: { name: 'mcp_x_update-page', arguments: { page_id: 'page-123', content: '## State' } } }]
      };
    };
    TaskExecutor.executeTool = async (name) => {
      assert.strictEqual(name, 'mcp_x_search');
      return { success: true, result: 'found page-123 "ARC-AI MCP Live Test"' };
    };
    try {
      const r = await ai.tryTargetResolution(baseResolveArgs([searchSchema(), fetchSchema()]));
      assert.ok(r && r.toolCalls.length === 1, 'expected retry');
      assert.strictEqual(r.toolCalls[0].function.name, 'mcp_x_update-page');
      assert.strictEqual(r.toolCalls[0].function.arguments.page_id, 'page-123');
      assert.ok(seenTools[0].length <= 6, 'resolve round respects tool cap');
    } finally { restore(); }
  });

  await ok('T-07 direct retry in round 1 skips round 2', async () => {
    let calls = 0;
    ai.llmRouter.generate = async () => {
      calls += 1;
      return { text: '', toolCalls: [{ id: 'u0', function: { name: 'mcp_x_update-page', arguments: { page_id: 'page-9', content: 'x' } } }] };
    };
    try {
      const r = await ai.tryTargetResolution(baseResolveArgs([searchSchema()]));
      assert.ok(r && r.toolCalls[0].function.arguments.page_id === 'page-9');
      assert.strictEqual(calls, 1, 'only one generation round');
    } finally { restore(); }
  });

  await ok('T-08 no resolvers exposed -> null (ask flow preserved)', async () => {
    let called = false;
    ai.llmRouter.generate = async () => { called = true; return {}; };
    try {
      const r = await ai.tryTargetResolution(baseResolveArgs([]));
      assert.strictEqual(r, null);
      assert.strictEqual(called, false, 'no generation without resolvers');
    } finally { restore(); }
  });

  await ok('T-09 non-identifier gap (missing content) -> null, no generation', async () => {
    let called = false;
    ai.llmRouter.generate = async () => { called = true; return {}; };
    try {
      const args = baseResolveArgs([searchSchema()]);
      args.missing = ['page_id', 'content'];
      const r = await ai.tryTargetResolution(args);
      assert.strictEqual(r, null);
      assert.strictEqual(called, false);
    } finally { restore(); }
  });

  await ok('T-10 retry still invalid -> null (ask flow preserved)', async () => {
    ai.llmRouter.generate = async (req) => {
      const names = (req.tools || []).map((t) => t?.function?.name);
      if (names.includes('mcp_x_search')) {
        return { text: '', toolCalls: [{ id: 's1', function: { name: 'mcp_x_search', arguments: { query: 'x' } } }] };
      }
      return { text: '', toolCalls: [{ id: 'u1', function: { name: 'mcp_x_update-page', arguments: { content: 'no id again' } } }] };
    };
    TaskExecutor.executeTool = async () => ({ success: true, result: 'nothing useful' });
    try {
      const r = await ai.tryTargetResolution(baseResolveArgs([searchSchema()]));
      assert.strictEqual(r, null);
    } finally { restore(); }
  });

  await ok('T-11 denied resolver never enters the resolve round', async () => {
    let r1Tools = null;
    ai.llmRouter.generate = async (req) => {
      r1Tools = (req.tools || []).map((t) => t?.function?.name);
      return { text: '', toolCalls: [] };
    };
    try {
      // Caller passes the EXPOSED set only (denied tool absent) — the
      // method must use exactly that set, never reintroduce anything.
      const r = await ai.tryTargetResolution(baseResolveArgs([fetchSchema()]));
      assert.strictEqual(r, null);
      assert.ok(r1Tools.includes('mcp_x_fetch'), 'exposed resolver offered');
      assert.ok(!r1Tools.includes('mcp_x_blocked-search'), 'denied tool reintroduced');
    } finally { restore(); }
  });

  await ok('T-12 findResolverSchemas picks SEARCH/READ only, excludes original, caps 4', () => {
    const mk = (name, desc) => ({ function: { name, description: desc } });
    const found = ai.findResolverSchemas([
      mk('mcp_x_search', 'Search workspace pages'),
      mk('mcp_x_fetch', 'Fetch a page by id'),
      mk('mcp_x_update-page', 'Update a page'),
      mk('mcp_x_create-pages', 'Creates pages'),
      mk('mcp_x_noop', 'Does bookkeeping')
    ], 'mcp_x_update-page');
    assert.ok(found.map((s) => s.function.name).includes('mcp_x_search'));
    assert.ok(found.map((s) => s.function.name).includes('mcp_x_fetch'));
    assert.ok(!found.map((s) => s.function.name).includes('mcp_x_update-page'));
    assert.ok(!found.map((s) => s.function.name).includes('mcp_x_create-pages'));
    assert.ok(found.length <= 4);
  });

  // ---- 6. production-shaped: 43 real schemas under pressure ----
  await ok('T-13 43 real Notion tools: write survives budget under memory/history pressure', () => {
    const notionSchemas = require('./fixtures/notionRealSchemas');
    assert.strictEqual(notionSchemas.length, 43, `fixture has ${notionSchemas.length} tools`);
    const { selectToolSchemas } = require('../lib/llm/toolSelection');
    const mkNative = () => [
      { function: { name: 'memorize', description: 'save a note' } },
      { function: { name: 'recallMemory', description: 'read a note' } },
      { function: { name: 'storeUserFact', description: 'store a fact' } }
    ];
    const q = 'Open the Notion page ARC-AI MCP Live Test that you created earlier. Add a new section called ARC-AI Current State. Preserve everything already on the page. Do not create a new page.';
    const pick = selectToolSchemas(q, mkNative, { mcpSchemas: notionSchemas, mcpBlocked: [] });
    const big = (i) => ({ query: `note ${i} ` + 'q'.repeat(200), response: `ans ${i} ` + 'r'.repeat(400), timestamp: new Date() });
    const r = assembleBudgetedRequest({
      systemTemplate: 'SYS __LONG_TERM_MEMORY_SLOT____RETRIEVAL_CONTEXT_SLOT__ END',
      baseUserText: q,
      docText: '',
      memoryDocs: Array.from({ length: 20 }, (_, i) => big(i)),
      factDocs: Array.from({ length: 20 }, (_, i) => ({ fact: `fact ${i} ` + 'f'.repeat(150), createdAt: new Date() })),
      ragItems: [],
      selectedTools: pick.tools,
      outputBudget: OUTPUT_BUDGET_DEFAULT,
      query: q,
      recentTurns: [
        { role: 'user', content: 'Create a page called ARC-AI MCP Live Test.' },
        { role: 'assistant', content: 'Created "ARC-AI MCP Live Test" (3dad7848).' }
      ],
      protectedToolNames: [...(pick.mcpExplicit || []), ...(pick.mcpCapability || [])]
    });
    assert.strictEqual(r.ok, true);
    const names = r.tools.map((s) => s.function.name);
    assert.ok(names.includes('mcp_notion_notion-update-page'), `update-page lost: ${names}`);
    assert.ok(names.includes('mcp_notion_notion-fetch'), `fetch lost: ${names}`);
    assert.ok(!names.includes('mcp_notion_notion-create-pages'), 'create-pages must stay out');
    assert.ok(r.tools.length <= 6, `cap exceeded: ${r.tools.length}`);
  });

  await ok('T-14 resolved update survives continuation (search + update active)', () => {
    const notionSchemas = require('./fixtures/notionRealSchemas');
    const prev = [
      { function: { name: 'memorize' } },
      notionSchemas.find((s) => s.function.name === 'mcp_notion_notion-update-page'),
      notionSchemas.find((s) => s.function.name === 'mcp_notion_notion-fetch'),
      notionSchemas.find((s) => s.function.name === 'mcp_notion_notion-ai-search')
    ];
    const cont = selectContinuationTools(
      prev,
      ['mcp_notion_notion-ai-search', 'mcp_notion_notion-update-page'],
      () => [{ function: { name: 'memorize' } }],
      { mcpSchemas: notionSchemas }
    );
    const names = cont.tools.map((s) => s?.function?.name);
    assert.ok(names.includes('mcp_notion_notion-update-page'), `update lost in continuation: ${names}`);
  });

  await ok('T-15 declareToolCapabilities on real update-page gives UPDATE (name-declared)', () => {
    const notionSchemas = require('./fixtures/notionRealSchemas');
    const caps = declareToolCapabilities(notionSchemas.find((s) => s.function.name === 'mcp_notion_notion-update-page'));
    assert.ok(caps.has('UPDATE'), `got ${[...caps]}`);
  });

  // ---- 7. CREATE regression (§4 rule: CREATE never resolves) ----
  const { classifyIntentCapabilities, selectToolSchemas } = require('../lib/llm/toolSelection');
  const mkNative = () => [
    { function: { name: 'memorize', description: 'save a note' } },
    { function: { name: 'recallMemory', description: 'read a note' } },
    { function: { name: 'storeUserFact', description: 'store a fact' } }
  ];
  const FLOW_A = 'Using the Notion MCP, create a new page called ARC-AI MCP Live Test. Put the following content in the page: ARC-AI MCP Live Test. This page was created by ARC-AI through the Model Context Protocol. Do not modify existing pages. Create only this new test page.';
  // Real-like create schema: target-affecting fields OPTIONAL (draft
  // creation needs no parent), content-bearing fields required.
  const createSchema = (required) => ({
    type: 'function',
    function: {
      name: 'mcp_x_create-pages',
      description: 'Creates one or more pages with properties and content. Uses draft mode when no destination is named.',
      parameters: {
        type: 'object',
        properties: {
          parent_page_id: { type: 'string', description: 'Optional destination parent page' },
          title: { type: 'string', description: 'Page title' },
          content: { type: 'string', description: 'Page content' }
        },
        required
      }
    }
  });

  await ok('C-01 Flow A classifies CREATE-only (part-add cannot wipe it)', () => {
    assert.deepStrictEqual([...classifyIntentCapabilities(FLOW_A)].sort(), ['CREATE']);
  });

  await ok('C-02 Flow A selects create-pages capability, never update', () => {
    const notionSchemas = require('./fixtures/notionRealSchemas');
    const r = selectToolSchemas(FLOW_A, mkNative, { mcpSchemas: notionSchemas, mcpBlocked: [] });
    assert.ok(r.mcpCapability.includes('mcp_notion_notion-create-pages'), `capability: ${r.mcpCapability}`);
    assert.ok(!r.mcpCapability.includes('mcp_notion_notion-update-page'), `update must not be a pick: ${r.mcpCapability}`);
    assert.ok(r.tools.length <= 6);
  });

  await ok('C-03 explicit CREATE capability wins and stays CREATE', () => {
    const notionSchemas = require('./fixtures/notionRealSchemas');
    const r = selectToolSchemas('Use the Notion create-pages capability to create a page called X with some content.', mkNative, { mcpSchemas: notionSchemas, mcpBlocked: [] });
    assert.ok(r.mcpExplicit.includes('mcp_notion_notion-create-pages'), `explicit: ${r.mcpExplicit}`);
    assert.strictEqual(r.tools[0].function.name, 'mcp_notion_notion-create-pages');
    assert.ok(r.mcpCapability.includes('mcp_notion_notion-create-pages'));
  });

  await ok('C-04 CREATE survives budget + 6-tool cap under pressure', () => {
    const notionSchemas = require('./fixtures/notionRealSchemas');
    const r = selectToolSchemas(FLOW_A, mkNative, { mcpSchemas: notionSchemas, mcpBlocked: [] });
    const big = (i) => ({ query: `note ${i} ` + 'q'.repeat(200), response: `ans ${i} ` + 'r'.repeat(400), timestamp: new Date() });
    const b = assembleBudgetedRequest({
      systemTemplate: 'SYS __LONG_TERM_MEMORY_SLOT____RETRIEVAL_CONTEXT_SLOT__ END',
      baseUserText: FLOW_A, docText: '',
      memoryDocs: Array.from({ length: 20 }, (_, i) => big(i)),
      factDocs: [], ragItems: [],
      selectedTools: r.tools, outputBudget: OUTPUT_BUDGET_DEFAULT, query: FLOW_A,
      protectedToolNames: [...(r.mcpExplicit || []), ...(r.mcpCapability || [])]
    });
    assert.strictEqual(b.ok, true);
    const names = b.tools.map((s) => s.function.name);
    assert.ok(names.includes('mcp_notion_notion-create-pages'), `create lost: ${names}`);
    assert.ok(b.tools.length <= 6);
  });

  await ok('C-05 CREATE intent + missing parent id never resolves (no generation)', async () => {
    let called = false;
    ai.llmRouter.generate = async () => { called = true; return {}; };
    try {
      const args = baseResolveArgs([searchSchema(), fetchSchema()], ['CREATE']);
      args.execName = 'mcp_x_create-pages';
      args.argSchema = createSchema(['parent_page_id', 'title', 'content']);
      args.missing = ['parent_page_id'];
      args.originalCall = { id: 'c1', function: { name: 'mcp_x_create-pages', arguments: JSON.stringify({ title: 'T', content: 'C' }) } };
      const r = await ai.tryTargetResolution(args);
      assert.strictEqual(r, null);
      assert.strictEqual(called, false, 'resolve round must not run for CREATE');
    } finally { restore(); }
  });

  await ok('C-06 optional parent absent validates clean (no pending, execute)', () => {
    const { validateArgs, missingRequired } = require('../lib/llm/pendingArgs');
    const schema = createSchema(['title', 'content']);
    const check = validateArgs(schema, { title: 'T', content: 'C' });
    assert.strictEqual(check.ok, true, `optional parent must not block: ${JSON.stringify(check.errors)}`);
    assert.deepStrictEqual(missingRequired(schema, { title: 'T', content: 'C' }), []);
  });

  await ok('C-07 UPDATE intent still resolves (Flow B semantics preserved)', async () => {
    ai.llmRouter.generate = async (req) => {
      const names = (req.tools || []).map((t) => t?.function?.name);
      if (names.includes('mcp_x_search')) {
        return { text: '', toolCalls: [{ id: 's1', function: { name: 'mcp_x_search', arguments: { query: 'Live Test' } } }] };
      }
      return { text: '', toolCalls: [{ id: 'u1', function: { name: 'mcp_x_update-page', arguments: { page_id: 'p1', content: 'x' } } }] };
    };
    TaskExecutor.executeTool = async () => ({ success: true, result: 'p1' });
    try {
      const r = await ai.tryTargetResolution(baseResolveArgs([searchSchema()], ['READ', 'UPDATE']));
      assert.ok(r && r.toolCalls[0].function.arguments.page_id === 'p1');
    } finally { restore(); }
  });

  await ok('C-08 DELETE intent with missing id resolves (existing-resource rule)', async () => {
    ai.llmRouter.generate = async (req) => {
      const names = (req.tools || []).map((t) => t?.function?.name);
      if (names.includes('mcp_x_search')) {
        return { text: '', toolCalls: [{ id: 's1', function: { name: 'mcp_x_search', arguments: { query: 'old' } } }] };
      }
      return { text: '', toolCalls: [{ id: 'd1', function: { name: 'mcp_x_delete-thing', arguments: { issue_id: 'i9' } } }] };
    };
    TaskExecutor.executeTool = async () => ({ success: true, result: 'i9' });
    const delSchema = () => ({
      type: 'function',
      function: {
        name: 'mcp_x_delete-thing', description: 'Delete a thing by id.',
        parameters: { type: 'object', properties: { issue_id: { type: 'string' } }, required: ['issue_id'] }
      }
    });
    try {
      const args = baseResolveArgs([searchSchema()], ['DELETE']);
      args.execName = 'mcp_x_delete-thing';
      args.argSchema = delSchema();
      args.missing = ['issue_id'];
      args.originalCall = { id: 'd0', function: { name: 'mcp_x_delete-thing', arguments: '{}' } };
      const r = await ai.tryTargetResolution(args);
      assert.ok(r && r.toolCalls[0].function.arguments.issue_id === 'i9');
    } finally { restore(); }
  });

  await ok('C-09 negated-modify suppresses UPDATE; mixed create+update keeps both', () => {
    assert.ok(!classifyIntentCapabilities('Do not modify existing pages. Create only this new test page.').has('UPDATE'));
    const both = classifyIntentCapabilities('update the old report and add a new page');
    assert.ok(both.has('UPDATE') && both.has('CREATE'), `got ${[...both]}`);
  });
}

run().then(() => {
  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
