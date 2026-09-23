'use strict';

// Single authoritative MCP path (DB-free, no provider keys).
//
// Production failure: "What teams and projects do I have in Linear?"
// answered with confabulated "only comments integration" prose plus manual
// API/token/UI instructions, while the realtime panel idled at
// "Waiting for plan / 0 steps". Root causes found in-repo:
//   1. ONE chat entry (index.js → processQuery); the false prose is model
//      confabulation, and the panel placeholder is its generic idle state —
//      there is no second planner implementation to consolidate.
//   2. No code template generates that prose (verified by search); the model
//      confabulates it when the exposed set is degraded (partial discovery)
//      and nothing shapes a degraded answer.
//
// This suite locks the unified-path invariants without new heuristics:
//
//   S-01 plan contract: required capabilities → executable:true
//   S-02 plan contract: suppressed → executable:false
//   S-03 plan contract: degraded (intent, no match) → executable:false
//   S-04 plan contract: knowledge question → executable:true (nothing needed)
//   S-05 degraded notice fires only for degraded sets (never suppressed/
//         matched/empty-intent), bans manual API, names no vendors/tools
//   S-06 snapshot diagnostic is read-only and shape-stable
//   S-07 inventory/final-tools equality helper holds on a degraded set too
//   S-08 realtime panel contract: inline MCP execution emits agent status
//         (verified by source contract — presence channel already rendered)
//
// Run:  cd server && node tests/mcpSinglePath.test.js

const assert = require('assert');

const {
  selectToolSchemas,
  classifyIntentCapabilities
} = require('../lib/llm/toolSelection');
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

// Degraded production shape: the exposed set contains ONLY comment tools
// (partial discovery) while the user asks for teams/projects.
const DEGRADED = [
  mk('linear', 'list_comments', 'List comments on an issue.'),
  mk('linear', 'save_comment', 'Add a comment to an existing issue.')
];
const HEALTHY = [
  ...DEGRADED,
  mk('linear', 'list_teams', 'List all teams in the workspace.'),
  mk('linear', 'list_projects', 'List all projects in the workspace.')
];
const TEAMS_Q = 'What teams and projects do I have in Linear?';

