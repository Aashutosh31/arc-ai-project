'use strict';

// Generic MCP capability-driven tool selection tests (DB-free).
//
// The lexical scorer only surfaces tools whose name/description tokens overlap
// the query, so a request like "Open the Notion page you just created and add
// a new section to it…" — which never mentions append/update — offers no write
// tool. This suite guards the generic capability layer that closes that gap:
//   - capability matrix: one natural-language request per capability class
//     must surface the matching synthetic tool, no vendor knowledge needed
//   - add-rule: "add a section to …" = UPDATE, "add a new page" = CREATE
//   - multi-step intent: "find … and update …" keeps every capability
//   - policy: capability picks still obey no-substitution suppression
//   - context budget: capability picks are protected like explicit picks
//   - continuation: capability tools survive the next turn
//   - explicit tool-name requests still win the first slot
//   - Notion regression: the exact production sentence now includes a write tool
//
// Run:  cd server && node tests/mcpCapabilitySelection.test.js

const assert = require('assert');

const {
  selectToolSchemas,
  selectContinuationTools,
  classifyIntentCapabilities,
  declareToolCapabilities
} = require('../lib/llm/toolSelection');
const { trimToolsToBudget } = require('../lib/llm/contextBudget');

const mk = (server, name, description) => ({
  type: 'function',
  function: {
    name: `mcp_${server}_${name}`,
    description,
    parameters: { type: 'object', properties: {}, required: [] }
  }
});

// Generic "team vault" server covering every capability class.
const VAULT = [
  mk('store', 'read_file', 'Read a file from the team vault by name.'),
  mk('store', 'search_files', 'Search files in the team vault by keyword.'),
  mk('store', 'list_files', 'List files available in the team vault.'),
  mk('store', 'create_file', 'Create a new file in the team vault.'),
  mk('store', 'update_file', 'Update an existing file in the team vault.'),
  mk('store', 'delete_file', 'Delete a file from the team vault.'),
  mk('store', 'upload_file', 'Upload a file into the team vault.'),
  mk('store', 'download_file', 'Download a file from the team vault.'),
  mk('store', 'execute_task', 'Run a scheduled task or job in the team vault.'),
  mk('msg', 'send_message', 'Send a message through the messaging service.')
];

// Notion-like server (synthetic — NOT the real Notion schemas).
const NOTION = [
  mk('notion', 'search', 'Search across all your pages and databases.'),
  mk('notion', 'get_page', 'Retrieve the properties and child blocks of a page.'),
  mk('notion', 'create_page', 'Create a new page.'),
  mk('notion', 'append_block_children', 'Append one or more block children to the last block array of a page.'),
  mk('notion', 'update_page', 'Update the properties or parent of a page.'),
  mk('notion', 'comment', 'Leave a comment on a page.'),
  mk('notion', 'delete_page', 'Delete (trash) a page.'),
  mk('notion', 'list_databases', 'List all available databases.')
];

const names = (tools) => (tools || []).map((s) => s?.function?.name).filter(Boolean);
const has = (tools, name) => names(tools).includes(name);
const sel = (text, exposed, blocked) =>
  selectToolSchemas(text, () => [], { mcpSchemas: exposed, mcpBlocked: blocked || [] });

let pass = 0;
let fail = 0;
const failures = [];

