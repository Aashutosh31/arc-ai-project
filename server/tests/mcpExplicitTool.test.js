'use strict';

// MCP explicit-tool regression tests (DB-free) — production Groq 400:
//
//   "Tool call validation failed: attempted to call tool
//    'mcp_mcp_reference_annotatedMessage' which was not in request.tools"
//
// Root cause: an explicitly requested, policy-permitted MCP tool had NO
// guaranteed slot in request.tools. It could be omitted three ways, all
// reproduced here against the REAL pipeline:
//   (a) 6-slot cap filled by native groups before scored MCP append;
//   (b) context-budget trim evicting MCP first (unknown-group rank last);
//   (c) continuation lookup covering only prev tools + native registry,
//       so an active mcp_... tool absent from prev had mandatory=0 while the
//       continuation messages still referenced it.
// The model then called the user-named tool anyway; Groq rejects server-side.
//
// Run:  cd server && node tests/mcpExplicitTool.test.js

const assert = require('assert');

const {
  selectToolSchemas,
  selectContinuationTools,
  matchExplicitMcpSchemas,
  partitionToolCallsByExposure
} = require('../lib/llm/toolSelection');
const {
  trimToolsToBudget,
  assembleBudgetedRequest,
  estToolsTokens
} = require('../lib/llm/contextBudget');
const toolRegistry = require('../tools/index');

const ALL_NATIVE = toolRegistry.getSchemas();

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

// 9-tool reference-server fixture: slug `mcp_reference`, mixed naming
// patterns (camelCase annotatedMessage/getTinyImage, snake_case rest).
const mkMcp = (tool, description) => ({
  type: 'function',
  function: {
    name: `mcp_mcp_reference_${tool}`,
    description,
    parameters: { type: 'object', properties: {}, required: [] }
  }
});
const TARGET = 'mcp_mcp_reference_annotatedMessage';
const MCP9 = [
  mkMcp('annotatedMessage', 'Render an annotated message card in the chat UI.'),
  mkMcp('getTinyImage', 'Fetch a tiny placeholder image for UI previews.'),
  mkMcp('renderCard', 'Render a generic UI card with title and body.'),
  mkMcp('showVideo', 'Embed a short video preview in the chat surface.'),
  mkMcp('playSound', 'Play a short notification sound for the user.'),
  mkMcp('openMapView', 'Open an interactive map view centered on coordinates.'),
  mkMcp('listFiles', 'List files available in the reference sandbox.'),
  mkMcp('readFile', 'Read a file from the reference sandbox by name.'),
  mkMcp('getStatus', 'Return the reference server health status.')
];
const APPS_WORLD = {
  type: 'function',
  function: {
    name: 'mcp_apps_hello_world',
    description: 'Say hello from the apps demo server.',
    parameters: { type: 'object', properties: {}, required: [] }
  }
};

const names = (tools) => (tools || []).map((s) => s?.function?.name).filter(Boolean);
const sel = (text, exposed = MCP9, blocked = []) =>
  selectToolSchemas(text, () => ALL_NATIVE, { mcpSchemas: exposed, mcpBlocked: blocked });

