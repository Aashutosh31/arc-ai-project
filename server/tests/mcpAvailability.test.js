'use strict';

// MCP availability + execution acceptance (DB-free, no provider keys).
//
// Production failure under test: an authorized 64-tool integration shows
// CONNECTED + authorized + discovered, yet the agent answers "I have no
// tool" and suggests a manual API token / vendor UI / GraphQL instead of
// calling the exposed tool.
//
// This suite proves the fix through the REAL pipeline against a live
// 64-tool integration served in-memory (same McpServer + transport +
// McpManager + registry + TaskExecutor path production uses; only the
// remote end is local because no live OAuth credentials exist here):
//
//   V-01 inventory is explicit, bounded, secret-free, same-source
//   V-02 "teams and projects" selects + EXECUTES both list tools (multi)
//   V-03 "find open issues" executes a real search/read tool
//   V-04 create executes exactly once and returns the created identity
//   V-05 comment executes against the created issue
//   V-06 update executes against the created issue
//   V-07 complete executes against the created issue (no repeated id)
//   V-08 working-state continuity resolves follow-up refs
//   V-09 selected schemas survive provider tool-def construction
//   V-10 write picks survive crushing context budgets (protected)
//   V-11 denied tool: never selected, never executes (deny-wins)
//   V-12 unauthorized (no exposure): no forced pick, empty inventory
//   V-13 prose guards: false-unavailable + manual-token shapes detected
//   V-14 generic nouns never drive cross-capability substitution
//   V-15 generic vocabulary covers every capability class
//
// Run:  cd server && node tests/mcpAvailability.test.js

const assert = require('assert');
const z = require('zod');
const { McpServer } = require('@modelcontextprotocol/server');
const { InMemoryTransport } = require('@modelcontextprotocol/client');

const { McpToolSource, McpManager, McpRegistry } = require('../lib/mcp');
const {
  selectToolSchemas,
  classifyIntentCapabilities,
  declareToolCapabilities,
  buildMcpCapabilityInventory,
  reselectMcpCapabilities,
  isNoToolAvailableProse,
  isManualApiFallbackProse,
  partitionToolCallsByExposure
} = require('../lib/llm/toolSelection');
const { trimToolsToBudget, assembleBudgetedRequest } = require('../lib/llm/contextBudget');
const GroqProvider = require('../lib/llm/providers/GroqProvider');
const TaskExecutor = require('../services/TaskExecutor');

const passed = [];
const failed = [];
const test = (name, fn) => (async () => {
  try { await fn(); passed.push(name); console.log(`  ok - ${name}`); }
  catch (err) { failed.push({ name, err }); console.error(`  FAIL - ${name}`); console.error(`         ${err && err.message}`); }
})();

const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });

// ---- 64-tool integration ----------------------------------------------------
// Shape mirrors the production report (list/search/create/comment/update +
// a long tail to 64 tools). Handlers are stateful so create → comment →
// update → complete runs against one real identity, like acceptance D–G.
const store = {
  issues: [
    { id: 'iss-seed-1', identifier: 'ARC-1', title: 'ARC-AI bootstrap', description: 'Seed issue.', state: 'open', teamId: 'team-1', comments: [] }
  ],
  nextId: 2,
  createdCalls: 0
};

