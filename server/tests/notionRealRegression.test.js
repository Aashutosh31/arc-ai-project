'use strict';

// Phase 9-10: production-shaped validation against real Notion MCP 43-tool
// schema fixture + full 1-21 matrix + high-pressure checks.
// Zero DB dependency; all selection logic runs in-memory.

const assert = require('assert');
const {
  selectToolSchemas,
  selectContinuationTools,
  classifyIntentCapabilities,
  declareToolCapabilities
} = require('../lib/llm/toolSelection');
const { assembleBudgetedRequest, OUTPUT_BUDGET_DEFAULT } = require('../lib/llm/contextBudget');

// 43 real Notion tool schemas (trimmed descriptions, wire names preserved)
const notionSchemas = require('./fixtures/notionRealSchemas');

const notionNames = notionSchemas.map((s) => s.function.name);

const mkNative = () => [
  { function: { name: 'memorize', description: 'save a note' } },
  { function: { name: 'recallMemory', description: 'read a note' } },
  { function: { name: 'storeUserFact', description: 'store a fact' } }
];

const has = (names, ...want) => want.every((w) => names.includes(w));
const lacks = (names, ...no) => no.every((n) => !names.includes(n));
const pick = (q, opts = {}) => {
  const r = selectToolSchemas(q, () => mkNative(), {
    mcpSchemas: opts.mcpSchemas ?? notionSchemas,
    mcpBlocked: opts.mcpBlocked ?? [],
    ...opts
  });
  return r;
};

let pass = 0;
let fail = 0;
const ok = (label, fn) => {
  try { fn(); pass++; console.log(`  ok - ${label}`); }
  catch (e) { fail++; console.error(`  FAIL - ${label}`); console.error('    ', e.message); }
};

// ---------------------------------------------------------------
// 1. Real Notion sentence regression (the core acceptance test)
// ---------------------------------------------------------------
ok('R-01 intentCaps = READ,UPDATE for the real sentence', () => {
  const caps = classifyIntentCapabilities(
    'Open the Notion page ARC-AI MCP Live Test that you created earlier. Add a new section called ARC-AI Current State. Write a concise summary of what ARC-AI currently supports and then add a checklist of 5 concrete next development goals. Preserve everything already on the page. Do not create a new page.'
  );
  assert.deepStrictEqual([...caps].sort(), ['READ', 'UPDATE']);
});

ok('R-02 real sentence yields update-page + fetch, no create-pages, ≤6 tools', () => {
  const r = pick('Open the Notion page ARC-AI MCP Live Test that you created earlier. Add a new section called ARC-AI Current State. Write a concise summary of what ARC-AI currently supports and then add a checklist of 5 concrete next development goals. Preserve everything already on the page. Do not create a new page.');
  const names = r.tools.map((s) => s.function.name);
  assert.ok(names.includes('mcp_notion_notion-update-page'), 'missing update-page');
  assert.ok(names.includes('mcp_notion_notion-fetch'), 'missing fetch');
  assert.ok(!names.includes('mcp_notion_notion-create-pages'), 'create-pages must not appear');
  assert.ok(names.length <= 6, `tool count ${names.length} exceeds 6`);
  // Feasibility ordering ranks the parameter-free reader first; membership
  // (not order) is the contract here.
  assert.deepStrictEqual([...(r.mcpCapability || [])].sort(), ['mcp_notion_notion-fetch', 'mcp_notion_notion-update-page']);
});

ok('R-03 continuation retains update-page', () => {
  const r = pick('Open the Notion page ARC-AI MCP Live Test that you created earlier. Add a new section called ARC-AI Current State. Write a concise summary of what ARC-AI currently supports and then add a checklist of 5 concrete next development goals. Preserve everything already on the page. Do not create a new page.');
  const active = ['mcp_notion_notion-search', 'mcp_notion_notion-update-page'];
  const cont = selectContinuationTools(r.tools, active, () => mkNative(), { mcpSchemas: notionSchemas });
  assert.ok(cont.tools.map((s) => s.function.name).includes('mcp_notion_notion-update-page'), 'update-page lost in continuation');
});

