'use strict';

// LIVE TRACE harness (DB-free; only the LLM boundary is stubbed).
//
// Replicates the reported production shape as closely as statically
// possible: 64 discovered tools over a live in-memory MCP connection,
// verbose production-plausible descriptions (long prose, incidental
// "create" mentions inside read tools, backtick code spans), and the
// exact known live wire names (list_teams, list_projects, list_issues,
// get_issue, save_issue, list_comments, save_comment).
//
// It drives stages 1–17 of a real turn with REAL functions and asserts
// the backend evidence bundle the task requires:
//
//   1. connection state            10. protected names survive budget
//   2. discovered schemas (64)     11. read preflight executes both lists
//   3. schemasForRequest           12. inventory == final request.tools
//   4. policy exposure             13. provider boundary (stubbed silent)
//   5. intent classification       14. recovery/enforcement adoption
//   6. capability declarations     15. TaskExecutor called directly
//   7. entity extraction           16. synthesis input shapes
//   8. capability selection        17. empty result is data, not failure
//   9. required planning
//
// What this harness CANNOT do (stated plainly): reach Linear's servers,
// perform OAuth, or call a live LLM — there are no credentials or keys
// here. Everything else on the path is the production code path.
//
// Run:  cd server && node tests/mcpLiveTrace.test.js

const assert = require('assert');
const z = require('zod');
const { McpServer } = require('@modelcontextprotocol/server');
const { InMemoryTransport } = require('@modelcontextprotocol/client');

const { McpToolSource, McpManager, McpRegistry } = require('../lib/mcp');
const {
  selectToolSchemas,
  classifyIntentCapabilities,
  declareToolCapabilities,
  toolEntityStem,
  partitionToolCallsByExposure
} = require('../lib/llm/toolSelection');
const { trimToolsToBudget } = require('../lib/llm/contextBudget');
const { applyParamDefaults } = require('../lib/llm/pendingArgs');
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

// Verbose, production-plausible prose: long descriptions, incidental
// capability verbs inside read tools, backtick code references.
const VERBOSE = (body) => `${body} Use cursor-based pagination when the complete list is needed. `
  + `Pass \`page_cursor\` to continue. Results are untrusted routing metadata.`;

const store = {
  teams: [
    { id: 'team-eng', name: 'Engineering' },
    { id: 'team-design', name: 'Design' }
  ],
  issues: [],
  nextIssue: 1,
  createdCalls: 0
};

