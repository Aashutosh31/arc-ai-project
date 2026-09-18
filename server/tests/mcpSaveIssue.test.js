'use strict';

// Real Linear save_issue semantics (DB-free, no provider keys).
//
// The live Linear MCP exposes mcp_linear_save_issue — NOT a literal
// create_issue tool. This suite proves the generic save/upsert pipeline
// against a strict live-shaped server (save_issue requires title AND
// team_id; save_comment; save_project; readers; distractor label/comment
// tools), through REAL selection → protection → budget → inventory →
// TaskExecutor execution:
//
//   1. save_issue → CREATE+UPDATE when schema supports both
//   2. save_issue is selected for CREATE(ISSUE)
//   3. save_project cannot satisfy CREATE(ISSUE)
//   4. get_issue cannot satisfy CREATE(ISSUE)
//   5. list_issues cannot satisfy CREATE(ISSUE)
//   6. save_issue survives 6-tool budget
//   7. save_issue appears in final provider tools
//   8. inventory contains save_issue only if request.tools does
//   9. silent provider → save_issue recovery (single team auto-resolved)
//   10. required team resolution (single → automatic)
//   11. ambiguous team → clarification with options, never a guessed id
//   12. no invented IDs (unnamed multi-team leaves team_id missing)
//   13. save_issue update path (existing issue + description)
//   14. past interrogative does not mutate
//   15. denied save_issue never executes
//
// Run:  cd server && node tests/mcpSaveIssue.test.js

const assert = require('assert');
const z = require('zod');
const { McpServer } = require('@modelcontextprotocol/server');
const { InMemoryTransport } = require('@modelcontextprotocol/client');

const { McpToolSource, McpManager, McpRegistry } = require('../lib/mcp');
const {
  selectToolSchemas,
  classifyIntentCapabilities,
  declareToolCapabilities,
  toolEntityStem
} = require('../lib/llm/toolSelection');
const { trimToolsToBudget, assembleBudgetedRequest } = require('../lib/llm/contextBudget');
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

// Live-shaped store. teams is mutable so tests cover single vs ambiguous.
const store = {
  teams: [
    { id: 'team-eng', name: 'Engineering' },
    { id: 'team-design', name: 'Design' }
  ],
  issues: [],
  nextIssue: 1,
  createdCalls: 0,
  comments: 0
};

const createServer = () => {
  const server = new McpServer({ name: 'linear-shaped', version: '1.0.0' });
  server.registerTool('list_teams',
    { description: 'List all teams in the workspace.', inputSchema: z.object({}) },
    async () => J(store.teams));
  server.registerTool('list_projects',
    { description: 'List all projects in the workspace.', inputSchema: z.object({}) },
    async () => J([{ id: 'proj-1', name: 'ARC-AI', teamId: 'team-eng' }]));
  server.registerTool('get_issue',
    { description: 'Retrieve a single issue by its identifier.', inputSchema: z.object({ issueId: z.string() }) },
    async ({ issueId }) => J(store.issues.find((i) => i.id === issueId) || null));
  server.registerTool('list_issues',
    { description: 'List issues in the workspace, newest first.', inputSchema: z.object({}) },
    async () => J(store.issues.map((i) => ({ id: i.id, title: i.title, state: i.state }))));
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
          id: `iss-${store.nextIssue}`, identifier: `ARC-${store.nextIssue}`,
          title: String(title), description: String(description || ''),
          team_id, project_id: project_id || null,
          state: 'open', comments: []
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
  server.registerTool('save_project',
    {
      description: 'Create a new project or update an existing one. Omit id to create.',
      inputSchema: z.object({ id: z.string().optional(), name: z.string() })
    },
    async ({ id, name }) => J({ id: id || 'proj-new', name }));
  server.registerTool('save_comment',
    {
      description: 'Add a comment to an existing issue.',
      inputSchema: z.object({ issueId: z.string(), body: z.string() })
    },
    async ({ issueId, body }) => {
      const issue = store.issues.find((i) => i.id === issueId);
      if (!issue) return { content: [{ type: 'text', text: 'Issue not found.' }], isError: true };
      store.comments += 1;
      const comment = { id: `cmt-${store.comments}`, body: String(body) };
      issue.comments.push(comment);
      return J({ id: comment.id, issueId: issue.id, body: comment.body });
    });
  server.registerTool('list_project_labels',
    { description: 'List labels for a project.', inputSchema: z.object({}) },
    async () => J([{ id: 'lbl-1', name: 'bug' }]));
  server.registerTool('list_comments',
    { description: 'List comments on an issue.', inputSchema: z.object({ issueId: z.string().optional() }) },
    async () => J([]));
  return server;
};