async function run() {
  // 1. Explicit MCP tool-name request is included in request.tools.
  await check('E-01 explicit wire-name request includes annotatedMessage', () => {
    const pick = sel('Please call mcp_mcp_reference_annotatedMessage to show the card.');
    assert.ok(names(pick.tools).includes(TARGET), `tools=${names(pick.tools)}`);
    assert.ok((pick.mcpExplicit || []).includes(TARGET), 'reported as explicit');
    assert.strictEqual(names(pick.tools)[0], TARGET, 'explicit tool takes first slot');
  });

  // 2. CamelCase / separator / case variants survive normalization.
  await check('E-02 camelCase + separator + space variants all match', () => {
    const variants = [
      'call MCP_MCP_REFERENCE_annotatedMessage now',
      'call mcp-mcp-reference-annotated-message now',
      'please use the annotatedMessage tool from the reference server',
      'show me an annotated message via MCP'
    ];
    for (const q of variants) {
      const direct = matchExplicitMcpSchemas(q, MCP9);
      assert.ok(direct.some((s) => s.function.name === TARGET), `variant missed: ${q}`);
      const pick = sel(q);
      assert.ok(names(pick.tools).includes(TARGET), `selection missed variant: ${q}`);
    }
    // Other naming patterns: camelCase getTinyImage, snake mcp_apps_hello_world.
    assert.ok(names(sel('fetch it with getTinyImage').tools).includes('mcp_mcp_reference_getTinyImage'));
    assert.ok(names(sel('run mcp_apps_hello_world please', [...MCP9, APPS_WORLD]).tools).includes('mcp_apps_hello_world'));
  });

  await check('E-03 short everyday words never force-include (no false positives)', () => {
    // "echo ... working" must not explicit-match a short tool; scoring path untouched.
    const tiny = [{ type: 'function', function: { name: 'mcp_sel_echo', description: 'Echo text.', parameters: {} } }];
    assert.deepStrictEqual(matchExplicitMcpSchemas('Use the MCP echo tool to echo hello.', tiny), []);
    assert.deepStrictEqual(matchExplicitMcpSchemas('Explain encapsulation in OOP', MCP9), []);
  });

  await check('E-04 explicit tool survives a cap filled by native groups', () => {
    const pick = sel('Remember this: search the web for the latest news about time and weather, and call mcp_mcp_reference_annotatedMessage');
    assert.ok(pick.tools.length <= 6, 'cap intact');
    assert.ok(names(pick.tools).includes(TARGET), `crowded out: ${names(pick.tools)}`);
  });

  // 3. Context budget pressure retains the explicit tool, drops unrelated tools.
  await check('E-05 trim keeps explicit tool at crushing budgets, drops the rest', () => {
    const pick = sel('Please call mcp_mcp_reference_annotatedMessage to show the card.');
    assert.ok(names(pick.tools).length > 1, 'needs filler tools to trim');
    for (const budget of [400, 200, 100]) {
      const trimmed = trimToolsToBudget(pick.tools, budget, { protectedNames: pick.mcpExplicit });
      assert.ok(names(trimmed).includes(TARGET), `budget=${budget} dropped explicit: ${names(trimmed)}`);
      assert.ok(trimmed.length < pick.tools.length, `budget=${budget} trimmed nothing`);
    }
    // Unprotected trim behavior unchanged: MCP still ranks last without protection.
    const bare = trimToolsToBudget(pick.tools, estToolsTokens(pick.tools.filter((s) => !s.function.name.startsWith('mcp_'))));
    assert.ok(!names(bare).some((n) => n.startsWith('mcp_')), 'unprotected trim still evicts MCP first');
  });

  await check('E-06 budgeted pipeline retains explicit tool under memory+doc pressure', () => {
    const q = 'Please call mcp_mcp_reference_annotatedMessage to show the card.';
    const pick = sel(q);
    const bigMems = Array.from({ length: 20 }, (_, i) => ({
      query: `long user question number ${i} with padding padding padding`,
      response: `long assistant answer number ${i} with padding padding padding`,
      timestamp: new Date()
    }));
    const budgeted = assembleBudgetedRequest({
      systemTemplate: 'sys __LONG_TERM_MEMORY_SLOT____RETRIEVAL_CONTEXT_SLOT__',
      baseUserText: q,
      docText: 'x'.repeat(9000),
      memoryDocs: bigMems,
      factDocs: [],
      ragItems: [],
      selectedTools: pick.tools,
      outputBudget: 1200,
      query: q,
      protectedToolNames: pick.mcpExplicit
    });
    assert.ok(budgeted.ok, 'pipeline fits');
    assert.ok(names(budgeted.tools).includes(TARGET), `pipeline dropped explicit: ${names(budgeted.tools)}`);
  });

  // 4. Continuation preserves an active MCP tool absent from the previous set.
  await check('E-07 continuation recovers active MCP tool via mcpSchemas', () => {
    const prev = sel('Explain encapsulation in OOP').tools; // native trio, no MCP
    assert.ok(!names(prev).includes(TARGET), 'precondition: target absent from prev');
    const cont = selectContinuationTools(prev, [TARGET], () => ALL_NATIVE, { mcpSchemas: MCP9 });
    assert.ok(names(cont.tools).includes(TARGET), `continuation dropped active: ${names(cont.tools)}`);
    assert.strictEqual(cont.mandatoryCount, 1, 'active tool is mandatory');
    // Invariant holds on the healed continuation set.
    const exposure = partitionToolCallsByExposure(
      [{ id: 'call-1', function: { name: TARGET, arguments: {} } }],
      cont.tools
    );
    assert.deepStrictEqual(exposure.unexposedNames, [], 'no unexposed continuation calls');
  });

  await check('E-08 continuation still resolves active tools from prev (no regression)', () => {
    const prev = sel('Please call mcp_mcp_reference_annotatedMessage to show the card.').tools;
    const cont = selectContinuationTools(prev, [TARGET], () => ALL_NATIVE, { mcpSchemas: MCP9 });
    assert.ok(names(cont.tools).includes(TARGET));
  });

  // 5. Denied tool explicitly named is NOT reintroduced.
  await check('E-09 denied MCP tool stays excluded even when explicitly named', () => {
    const blocked = MCP9.filter((s) => s.function.name === TARGET);
    const exposed = MCP9.filter((s) => s.function.name !== TARGET);
    const pick = sel('Please call mcp_mcp_reference_annotatedMessage to show the card.', exposed, blocked);
    assert.ok(!names(pick.tools).includes(TARGET), 'denied tool reintroduced!');
    assert.ok(!names(pick.tools).some((n) => n.startsWith('mcp_')), 'no substitute MCP offered');
    assert.strictEqual(pick.mcpSuppressed, true, 'suppression still flagged');
    // Continuation must not heal a denied tool either.
    const cont = selectContinuationTools(pick.tools, [TARGET], () => ALL_NATIVE, { mcpSchemas: exposed });
    assert.ok(!names(cont.tools).includes(TARGET), 'continuation reintroduced denied tool!');
  });

  // 6. Tool-call exposure invariant helper.
  await check('E-10 partitionToolCallsByExposure flags calls missing from request.tools', () => {
    const tools = sel('Please call mcp_mcp_reference_annotatedMessage.').tools;
    const calls = [
      { id: 'a', function: { name: TARGET, arguments: {} } },
      { id: 'b', function: { name: 'mcp_mcp_reference_readFile', arguments: {} } }
    ];
    const part = partitionToolCallsByExposure(calls, tools);
    assert.strictEqual(part.exposedCalls.length, 1, 'exactly the offered call is exposed');
    assert.deepStrictEqual(part.unexposedNames, ['mcp_mcp_reference_readFile']);
    assert.deepStrictEqual(partitionToolCallsByExposure([], tools).unexposedNames, []);
  });

  console.log(`\n${pass + fail} tests, ${pass} passed, ${fail} failed`);
  if (fail) {
    for (const f of failures) console.error(`\nFAILED: ${f.label}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