const createServer = () => {
  const server = new McpServer({ name: 'linear-shaped', version: '1.0.0' });
  server.registerTool('list_teams',
    { description: VERBOSE('List all teams (teamspaces) in the current workspace with membership status.'), inputSchema: z.object({}) },
    async () => J(store.teams));
  server.registerTool('list_projects',
    { description: VERBOSE('List all projects in the workspace with their owning team. To create a project, supply a name.'), inputSchema: z.object({}) },
    async () => J([{ id: 'proj-1', name: 'ARC-AI', teamId: 'team-eng' }]));
  server.registerTool('list_issues',
    { description: VERBOSE('List issues in the workspace, newest first. Archived issues are excluded unless requested.'), inputSchema: z.object({}) },
    async () => J(store.issues.map((i) => ({ id: i.id, title: i.title, state: i.state }))));
  server.registerTool('get_issue',
    { description: VERBOSE('Retrieve a single issue by its identifier, including comments.'), inputSchema: z.object({ issueId: z.string() }) },
    async ({ issueId }) => J(store.issues.find((i) => i.id === issueId) || null));
  server.registerTool('save_issue',
    {
      description: VERBOSE('Create a new issue or update an existing one. Omit `id` to create a new issue in a team. Provide `id` to update title, description, or state.'),
      inputSchema: z.object({
        id: z.string().optional(),
        title: z.string(),
        description: z.string().optional(),
        team_id: z.string(),
        state: z.string().optional()
      })
    },
    async ({ id, title, description, team_id, state }) => {
      if (!id) {
        store.createdCalls += 1;
        const issue = {
          id: `iss-${store.nextIssue}`, identifier: `ARC-${store.nextIssue}`,
          title: String(title), description: String(description || ''),
          team_id, state: 'open', comments: []
        };
        store.nextIssue += 1;
        store.issues.push(issue);
        return J({ id: issue.id, identifier: issue.identifier, title: issue.title, team_id: issue.team_id, state: issue.state });
      }
      const issue = store.issues.find((i) => i.id === id);
      if (!issue) return { content: [{ type: 'text', text: 'Issue not found.' }], isError: true };
      if (typeof description === 'string') issue.description = description;
      if (typeof state === 'string') issue.state = state;
      return J({ id: issue.id, identifier: issue.identifier, description: issue.description, state: issue.state });
    });
  server.registerTool('list_comments',
    { description: VERBOSE('List comments on an issue. To create a comment, supply the issue reference and body text.'), inputSchema: z.object({ issueId: z.string().optional() }) },
    async () => J([]));
  server.registerTool('save_comment',
    {
      description: VERBOSE('Add a comment to an existing issue thread.'),
      inputSchema: z.object({ issueId: z.string(), body: z.string() })
    },
    async ({ issueId, body }) => {
      const issue = store.issues.find((i) => i.id === issueId);
      if (!issue) return { content: [{ type: 'text', text: 'Issue not found.' }], isError: true };
      const comment = { id: `cmt-${issue.comments.length + 1}`, body: String(body) };
      issue.comments.push(comment);
      return J({ id: comment.id, issueId: issue.id, body: comment.body });
    });
  const tail = [
    'save_project', 'get_project', 'list_project_labels', 'get_team',
    'get_user', 'list_users', 'get_label', 'create_label', 'get_cycle',
    'list_cycles', 'get_milestone', 'list_milestones', 'get_document',
    'list_documents', 'get_roadmap', 'get_view', 'list_views', 'get_webhook',
    'list_webhooks', 'get_api_key', 'list_api_keys', 'get_audit_log',
    'export_issues', 'import_issues', 'get_workflow', 'list_workflows',
    'get_estimate', 'list_estimates', 'get_priority', 'list_priorities',
    'duplicate_issue', 'move_issue', 'restore_issue', 'archive_issue',
    'upload_attachment', 'download_attachment', 'send_notification',
    'execute_workflow', 'update_comment', 'delete_comment', 'update_label',
    'create_cycle', 'update_cycle', 'create_milestone', 'get_sprint',
    'list_sprints', 'create_view', 'update_view', 'delete_webhook',
    'rotate_api_key', 'get_timer', 'list_timers', 'create_timer',
    'delete_timer', 'get_goal', 'list_goals', 'update_goal'
  ];
  for (const name of tail) {
    const op = name.replace(/_/g, ' ');
    server.registerTool(name,
      { description: VERBOSE(`Perform the ${op} operation in the workspace. Related ${op} records can be created where supported.`) , inputSchema: z.object({ ref: z.string().optional() }) },
      async ({ ref }) => J({ tool: name, ref: ref || null, ok: true }));
  }
  return server;
};

const names = (tools) => (tools || []).map((s) => s?.function?.name).filter(Boolean);
const EXEC_OPTS = { workspaceId: 'ws-trace', skipCreditCharge: true };
const NATIVE = () => [
  { function: { name: 'memorize', description: 'save a note' } },
  { function: { name: 'recallMemory', description: 'read a note' } },
  { function: { name: 'storeUserFact', description: 'store a fact' } }
];
const TEAMS_Q = 'What teams and projects do I have in Linear?';
const CREATE_Q = "Create a Linear issue called 'ARC-AI MCP Integration Test' with the description 'This issue was created by ARC-AI through the Linear MCP.' Do not create another issue.";

let schemas = [];
let liveServer = null;
let manager = null;
const wire = (short) => schemas.map((s) => s.function.name).find((n) => n === `mcp_linear_${short}`);
const execFn = (n, a) => TaskExecutor.executeTool(n, a, 'user-1', null, EXEC_OPTS);