const names = (tools) => (tools || []).map((s) => s?.function?.name).filter(Boolean);
const EXEC_OPTS = { workspaceId: 'ws-save', skipCreditCharge: true };
const NATIVE = () => [
  { function: { name: 'memorize', description: 'save a note' } },
  { function: { name: 'recallMemory', description: 'read a note' } },
  { function: { name: 'storeUserFact', description: 'store a fact' } }
];
const CREATE_Q = "Create a Linear issue called 'ARC-AI MCP Integration Test' with the description 'This issue was created by ARC-AI through the Linear MCP.' Do not create another issue.";

let schemas = [];
let liveServer = null;
const wire = (short) => schemas.map((s) => s.function.name).find((n) => n === `mcp_linear_${short}`);
const execFn = (n, a) => TaskExecutor.executeTool(n, a, 'user-1', null, EXEC_OPTS);

const main = async () => {
  const registry = new McpRegistry();
  const manager = new McpManager({ registry });
  McpToolSource.init({ manager, registry });
  liveServer = createServer();
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await liveServer.connect(serverEnd);
  registry.register({
    id: 'save-1', name: 'Linear', scope: 'global', transport: 'stdio',
    testHooks: { createTransport: () => clientEnd }
  });
  schemas = (await McpToolSource.schemasForRequest({ workspaceId: 'ws-save', isGuest: false })).schemas;
  assert.ok(wire('save_issue'), 'save_issue not discovered');

  await test('1. save_issue declares CREATE+UPDATE when schema supports both', async () => {
    const caps = declareToolCapabilities(schemas.find((s) => s.function.name === wire('save_issue')));
    assert.ok(caps.has('CREATE') && caps.has('UPDATE'), `got ${[...caps]}`);
    assert.strictEqual(toolEntityStem(schemas.find((s) => s.function.name === wire('save_issue'))), 'issue');
  });

  await test('2. save_issue is selected for CREATE(ISSUE)', async () => {
    const sel = selectToolSchemas(CREATE_Q, NATIVE, { mcpSchemas: schemas });
    assert.ok(names(sel.tools).includes(wire('save_issue')), `missing: ${names(sel.tools)}`);
    assert.ok(sel.mcpCapability.includes(wire('save_issue')), 'mutation not capability-protected');
  });

  await test('3. save_project cannot satisfy CREATE(ISSUE)', async () => {
    const sel = selectToolSchemas('Create an issue for the login bug', NATIVE, { mcpSchemas: schemas });
    assert.ok(!(sel.mcpCapability || []).includes(wire('save_project')), `project mutation pin: ${sel.mcpCapability}`);
  });

  await test('4. get_issue cannot satisfy CREATE(ISSUE)', async () => {
    const sel = selectToolSchemas('Create an issue for the login bug', NATIVE, { mcpSchemas: schemas });
    assert.ok(!(sel.mcpCapability || []).includes(wire('get_issue')), `reader pin: ${sel.mcpCapability}`);
  });

  await test('5. list_issues cannot satisfy CREATE(ISSUE)', async () => {
    const sel = selectToolSchemas('Create an issue for the login bug', NATIVE, { mcpSchemas: schemas });
    assert.ok(!(sel.mcpCapability || []).includes(wire('list_issues')), `lister pin: ${sel.mcpCapability}`);
  });

  await test('6. save_issue survives 6-tool budget', async () => {
    const sel = selectToolSchemas(CREATE_Q, NATIVE, { mcpSchemas: schemas });
    assert.ok(sel.tools.length <= 6);
    const trimmed = trimToolsToBudget(sel.tools, 60, {
      protectedNames: [...(sel.mcpExplicit || []), ...(sel.mcpCapability || [])]
    });
    assert.ok(names(trimmed).includes(wire('save_issue')), `evicted: ${names(trimmed)}`);
  });

  await test('7. save_issue appears in final provider tools', async () => {
    const sel = selectToolSchemas(CREATE_Q, NATIVE, { mcpSchemas: schemas });
    const { assembleBudgetedRequest } = require('../lib/llm/contextBudget');
    const built = assembleBudgetedRequest({
      systemTemplate: 'SYS __LONG_TERM_MEMORY_SLOT____RETRIEVAL_CONTEXT_SLOT__ END',
      baseUserText: CREATE_Q, query: CREATE_Q, selectedTools: sel.tools, outputBudget: 1200,
      mcpInventoryText: ai.mcpInventoryBlockForTools(sel.tools, {}),
      protectedToolNames: [...(sel.mcpExplicit || []), ...(sel.mcpCapability || [])]
    });
    assert.strictEqual(built.ok, true);
    assert.ok(names(built.tools).includes(wire('save_issue')), `lost: ${names(built.tools)}`);
  });

  await test('8. inventory contains save_issue only if request.tools does', async () => {
    const sel = selectToolSchemas(CREATE_Q, NATIVE, { mcpSchemas: schemas });
    const block = ai.mcpInventoryBlockForTools(sel.tools.slice(0, 6), {});
    const invWires = [...new Set([...block.matchAll(/\bmcp_[a-z0-9_]+\b/g)].map((m) => m[0]))].sort();
    assert.deepStrictEqual(invWires, names(sel.tools).filter((n) => n.startsWith('mcp_')).sort());
  });

  await test('9. silent provider → save_issue recovery (single team auto-resolved)', async () => {
    store.teams = [{ id: 'team-solo', name: 'Solo' }];
    const before = store.createdCalls;
    try {
      const sel = selectToolSchemas(CREATE_Q, NATIVE, { mcpSchemas: schemas });
      const tools = sel.tools.slice(0, 6);
      const required = (sel.mcpCapability || [])
        .map((n) => tools.find((s) => s?.function?.name === n)).filter(Boolean);
      assert.ok(required.some((s) => s.function.name === wire('save_issue')), 'save not required');
      const plan = ai.planMcpRecovery({
        requiredSchemas: required, suppressed: false, proseBad: true, emptyAnswer: false,
        proseText: "I'm unable to create a Linear issue."
      });
      assert.ok(plan, 'no recovery planned');
      const outcome = await ai.runMcpRecovery({
        plan, messages: [{ role: 'user', content: CREATE_Q }],
        systemPrompt: ai.mcpInventoryBlockForTools(plan.retryTools, {}),
        maxTokens: 1200, temperature: 0.3, userContext: { userId: 'user-1' },
        attachments: [], signal: null, metadata: null, baseText: CREATE_Q,
        mcpSchemas: schemas, execFn,
        generate: async () => ({ text: 'still silent', toolCalls: [], provider: 'stub', model: 'stub', tokens: {} })
      });
      assert.ok(outcome.recovered, 'double-silence not recovered');
      assert.strictEqual(outcome.toolCalls.length, 1, 'must construct exactly one call');
      const tc = outcome.toolCalls[0];
      assert.strictEqual(tc.function.name, wire('save_issue'));
      assert.ok(!('project_id' in (tc.function.arguments || {})), 'optional project must not be asked for or invented');
      const res = await TaskExecutor.executeTool(tc.function.name, tc.function.arguments, 'user-1', null, EXEC_OPTS);
      assert.strictEqual(res.success, true, res.error);
      assert.strictEqual(store.createdCalls, before + 1, 'must create exactly one issue');
      const body = JSON.parse(res.result);
      assert.strictEqual(body.team_id, 'team-solo', `wrong team resolved: ${res.result}`);
      assert.ok(body.id, 'no created identity');
    } finally {
      store.teams = [
        { id: 'team-eng', name: 'Engineering' },
        { id: 'team-design', name: 'Design' }
      ];
    }
  });

  await test('10. single team resolves automatically in-turn', async () => {
    store.teams = [{ id: 'team-solo', name: 'Solo' }];
    try {
      const schema = schemas.find((s) => s.function.name === wire('save_issue'));
      const out = await ai.tryCreationContext({
        originalCall: { id: 'c1', function: { name: wire('save_issue'), arguments: { title: 'T' } } },
        execName: wire('save_issue'),
        argSchema: schema,
        intentCaps: new Set(['CREATE']),
        userText: 'Create a Linear issue called T',
        mcpSchemas: schemas,
        execFn
      });
      assert.ok(out && out.toolCalls && out.toolCalls.length === 1, 'not resolved in-turn');
      assert.strictEqual(out.toolCalls[0].function.arguments.team_id, 'team-solo', 'wrong auto team');
    } finally {
      store.teams = [
        { id: 'team-eng', name: 'Engineering' },
        { id: 'team-design', name: 'Design' }
      ];
    }
  });

  await test('11. ambiguous team asks with options, never a guessed id', async () => {
    const schema = schemas.find((s) => s.function.name === wire('save_issue'));
    const out = await ai.tryCreationContext({
      originalCall: { id: 'c1', function: { name: wire('save_issue'), arguments: { title: 'T' } } },
      execName: wire('save_issue'),
      argSchema: schema,
      intentCaps: new Set(['CREATE']),
      userText: 'Create a Linear issue called T',
      mcpSchemas: schemas,
      execFn
    });
    assert.ok(out && out.ask === true, 'ambiguous scope must ask');
    assert.ok(out.optionsNote && out.optionsNote.includes('Engineering') && out.optionsNote.includes('Design'),
      `options missing: ${out.optionsNote}`);
    assert.ok(!JSON.stringify(out.pendingArgs || {}).match(/team-eng|team-design/), 'id invented during ambiguity');
  });

  await test('12. named team resolves from text without asking', async () => {
    const schema = schemas.find((s) => s.function.name === wire('save_issue'));
    const out = await ai.tryCreationContext({
      originalCall: { id: 'c1', function: { name: wire('save_issue'), arguments: { title: 'T' } } },
      execName: wire('save_issue'),
      argSchema: schema,
      intentCaps: new Set(['CREATE']),
      userText: 'Create a Linear issue called T for the Design team',
      mcpSchemas: schemas,
      execFn
    });
    assert.ok(out && out.toolCalls && out.toolCalls.length === 1, 'named team not resolved');
    assert.strictEqual(out.toolCalls[0].function.arguments.team_id, 'team-design');
  });

  await test('13. save_issue update path resolves the existing issue', async () => {
    const target = store.issues[store.issues.length - 1];
    assert.ok(target, 'needs a created issue from test 9');
    const schema = schemas.find((s) => s.function.name === wire('save_issue'));
    // UPDATE intent never takes the creation path.
    const skipped = await ai.tryCreationContext({
      originalCall: { id: 'u1', function: { name: wire('save_issue'), arguments: { description: 'x' } } },
      execName: wire('save_issue'),
      argSchema: schema,
      intentCaps: new Set(['UPDATE']),
      userText: 'Update it so the description says x',
      mcpSchemas: schemas,
      execFn
    });
    assert.strictEqual(skipped, null, 'UPDATE must not take creation path');
    // The same tool executes the update once the id is known. This strict
    // schema requires title+team context on every call, so a correct update
    // resends them alongside the change (missing context fails validation
    // truthfully instead of executing a partial write).
    const res = await TaskExecutor.executeTool(wire('save_issue'),
      { id: target.id, title: target.title, team_id: 'team-solo', description: 'ARC can modify an existing issue through MCP.' }, 'user-1', null, EXEC_OPTS);
    assert.strictEqual(res.success, true, res.error);
    assert.ok(String(res.result).includes('modify an existing issue'), res.result);
  });

  await test('14. past interrogative does not mutate', async () => {
    assert.deepStrictEqual([...classifyIntentCapabilities('What did you just change?')], []);
    const sel = selectToolSchemas('What did you just change?', NATIVE, { mcpSchemas: schemas });
    assert.ok(!(sel.mcpCapability || []).includes(wire('save_issue')), 'history pinned mutation');
    const plan = ai.planMcpRecovery({
      requiredSchemas: [], suppressed: false, proseBad: false, emptyAnswer: false,
      proseText: 'I updated the description.'
    });
    assert.strictEqual(plan, null);
  });

  await test('15. denied save_issue never executes', async () => {
    // Deny-wins is enforced registry-side: re-register the same live
    // server with save_issue denied (last test — safe to re-init).
    const { McpManager: Manager2, McpRegistry: Registry2 } = require('../lib/mcp');
    const { InMemoryTransport: Transport2 } = require('@modelcontextprotocol/client');
    const registry2 = new Registry2();
    const manager2 = new Manager2({ registry: registry2 });
    McpToolSource.init({ manager: manager2, registry: registry2 });
    const server2 = createServer();
    const [clientEnd2, serverEnd2] = Transport2.createLinkedPair();
    await server2.connect(serverEnd2);
    const denied = wire('save_issue');
    registry2.register({
      id: 'save-denied', name: 'Linear', scope: 'global', transport: 'stdio',
      deniedTools: [denied], testHooks: { createTransport: () => clientEnd2 }
    });
    const deniedPick = await McpToolSource.schemasForRequest({ workspaceId: 'ws-save', isGuest: false });
    assert.ok(!names(deniedPick.schemas).some((n) => n === denied), 'denied tool exposed');
    const sel = selectToolSchemas(CREATE_Q, NATIVE, { mcpSchemas: deniedPick.schemas, mcpBlocked: deniedPick.blocked });
    assert.ok(!names(sel.tools).includes(denied), 'denied tool selected');
    const res = await TaskExecutor.executeTool(denied, { title: 'X', team_id: 'team-eng' }, 'user-1', null, EXEC_OPTS);
    assert.strictEqual(res.success, false, 'denied tool executed');
    assert.ok(!JSON.stringify(res).includes('iss-'), 'denied execution leaked a result');
    await McpToolSource.shutdown();
    try { await server2.close(); } catch { /* best effort */ }
    try { await liveServer.close(); } catch { /* best effort */ }
    liveServer = null;
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