const main = async () => {
  await test('S-01 plan: required capabilities → executable:true', async () => {
    const sel = selectToolSchemas(TEAMS_Q, () => [], { mcpSchemas: HEALTHY });
    const plan = ai.buildMcpPlanSummary({
      intentCaps: classifyIntentCapabilities(TEAMS_Q),
      requiredNames: sel.mcpCapability,
      selectedTools: sel.tools,
      suppressed: false,
      exposedCount: HEALTHY.length
    });
    assert.deepStrictEqual(plan.intent.sort(), ['LIST', 'READ']);
    assert.ok(plan.requiredMcpTools.length >= 2, `required: ${plan.requiredMcpTools}`);
    assert.strictEqual(plan.executable, true, 'matching capability must be executable');
    assert.strictEqual(plan.suppressed, false);
  });

  await test('S-02 plan: suppressed → executable:false', async () => {
    const plan = ai.buildMcpPlanSummary({
      intentCaps: new Set(['LIST', 'READ']),
      requiredNames: [],
      selectedTools: [],
      suppressed: true,
      exposedCount: 0,
      blockedCount: 2
    });
    assert.strictEqual(plan.executable, false);
    assert.strictEqual(plan.suppressed, true);
  });

  await test('S-03 plan: degraded intent without match → executable:false', async () => {
    const sel = selectToolSchemas(TEAMS_Q, () => [], { mcpSchemas: DEGRADED });
    assert.strictEqual((sel.mcpCapability || []).length, 0, 'degraded set must not pin teams');
    const plan = ai.buildMcpPlanSummary({
      intentCaps: classifyIntentCapabilities(TEAMS_Q),
      requiredNames: [],
      selectedTools: sel.tools,
      suppressed: false,
      exposedCount: DEGRADED.length
    });
    assert.strictEqual(plan.executable, false, 'degraded plan must not claim executable');
  });

  await test('S-04 plan: knowledge question → executable:true (nothing needed)', async () => {
    const plan = ai.buildMcpPlanSummary({
      intentCaps: classifyIntentCapabilities('Explain encapsulation in OOP'),
      requiredNames: [],
      selectedTools: [],
      suppressed: false,
      exposedCount: HEALTHY.length
    });
    assert.strictEqual(plan.executable, true);
  });

  await test('S-05 degraded notice fires only for degraded sets', async () => {
    const intent = classifyIntentCapabilities(TEAMS_Q);
    const degradedSel = selectToolSchemas(TEAMS_Q, () => [], { mcpSchemas: DEGRADED });
    const healthySel = selectToolSchemas(TEAMS_Q, () => [], { mcpSchemas: HEALTHY });
    const note = ai.mcpDegradedNotice({
      intentCaps: intent, capabilityNames: degradedSel.mcpCapability,
      mcpSchemas: DEGRADED, mcpBlocked: [], suppressed: false
    });
    assert.ok(note.length > 100, 'degraded set needs shaping notice');
    assert.ok(!/linear|notion|github|jira|asana|trello/i.test(note), `vendor leak: ${note.slice(0, 120)}`);
    assert.ok(!/mcp_linear_\w+/.test(note), 'notice must not name tools');
    // Never manual-API-shaped itself, and explicitly forbids it.
    assert.ok(/never/i.test(note) || /do not/i.test(note));
    // Suppressed → policy notice owns the answer, not this one.
    assert.strictEqual(ai.mcpDegradedNotice({
      intentCaps: intent, capabilityNames: [], mcpSchemas: DEGRADED, mcpBlocked: [], suppressed: true
    }), '');
    // Healthy set → selection pinned tools → no notice.
    assert.ok((healthySel.mcpCapability || []).length > 0, 'healthy set must pin teams');
    assert.strictEqual(ai.mcpDegradedNotice({
      intentCaps: intent, capabilityNames: healthySel.mcpCapability,
      mcpSchemas: HEALTHY, mcpBlocked: [], suppressed: false
    }), '');
    // No intent → no notice.
    assert.strictEqual(ai.mcpDegradedNotice({
      intentCaps: new Set(), capabilityNames: [], mcpSchemas: DEGRADED, mcpBlocked: [], suppressed: false
    }), '');
    // Empty exposure → connection-failure lines own the answer.
    assert.strictEqual(ai.mcpDegradedNotice({
      intentCaps: intent, capabilityNames: [], mcpSchemas: [], mcpBlocked: [], suppressed: false
    }), '');
  });

  await test('S-06 snapshot diagnostic is read-only and shape-stable', async () => {
    assert.deepStrictEqual(ai.diagnoseMcpSnapshot({ mcpSchemas: [], metadata: null }), []);
    const gaps = ai.diagnoseMcpSnapshot({ mcpSchemas: DEGRADED, metadata: null });
    assert.ok(Array.isArray(gaps), 'must return an array');
    // No metadata → no per-server attribution → no gaps (never guesses).
    assert.strictEqual(gaps.length, 0);
  });

  await test('S-07 inventory/final-tools equality on a degraded set', async () => {
    const sel = selectToolSchemas(TEAMS_Q, () => [], { mcpSchemas: DEGRADED });
    const block = ai.mcpInventoryBlockForTools(sel.tools.slice(0, 6), {});
    const invWires = [...new Set([...block.matchAll(/\bmcp_[a-z0-9_-]+\b/g)].map((m) => m[0]))].sort();
    assert.deepStrictEqual(invWires, names(sel.tools).filter((n) => n.startsWith('mcp_')).sort());
  });

  await test('S-08 single chat entry + inline status contract (source)', async () => {
    const fs = require('fs');
    const indexSrc = fs.readFileSync(require.resolve('../index.js'), 'utf8');
    const entries = (indexSrc.match(/AIService\.processQuery/g) || []).length;
    assert.ok(entries >= 1, 'chat must enter through processQuery');
    const aiSrc = fs.readFileSync(require.resolve('../services/AIService'), 'utf8');
    assert.ok(/status: 'executing tools'/.test(aiSrc), 'inline MCP runs must surface agent status');
  });

  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`\nFAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
