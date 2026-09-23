'use strict';

// MCP tool-visibility invariant + entity-aware selection (DB-free).
//
// The production failure: the model saw an inventory of 64 MCP tools while
// request.tools carried only 6, called an unlisted tool, and the provider
// 400'd ("attempted to call tool X which was not in request.tools") — while
// coverage had forced unrelated tools (get_project, list_comments,
// list_project_labels) for "create an issue".
//
// Invariant under test: Set(inventory MCP names) === Set(request.tools MCP
// names). The inventory is generated ONLY from the final provider-visible
// tool set. Capability matching is intent → entity → mutation/read →
// lexical, with save/upsert mutation semantics. Generic: no vendor names in
// the implementation; this file's "issue/project/comment" servers are test
// DATA only.
//
//   A. inventory visibility (subset/equality, refresh, empty note)
//   B. CREATE(ISSUE) picks the issue mutation, never project/comment/label
//   C. save/upsert semantics declare CREATE+UPDATE when schema supports both
//   D. entity matching (no cross-entity substitution)
//   E. 6-tool pressure (mutation + resolver survive, unrelated dropped first)
//   F. provider-mismatch defense (add-once-and-retry; denied never added)
//   G. continuation (active tool survives, inventory matches)
//
// Run:  cd server && node tests/mcpVisibility.test.js

const assert = require('assert');

const {
  selectToolSchemas,
  selectContinuationTools,
  classifyIntentCapabilities,
  declareToolCapabilities,
  extractMissingToolName
} = require('../lib/llm/toolSelection');
const { trimToolsToBudget, assembleBudgetedRequest } = require('../lib/llm/contextBudget');
const ai = require('../services/AIService');

const passed = [];
const failed = [];
const test = (name, fn) => (async () => {
  try { await fn(); passed.push(name); console.log(`  ok - ${name}`); }
  catch (err) { failed.push({ name, err }); console.error(`  FAIL - ${name}`); console.error(`         ${err && err.message}`); }
})();

const mk = (server, name, description, parameters) => ({
  type: 'function',
  function: {
    name: `mcp_${server}_${name}`,
    description,
    parameters: parameters || { type: 'object', properties: {}, required: [] }
  }
});
const names = (tools) => (tools || []).map((s) => s?.function?.name).filter(Boolean);
// MCP wire names advertised inside an inventory block.
const inventoryWires = (block) => {
  const out = [];
  for (const m of String(block || '').matchAll(/\bmcp_[a-z0-9_-]+\b/g)) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
};

// Real-Linear-shaped exposed set: the issue mutation plus distractors whose
// descriptions incidentally mention "create", plus filler for cap pressure.
const EXPOSED = [
  mk('linear', 'get_project', 'Retrieve a project. To create a project, use the create flow with a name.'),
  mk('linear', 'list_comments', 'List comments on an issue. To create a comment, supply body text.'),
  mk('linear', 'list_project_labels', 'List labels for a project. Labels can be created by admins.'),
  mk('linear', 'save_issue', 'Create a new issue or update an existing one. Omit id to create a new issue with a title and description.',
    { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } }, required: ['title'] }),
  mk('linear', 'save_project', 'Create a new project or update an existing one. Omit id to create.',
    { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['name'] }),
  mk('linear', 'get_issue', 'Retrieve a single issue by its identifier.',
    { type: 'object', properties: { issueId: { type: 'string' } }, required: ['issueId'] }),
  mk('linear', 'list_issues', 'List issues in the workspace.'),
  mk('linear', 'list_teams', 'List all teams in the workspace.'),
  mk('linear', 'list_projects', 'List all projects in the workspace.'),
  mk('linear', 'search_issues', 'Search issues by keyword.',
    { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }),
  mk('linear', 'save_comment', 'Add a comment to an existing issue.',
    { type: 'object', properties: { issueId: { type: 'string' }, body: { type: 'string' } }, required: ['issueId', 'body'] })
];
const CREATE_Q = "Create a Linear issue called 'ARC-AI MCP Integration Test' with the description 'This issue was created by ARC-AI through the Linear MCP.' Do not create another issue.";