// ---------------------------------------------------------------
// 2. Capability matrix: 10 caps × 2 queries each = 20 queries
// ---------------------------------------------------------------
const MATRIX = [
  ['READ',   'show me the project status page', 'mcp_notion_notion-fetch'],
  ['READ',   'open the quarterly report', 'mcp_notion_notion-fetch'],
  ['SEARCH', 'find the Q3 roadmap document', 'mcp_notion_notion-search'],
  ['SEARCH', 'look up the API design notes', 'mcp_notion_notion-search'],
  ['LIST',   'list my recent pages', 'mcp_notion_notion-list-recent-pages'],
  ['LIST',   'list the shared pages', 'mcp_notion_notion-list-shared-pages'],
  ['CREATE', 'create a new page for the project', 'mcp_notion_notion-create-pages'],
  ['CREATE', 'add a fresh document for the sprint', 'mcp_notion_notion-create-pages'],
  ['UPDATE', 'add a section to the existing page', 'mcp_notion_notion-update-page'],
  ['UPDATE', 'update the page with current status', 'mcp_notion_notion-update-page'],
  ['DELETE', 'remove the draft page', null],
  ['DELETE', 'delete that old report page', null],
  ['SEND',   'post a comment on the page', 'mcp_notion_notion-create-comment'],
  ['SEND',   'send feedback on the document', 'mcp_notion_notion-create-comment'],
  ['UPLOAD', 'attach a file to the page', 'mcp_notion_notion-create-attachment'],
  ['UPLOAD', 'upload the report PDF', 'mcp_notion_notion-create-attachment'],
  ['DOWNLOAD','export the project page', 'mcp_notion_notion-download-attachment'],
  ['DOWNLOAD','download the report file', 'mcp_notion_notion-download-attachment'],
  ['EXECUTE','run the automation task', 'mcp_notion_notion-trigger-action'],
  ['EXECUTE','start the sync process', 'mcp_notion_notion-trigger-action']
];
// Some expected tools may not exist in the real fixture (e.g., trigger-action);
// these tests verify the CAPABILITY is in mcpCapability, not the exact tool name.

for (const [cap, query, expectedTool] of MATRIX) {
  if (cap === 'DELETE') {
    // Honest DELETE behavior on the real fixture: no Notion tool name-declares
    // deletion and the fixture carries no server annotations, so a destructive
    // pick must NOT be fabricated from incidental prose ("are deleted once
    // they expire", "remove all filters"). The intent must still classify as
    // DELETE, and the annotation mechanism below proves a real annotated
    // server resolves it.
    ok(`M-${cap}: "${query}" → intent DELETE, no fabricated delete tool`, () => {
      assert.ok(classifyIntentCapabilities(query).has('DELETE'), 'intent missed DELETE');
      const r = pick(query);
      assert.ok(
        !r.mcpCapability.some((n) => /create-attachment|download-skill|update-folder|update-data-source|query-data-sources|update-view/.test(n)),
        `incidental-prose tool pinned for DELETE: ${JSON.stringify(r.mcpCapability)}`
      );
    });
    continue;
  }
  const exact = notionNames.includes(expectedTool);
  ok(`M-${cap}: "${query}" → capability includes ${cap}`, () => {
    const r = pick(query);
    assert.ok(r.mcpCapability.length > 0, 'no capability picks');
    const capsHit = r.tools
      .filter((s) => r.mcpCapability.includes(s.function.name))
      .map((s) => {
        const c = declareToolCapabilities(s);
        return [...c];
      });
    const hasCap = capsHit.some((cs) => cs.includes(cap));
    assert.ok(hasCap, `expected capability ${cap} in picks ${JSON.stringify(r.mcpCapability)}`);
  });
}

// ---------------------------------------------------------------
// 2b. MCP metadata compatibility: annotations + params + prose hygiene
// Real servers expose MCP annotations and rich input schemas; the classifier
// must read them generically (no vendor knowledge).
// ---------------------------------------------------------------
const withMeta = (name, description, parameters, annotations) => {
  const s = {
    type: 'function',
    function: { name, description, parameters: parameters || { type: 'object', properties: {} } }
  };
  if (annotations) {
    Object.defineProperty(s, 'mcpMetadata', {
      value: Object.freeze({ annotations }),
      enumerable: false
    });
  }
  return s;
};

ok('META-01 readOnlyHint declares READ and strips mutating caps', () => {
  const s = withMeta(
    'mcp_x_retrieve_thing',
    'Retrieve a thing. Updated copies and deleted drafts are mentioned here.',
    { type: 'object', properties: {} },
    { readOnlyHint: true }
  );
  const caps = declareToolCapabilities(s);
  assert.ok(caps.has('READ'), 'readOnly tool must declare READ');
  assert.ok(!caps.has('UPDATE') && !caps.has('DELETE'), `mutating caps leak: ${[...caps]}`);
});

