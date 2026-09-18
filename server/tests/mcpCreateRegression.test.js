'use strict';

// REAL CREATE-failure regression (DB-free, no provider keys).
//
// Reproduces the reported production failure shape exactly: the live Linear
// surface exposes mcp_linear_save_issue alongside distractor tools whose
// descriptions incidentally mention "create" (list_comments,
// list_project_labels, get_template), and save_issue STRICTLY requires
// creation context (team_id). The old path planned/executed the unrelated
// readers (list_comments FAILED on missing identifiers) instead of the
// mutation. This suite locks the fix:
//
//   A. CREATE(ISSUE) capability-pins mcp_linear_save_issue only
//   B. READ requests still pin list/get tools (no regression)
//   C. CREATE cannot select COMMENT (list_comments / save_comment)
//   D. CREATE cannot select LABEL (list_project_labels)
//   E. CREATE cannot select TEMPLATE (get_template)
//   F. save_issue survives the 6-tool budget
//   G. single-team context auto-resolves; exactly one issue is created
//   H. ambiguous teams clarify with options, never a guessed id
//   I. no invented IDs (optional project_id never fabricated)
//   J. read teams/projects executes both lists, nothing else
//   K. comment request routes to the comment mutation
//   L. update request routes to save_issue with UPDATE semantics
//   M. preflight directly rejects irrelevant required tools (gate)
//
// Run:  cd server && node tests/mcpCreateRegression.test.js

const assert = require('assert');
const z = require('zod');
const { McpServer } = require('@modelcontextprotocol/server');
const { InMemoryTransport } = require('@modelcontextprotocol/client');