const main = async () => {
  // ---- A. inventory visibility ------------------------------------------------
  await test('A-01 inventory MCP names exactly equal final request.tools MCP names', async () => {
    const sel = selectToolSchemas(CREATE_Q, () => [], { mcpSchemas: EXPOSED });
    const b = assembleBudgetedRequest({
      systemTemplate: 'SYS __LONG_TERM_MEMORY_SLOT____RETRIEVAL_CONTEXT_SLOT__ END',
      baseUserText: CREATE_Q, query: CREATE_Q, selectedTools: sel.tools,
      outputBudget: 1200,
      protectedToolNames: [...(sel.mcpExplicit || []), ...(sel.mcpCapability || [])]
    });
    assert.strictEqual(b.ok, true);
    const block = ai.mcpInventoryBlockForTools(b.tools, {});
    const finalMcp = names(b.tools).filter((n) => n.startsWith('mcp_')).sort();
    assert.deepStrictEqual(inventoryWires(block).sort(), finalMcp, 'inventory/request.tools mismatch');
  });

  await test('A-02 empty tool set says no MCP tools are available', async () => {
    const block = ai.mcpInventoryBlockForTools([], {});
    assert.ok(/No MCP tools are currently available for this request/.test(block));
    assert.strictEqual(inventoryWires(block).length, 0, 'tool-less inventory leaked wires');
  });

  await test('A-03 refresh replaces the block (no stale wires survive)', async () => {
    const before = ai.mcpInventoryBlockForTools(EXPOSED.slice(0, 3), {});
    const prompt = ai.refreshInventoryPrompt(`SYS\n${before}\nEND`, ai.mcpInventoryBlockForTools([EXPOSED[3]], {}));
    assert.ok(prompt.includes('mcp_linear_save_issue'), 'fresh wire missing');
    assert.ok(!prompt.includes('mcp_linear_get_project'), 'stale wire survived refresh');
    assert.ok(!prompt.includes('mcp_linear_list_comments'), 'stale wire survived refresh');
  });

  await test('A-04 server failure lines name no tools', async () => {
    const block = ai.mcpInventoryBlockForTools([], {
      failures: [{ configId: 'cfg-9', reason: 'oauth expired' }]
    });
    assert.ok(/No MCP tools are currently available/.test(block));
    assert.ok(/authorize\/reconnect/i.test(block), 'authorization path missing');
    const { isManualApiFallbackProse } = require('../lib/llm/toolSelection');
    assert.ok(!isManualApiFallbackProse(block), 'manual-token fallback leaked');
  });

  await test('A-05 hyphenated MCP wire names are parsed whole (ASSERT-1 regression)', async () => {
    // Real server slugs/tools carry hyphens (e.g. notion-check-mcp-next-steps).
    // The parser must not truncate at the hyphen: truncation fabricated a
    // "leaked" ASSERT-1 mismatch for an advertised tool that was offered.
    const hyphen = mk('notion-connector', 'notion-check-mcp-next-steps',
      'Determine the next steps for a Notion page.');
    const block = ai.mcpInventoryBlockForTools([hyphen], {});
    const wires = inventoryWires(block);
    assert.ok(wires.includes('mcp_notion-connector_notion-check-mcp-next-steps'),
      `hyphenated wire truncated: ${wires.join(',')}`);
    assert.ok(!wires.some((n) => n === 'mcp_notion-connector_notion'),
      'parser dropped the hyphenated tail');
    // Exact-equality path the ASSERT-1 invariant relies on.
    const final = ai.mcpInventoryBlockForTools([hyphen], { failures: [] });
    assert.deepStrictEqual(inventoryWires(final), ['mcp_notion-connector_notion-check-mcp-next-steps']);
  });

  await test('A-06 hyphenated wire survives 64-tool selection + inventory equality', async () => {
    const hyphen = mk('notion-connector', 'notion-check-mcp-next-steps',
      'Determine the next steps for a Notion page.');
    const big = [hyphen, ...EXPOSED];
    for (let i = 0; i < 50; i += 1) {
      big.push(mk('linear', `aux_op_${i}`, `Perform auxiliary operation ${i} in the workspace.`));
    }
    const sel = selectToolSchemas(CREATE_Q, () => [], { mcpSchemas: big });
    assert.ok(sel.tools.length <= 6, `cap exceeded: ${sel.tools.length}`);
    assert.ok(names(sel.tools).includes('mcp_linear_save_issue'), 'mutation missing');
    const block = ai.mcpInventoryBlockForTools(sel.tools, {});
    assert.deepStrictEqual(
      inventoryWires(block).sort(),
      names(sel.tools).filter((n) => n.startsWith('mcp_')).sort(),
      'inventory/request.tools mismatch with hyphenated wires present');
  });

  // ---- B. create-issue selection ------------------------------------------------
  await test('B-01 CREATE(ISSUE) picks the issue mutation tool', async () => {
    const sel = selectToolSchemas(CREATE_Q, () => [], { mcpSchemas: EXPOSED });
    assert.ok(names(sel.tools).includes('mcp_linear_save_issue'), `missing: ${names(sel.tools)}`);
    assert.ok(sel.mcpCapability.includes('mcp_linear_save_issue'), 'mutation not capability-protected');
  });

  await test('B-02 project/comment/label tools do not crowd the CREATE cap', async () => {
    const sel = selectToolSchemas(CREATE_Q, () => [], { mcpSchemas: EXPOSED });
    for (const bad of ['mcp_linear_get_project', 'mcp_linear_list_comments', 'mcp_linear_list_project_labels']) {
      assert.ok(!names(sel.tools).includes(bad), `${bad} crowded the cap: ${names(sel.tools)}`);
      assert.ok(!(sel.mcpCapability || []).includes(bad), `${bad} capability-pinned`);
    }
  });

  // ---- C. save/upsert semantics ---------------------------------------------------
  await test('C-01 generic save tool declares CREATE+UPDATE when schema supports both', async () => {
    const caps = declareToolCapabilities(EXPOSED.find((s) => s.function.name === 'mcp_linear_save_issue'));
    assert.ok(caps.has('CREATE') && caps.has('UPDATE'), `got ${[...caps]}`);
  });

  await test('C-02 id-required update-only tool prefers UPDATE, never CREATE', async () => {
    const caps = declareToolCapabilities(mk('x', 'update_record', 'Update the record fields.',
      { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }));
    assert.ok(caps.has('UPDATE'), `got ${[...caps]}`);
    assert.ok(!caps.has('CREATE'), `CREATE invented: ${[...caps]}`);
  });

  await test('C-03 upsert verb classifies both capabilities', async () => {
    const caps = classifyIntentCapabilities('upsert the entry for this week');
    assert.ok(caps.has('CREATE') && caps.has('UPDATE'), `got ${[...caps]}`);
  });

  // ---- D. entity matching -----------------------------------------------------------
  await test('D-01 CREATE(ISSUE) is never satisfied by READ(PROJECT)', async () => {
    const sel = selectToolSchemas('Create an issue for the login bug', () => [], { mcpSchemas: EXPOSED });
    assert.ok(!(sel.mcpCapability || []).includes('mcp_linear_get_project'), `cross-entity pin: ${sel.mcpCapability}`);
  });

  await test('D-02 CREATE(ISSUE) is never satisfied by LIST(COMMENT)', async () => {
    const sel = selectToolSchemas('Create an issue for the login bug', () => [], { mcpSchemas: EXPOSED });
    assert.ok(!(sel.mcpCapability || []).includes('mcp_linear_list_comments'), `cross-entity pin: ${sel.mcpCapability}`);
  });

  await test('D-03 LIST(PROJECT) is never replaced by LIST(PROJECT_LABEL)', async () => {
    const sel = selectToolSchemas('List my projects', () => [], { mcpSchemas: EXPOSED });
    assert.ok(names(sel.tools).includes('mcp_linear_list_projects'), `missing: ${names(sel.tools)}`);
    assert.ok(!(sel.mcpCapability || []).includes('mcp_linear_list_project_labels'), `label swap: ${sel.mcpCapability}`);
  });

  await test('D-04 CREATE(ISSUE) is never satisfied by save_project', async () => {
    const sel = selectToolSchemas('Create an issue for the login bug', () => [], { mcpSchemas: EXPOSED });
    assert.ok(!(sel.mcpCapability || []).includes('mcp_linear_save_project'), `project mutation pin: ${sel.mcpCapability}`);
  });

  await test('D-05 CREATE(ISSUE) is never satisfied by get_issue', async () => {
    const sel = selectToolSchemas('Create an issue for the login bug', () => [], { mcpSchemas: EXPOSED });
    assert.ok(!(sel.mcpCapability || []).includes('mcp_linear_get_issue'), `reader pin: ${sel.mcpCapability}`);
  });

  await test('D-06 CREATE(ISSUE) is never satisfied by list_issues', async () => {
    const sel = selectToolSchemas('Create an issue for the login bug', () => [], { mcpSchemas: EXPOSED });
    assert.ok(!(sel.mcpCapability || []).includes('mcp_linear_list_issues'), `lister pin: ${sel.mcpCapability}`);
  });

  // ---- E. 6-tool pressure ---------------------------------------------------------------
  await test('E-01 mutation + resolver survive; unrelated dropped first', async () => {
    const filler = Array.from({ length: 20 }, (_, i) =>
      mk('linear', `aux_tool_${i}`, `Perform auxiliary operation ${i} in the workspace.`));
    const big = [...EXPOSED, ...filler];
    const sel = selectToolSchemas(CREATE_Q, () => [], { mcpSchemas: big });
    assert.ok(sel.tools.length <= 6, `cap exceeded: ${sel.tools.length}`);
    assert.ok(names(sel.tools).includes('mcp_linear_save_issue'), `mutation lost: ${names(sel.tools)}`);
    const trimmed = trimToolsToBudget(sel.tools, 60, {
      protectedNames: [...(sel.mcpExplicit || []), ...(sel.mcpCapability || [])]
    });
    assert.ok(names(trimmed).includes('mcp_linear_save_issue'), `mutation evicted: ${names(trimmed)}`);
    assert.ok(!names(trimmed).some((n) => n.includes('aux_tool')), `filler survived over mutation: ${names(trimmed)}`);
  });

  // ---- E2. reported production shape (64 tools + natives) -----------------------------------
  await test('E-02 production shape: mutation protected, project/label out, inventory exact', async () => {
    const big = [...EXPOSED];
    for (let i = 0; i < 53; i += 1) {
      big.push(mk('linear', `aux_op_${i}`, `Perform auxiliary operation ${i} in the workspace.`));
    }
    assert.strictEqual(big.length, 64);
    const native = () => [
      { function: { name: 'memorize', description: 'save a note' } },
      { function: { name: 'recallMemory', description: 'read a note' } },
      { function: { name: 'storeUserFact', description: 'store a fact' } }
    ];
    const sel = selectToolSchemas(CREATE_Q, native, { mcpSchemas: big });
    assert.ok(sel.tools.length <= 6, `cap exceeded: ${sel.tools.length}`);
    assert.ok(names(sel.tools).includes('mcp_linear_save_issue'), `mutation missing: ${names(sel.tools)}`);
    for (const bad of ['mcp_linear_get_project', 'mcp_linear_list_project_labels']) {
      assert.ok(!names(sel.tools).includes(bad), `${bad} crowded the cap: ${names(sel.tools)}`);
    }
    const b = assembleBudgetedRequest({
      systemTemplate: 'SYS __LONG_TERM_MEMORY_SLOT____RETRIEVAL_CONTEXT_SLOT__ END',
      baseUserText: CREATE_Q, query: CREATE_Q, selectedTools: sel.tools, outputBudget: 1200,
      mcpInventoryText: ai.mcpInventoryBlockForTools(sel.tools, {}),
      protectedToolNames: [...(sel.mcpExplicit || []), ...(sel.mcpCapability || [])]
    });
    assert.strictEqual(b.ok, true);
    assert.ok(names(b.tools).includes('mcp_linear_save_issue'), 'mutation lost in budget');
    const block = ai.mcpInventoryBlockForTools(b.tools, {});
    assert.deepStrictEqual(
      inventoryWires(block).sort(),
      names(b.tools).filter((n) => n.startsWith('mcp_')).sort(),
      'inventory/request.tools mismatch at 64-tool scale');
  });

  // ---- F. provider-mismatch defense ---------------------------------------------------------
  await test('F-01 missing-tool error shapes extract the wire name', async () => {
    assert.strictEqual(
      extractMissingToolName(new Error("attempted to call tool 'mcp_linear_list_issues' which was not in request.tools")),
      'mcp_linear_list_issues');
    assert.strictEqual(
      extractMissingToolName(new Error('Tool call validation failed: "mcp_linear_x" not in request.tools')),
      'mcp_linear_x');
    assert.strictEqual(extractMissingToolName(new Error('rate limited, try later')), null);
    assert.strictEqual(extractMissingToolName(null), null);
  });

  await test('F-02 exposed permitted tool resolves to an add-once spec', async () => {
    const tools = EXPOSED.slice(0, 6).filter((s) => s.function.name !== 'mcp_linear_list_issues');
    const err = new Error("attempted to call tool 'mcp_linear_list_issues' which was not in request.tools");
    const spec = ai.missingToolRetrySpec(err, tools, EXPOSED, []);
    assert.ok(spec && spec.name === 'mcp_linear_list_issues', 'no spec for exposed tool');
    assert.strictEqual(spec.schema.function.name, 'mcp_linear_list_issues', 'wrong schema resolved');
    assert.ok(spec.tools.length <= 6, 'cap grown by failsafe');
    assert.ok(names(spec.tools).includes('mcp_linear_list_issues'), 'missing tool not added');
  });

  await test('F-03 denied tool is never added by the failsafe', async () => {
    const tools = EXPOSED.filter((s) => s.function.name !== 'mcp_linear_list_issues');
    const blocked = EXPOSED.filter((s) => s.function.name === 'mcp_linear_list_issues');
    const err = new Error("attempted to call tool 'mcp_linear_list_issues' which was not in request.tools");
    // Denied == absent from the exposed set the caller passes.
    const spec = ai.missingToolRetrySpec(err, tools, tools, []);
    assert.strictEqual(spec, null, 'denied tool would be added');
    void blocked;
  });

  await test('F-04 unknown/already-offered names yield no spec', async () => {
    assert.strictEqual(
      ai.missingToolRetrySpec(new Error("attempted to call tool 'mcp_nope' which was not in request.tools"), EXPOSED.slice(0, 3), EXPOSED, []),
      null, 'unknown tool spec fabricated');
    const tools = [EXPOSED[3]];
    assert.strictEqual(
      ai.missingToolRetrySpec(new Error("attempted to call tool 'mcp_linear_save_issue' which was not in request.tools"), tools, EXPOSED, []),
      null, 'already-offered tool re-added');
  });

  // ---- G. continuation ------------------------------------------------------------------
  await test('G-01 active issue tool survives with a matching inventory', async () => {
    const prev = selectToolSchemas(CREATE_Q, () => [], { mcpSchemas: EXPOSED }).tools;
    const cont = selectContinuationTools(prev, ['mcp_linear_save_issue'], () => [], { mcpSchemas: EXPOSED });
    assert.ok(names(cont.tools).includes('mcp_linear_save_issue'), 'active tool lost');
    const block = ai.mcpInventoryBlockForTools(cont.tools, {});
    assert.deepStrictEqual(inventoryWires(block).sort(), names(cont.tools).filter((n) => n.startsWith('mcp_')).sort());
  });

  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`\nFAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
