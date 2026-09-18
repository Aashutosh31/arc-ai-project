'use strict';

// MCP server scope + identifier-gated feasibility (DB-free).
//
// Production failure: "What teams and projects do I have in Linear?"
// executed mcp_notion_notion-get-teams (COMPLETED, wrong server) and
// mcp_linear_list_comments (FAILED, identifier-gated) while the correct
// mcp_linear_list_teams / mcp_linear_list_projects existed. Two missing
// pieces, both generic (no vendor names anywhere in implementation):
//   1. explicit server mention ("in Linear") never bound candidate tools
//      to that server — a same-entity foreign tool could win;
//   2. identifier-gated tools (required ids, or oneOf/anyOf where every
//      branch demands one) ranked alongside parameter-free enumerators.
//
//   1. Explicit Linear scope excludes Notion tools.
//   2. Explicit Notion scope excludes Linear tools.
//   3. LIST(TEAM) prefers lister over getter.
//   4. LIST(PROJECT) prefers lister over getter.
//   5. Identifier-required tools are excluded when arguments unavailable.
//   6. list_comments cannot satisfy LIST(TEAM).
//   7. list_comments cannot satisfy LIST(PROJECT).
//   8. selected MCP tools all belong to the requested server scope.
//   9. preflight plan and actual execution have identical server/tool scope.
//   10. existing MCP policy/deny behavior remains unchanged.
//
// Run:  cd server && node tests/mcpServerScope.test.js

const assert = require('assert');
const z = require('zod');
const { McpServer } = require('@modelcontextprotocol/server');
const { InMemoryTransport } = require('@modelcontextprotocol/client');

const { McpToolSource, McpManager, McpRegistry } = require('../lib/mcp');
const {
  selectToolSchemas,
  detectMcpServerScope,
  mcpServerKeyOf,
  requiresTargetId
} = require('../lib/llm/toolSelection');
const TaskExecutor = require('../services/TaskExecutor');
const ai = require('../services/AIService');

const passed = [];
const failed = [];
const test = (name, fn) => (async () => {
  try { await fn(); passed.push(name); console.log(`  ok - ${name}`); }
  catch (err) { failed.push({ name, err }); console.error(`  FAIL - ${name}`); console.error(`         ${err && err.message}`); }
})();

const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });
const J = (v) => text(JSON.stringify(v));

// Two live servers behind one registry, exactly like production.
const createLinearServer = () => {
  const server = new McpServer({ name: 'linear-shaped', version: '1.0.0' });
  server.registerTool('list_teams',
    { description: 'List all teams in the workspace.', inputSchema: z.object({}) },
    async () => J([{ id: 'team-1', name: 'Engineering' }]));
  server.registerTool('list_projects',
    { description: 'List all projects in the workspace.', inputSchema: z.object({}) },
    async () => J([{ id: 'proj-1', name: 'ARC-AI' }]));
  server.registerTool('get_team',
    { description: 'Retrieve a single team by identifier.', inputSchema: z.object({ teamId: z.string() }) },
    async ({ teamId }) => J({ id: teamId, name: 'Engineering' }));
  server.registerTool('list_comments',
    { description: 'List comments. Provide exactly one of issueId, projectId, initiativeId, documentId, milestoneId, or statusUpdateId.',
      inputSchema: z.object({ issueId: z.string().optional() }) },
    async () => ({ content: [{ type: 'text', text: 'Provide exactly one of issueId, projectId, initiativeId, documentId, milestoneId, or statusUpdateId' }], isError: true }));
  return server;
};

const createNotionServer = () => {
  const server = new McpServer({ name: 'notion-shaped', version: '1.0.0' });
  server.registerTool('notion-get-teams',
    { description: 'Retrieves a list of teams (teamspaces) in the current workspace.', inputSchema: z.object({}) },
    async () => J([{ id: 'nt-1', name: 'Notion Team' }]));
  return server;
};

const names = (tools) => (tools || []).map((s) => s?.function?.name).filter(Boolean);
const EXEC_OPTS = { workspaceId: 'ws-scope', skipCreditCharge: true };
const NATIVE = () => [
  { function: { name: 'memorize', description: 'save a note' } },
  { function: { name: 'recallMemory', description: 'read a note' } },
  { function: { name: 'storeUserFact', description: 'store a fact' } }
];
const TEAMS_Q = 'What teams and projects do I have in Linear?';