async function check(label, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok - ${label}`);
  } catch (err) {
    fail += 1;
    failures.push({ label, err });
    console.error(`  FAIL - ${label}`);
    console.error(`         ${err && err.message}`);
  }
}

async function run() {
  // ---- capability matrix ---------------------------------------------------
  const MATRIX = [
    ['M-01a read request selects a read tool', 'read the quarterly file', 'mcp_store_read_file', 'READ'],
    ['M-01b search request selects a search tool', 'find my file', 'mcp_store_search_files', 'SEARCH'],
    ['M-01c list request selects a list tool', 'list my files', 'mcp_store_list_files', 'LIST'],
    ['M-01d create request selects a create tool', 'create a new file for expenses', 'mcp_store_create_file', 'CREATE'],
    ['M-01e update request selects an update tool', 'edit the expenses file', 'mcp_store_update_file', 'UPDATE'],
    ['M-01f delete request selects a delete tool', 'delete the temp file', 'mcp_store_delete_file', 'DELETE'],
    ['M-01g send request selects a send tool', 'send a message to the team', 'mcp_msg_send_message', 'SEND'],
    ['M-01h upload request selects an upload tool', 'upload this file', 'mcp_store_upload_file', 'UPLOAD'],
    ['M-01i download request selects a download tool', 'download the report file', 'mcp_store_download_file', 'DOWNLOAD'],
    ['M-01j execute request selects an execute tool', 'run the monthly job', 'mcp_store_execute_task', 'EXECUTE']
  ];
  for (const [label, query, target] of MATRIX) {
    await check(label, () => {
      const pick = sel(query, VAULT);
      assert.ok(has(pick.tools, target), `missing ${target}: ${names(pick.tools)}`);
      assert.strictEqual(pick.tools.length, 1, `unexpected extras: ${names(pick.tools)}`);
      assert.ok(pick.tools.every((s) => s.function.name.startsWith('mcp_')), 'only MCP schemas');
      assert.strictEqual(pick.mcpSuppressed, false);
    });
  }

  // ---- add-rule: part/entity disambiguation ---------------------------------
  await check('M-02 "add a section to the page I just opened" = UPDATE + READ, no CREATE', () => {
    const pick = sel('add a section to the page I just opened', NOTION);
    const caps = classifyIntentCapabilities('add a section to the page I just opened');
    assert.ok(caps.has('UPDATE') && caps.has('READ'), `caps=${[...caps]}`);
    assert.ok(!caps.has('CREATE'), `CREATE misread: ${[...caps]}`);
    assert.ok(
      has(pick.tools, 'mcp_notion_append_block_children') || has(pick.tools, 'mcp_notion_update_page'),
      `no UPDATE tool offered: ${names(pick.tools)}`
    );
    assert.ok(has(pick.tools, 'mcp_notion_get_page'), `no READ tool offered: ${names(pick.tools)}`);
    assert.ok(!has(pick.tools, 'mcp_notion_create_page'), `CREATE tool offered: ${names(pick.tools)}`);
  });

  await check('M-03 "create a new page for the project" selects the create tool only', () => {
    const pick = sel('create a new page for the project', NOTION);
    assert.ok(has(pick.tools, 'mcp_notion_create_page'), names(pick.tools));
    assert.strictEqual(pick.tools.length, 1, names(pick.tools));
  });

  // ---- multi-step intent -----------------------------------------------------
  await check('M-04 "find the report file and update it" keeps SEARCH + UPDATE', () => {
    const pick = sel('find the report file and update it', VAULT);
    assert.ok(has(pick.tools, 'mcp_store_search_files'), `missing search: ${names(pick.tools)}`);
    assert.ok(has(pick.tools, 'mcp_store_update_file'), `missing update: ${names(pick.tools)}`);
    assert.ok(pick.tools.length <= 6, `cap: ${names(pick.tools)}`);
  });

  // ---- policy no-substitution still wins -------------------------------------
  await check('M-05 blocked update request suppresses ALL MCP tools', () => {
    const blocked = VAULT.filter((s) => s.function.name === 'mcp_store_update_file');
    const exposed = VAULT.filter((s) => s.function.name !== 'mcp_store_update_file');
    const pick = sel('update the expenses file', exposed, blocked);
    assert.strictEqual(pick.tools.length, 0, `substituted: ${names(pick.tools)}`);
    assert.strictEqual(pick.mcpSuppressed, true);
    assert.ok(Array.isArray(pick.mcpCapability) && pick.mcpCapability.length === 0, 'no capability picks when suppressed');
    assert.strictEqual(pick.mcpMatched, 0);
  });

  // ---- no capability verbs → nothing fires -----------------------------------
  await check('M-06 knowledge question matches no MCP tools', () => {
    const pick = sel('Explain encapsulation in OOP', VAULT);
    assert.strictEqual(pick.tools.length, 0);
    assert.strictEqual(classifyIntentCapabilities('Explain encapsulation in OOP').size, 0);
  });

  // ---- context budget protection ---------------------------------------------
  await check('M-07 capability pick survives crushing budget (protected)', () => {
    const pick = sel('Edit the roadmap page', NOTION);
    const cap = pick.mcpCapability[0];
    assert.ok(cap, `no capability pick: ${names(pick.tools)} / ${pick.mcpCapability}`);
    assert.ok(has(pick.tools, cap), `capability tool absent from tools: ${names(pick.tools)}`);
    const trimmed = trimToolsToBudget(pick.tools, 60, {
      protectedNames: [...(pick.mcpExplicit || []), ...pick.mcpCapability]
    });
    assert.ok(has(trimmed, cap), `capability tool evicted: ${names(trimmed)}`);
  });

  // ---- continuation ----------------------------------------------------------
  await check('M-08 continuation preserves capability tools after an active call', () => {
    const prev = sel('find the report file and update it', VAULT).tools;
    assert.ok(has(prev, 'mcp_store_update_file') && has(prev, 'mcp_store_search_files'));
    const cont = selectContinuationTools(
      prev, ['mcp_store_search_files'], () => [], { mcpSchemas: VAULT }
    );
    assert.ok(has(cont.tools, 'mcp_store_search_files'), 'active tool mandatory');
    assert.ok(has(cont.tools, 'mcp_store_update_file'), 'update tool preserved for the next step');
    assert.strictEqual(cont.mandatoryCount, 1);
  });

  // ---- emergent cap priority: actions before lookups --------------------------
  await check('M-09 action capabilities all present, lookup last under the cap', () => {
    const pick = sel('list my files, delete the temp file, and send a message', VAULT);
    assert.ok(has(pick.tools, 'mcp_store_delete_file'), names(pick.tools));
    assert.ok(has(pick.tools, 'mcp_msg_send_message'), names(pick.tools));
    assert.ok(has(pick.tools, 'mcp_store_list_files'), names(pick.tools));
    assert.ok(pick.tools.length <= 6);
  });

  // ---- intent classifier unit checks ------------------------------------------
  await check('M-10 add/create disambiguation unit checks', () => {
    assert.ok(classifyIntentCapabilities('add a section to the page').has('UPDATE'));
    assert.ok(classifyIntentCapabilities('add a new section to the page').has('UPDATE'));
    assert.ok(!classifyIntentCapabilities('add a new section to the page').has('CREATE'));
    assert.ok(classifyIntentCapabilities('add a new page').has('CREATE'));
    assert.ok(!classifyIntentCapabilities('add a new page').has('UPDATE'));
    assert.ok(classifyIntentCapabilities('create a page for the project').has('CREATE'));
    assert.ok(classifyIntentCapabilities('delete the test page').has('DELETE'));
    const multi = classifyIntentCapabilities('search for files and update them');
    assert.ok(multi.has('SEARCH') && multi.has('UPDATE'));
  });

  // ---- tool declarer unit checks ----------------------------------------------
  await check('M-11 declareToolCapabilities unit checks', () => {
    const update = declareToolCapabilities(mk('n', 'update_page', 'Update the properties or parent of a page.'));
    assert.ok(update.has('UPDATE') && !update.has('DELETE'), [...update].join(','));
    const del = declareToolCapabilities(mk('n', 'delete_page', 'Delete (trash) a page.'));
    assert.ok(del.has('DELETE') && !del.has('UPDATE'), [...del].join(','));
    const read = declareToolCapabilities(mk('n', 'get_page', 'Retrieve the properties and child blocks of a page.'));
    assert.ok(read.has('READ'), [...read].join(','));
    const append = declareToolCapabilities(mk('n', 'append_block_children', 'Append one or more block children.'));
    assert.ok(append.has('UPDATE'), [...append].join(','));
  });

  // ---- Notion regression (the exact production sentence) ----------------------
  await check('M-12 regression: "Open the Notion page you just created and add a new section…" offers a write tool', () => {
    const q = 'Open the Notion page you just created and add a new section to it with the key points about ARC.';
    const pick = sel(q, NOTION);
    assert.ok(
      has(pick.tools, 'mcp_notion_append_block_children') || has(pick.tools, 'mcp_notion_update_page'),
      `no write tool offered, only ${names(pick.tools)}`
    );
    assert.ok(has(pick.tools, 'mcp_notion_get_page'), `no read tool: ${names(pick.tools)}`);
    assert.ok(pick.tools.length <= 6, `cap: ${names(pick.tools)}`);
    assert.ok(pick.tools.every((s) => s.function.name.startsWith('mcp_')), 'only MCP schemas');
  });

  // ---- explicit tool-name request still wins the first slot -------------------
  await check('M-13 explicit tool name still wins the first slot over capability picks', () => {
    const pick = sel('add a section to it using mcp_notion_append_block_children', NOTION);
    assert.strictEqual(names(pick.tools)[0], 'mcp_notion_append_block_children', names(pick.tools));
    assert.ok((pick.mcpExplicit || []).includes('mcp_notion_append_block_children'));
  });

  console.log(`\n${pass + fail} tests, ${pass} passed, ${fail} failed`);
  if (fail) {
    for (const f of failures) console.error(`\nFAILED: ${f.label}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
}

run().catch((err) => { console.error(err); process.exitCode = 1; });