const { McpToolSource, McpManager, McpRegistry } = require('../lib/mcp');
const {
  selectToolSchemas,
  classifyIntentCapabilities
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

// Production-plausible prose: read tools with incidental "create" mentions,
// exactly the shape that used to hijack CREATE(ISSUE).
const store = {
  teams: [{ id: 'team-solo', name: 'Solo' }],
  issues: [],
  createdCalls: 0
};

const createServer = () => {
  const server = new McpServer({ name: 'linear-shaped', version: '1.0.0' });
  server.registerTool('list_teams',
    { description: 'List all teams in the workspace.', inputSchema: z.object({}) },
    async () => J(store.teams));
  server.registerTool('list_projects',
    { description: 'List all projects in the workspace.', inputSchema: z.object({}) },
    async () => J([{ id: 'proj-1', name: 'ARC-AI' }]));
  server.registerTool('save_issue',
    {
      description: 'Create a new issue or update an existing one. Omit id to create a new issue in a team.',
      inputSchema: z.object({
        id: z.string().optional(),
        title: z.string(),
        description: z.string().optional(),
        team_id: z.string(),
        project_id: z.string().optional(),
        state: z.string().optional()
      })
    },
    async ({ id, title, description, team_id, project_id, state }) => {
      if (!id) {
        store.createdCalls += 1;
        const issue = {
          id: `iss-${store.createdCalls}`, title: String(title),
          description: String(description || ''), team_id,
          project_id: project_id || null, state: 'open', comments: []
        };
        store.issues.push(issue);
        return J({ id: issue.id, title: issue.title, team_id: issue.team_id });
      }
      const issue = store.issues.find((i) => i.id === id);
      if (!issue) return { content: [{ type: 'text', text: 'Issue not found.' }], isError: true };
      if (typeof description === 'string') issue.description = description;
      if (typeof state === 'string') issue.state = state;
      return J({ id: issue.id, description: issue.description, state: issue.state });
    });
  server.registerTool('list_comments',
    { description: 'List comments on an issue. To create a comment, supply the issue reference and body text.', inputSchema: z.object({ issueId: z.string().optional() }) },
    async () => J([]));
  server.registerTool('save_comment',
    { description: 'Add a comment to an existing issue.', inputSchema: z.object({ issueId: z.string(), body: z.string() }) },
    async ({ issueId, body }) => {
      const issue = store.issues.find((i) => i.id === issueId);
      if (!issue) return { content: [{ type: 'text', text: 'Issue not found.' }], isError: true };
      const comment = { id: `cmt-${issue.comments.length + 1}`, body: String(body) };
      issue.comments.push(comment);
      return J(comment);
    });
  server.registerTool('list_project_labels',
    { description: 'List labels for a project. Related label records can be created where supported.', inputSchema: z.object({}) },
    async () => J([{ id: 'lbl-1', name: 'bug' }]));
  server.registerTool('get_template',
    { description: 'Retrieve a template by name. Templates can be created where supported.', inputSchema: z.object({ name: z.string() }) },
    async () => J(null));
  return server;
};

const names = (tools) => (tools || []).map((s) => s?.function?.name).filter(Boolean);
const EXEC_OPTS = { workspaceId: 'ws-create', skipCreditCharge: true };
const NATIVE = () => [];
const CREATE_Q = "Create a Linear issue called 'ARC-AI MCP Integration Test' with the description 'This issue was created by ARC-AI through the Linear MCP.' Do not create another issue.";

let schemas = [];
let liveServer = null;
const wire = (short) => schemas.map((s) => s.function.name).find((n) => n === `mcp_linear_${short}`);
const execFn = (n, a) => TaskExecutor.executeTool(n, a, 'user-1', null, EXEC_OPTS);

const runPreflightTurn = async (query) => {
  const sel = selectToolSchemas(query, NATIVE, { mcpSchemas: schemas });
  const tools = sel.tools.slice(0, 6);
  const required = ai.requiredMcpSchemas({ mcpCapability: sel.mcpCapability }, [], tools);
  const out = await ai.runMcpPreflight({
    requiredSchemas: required, tools, baseText: query,
    intentCaps: classifyIntentCapabilities(query), execFn,
    socket: null, workspaceId: 'ws-create', signal: null, title: query,
    mcpSchemas: schemas
  });
  return { sel, tools, required, out };
};

const main = async () => {
  const registry = new McpRegistry();
  const manager = new McpManager({ registry });
  McpToolSource.init({ manager, registry });
  liveServer = createServer();
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await liveServer.connect(serverEnd);
  registry.register({
    id: 'create-1', name: 'Linear', scope: 'global', transport: 'stdio',
    testHooks: { createTransport: () => clientEnd }
  });
  schemas = (await McpToolSource.schemasForRequest({ workspaceId: 'ws-create', isGuest: false })).schemas;
  assert.ok(wire('save_issue'), 'save_issue not discovered');

  await test('A. CREATE(ISSUE) capability-pins save_issue only', async () => {
    const sel = selectToolSchemas(CREATE_Q, NATIVE, { mcpSchemas: schemas });
    assert.deepStrictEqual(sel.mcpCapability, [wire('save_issue')],
      `capability must be exactly save_issue: ${sel.mcpCapability}`);
  });

  await test('B. READ requests still pin list/get tools', async () => {
    const sel = selectToolSchemas('What teams and projects do I have in Linear?', NATIVE, { mcpSchemas: schemas });
    assert.ok(sel.mcpCapability.includes(wire('list_teams')), 'teams lister missing');
    assert.ok(sel.mcpCapability.includes(wire('list_projects')), 'projects lister missing');
  });

  await test('C. CREATE cannot select COMMENT tools', async () => {
    const sel = selectToolSchemas(CREATE_Q, NATIVE, { mcpSchemas: schemas });
    assert.ok(!sel.mcpCapability.includes(wire('list_comments')), 'list_comments pinned for CREATE');
    assert.ok(!sel.mcpCapability.includes(wire('save_comment')), 'save_comment pinned for CREATE');
  });

  await test('D. CREATE cannot select LABEL tools', async () => {
    const sel = selectToolSchemas(CREATE_Q, NATIVE, { mcpSchemas: schemas });
    assert.ok(!sel.mcpCapability.includes(wire('list_project_labels')), 'labels pinned for CREATE');
  });

  await test('E. CREATE cannot select TEMPLATE tools', async () => {
    const sel = selectToolSchemas(CREATE_Q, NATIVE, { mcpSchemas: schemas });
    assert.ok(!sel.mcpCapability.includes(wire('get_template')), 'template pinned for CREATE');
  });

  await test('F. save_issue survives the 6-tool budget', async () => {
    const sel = selectToolSchemas(CREATE_Q, NATIVE, { mcpSchemas: schemas });
    const { trimToolsToBudget } = require('../lib/llm/contextBudget');
    const trimmed = trimToolsToBudget(sel.tools, 60, {
      protectedNames: [...(sel.mcpExplicit || []), ...(sel.mcpCapability || [])]
    });
    assert.ok(names(trimmed).includes(wire('save_issue')), `evicted: ${names(trimmed)}`);
  });

  await test('G. strict CREATE preflight creates exactly one issue (single team auto-resolved)', async () => {
    store.teams = [{ id: 'team-solo', name: 'Solo' }];
    const before = store.createdCalls;
    const { out } = await runPreflightTurn(CREATE_Q);
    assert.deepStrictEqual(out.plan.tools, [wire('save_issue')], `plan: ${out.plan.tools}`);
    assert.deepStrictEqual(out.plan.capabilities, ['CREATE(ISSUE)'], `caps: ${out.plan.capabilities}`);
    assert.strictEqual(out.executed.length, 1, 'exactly one construction');
    assert.strictEqual(out.executed[0].name, wire('save_issue'));
    const args = out.toolCalls[0].function.arguments;
    assert.strictEqual(args.title, 'ARC-AI MCP Integration Test', 'echoed title would fabricate');
    assert.strictEqual(args.team_id, 'team-solo', 'single team must auto-resolve');
    assert.strictEqual(store.createdCalls, before + 1, 'must create exactly one issue');
  });

  await test('H. ambiguous teams clarify with options, never a guessed id', async () => {
    store.teams = [
      { id: 'team-eng', name: 'Engineering' },
      { id: 'team-design', name: 'Design' }
    ];
    const { out } = await runPreflightTurn('Create a Linear issue called T');
    assert.strictEqual(out.executed.length, 0, 'must not execute without scope');
    assert.strictEqual(out.plan.needsClarification, true);
    const opts = JSON.stringify(out.plan.options || {});
    assert.ok(opts.includes('Engineering') && opts.includes('Design'), `options missing: ${opts}`);
    assert.ok(!opts.includes('team-eng') && !opts.includes('team-design'), 'ids must never leak as guesses');
  });

  await test('I. optional project_id is never invented', async () => {
    store.teams = [{ id: 'team-solo', name: 'Solo' }];
    const { out } = await runPreflightTurn(CREATE_Q);
    assert.strictEqual(out.executed.length, 1);
    assert.ok(!('project_id' in (out.toolCalls[0].function.arguments || {})), 'project_id fabricated');
  });

  await test('J. read teams/projects executes both lists, nothing else', async () => {
    const { out } = await runPreflightTurn('What teams and projects do I have in Linear?');
    assert.strictEqual(out.executed.length, 2, 'both reads must execute');
    const done = out.executed.map((e) => e.name).sort();
    assert.deepStrictEqual(done, [wire('list_projects'), wire('list_teams')].sort());
    for (const bad of ['list_comments', 'list_project_labels', 'get_template']) {
      assert.ok(!done.includes(wire(bad)), `${bad} executed on a read turn`);
    }
  });

  await test('K. comment request routes to the comment mutation', async () => {
    // Identifier-shaped target (UUID): strict resolution never invents ids,
    // so the test plants a UUID-identified issue like the live path sees.
    const uuid = '123e4567-e89b-12d3-a456-426614174001';
    if (!store.issues.some((i) => i.id === uuid)) {
      store.issues.push({ id: uuid, title: 'X', description: '', team_id: 'team-solo', state: 'open', comments: [] });
    }
    const { out } = await runPreflightTurn(
      `Add a comment to ${uuid} saying 'ARC-AI MCP write test completed successfully.'`);
    assert.strictEqual(out.executed.length, 1);
    assert.strictEqual(out.toolCalls[0].function.name, wire('save_comment'));
    assert.ok(!out.plan.tools.includes(wire('save_issue')), 'issue mutation must not hijack a comment');
  });

  await test('L. update request routes to save_issue with UPDATE semantics', async () => {
    const target = store.issues[0];
    const sel = selectToolSchemas(`Update the issue ${target.id} so the description says done`, NATIVE, { mcpSchemas: schemas });
    assert.ok(sel.mcpCapability.includes(wire('save_issue')), `update must pin save_issue: ${sel.mcpCapability}`);
    assert.ok(!sel.mcpCapability.includes(wire('list_comments')), 'comment reader pinned for UPDATE');
    assert.ok(!sel.mcpCapability.includes(wire('list_project_labels')), 'label reader pinned for UPDATE');
    const res = await TaskExecutor.executeTool(wire('save_issue'),
      { id: target.id, title: target.title, team_id: 'team-solo', description: 'done' }, 'user-1', null, EXEC_OPTS);
    assert.strictEqual(res.success, true, res.error);
    assert.ok(String(res.result).includes('done'));
  });

  await test('M. preflight directly rejects irrelevant required tools', async () => {
    const required = [
      schemas.find((s) => s.function.name === wire('list_comments')),
      schemas.find((s) => s.function.name === wire('list_project_labels')),
      schemas.find((s) => s.function.name === wire('get_template'))
    ].filter(Boolean);
    const out = await ai.runMcpPreflight({
      requiredSchemas: required,
      tools: schemas.slice(0, 6),
      baseText: CREATE_Q,
      intentCaps: classifyIntentCapabilities(CREATE_Q),
      execFn, socket: null, workspaceId: 'ws-create', signal: null,
      title: CREATE_Q, mcpSchemas: schemas
    });
    assert.strictEqual(out.executed.length, 0, 'irrelevant tools must never execute for CREATE');
  });

  await test('N. shared gate: comment rejected, mutation and reads pass', async () => {
    const intentCreate = classifyIntentCapabilities(CREATE_Q);
    assert.ok(intentCreate.has('CREATE'), 'intent must include CREATE');
    const bad = ai.gatePreflightCandidate(
      schemas.find((s) => s.function.name === wire('list_comments')), intentCreate, CREATE_Q);
    assert.strictEqual(bad.ok, false, 'list_comments must fail the CREATE gate');
    assert.strictEqual(bad.reason, 'entity-mismatch');
    const good = ai.gatePreflightCandidate(
      schemas.find((s) => s.function.name === wire('save_issue')), intentCreate, CREATE_Q);
    assert.strictEqual(good.ok, true, 'save_issue must pass the CREATE gate');
    const read = ai.gatePreflightCandidate(
      schemas.find((s) => s.function.name === wire('list_teams')),
      classifyIntentCapabilities('What teams do I have in Linear?'),
      'What teams do I have in Linear?');
    assert.strictEqual(read.ok, true, 'list_teams must pass the LIST gate');
  });

  await test('O. capability miss reports entity-matching candidates, silent when covered', async () => {
    const intentCreate = classifyIntentCapabilities(CREATE_Q);
    const misses = ai.logMcpCapabilityMiss({
      intentCaps: intentCreate,
      capabilityNames: [],
      mcpSchemas: schemas,
      scopedSchemas: schemas,
      serverScope: [],
      queryText: CREATE_Q
    });
    const createMiss = misses.find((m) => m.cap === 'CREATE');
    assert.ok(createMiss, 'zero-pick CREATE must be reported');
    const saveHit = (createMiss.entityCandidates || []).find((c) => c.tool === wire('save_issue'));
    assert.ok(saveHit, `save_issue missing from candidates: ${JSON.stringify(createMiss.entityCandidates)}`);
    assert.ok(saveHit.declared.includes('CREATE'), 'candidate caps must show CREATE');
    assert.ok(typeof saveHit.serverKey === 'string', 'candidate must carry its server key');
    const covered = ai.logMcpCapabilityMiss({
      intentCaps: intentCreate,
      capabilityNames: [wire('save_issue')],
      mcpSchemas: schemas,
      scopedSchemas: schemas,
      serverScope: [],
      queryText: CREATE_Q
    });
    assert.deepStrictEqual(covered, [], 'covered caps must stay silent');
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