let schemas = [];
let linearServer = null;
let notionServer = null;

const main = async () => {
  const registry = new McpRegistry();
  const manager = new McpManager({ registry });
  McpToolSource.init({ manager, registry });
  linearServer = createLinearServer();
  notionServer = createNotionServer();
  const [lc, ls] = InMemoryTransport.createLinkedPair();
  const [nc, ns] = InMemoryTransport.createLinkedPair();
  await linearServer.connect(ls);
  await notionServer.connect(ns);
  registry.register({
    id: 'scope-linear', name: 'Linear', scope: 'global', transport: 'stdio',
    testHooks: { createTransport: () => lc }
  });
  registry.register({
    id: 'scope-notion', name: 'Notion', scope: 'global', transport: 'stdio',
    testHooks: { createTransport: () => nc }
  });
  schemas = (await McpToolSource.schemasForRequest({ workspaceId: 'ws-scope', isGuest: false })).schemas;
  assert.ok(schemas.some((s) => s.function.name === 'mcp_linear_list_teams'));
  assert.ok(schemas.some((s) => s.function.name === 'mcp_notion_notion-get-teams'));

  await test('1. Explicit Linear scope excludes Notion tools', async () => {
    const scope = detectMcpServerScope(TEAMS_Q, schemas);
    assert.deepStrictEqual(scope, ['linear'], `scope: ${JSON.stringify(scope)}`);
    const sel = selectToolSchemas(TEAMS_Q, NATIVE, { mcpSchemas: schemas, serverScope: scope });
    assert.ok(!names(sel.tools).some((n) => n.startsWith('mcp_notion_')), `notion leaked: ${names(sel.tools)}`);
    assert.ok(!(sel.mcpCapability || []).some((n) => n.startsWith('mcp_notion_')), 'notion capability-pinned');
    assert.ok(names(sel.tools).includes('mcp_linear_list_teams'), 'linear lister missing');
    assert.ok(names(sel.tools).includes('mcp_linear_list_projects'), 'linear projects missing');
  });

  await test('2. Explicit Notion scope excludes Linear tools', async () => {
    const q = 'Open the Notion page called Roadmap';
    const scope = detectMcpServerScope(q, schemas);
    assert.deepStrictEqual(scope, ['notion'], `scope: ${JSON.stringify(scope)}`);
    const sel = selectToolSchemas(q, NATIVE, { mcpSchemas: schemas, serverScope: scope });
    assert.ok(!names(sel.tools).some((n) => n.startsWith('mcp_linear_')), `linear leaked: ${names(sel.tools)}`);
  });

  await test('3. LIST(TEAM) prefers lister over getter', async () => {
    const sel = selectToolSchemas('What teams do I have in Linear?', NATIVE, {
      mcpSchemas: schemas, serverScope: ['linear']
    });
    assert.ok(names(sel.tools).includes('mcp_linear_list_teams'));
    const idxLister = names(sel.tools).indexOf('mcp_linear_list_teams');
    const idxGetter = names(sel.tools).indexOf('mcp_linear_get_team');
    if (idxGetter >= 0) {
      assert.ok(idxLister < idxGetter, `getter outranks lister: ${names(sel.tools)}`);
    }
  });

  await test('4. LIST(PROJECT) prefers lister over getter', async () => {
    const sel = selectToolSchemas(TEAMS_Q, NATIVE, { mcpSchemas: schemas, serverScope: ['linear'] });
    assert.ok((sel.mcpCapability || []).includes('mcp_linear_list_projects'));
  });

  await test('5. Identifier-required tools are excluded when arguments unavailable', async () => {
    const gated = schemas.find((s) => s.function.name === 'mcp_linear_get_team');
    assert.ok(requiresTargetId(gated), 'get_team must read as identifier-gated');
    assert.ok(!requiresTargetId(schemas.find((s) => s.function.name === 'mcp_linear_list_teams')), 'lister must read as feasible');
    // Unscoped behavior preserved: the getter may still appear (ranked low),
    // but the lister leads.
    const sel = selectToolSchemas('What teams do I have in Linear?', NATIVE, { mcpSchemas: schemas });
    assert.ok(names(sel.tools).includes('mcp_linear_list_teams'));
  });

  await test('6. list_comments cannot satisfy LIST(TEAM)', async () => {
    const sel = selectToolSchemas('What teams do I have in Linear?', NATIVE, {
      mcpSchemas: schemas, serverScope: ['linear']
    });
    assert.ok(!(sel.mcpCapability || []).includes('mcp_linear_list_comments'), 'comment lister pinned for teams');
  });

  await test('7. list_comments cannot satisfy LIST(PROJECT)', async () => {
    const sel = selectToolSchemas('What projects do I have in Linear?', NATIVE, {
      mcpSchemas: schemas, serverScope: ['linear']
    });
    assert.ok(!(sel.mcpCapability || []).includes('mcp_linear_list_comments'), 'comment lister pinned for projects');
  });

  await test('8. selected MCP tools all belong to the requested server scope', async () => {
    const sel = selectToolSchemas(TEAMS_Q, NATIVE, { mcpSchemas: schemas, serverScope: ['linear'] });
    const scoped = names(sel.tools).filter((x) => x.startsWith('mcp_'));
    assert.ok(scoped.length > 0, 'no MCP tools selected');
    for (const n of scoped) {
      assert.strictEqual(mcpServerKeyOf({ function: { name: n } }), 'linear', `${n} out of scope`);
    }
  });

  await test('9. preflight plan and actual execution have identical server/tool scope', async () => {
    const sel = selectToolSchemas(TEAMS_Q, NATIVE, { mcpSchemas: schemas, serverScope: ['linear'] });
    const tools = sel.tools.slice(0, 6);
    const required = ai.requiredMcpSchemas({ mcpCapability: sel.mcpCapability }, [], tools);
    const execCalls = [];
    const execFn = async (n, a) => {
      execCalls.push(n);
      return TaskExecutor.executeTool(n, a, 'user-1', null, EXEC_OPTS);
    };
    const out = await ai.runMcpPreflight({
      requiredSchemas: required, tools, baseText: TEAMS_Q,
      intentCaps: new Set(['LIST', 'READ']), execFn,
      socket: null, workspaceId: 'ws-scope', signal: null, title: TEAMS_Q,
      serverScope: ['linear']
    });
    assert.strictEqual(out.plan.executable, true);
    assert.deepStrictEqual(out.plan.serverScope, ['linear']);
    assert.ok(out.executed.length >= 2, 'both lists must execute');
    for (const e of out.executed) {
      assert.strictEqual(mcpServerKeyOf({ function: { name: e.name } }), 'linear', `${e.name} executed out of scope`);
      assert.strictEqual(e.content.success, true, `${e.name} failed`);
    }
    assert.ok(execCalls.includes('mcp_linear_list_teams'));
    assert.ok(execCalls.includes('mcp_linear_list_projects'));
    assert.ok(!execCalls.some((n) => n.startsWith('mcp_notion_')), 'foreign server executed');
    // Out-of-scope required entries are rejected before TaskExecutor.
    const bad = await ai.runMcpPreflight({
      requiredSchemas: [
        schemas.find((s) => s.function.name === 'mcp_linear_list_teams'),
        schemas.find((s) => s.function.name === 'mcp_notion_notion-get-teams')
      ],
      tools, baseText: TEAMS_Q, intentCaps: new Set(['LIST', 'READ']), execFn,
      socket: null, workspaceId: 'ws-scope', signal: null, title: TEAMS_Q,
      serverScope: ['linear']
    });
    assert.ok(bad.executed.every((e) => !e.name.startsWith('mcp_notion_')), 'foreign tool executed despite scope');
    assert.ok(bad.executed.some((e) => e.name === 'mcp_linear_list_teams'), 'in-scope tool dropped');
  });

  await test('11. fragmented identities share one scope (linear ~ linearmcp)', async () => {
    const { mcpScopeMatches } = require('../lib/llm/toolSelection');
    assert.strictEqual(mcpScopeMatches('linear', 'linear'), true);
    assert.strictEqual(mcpScopeMatches('linear', 'linearmcp'), true, 'suffixed identity must match');
    assert.strictEqual(mcpScopeMatches('linear', 'linear_mcp'), true, 'segmented identity must match');
    assert.strictEqual(mcpScopeMatches('linear', 'mcp_linear'), true, 'prefixed identity must match');
    assert.strictEqual(mcpScopeMatches('linear', 'notion'), false, 'foreign integration must never match');
    assert.strictEqual(mcpScopeMatches('linear', 'github'), false);
    assert.strictEqual(mcpScopeMatches('git', 'github'), false, 'short mention must not over-match');
    assert.strictEqual(mcpScopeMatches('arc', 'arcade'), false, 'short mention must not over-match');
    const mkFrag = (slug, name, desc) => ({
      type: 'function',
      function: { name, description: desc, parameters: { type: 'object', properties: {}, required: [] } },
      mcpMetadata: { slug }
    });
    const frag = [
      mkFrag('linearmcp', 'mcp_linearmcp_save_issue', 'Create a new issue or update an existing one.'),
      mkFrag('linear', 'mcp_linear_list_comments', 'List comments on an issue.'),
      mkFrag('notion', 'mcp_notion_search', 'Search pages.')
    ];
    assert.deepStrictEqual(detectMcpServerScope('Create a Linear issue', frag).sort(), ['linear', 'linearmcp']);
    assert.deepStrictEqual(detectMcpServerScope('Search Notion', frag), ['notion']);
  });

  await test('12. fragmented mutation stays selectable for CREATE(ISSUE)', async () => {
    const mkFrag = (slug, name, desc) => ({
      type: 'function',
      function: { name, description: desc, parameters: { type: 'object', properties: {}, required: [] } },
      mcpMetadata: { slug }
    });
    const frag = [
      mkFrag('linearmcp', 'mcp_linearmcp_save_issue', 'Create a new issue or update an existing one.'),
      mkFrag('linear', 'mcp_linear_save_comment', 'Add a comment to an existing issue.'),
      mkFrag('linear', 'mcp_linear_list_comments', 'List comments on an issue.')
    ];
    const sel = selectToolSchemas("Create a Linear issue called 'X'", NATIVE, { mcpSchemas: frag, serverScope: ['linear'] });
    assert.ok(sel.mcpCapability.includes('mcp_linearmcp_save_issue'), `fragmented mutation dropped: ${sel.mcpCapability}`);
    assert.ok(!sel.mcpCapability.includes('mcp_linear_save_comment'), 'comment tool pinned for CREATE');
    assert.ok(!sel.mcpCapability.includes('mcp_linear_list_comments'), 'comment reader pinned for CREATE');
  });

  await test('10. existing MCP policy/deny behavior remains unchanged', async () => {
    const { McpManager: M2, McpRegistry: R2 } = require('../lib/mcp');
    const { InMemoryTransport: T2 } = require('@modelcontextprotocol/client');
    const registry2 = new R2();
    const manager2 = new M2({ registry: registry2 });
    McpToolSource.init({ manager: manager2, registry: registry2 });
    const srv2 = createLinearServer();
    const [c2, s2] = T2.createLinkedPair();
    await srv2.connect(s2);
    registry2.register({
      id: 'scope-denied', name: 'Linear', scope: 'global', transport: 'stdio',
      deniedTools: ['mcp_linear_list_teams'], testHooks: { createTransport: () => c2 }
    });
    const deniedPick = await McpToolSource.schemasForRequest({ workspaceId: 'ws-scope', isGuest: false });
    assert.ok(!deniedPick.schemas.some((s) => s.function.name === 'mcp_linear_list_teams'), 'denied tool exposed');
    const sel = selectToolSchemas(TEAMS_Q, NATIVE, {
      mcpSchemas: deniedPick.schemas, mcpBlocked: deniedPick.blocked, serverScope: ['linear']
    });
    assert.ok(!names(sel.tools).includes('mcp_linear_list_teams'), 'denied tool selected');
    const res = await TaskExecutor.executeTool('mcp_linear_list_teams', {}, 'user-1', null, EXEC_OPTS);
    assert.strictEqual(res.success, false, 'denied tool executed');
    await McpToolSource.shutdown();
    try { await srv2.close(); } catch { /* best effort */ }
    try { await linearServer.close(); } catch { /* best effort */ }
    try { await notionServer.close(); } catch { /* best effort */ }
    linearServer = null;
    notionServer = null;
  });

  await McpToolSource.shutdown().catch(() => {});
  try { if (linearServer) await linearServer.close(); } catch { /* best effort */ }
  try { if (notionServer) await notionServer.close(); } catch { /* best effort */ }

  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`\nFAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