ok('META-02 destructiveHint makes a desc-declared remover pickable for DELETE', () => {
  const remover = withMeta(
    'mcp_x_retire_thing',
    'Remove a thing from the workspace.',
    { type: 'object', properties: {} },
    { destructiveHint: true }
  );
  const plain = withMeta('mcp_x_retire_thing', 'Remove a thing from the workspace.');
  const rAnn = pick('delete the old thing', { mcpSchemas: [remover] });
  assert.ok(rAnn.mcpCapability.includes('mcp_x_retire_thing'), `annotated remover not picked: ${rAnn.mcpCapability}`);
  const rPlain = pick('delete the old thing', { mcpSchemas: [plain] });
  assert.ok(!rPlain.mcpCapability.includes('mcp_x_retire_thing'), 'desc-only remover must not be pinned for DELETE');
});

ok('META-03 parameter names contribute to declaration', () => {
  const s = withMeta('mcp_x_store_blob', 'Handles workspace blobs.', {
    type: 'object',
    properties: {
      download_url: { type: 'string' },
      file_id: { type: 'string' }
    }
  });
  assert.ok(declareToolCapabilities(s).has('DOWNLOAD'), 'download_url param must declare DOWNLOAD');
});

ok('META-04 backtick code spans do not declare capabilities', () => {
  const s = withMeta('mcp_x_get_thing', 'Get a thing. Check `truncated`, `unknown_ids` before use.');
  const caps = declareToolCapabilities(s);
  assert.ok(!caps.has('DELETE'), `code-span false positive: ${[...caps]}`);
  assert.ok(caps.has('READ'), 'READ must survive code-span stripping');
});

ok('META-05 token-exact domain match: section != selection, state != statements', () => {
  const pageUpdater = withMeta('mcp_x_update-page', 'Update a page.');
  const commenter = withMeta('mcp_x_create-comment', 'Add a comment. Use `selection_with_ellipsis` with "# Section Ti...tle".');
  const r = pick('add a section to it', { mcpSchemas: [commenter, pageUpdater] });
  assert.ok(r.mcpCapability.includes('mcp_x_update-page'), `wrong UPDATE tool: ${r.mcpCapability}`);
});

ok('META-06 short follow-up keeps UPDATE via name-declared tool', () => {
  const r = pick('add a section to it');
  const capsHit = r.tools
    .filter((s) => r.mcpCapability.includes(s.function.name))
    .flatMap((s) => [...declareToolCapabilities(s)]);
  assert.ok(capsHit.includes('UPDATE'), `UPDATE lost on short follow-up: ${r.mcpCapability}`);
});

// ---------------------------------------------------------------
// 3. Multi-step: search + update, read + update, search + create
// ---------------------------------------------------------------
ok('M-14 search + update keeps both capabilities', () => {
  const r = pick('search for the project page and update it with new goals');
  const capsHit = r.tools
    .filter((s) => r.mcpCapability.includes(s.function.name))
    .flatMap((s) => [...declareToolCapabilities(s)]);
  assert.ok(capsHit.includes('SEARCH') || capsHit.includes('READ'), 'missing search/read');
  assert.ok(capsHit.includes('UPDATE'), 'missing update');
});

ok('M-15 read + update keeps both capabilities', () => {
  const r = pick('open the report page then add a section to it');
  const capsHit = r.tools
    .filter((s) => r.mcpCapability.includes(s.function.name))
    .flatMap((s) => [...declareToolCapabilities(s)]);
  assert.ok(capsHit.includes('READ'), 'missing read');
  assert.ok(capsHit.includes('UPDATE'), 'missing update');
});

ok('M-16 search + create keeps both capabilities', () => {
  const r = pick('search for the sprint board and create a new task page');
  const capsHit = r.tools
    .filter((s) => r.mcpCapability.includes(s.function.name))
    .flatMap((s) => [...declareToolCapabilities(s)]);
  assert.ok(capsHit.includes('SEARCH') || capsHit.includes('READ'), 'missing search/read');
  assert.ok(capsHit.includes('CREATE'), 'missing create');
});

// ---------------------------------------------------------------
// 4. Capability picks survive crushing budget
// ---------------------------------------------------------------
ok('M-17 capability picks survive crushing budget', () => {
  const r = pick('add a new page for the project');
  const pickedNames = r.mcpCapability;
  assert.ok(pickedNames.length > 0, 'no cap picks');
  const budgeted = assembleBudgetedRequest({
    systemTemplate: 'SYSTEM',
    baseUserText: 'add a new page for the project',
    docText: '',
    memoryDocs: [],
    factDocs: [],
    ragItems: [],
    selectedTools: r.tools,
    outputBudget: 200,
    query: 'add a new page for the project',
    protectedToolNames: pickedNames
  }).tools.map((s) => s.function.name);
  for (const n of pickedNames) {
    assert.ok(budgeted.includes(n), `cap pick ${n} lost in budget trim`);
  }
});