const createServer = () => {
  const server = new McpServer({ name: 'linear-shaped', version: '1.0.0' });
  const J = (v) => text(JSON.stringify(v));

  server.registerTool('list_teams',
    { description: 'List all teams in the workspace.', inputSchema: z.object({}) },
    async () => J([{ id: 'team-1', name: 'Engineering' }, { id: 'team-2', name: 'Design' }]));

  server.registerTool('list_projects',
    { description: 'List all projects in the workspace with their team.', inputSchema: z.object({}) },
    async () => J([{ id: 'proj-1', name: 'ARC-AI', teamId: 'team-1' }]));

  server.registerTool('search_issues',
    { description: 'Search issues by keyword across title and description.', inputSchema: z.object({ query: z.string() }) },
    async ({ query }) => {
      const q = String(query || '').toLowerCase();
      return J(store.issues.filter((i) => `${i.title} ${i.description}`.toLowerCase().includes(q)));
    });

  // Live-shaped mutation tool: one save_* entry point for CREATE and
  // UPDATE (omit id to create). Mirrors the real Linear save_issue shape.
  server.registerTool('save_issue',
    {
      description: 'Create a new issue or update an existing one. Omit id to create a new issue with a title and description.',
      inputSchema: z.object({
        id: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        teamId: z.string().optional(),
        state: z.string().optional()
      })
    },
    async ({ id, title, description, teamId, state }) => {
      if (!id) {
        store.createdCalls += 1;
        const issue = {
          id: `iss-${store.nextId}`, identifier: `ARC-${store.nextId}`,
          title: String(title), description: String(description || ''),
          state: 'open', teamId: teamId || 'team-1', comments: []
        };
        store.nextId += 1;
        store.issues.push(issue);
        return J({ id: issue.id, identifier: issue.identifier, title: issue.title, state: issue.state });
      }
      const issue = store.issues.find((i) => i.id === id);
      if (!issue) return { content: [{ type: 'text', text: 'Issue not found.' }], isError: true };
      if (typeof title === 'string') issue.title = title;
      if (typeof description === 'string') issue.description = description;
      if (typeof state === 'string') issue.state = state;
      return J({ id: issue.id, identifier: issue.identifier, description: issue.description, state: issue.state });
    });

  server.registerTool('save_comment',
    {
      description: 'Add a comment to an existing issue.',
      inputSchema: z.object({ issueId: z.string(), body: z.string() })
    },
    async ({ issueId, body }) => {
      const issue = store.issues.find((i) => i.id === issueId);
      if (!issue) return { content: [{ type: 'text', text: 'Issue not found.' }], isError: true };
      const comment = { id: `cmt-${issue.comments.length + 1}`, body: String(body) };
      issue.comments.push(comment);
      return J({ id: comment.id, issueId: issue.id, body: comment.body });
    });

  server.registerTool('archive_issue',
    { description: 'Archive an issue so it leaves the active backlog.', inputSchema: z.object({ issueId: z.string() }) },
    async ({ issueId }) => {
      const issue = store.issues.find((i) => i.id === issueId);
      if (!issue) return { content: [{ type: 'text', text: 'Issue not found.' }], isError: true };
      issue.state = 'archived';
      return J({ id: issue.id, state: issue.state });
    });

  server.registerTool('get_issue',
    { description: 'Retrieve a single issue by its identifier.', inputSchema: z.object({ issueId: z.string() }) },
    async ({ issueId }) => J(store.issues.find((i) => i.id === issueId) || null));

  server.registerTool('get_team',
    { description: 'Retrieve a single team by its identifier.', inputSchema: z.object({ teamId: z.string() }) },
    async ({ teamId }) => J({ id: teamId, name: teamId === 'team-1' ? 'Engineering' : 'Design' }));

  server.registerTool('get_project',
    { description: 'Retrieve a single project by its identifier.', inputSchema: z.object({ projectId: z.string() }) },
    async ({ projectId }) => J({ id: projectId, name: 'ARC-AI' }));

  server.registerTool('list_issues',
    { description: 'List issues in the workspace, newest first.', inputSchema: z.object({}) },
    async () => J(store.issues.map((i) => ({ id: i.id, title: i.title, state: i.state }))));

  server.registerTool('list_labels',
    { description: 'List labels available for issues.', inputSchema: z.object({}) },
    async () => J([{ id: 'lbl-1', name: 'bug' }]));

  server.registerTool('list_cycles',
    { description: 'List development cycles for planning.', inputSchema: z.object({}) },
    async () => J([{ id: 'cyc-1', name: 'Sprint 1' }]));

  // Long tail to exactly 64 tools: plausible integration surface.
  const tailNames = [
    'duplicate_issue', 'move_issue', 'restore_issue', 'delete_issue',
    'upload_attachment', 'download_attachment', 'send_notification',
    'execute_workflow', 'get_user', 'list_users', 'get_comment',
    'list_comments', 'update_comment', 'delete_comment', 'get_label',
    'create_label', 'update_label', 'get_cycle', 'create_cycle',
    'update_cycle', 'get_milestone', 'list_milestones', 'create_milestone',
    'get_document', 'list_documents', 'create_document', 'update_document',
    'search_documents', 'get_roadmap', 'list_roadmaps', 'get_view',
    'list_views', 'create_view', 'update_view', 'get_webhook',
    'list_webhooks', 'create_webhook', 'delete_webhook', 'get_api_key',
    'list_api_keys', 'rotate_api_key', 'get_audit_log', 'export_issues',
    'import_issues', 'get_workflow', 'list_workflows', 'update_workflow',
    'get_estimate', 'list_estimates', 'get_priority', 'list_priorities',
    'get_sprint'
  ];
  for (const name of tailNames) {
    server.registerTool(name,
      { description: `Perform the ${name.replace(/_/g, ' ')} operation in the workspace.`, inputSchema: z.object({ ref: z.string().optional() }) },
      async ({ ref }) => J({ tool: name, ref: ref || null, ok: true }));
  }
  return server;
};