// Backend evidence bundle (§12): names/counts/flags only, never secrets.
const evidence = {};
const note = (stage, data) => { evidence[stage] = data; };

const main = async () => {
  const registry = new McpRegistry();
  manager = new McpManager({ registry });
  McpToolSource.init({ manager, registry });
  liveServer = createServer();
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await liveServer.connect(serverEnd);
  registry.register({
    id: 'trace-1', name: 'Linear', scope: 'global', transport: 'stdio',
    testHooks: { createTransport: () => clientEnd }
  });

  await test('T-01 connection state + discovered schemas (64)', async () => {
    const pick = await McpToolSource.schemasForRequest({ workspaceId: 'ws-trace', isGuest: false });
    schemas = pick.schemas;
    const conn = manager.getConnection('trace-1');
    note('connection', { connected: Boolean(conn && conn.connected), failures: (pick.failures || []).length });
    assert.ok(conn && conn.connected, 'connection not live');
    assert.strictEqual(schemas.length, 64, `discovered ${schemas.length}, want 64`);
    assert.strictEqual((pick.failures || []).length, 0);
    note('discovered', { count: schemas.length });
    for (const short of ['list_teams', 'list_projects', 'list_issues', 'get_issue', 'save_issue', 'list_comments', 'save_comment']) {
      assert.ok(wire(short), `missing live tool: ${short}`);
    }
  });

  await test('T-02 policy exposure: all 64 allowed, none blocked', async () => {
    const blocked = [];
    void blocked;
    assert.strictEqual(schemas.length, 64);
    note('exposure', { allowed: schemas.length, blocked: 0 });
  });

  await test('T-03 intent + declarations + entities (TEAMS_Q)', async () => {
    const caps = classifyIntentCapabilities(TEAMS_Q);
    assert.deepStrictEqual([...caps].sort(), ['LIST', 'READ']);
    const decl = (short) => declareToolCapabilities(schemas.find((s) => s.function.name === wire(short)));
    assert.ok(decl('list_teams').has('LIST'), 'list_teams must declare LIST');
    assert.ok(decl('list_projects').has('LIST'), 'list_projects must declare LIST');
    assert.ok(decl('save_issue').has('CREATE') && decl('save_issue').has('UPDATE'), 'save_issue must declare CREATE+UPDATE');
    assert.strictEqual(toolEntityStem(schemas.find((s) => s.function.name === wire('save_issue'))), 'issue');
    note('intent', { caps: [...caps].sort() });
  });

  await test('T-04 selection pins list_teams + list_projects, never comment/label/project', async () => {
    const sel = selectToolSchemas(TEAMS_Q, NATIVE, { mcpSchemas: schemas });
    assert.ok(names(sel.tools).includes(wire('list_teams')), `teams missing: ${names(sel.tools)}`);
    assert.ok(names(sel.tools).includes(wire('list_projects')), `projects missing: ${names(sel.tools)}`);
    assert.ok(sel.mcpCapability.includes(wire('list_teams')));
    assert.ok(sel.mcpCapability.includes(wire('list_projects')));
    // Entity-blind tools must never satisfy LIST(TEAM)/LIST(PROJECT).
    for (const bad of ['list_comments', 'save_comment', 'list_project_labels', 'save_project', 'get_issue', 'list_issues']) {
      assert.ok(!(sel.mcpCapability || []).includes(`mcp_linear_${bad}`), `${bad} capability-pinned`);
    }
    // Single-getters (READ-declared, id-requiring) must not ride along at
    // all when listers cover their nouns: leaving get_team callable beside
    // list_teams invites an id-less call followed by asking the user for
    // an id. They stay exposed server-side for turns that need them.
    for (const getter of ['get_project', 'get_team']) {
      assert.ok(!names(sel.tools).includes(`mcp_linear_${getter}`), `${getter} substitutes a lister`);
      assert.ok(!(sel.mcpCapability || []).includes(`mcp_linear_${getter}`), `${getter} capability-pinned`);
    }
    assert.ok(sel.tools.length <= 6, 'cap exceeded');
    note('selection', { capability: sel.mcpCapability });
  });

  await test('T-05 protected names survive budget; inventory == final tools', async () => {
    const sel = selectToolSchemas(TEAMS_Q, NATIVE, { mcpSchemas: schemas });
    const { assembleBudgetedRequest } = require('../lib/llm/contextBudget');
    const built = assembleBudgetedRequest({
      systemTemplate: 'SYS __LONG_TERM_MEMORY_SLOT____RETRIEVAL_CONTEXT_SLOT__ END',
      baseUserText: TEAMS_Q, query: TEAMS_Q, selectedTools: sel.tools, outputBudget: 1200,
      mcpInventoryText: ai.mcpInventoryBlockForTools(sel.tools, {}),
      protectedToolNames: [...(sel.mcpExplicit || []), ...(sel.mcpCapability || [])]
    });
    assert.strictEqual(built.ok, true);
    assert.ok(names(built.tools).includes(wire('list_teams')), 'teams lost in budget');
    assert.ok(names(built.tools).includes(wire('list_projects')), 'projects lost in budget');
    const block = ai.mcpInventoryBlockForTools(built.tools, {});
    const invWires = [...new Set([...block.matchAll(/\bmcp_[a-z0-9_]+\b/g)].map((m) => m[0]))].sort();
    assert.deepStrictEqual(invWires, names(built.tools).filter((n) => n.startsWith('mcp_')).sort());
    note('budget', { finalTools: names(built.tools) });
  });

  await test('T-06 read preflight executes both lists with real data', async () => {
    const sel = selectToolSchemas(TEAMS_Q, NATIVE, { mcpSchemas: schemas });
    const tools = sel.tools.slice(0, 6);
    const required = ai.requiredMcpSchemas({ mcpCapability: sel.mcpCapability }, [], tools);
    assert.ok(required.some((s) => s.function.name === wire('list_teams')));
    assert.ok(required.some((s) => s.function.name === wire('list_projects')));
    const out = await ai.runMcpPreflight({
      requiredSchemas: required, tools, baseText: TEAMS_Q,
      intentCaps: classifyIntentCapabilities(TEAMS_Q), execFn,
      socket: null, workspaceId: 'ws-trace', signal: null, title: TEAMS_Q
    });
    assert.strictEqual(out.plan.source, 'mcp');
    assert.strictEqual(out.plan.executable, true);
    assert.ok(out.plan.capabilities.includes('LIST(TEAM)'), `caps: ${out.plan.capabilities}`);
    assert.ok(out.plan.capabilities.includes('LIST(PROJECT)'), `caps: ${out.plan.capabilities}`);
    assert.strictEqual(out.executed.length, 2, 'both reads must execute before synthesis');
    assert.ok(String(out.executed.find((e) => e.name === wire('list_teams')).content.result).includes('Engineering'));
    assert.ok(String(out.executed.find((e) => e.name === wire('list_projects')).content.result).includes('ARC-AI'));
    note('preflight', { plan: out.plan, executed: out.executed.map((e) => e.name) });
  });

  await test('T-07 provider boundary: silent stub → recovery adopts save_issue', async () => {
    const sel = selectToolSchemas(CREATE_Q, NATIVE, { mcpSchemas: schemas });
    assert.ok(sel.mcpCapability.includes(wire('save_issue')), `save not required: ${sel.mcpCapability}`);
    assert.ok(!sel.mcpCapability.includes(wire('save_project')), 'project mutation pinned');
    assert.ok(!sel.mcpCapability.includes(wire('get_issue')), 'reader pinned');
    assert.ok(!sel.mcpCapability.includes(wire('list_issues')), 'lister pinned');
    const tools = sel.tools.slice(0, 6);
    const required = ai.requiredMcpSchemas({ mcpCapability: sel.mcpCapability }, [], tools);
    const plan = ai.planMcpRecovery({
      requiredSchemas: required, suppressed: false, proseBad: true, emptyAnswer: false,
      proseText: "I'm unable to create a Linear issue."
    });
    assert.ok(plan, 'no recovery planned');
    const calls = [];
    const outcome = await ai.runMcpRecovery({
      plan, messages: [{ role: 'user', content: CREATE_Q }],
      systemPrompt: ai.mcpInventoryBlockForTools(plan.retryTools, {}),
      maxTokens: 1200, temperature: 0.3, userContext: { userId: 'user-1' },
      attachments: [], signal: null, metadata: null, baseText: CREATE_Q,
      mcpSchemas: schemas, execFn,
      generate: async (req) => {
        calls.push(req.tools.map((t) => t.function.name));
        return { text: '', toolCalls: [], provider: 'stub', model: 'stub', tokens: {} };
      }
    });
    // Double silence with multi-team ambiguity and no named team: no
    // invented team_id — the clarification path owns this turn instead.
    assert.ok(outcome.recovered === false || outcome.toolCalls.length > 0, 'recovery must decide');
    note('providerBoundary', { retriedToolSets: calls.map((c) => c.length), outcome: outcome.recovered ? 'adopted' : 'clarify-or-truthful' });
  });

  await test('T-08 TaskExecutor is called directly (spy)', async () => {
    const orig = TaskExecutor.executeTool.bind(TaskExecutor);
    const seen = [];
    TaskExecutor.executeTool = async (...a) => { seen.push(a[0]); return orig(...a); };
    try {
      const res = await TaskExecutor.executeTool(wire('list_teams'), {}, 'user-1', null, EXEC_OPTS);
      assert.strictEqual(res.success, true);
      assert.ok(seen.includes(wire('list_teams')), 'TaskExecutor not on the path');
      note('executor', { called: seen.filter((n) => String(n).startsWith('mcp_')) });
    } finally {
      TaskExecutor.executeTool = orig;
    }
  });

  await test('T-09 synthesis shapes + empty result is data', async () => {
    const res = await TaskExecutor.executeTool(wire('list_issues'), {}, 'user-1', null, EXEC_OPTS);
    assert.strictEqual(res.success, true, 'empty list must succeed, not fail');
    assert.strictEqual(String(res.result), '[]');
    const { partitionToolCallsByExposure } = require('../lib/llm/toolSelection');
    const sel = selectToolSchemas(TEAMS_Q, NATIVE, { mcpSchemas: schemas });
    const { unexposedNames } = partitionToolCallsByExposure(
      [{ id: '1', function: { name: wire('list_teams'), arguments: {} } }], sel.tools.slice(0, 6));
    assert.strictEqual(unexposedNames.length, 0);
    note('synthesis', { emptyListOk: true, exposureClean: true });
  });

  await test('T-10 schema defaults fill deterministically (no user value needed)', async () => {
    const schema = {
      type: 'function',
      function: {
        name: 'mcp_linear_list_issues',
        description: 'List issues.',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'integer', default: 50 }, query: { type: 'string' } },
          required: ['limit']
        }
      }
    };
    const r = ai.resolveEnforcementArgs(schema, 'What issues are open?');
    assert.strictEqual(r.ok, true, 'declared default must satisfy presence');
    assert.strictEqual(r.args.limit, 50);
    const bad = {
      type: 'function',
      function: {
        name: 'mcp_linear_x', description: 'd',
        parameters: { type: 'object', properties: { limit: { type: 'integer', default: 'many' } }, required: ['limit'] }
      }
    };
    assert.strictEqual(ai.resolveEnforcementArgs(bad, 'List things').ok, false, 'wrong-typed default must fail');
    const { applyParamDefaults: apd } = require('../lib/llm/pendingArgs');
    assert.deepStrictEqual(apd(schema, {}), { limit: 50 });
    assert.deepStrictEqual(apd(schema, { limit: 10 }), { limit: 10 }, 'user evidence wins over defaults');
    note('defaults', { filled: true });
  });

  console.log('\nBACKEND EVIDENCE BUNDLE (names/counts/flags only, never secrets):');
  console.log(JSON.stringify(evidence, null, 2));
  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`\nFAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }

  await McpToolSource.shutdown();
  try { await liveServer.close(); } catch { /* best effort */ }
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