// ---------------------------------------------------------------
// 5. Continuation retains capability picks
// ---------------------------------------------------------------
ok('M-18 continuation retains capability tools', () => {
  const r = pick('add a new page for the project');
  const capPickNames = r.mcpCapability;
  const cont = selectContinuationTools(r.tools, ['mcp_notion_notion-create-pages'], () => mkNative(), { mcpSchemas: notionSchemas });
  const contNames = cont.tools.map((s) => s.function.name);
  for (const n of capPickNames) {
    assert.ok(contNames.includes(n), `cap pick ${n} lost in continuation`);
  }
});

// ---------------------------------------------------------------
// 6. Explicit tool name still wins slot 1
// ---------------------------------------------------------------
ok('M-19 explicit tool name wins first slot', () => {
  const r = pick('use mcp_notion_notion-fetch to get the page');
  assert.strictEqual(r.tools[0].function.name, 'mcp_notion_notion-fetch');
});

// ---------------------------------------------------------------
// 7. Blocked all → suppress all MCP
// ---------------------------------------------------------------
ok('M-20 blocked capability suppresses all MCP tools', () => {
  const exposed = [
    { function: { name: 'mcp_mem_getReminder', description: 'Shows the current reminder alarm' } },
    { function: { name: 'mcp_mem_setTimer', description: 'Starts a kitchen timer' } }
  ];
  const blocked = [{ function: { name: 'mcp_notion_notion-delete-report-page', description: 'Delete or remove the old report page, retrieve and purge its content for archiving' } }];
  const r = pick('delete the old report page', { mcpBlocked: blocked, mcpSchemas: exposed });
  assert.strictEqual(r.mcpSuppressed, true, `expected suppressed, got mcpMatched=${r.mcpMatched}`);
  assert.strictEqual(r.mcpSuppressed, true, 'expected suppressed');
  assert.strictEqual(r.tools.filter((s) => s.function.name.startsWith('mcp_')).length, 0, 'no MCP tools in suppressed request');
});

// ---------------------------------------------------------------
// 8. Guest mode → no MCP tools
// ---------------------------------------------------------------
ok('M-21 guest request yields no MCP tools', () => {
  // Guest mode is enforced at the MCPToolSource layer (schemasForRequest);
  // here we simulate by passing empty exposed list.
  const r = pick('open the project page', { mcpSchemas: [] });
  assert.strictEqual(r.tools.filter((s) => s.function.name.startsWith('mcp_')).length, 0);
});

// ---------------------------------------------------------------
// 9. High-pressure: 10 generic queries must not pin create-pages
// ---------------------------------------------------------------
const HIGH_PRESSURE = [
  'can you help me with my project',
  'what time is it in london',
  'summarize today standup notes',
  'tell me about the latest changes',
  'check the meeting schedule',
  'review the design document',
  'add a note about the sprint',
  'compare last month with this month',
  'organize my workspace pages',
  'send the weekly report to the team'
];
for (const q of HIGH_PRESSURE) {
  ok(`HP: "${q.slice(0, 30)}…" must not pin create-pages`, () => {
    const r = pick(q);
    const mcpNames = r.tools.map((s) => s.function.name);
    assert.ok(!mcpNames.includes('mcp_notion_notion-create-pages'), `create-pages appeared in: ${JSON.stringify(mcpNames)}`);
    assert.ok(r.tools.length <= 6, `tool count ${r.tools.length} exceeds 6 for: ${q}`);
  });
}

// ---------------------------------------------------------------
// 10. Suppression guard: negated create must not yield create-pages
// ---------------------------------------------------------------
ok('SUP-1 "do not create a new page" does not pin create-pages as a pick', () => {
  const r = pick('do not create a new page, just update the existing one');
  assert.ok(!r.mcpCapability.includes('mcp_notion_notion-create-pages'), 'create-pages must not be a capability pick');
  if (r.mcpCapability.length) {
    assert.ok(r.mcpCapability.some((n) => n.includes('update')), 'update-capability present');
  }
});

// ---------------------------------------------------------------
// Summary
// ---------------------------------------------------------------
console.log(`\n${pass + fail} tests, ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