const initSource = () => {
  const registry = new McpRegistry();
  const manager = new McpManager({ registry });
  McpToolSource.init({ manager, registry });
  return { registry, manager };
};

const wire = (schemas, short) => schemas.map((s) => s.function.name).find((n) => n === `mcp_linear_${short}` || n.endsWith(`_${short}`));
const names = (tools) => tools.map((s) => s?.function?.name).filter(Boolean);
const EXEC_OPTS = { workspaceId: 'ws-avail', skipCreditCharge: true };

let schemas = [];
let liveServer = null;

const main = async () => {
  const { registry } = initSource();
  liveServer = createServer();
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await liveServer.connect(serverEnd);
  registry.register({
    id: 'avail-1', name: 'Linear', scope: 'global', transport: 'stdio',
    testHooks: { createTransport: () => clientEnd }
  });
  const pick = await McpToolSource.schemasForRequest({ workspaceId: 'ws-avail', isGuest: false });
  schemas = pick.schemas;
  const failures = pick.failures || [];

  await test('V-00 64 tools discovered through the live connection', async () => {
    assert.strictEqual(schemas.length, 64, `discovered ${schemas.length}, want 64`);
    assert.strictEqual(failures.length, 0, `connection failures: ${JSON.stringify(failures)}`);
  });

  await test('V-01 inventory is explicit, bounded, secret-free, final-tools-only', async () => {
    // Visibility invariant: the block is built from the FINAL budgeted
    // request.tools — never the 64-tool discovered set. Simulate the
    // production order: select → budget → inventory-from-final.
    const ai = require('../services/AIService');
    const sel = selectToolSchemas('What teams and projects do I have in Linear?', () => [], { mcpSchemas: schemas });
    const b = assembleBudgetedRequest({
      systemTemplate: 'SYS __LONG_TERM_MEMORY_SLOT____RETRIEVAL_CONTEXT_SLOT__ END',
      baseUserText: 'What teams and projects do I have in Linear?',
      query: 'What teams and projects do I have in Linear?',
      selectedTools: sel.tools, outputBudget: 1200,
      mcpInventoryText: ai.mcpInventoryBlockForTools(sel.tools, {}),
      protectedToolNames: [...(sel.mcpExplicit || []), ...(sel.mcpCapability || [])]
    });
    assert.strictEqual(b.ok, true);
    const finalBlock = ai.mcpInventoryBlockForTools(b.tools, { metadata: pick.metadata, failures });
    const finalNames = b.tools.map((s) => s.function.name).sort();
    const invWires = [...finalBlock.matchAll(/\bmcp_linear_[a-z0-9_]+\b/g)].map((m) => m[0]);
    const uniqWires = [...new Set(invWires)].sort();
    const finalMcp = finalNames.filter((n) => n.startsWith('mcp_'));
    assert.deepStrictEqual(uniqWires, finalMcp, 'inventory/request.tools mismatch');
    assert.ok(finalBlock.includes('mcp_linear_list_teams'), 'teams wire missing');
    // Omitted tools are never leaked: 64 discovered, ≤6 described.
    assert.ok(!finalBlock.includes('mcp_linear_archive_issue') || finalMcp.includes('mcp_linear_archive_issue'),
      'omitted tool leaked into inventory');
    assert.ok(/CONNECTED/i.test(finalBlock) && /authoriz/i.test(finalBlock), 'state missing');
    // No credential VALUES (names like api_key are fine; values are not).
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}|bearer\s+[A-Za-z0-9._-]{12,}|sk-(live|test)-[A-Za-z0-9]{8,}/i.test(finalBlock),
      'secret-shaped material leaked');
    assert.ok(!/client_secret|refresh_token|access_token\s*[:=]\s*\S+/i.test(finalBlock), 'token material leaked');
    assert.ok(finalBlock.length < 20000, `inventory unbounded: ${finalBlock.length}`);
  });

  await test('V-02 teams+projects: both list tools selected AND executed', async () => {
    const q = 'What teams and projects do I have in Linear?';
    assert.deepStrictEqual([...classifyIntentCapabilities(q)].sort(), ['LIST', 'READ']);
    const sel = selectToolSchemas(q, () => [], { mcpSchemas: schemas });
    assert.ok(names(sel.tools).includes(wire(schemas, 'list_teams')), `teams missing: ${names(sel.tools)}`);
    assert.ok(names(sel.tools).includes(wire(schemas, 'list_projects')), `projects missing: ${names(sel.tools)}`);
    assert.ok(sel.tools.length <= 6);
    const teams = await TaskExecutor.executeTool(wire(schemas, 'list_teams'), {}, 'user-1', null, EXEC_OPTS);
    const projects = await TaskExecutor.executeTool(wire(schemas, 'list_projects'), {}, 'user-1', null, EXEC_OPTS);
    assert.strictEqual(teams.success, true, teams.error);
    assert.strictEqual(projects.success, true, projects.error);
    assert.ok(String(teams.result).includes('Engineering'), teams.result);
    assert.ok(String(projects.result).includes('ARC-AI'), projects.result);
  });

  await test('V-03 find open issues: real search/read execution', async () => {
    const sel = selectToolSchemas('Find open issues related to ARC-AI.', () => [], { mcpSchemas: schemas });
    const target = wire(schemas, 'search_issues');
    assert.ok(names(sel.tools).includes(target), `search missing: ${names(sel.tools)}`);
    const res = await TaskExecutor.executeTool(target, { query: 'ARC-AI' }, 'user-1', null, EXEC_OPTS);
    assert.strictEqual(res.success, true, res.error);
    assert.ok(String(res.result).includes('ARC-AI'), res.result);
  });

  let createdId = null;
  await test('V-04 create executes EXACTLY once and returns the identity', async () => {
    const before = store.createdCalls;
    const q = "Create a Linear issue called 'ARC-AI MCP Integration Test' with the description 'This issue was created by ARC-AI through the Linear MCP.' Do not create another issue.";
    const sel = selectToolSchemas(q, () => [], { mcpSchemas: schemas });
    const target = wire(schemas, 'save_issue');
    assert.ok(names(sel.tools).includes(target), `create missing: ${names(sel.tools)}`);
    assert.ok(sel.mcpCapability.includes(target), 'create must be capability-protected');
    const res = await TaskExecutor.executeTool(target, {
      title: 'ARC-AI MCP Integration Test',
      description: 'This issue was created by ARC-AI through the Linear MCP.'
    }, 'user-1', null, EXEC_OPTS);
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(store.createdCalls, before + 1, 'must create exactly one issue');
    const body = JSON.parse(res.result);
    assert.ok(body.id && body.title === 'ARC-AI MCP Integration Test', res.result);
    createdId = body.id;
  });

  await test('V-05 comment executes against the created issue', async () => {
    assert.ok(createdId, 'needs V-04 identity (no id repeated by any user turn)');
    const sel = selectToolSchemas('Add a comment saying the MCP test worked.', () => [], { mcpSchemas: schemas });
    const target = wire(schemas, 'save_comment');
    assert.ok(names(sel.tools).includes(target), `comment missing: ${names(sel.tools)}`);
    const res = await TaskExecutor.executeTool(target,
      { issueId: createdId, body: 'ARC-AI MCP write test completed successfully.' }, 'user-1', null, EXEC_OPTS);
    assert.strictEqual(res.success, true, res.error);
    assert.ok(String(res.result).includes(createdId), res.result);
  });

  await test('V-06 update description executes against the created issue', async () => {
    const sel = selectToolSchemas(
      "Update it so the description also says 'ARC can modify an existing issue through MCP.'",
      () => [], { mcpSchemas: schemas });
    const target = wire(schemas, 'save_issue');
    assert.ok(names(sel.tools).includes(target), `update missing: ${names(sel.tools)}`);
    const res = await TaskExecutor.executeTool(target,
      { id: createdId, description: 'ARC can modify an existing issue through MCP.' }, 'user-1', null, EXEC_OPTS);
    assert.strictEqual(res.success, true, res.error);
    assert.ok(String(res.result).includes('modify an existing issue'), res.result);
  });

  await test('V-07 mark completed executes without a repeated id', async () => {
    // Production selects with prior user turns as background (continuity):
    // the bare follow-up alone is ambiguous, the threaded query is not.
    const threaded = "Update it so the description also says 'ARC can modify an existing issue through MCP.'\nNow mark it completed.";
    const sel = selectToolSchemas(threaded, () => [], { mcpSchemas: schemas });
    const target = wire(schemas, 'save_issue');
    assert.ok(names(sel.tools).includes(target), `update missing: ${names(sel.tools)}`);
    const res = await TaskExecutor.executeTool(target,
      { id: createdId, state: 'completed' }, 'user-1', null, EXEC_OPTS);
    assert.strictEqual(res.success, true, res.error);
    assert.ok(String(res.result).includes('completed'), res.result);
  });

  await test('V-08 working-state continuity carries the issue across turns', async () => {
    const ai = require('../services/AIService');
    const derived = ai.buildWorkingStateFromMessages([{
      toolCalls: [{
        toolName: wire(schemas, 'save_issue'),
        input: { title: 'ARC-AI MCP Integration Test' },
        output: { id: createdId, title: 'ARC-AI MCP Integration Test' }
      }]
    }], null, null);
    assert.ok(derived && derived.activeResource, 'no working state derived');
    assert.ok(String(derived.activeResource.tool).includes('save_issue'), JSON.stringify(derived));
  });

  await test('V-09 selected schemas survive provider tool-def construction', async () => {
    const sel = selectToolSchemas(
      "Create a Linear issue called 'T' with description 'x'.", () => [], { mcpSchemas: schemas });
    const defs = GroqProvider.buildTools({ tools: sel.tools });
    assert.ok(Array.isArray(defs) && defs.length > 0, 'provider dropped all tools');
    const defNames = defs.map((d) => d.function.name);
    assert.ok(defNames.includes(wire(schemas, 'save_issue')), `save mutation dropped: ${defNames}`);
    // Invariant: every emitted call maps to request.tools.
    const { unexposedNames } = partitionToolCallsByExposure(
      [{ id: '1', function: { name: wire(schemas, 'save_issue'), arguments: {} } }], sel.tools);
    assert.strictEqual(unexposedNames.length, 0);
  });

  await test('V-10 write pick survives a crushing budget (protected)', async () => {
    const sel = selectToolSchemas(
      "Create a Linear issue called 'T' with description 'x'.", () => [], { mcpSchemas: schemas });
    const cap = sel.mcpCapability[0];
    assert.ok(cap, 'no capability pick');
    const trimmed = trimToolsToBudget(sel.tools, 60, {
      protectedNames: [...(sel.mcpExplicit || []), ...sel.mcpCapability]
    });
    assert.ok(names(trimmed).includes(cap), `evicted: ${names(trimmed)}`);
    // Full pipeline with inventory + protection under memory/history load.
    // Production order: preliminary inventory sizes the budget, the FINAL
    // block is rebuilt from the exact budgeted tools.
    const ai2 = require('../services/AIService');
    const big = (i) => ({ query: `note ${i} ` + 'q'.repeat(200), response: `ans ${i} ` + 'r'.repeat(400), timestamp: new Date() });
    const b = assembleBudgetedRequest({
      systemTemplate: 'SYS __LONG_TERM_MEMORY_SLOT____RETRIEVAL_CONTEXT_SLOT__ END',
      baseUserText: 'Create a Linear issue.',
      memoryDocs: Array.from({ length: 20 }, (_, i) => big(i)),
      factDocs: [], ragItems: [], selectedTools: sel.tools,
      outputBudget: 1200, query: 'Create a Linear issue.',
      mcpInventoryText: ai2.mcpInventoryBlockForTools(sel.tools, {}),
      protectedToolNames: [...(sel.mcpExplicit || []), ...sel.mcpCapability]
    });
    assert.strictEqual(b.ok, true);
    assert.ok(names(b.tools).includes(cap), `lost in budget: ${names(b.tools)}`);
    const finalPrompt = ai2.refreshInventoryPrompt(
      b.systemPrompt, ai2.mcpInventoryBlockForTools(b.tools, {}));
    assert.ok(finalPrompt.includes('mcp_linear_save_issue'), 'inventory dropped from context');
    const finalWires = [...new Set([...finalPrompt.matchAll(/\bmcp_linear_[a-z0-9_]+\b/g)].map((m) => m[0]))].sort();
    assert.deepStrictEqual(finalWires, names(b.tools).filter((n) => n.startsWith('mcp_')).sort(),
      'final inventory/request.tools mismatch');
  });

  await test('V-11 denied tool: never selected, never executes', async () => {
    const deniedWire = wire(schemas, 'save_issue');
    const { registry: reg2 } = initSource();
    const [c2, s2] = InMemoryTransport.createLinkedPair();
    const srv2 = createServer();
    await srv2.connect(s2);
    reg2.register({
      id: 'avail-denied', name: 'Linear', scope: 'global', transport: 'stdio',
      deniedTools: [deniedWire], testHooks: { createTransport: () => c2 }
    });
    const denied = await McpToolSource.schemasForRequest({ workspaceId: 'ws-avail', isGuest: false });
    const sel = selectToolSchemas('Create a Linear issue called X.', () => [],
      { mcpSchemas: denied.schemas, mcpBlocked: denied.blocked });
    assert.ok(!names(sel.tools).includes(deniedWire), 'denied tool selected');
    const res = await TaskExecutor.executeTool(deniedWire, { title: 'X' }, 'user-1', null, EXEC_OPTS);
    assert.strictEqual(res.success, false, 'denied tool executed');
    await srv2.close();
  });

  await test('V-12 unauthorized: no forced pick, empty inventory', async () => {
    assert.deepStrictEqual(reselectMcpCapabilities('Create a Linear issue called X.', [], [], 6), []);
    assert.strictEqual(buildMcpCapabilityInventory([], {}).text, '');
  });

  await test('V-13 prose guards catch false-unavailable + manual-token fallback', async () => {
    assert.ok(isNoToolAvailableProse("I don't have a tool for that."));
    assert.ok(isManualApiFallbackProse('Please provide your personal API token to proceed.'));
    assert.ok(isManualApiFallbackProse('Use the Linear GraphQL API with your token.'));
    assert.ok(!isNoToolAvailableProse('Created ARC-2: the issue is open and assigned.'));
    assert.ok(!isManualApiFallbackProse('Created ARC-2: the issue is open and assigned.'));
  });

  await test('V-14 generic nouns never drive cross-capability substitution', async () => {
    const sel = selectToolSchemas('List the data object.', () => [], { mcpSchemas: schemas });
    const bad = names(sel.tools).filter((n) => n === wire(schemas, 'delete_issue') || n === wire(schemas, 'archive_issue'));
    assert.strictEqual(bad.length, 0, `destructive substitution: ${names(sel.tools)}`);
    const capTools = (sel.mcpCapability || []).map((n) => schemas.find((s) => s.function.name === n)).filter(Boolean);
    for (const s of capTools) {
      assert.ok(declareToolCapabilities(s).has('LIST') || declareToolCapabilities(s).has('READ'),
        `${s.function.name} mis-pinned for a list request`);
    }
  });

  await test('V-15 generic vocabulary covers every capability class', async () => {
    const CASES = [
      ['read the workspace issue', 'get_issue', 'READ'],
      ['search issues for ARC-AI', 'search_issues', 'SEARCH'],
      ['list my projects', 'list_projects', 'LIST'],
      ['create an issue for the bug', 'save_issue', 'CREATE'],
      ['update that issue now', 'save_issue', 'UPDATE'],
      ['comment on the issue', 'save_comment', 'COMMENT'],
      ['upload an attachment', 'upload_attachment', 'UPLOAD'],
      ['download the attachment', 'download_attachment', 'DOWNLOAD'],
      ['run the sync workflow', 'execute_workflow', 'EXECUTE'],
      ['move the issue along', 'move_issue', 'MOVE'],
      ['duplicate that issue', 'duplicate_issue', 'DUPLICATE'],
      ['archive the old issue', 'archive_issue', 'ARCHIVE'],
      ['restore the issue', 'restore_issue', 'RESTORE']
    ];
    for (const [query, short, cap] of CASES) {
      const sel = selectToolSchemas(query, () => [], { mcpSchemas: schemas });
      const target = wire(schemas, short);
      assert.ok(names(sel.tools).includes(target), `${cap}: ${short} missing for "${query}": ${names(sel.tools)}`);
    }
  });

  await test('V-16 reselection fills coverage gaps without fabrication', async () => {
    const q = "Create a Linear issue called 'T'.";
    const sel = selectToolSchemas(q, () => [], { mcpSchemas: schemas });
    const without = sel.tools.filter((s) => s.function.name !== wire(schemas, 'save_issue'));
    const filled = reselectMcpCapabilities(q, schemas, without, 6);
    assert.ok(filled.some((s) => s.function.name === wire(schemas, 'save_issue')), 'gap not filled');
    const again = reselectMcpCapabilities(q, schemas, sel.tools, 6);
    assert.strictEqual(again.length, 0, 'already-covered request must not add tools');
  });

  await McpToolSource.shutdown();
  try { await liveServer.close(); } catch { /* best effort */ }

  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`\nFAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
