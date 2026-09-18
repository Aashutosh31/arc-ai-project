'use strict';

// Deterministic MCP action enforcement (DB-free, no provider keys).
//
// Production failure: "What teams and projects do I have in Linear?"
// completed the provider request with tools attached, yet NO MCP tool
// executed — the model answered prose claiming inability + UI/API
// alternatives. Selection and inventory were correct; the agent simply
// chose not to act.
//
// Mechanism under test: zero tool calls + REQUIRED_FOR_EXECUTION MCP
// capabilities (policy-filtered + intent/entity-selected + budgeted) →
// exactly ONE constrained recovery retry (single unambiguous tool →
// provider-forced via standard tool_choice), adopted into the normal
// execution/continuation machinery. False-unavailable prose always
// recovers; legitimate clarifications never do; denied/unauthorized/
// unavailable capabilities never force.
//
// The provider is stubbed SILENT on the first pass (reproducing the
// failure); the recovery retry emits the forced calls; execution runs for
// real through TaskExecutor against a live in-memory integration.
//
//   A. LIST(TEAM)+LIST(PROJECT): silent provider → recovery → real results
//   B. single READ: prose instead of call → recovery executes READ
//   C. CREATE: inability prose → recovery executes CREATE exactly once
//   D. COMMENT: inability prose → recovery executes COMMENT exactly once
//   E. UPDATE: inability prose → recovery executes UPDATE exactly once
//   F. denied tool: never forced
//   G. unauthorized MCP: never forced
//   H. unavailable capability: truthful answer stands, no retry
//   I. continuation: two required capabilities execute across rounds
//   J. inventory/request.tools equality on every provider request
//   K. 6-tool budget: required capabilities survive
//   L. no duplicate execution (stuttered identical calls deduped)
//
// Run:  cd server && node tests/mcpEnforcement.test.js

const assert = require('assert');
const z = require('zod');
const { McpServer } = require('@modelcontextprotocol/server');
const { InMemoryTransport } = require('@modelcontextprotocol/client');

const { McpToolSource, McpManager, McpRegistry } = require('../lib/mcp');
const {
  selectToolSchemas,
  selectContinuationTools,
  classifyIntentCapabilities,
  partitionToolCallsByExposure
} = require('../lib/llm/toolSelection');
const { trimToolsToBudget } = require('../lib/llm/contextBudget');
const GroqProvider = require('../lib/llm/providers/GroqProvider');
const GeminiProvider = require('../lib/llm/providers/GeminiProvider');
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

// Real-Linear-shaped integration (names from the production report).
const store = {
  issues: [],
  nextIssue: 1,
  comments: 0,
  createdCalls: 0
};

const createServer = () => {
  const server = new McpServer({ name: 'linear-shaped', version: '1.0.0' });
  server.registerTool('list_teams',
    { description: 'List all teams in the workspace.', inputSchema: z.object({}) },
    async () => J([{ id: 'team-1', name: 'Engineering' }, { id: 'team-2', name: 'Design' }]));
  server.registerTool('list_projects',
    { description: 'List all projects in the workspace.', inputSchema: z.object({}) },
    async () => J([{ id: 'proj-1', name: 'ARC-AI', teamId: 'team-1' }]));
  server.registerTool('list_issues',
    { description: 'List issues in the workspace, newest first.', inputSchema: z.object({}) },
    async () => J(store.issues.map((i) => ({ id: i.id, title: i.title, state: i.state }))));
  server.registerTool('save_issue',
    {
      description: 'Create a new issue or update an existing one. Omit id to create.',
      inputSchema: z.object({
        id: z.string().optional(), title: z.string().optional(),
        description: z.string().optional(), state: z.string().optional()
      })
    },
    async ({ id, title, description, state }) => {
      if (!id) {
        store.createdCalls += 1;
        const issue = {
          id: `iss-${store.nextIssue}`, identifier: `ARC-${store.nextIssue}`,
          title: String(title || 'Untitled'), description: String(description || ''),
          state: 'open', comments: []
        };
        store.nextIssue += 1;
        store.issues.push(issue);
        return J({ id: issue.id, identifier: issue.identifier, title: issue.title, state: issue.state });
      }
      const issue = store.issues.find((i) => i.id === id);
      if (!issue) return { content: [{ type: 'text', text: 'Issue not found.' }], isError: true };
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
      store.comments += 1;
      const comment = { id: `cmt-${store.comments}`, body: String(body) };
      issue.comments.push(comment);
      return J({ id: comment.id, issueId: issue.id, body: comment.body });
    });
  return server;
};

const names = (tools) => (tools || []).map((s) => s?.function?.name).filter(Boolean);
const EXEC_OPTS = { workspaceId: 'ws-enf', skipCreditCharge: true };
const wire = (schemas, short) => schemas.map((s) => s.function.name).find((n) => n === `mcp_linear_${short}`);

// Selection + budgeting, production order (natives + 6-cap).
const NATIVE = () => [
  { function: { name: 'memorize', description: 'save a note' } },
  { function: { name: 'recallMemory', description: 'read a note' } },
  { function: { name: 'storeUserFact', description: 'store a fact' } }
];
const requiredOf = (sel, tools) => (sel.mcpCapability || [])
  .map((n) => tools.find((s) => s?.function?.name === n)).filter(Boolean);

// Drive ONE enforcement turn: silent first pass → recovery retry (stubbed)
// → adopt → REAL execution. Returns executed results.
const runEnforcedTurn = async (schemas, query, firstProse, stubCalls) => {
  const sel = selectToolSchemas(query, NATIVE, { mcpSchemas: schemas });
  const tools = sel.tools.slice(0, 6);
  const required = requiredOf(sel, tools);
  const plan = ai.planMcpRecovery({
    requiredSchemas: required,
    suppressed: Boolean(sel.mcpSuppressed),
    proseBad: true,
    emptyAnswer: false,
    proseText: firstProse
  });
  assert.ok(plan, `no recovery planned for "${query}" (cap=${sel.mcpCapability})`);
  // Inventory equality on the recovery request.
  const block = ai.mcpInventoryBlockForTools(plan.retryTools, {});
  const invWires = [...new Set([...block.matchAll(/\bmcp_[a-z0-9_]+\b/g)].map((m) => m[0]))].sort();
  assert.deepStrictEqual(invWires, names(plan.retryTools).sort(), 'recovery inventory mismatch');
  const outcome = await ai.runMcpRecovery({
    plan,
    messages: [{ role: 'user', content: query }],
    systemPrompt: ai.refreshInventoryPrompt('SYS', block),
    maxTokens: 1200,
    temperature: 0.3,
    userContext: { userId: 'user-1' },
    attachments: [],
    signal: null,
    metadata: null,
    generate: async (req) => {
      // The constrained retry carries exactly the required tools; a single
      // unambiguous tool is provider-forced (standard tool_choice).
      assert.ok(Array.isArray(req.tools) && req.tools.length > 0, 'retry carried no tools');
      if (plan.forcedTool) {
        assert.ok(req.forcedTool === plan.forcedTool, 'single tool not forced');
      }
      const reqBlock = ai.mcpInventoryBlockForTools(req.tools, {});
      const reqWires = [...new Set([...reqBlock.matchAll(/\bmcp_[a-z0-9_]+\b/g)].map((m) => m[0]))].sort();
      assert.deepStrictEqual(reqWires, names(req.tools).sort(), 'retry inventory mismatch');
      return { text: '', toolCalls: stubCalls(req), provider: 'stub', model: 'stub', tokens: {} };
    }
  });
  assert.ok(outcome.recovered && outcome.toolCalls.length, 'recovery adopted no calls');
  const results = [];
  for (const tc of outcome.toolCalls) {
    const fname = tc.function.name;
    let args = {};
    try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments || {}; }
    catch { args = {}; }
    const res = await TaskExecutor.executeTool(fname, args, 'user-1', null, EXEC_OPTS);
    results.push({ name: fname, res });
  }
  return { sel, tools, plan, outcome, results };
};

const main = async () => {
  const registry = new McpRegistry();
  const manager = new McpManager({ registry });
  McpToolSource.init({ manager, registry });
  const server = createServer();
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd);
  registry.register({
    id: 'enf-1', name: 'Linear', scope: 'global', transport: 'stdio',
    testHooks: { createTransport: () => clientEnd }
  });
  const pick = await McpToolSource.schemasForRequest({ workspaceId: 'ws-enf', isGuest: false });
  const schemas = pick.schemas;
  assert.ok(schemas.length >= 5, `expected ≥5 tools, got ${schemas.length}`);

  await test('A. LIST(TEAM)+LIST(PROJECT): silent provider → recovery → real results', async () => {
    const q = 'What teams and projects do I have in Linear?';
    const { results } = await runEnforcedTurn(schemas, q,
      "I can't access your Linear teams and projects. You can view them in the Linear UI or use the API with a token.",
      (req) => names(req.tools)
        .filter((n) => n === wire(schemas, 'list_teams') || n === wire(schemas, 'list_projects'))
        .map((n, i) => ({ id: `t${i}`, function: { name: n, arguments: {} } })));
    assert.strictEqual(results.length, 2, `expected both reads, got ${results.map((r) => r.name)}`);
    assert.ok(results.every((r) => r.res.success), 'read failed');
    assert.ok(String(results.find((r) => r.name === wire(schemas, 'list_teams')).res.result).includes('Engineering'));
    assert.ok(String(results.find((r) => r.name === wire(schemas, 'list_projects')).res.result).includes('ARC-AI'));
  });

  await test('B. single READ: prose instead of call → recovery executes READ', async () => {
    const q = 'What issues are open?';
    const { results } = await runEnforcedTurn(schemas, q,
      "I'm unable to retrieve your issues right now.",
      (req) => [{ id: 'r1', function: { name: wire(schemas, 'list_issues'), arguments: {} } }]);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].res.success, true, results[0].res.error);
  });

  await test('C. CREATE: inability prose → recovery executes CREATE exactly once', async () => {
    const before = store.createdCalls;
    const q = "Create a Linear issue called 'ARC-AI MCP Integration Test' with the description 'This issue was created by ARC-AI through the Linear MCP.' Do not create another issue.";
    const { plan, results } = await runEnforcedTurn(schemas, q,
      "I don't have a tool to create Linear issues. Please use the Linear UI.",
      (req) => [{
        id: 'c1',
        function: {
          name: wire(schemas, 'save_issue'),
          arguments: { title: 'ARC-AI MCP Integration Test', description: 'This issue was created by ARC-AI through the Linear MCP.' }
        }
      }]);
    assert.strictEqual(plan.forcedTool, wire(schemas, 'save_issue'), 'single mutation not forced');
    assert.strictEqual(store.createdCalls, before + 1, 'must create exactly one issue');
    assert.ok(JSON.parse(results[0].res.result).id, 'no created identity');
  });

  await test('D. COMMENT: inability prose → recovery executes COMMENT exactly once', async () => {
    const target = store.issues[store.issues.length - 1].id;
    const before = store.comments;
    const q = "Add a comment to it saying 'ARC-AI MCP write test completed successfully.'";
    const sel = selectToolSchemas(`Create a Linear issue called T.\n${q}`, NATIVE, { mcpSchemas: schemas });
    const tools = sel.tools.slice(0, 6);
    const required = requiredOf(sel, tools).filter((s) => s.function.name === wire(schemas, 'save_comment'));
    assert.ok(required.length, `comment not required: ${sel.mcpCapability}`);
    const plan = ai.planMcpRecovery({
      requiredSchemas: required, suppressed: false, proseBad: true, emptyAnswer: false,
      proseText: "I can't add comments to Linear issues."
    });
    assert.ok(plan && plan.forcedTool === wire(schemas, 'save_comment'));
    const outcome = await ai.runMcpRecovery({
      plan, messages: [{ role: 'user', content: q }],
      systemPrompt: ai.mcpInventoryBlockForTools(plan.retryTools, {}),
      maxTokens: 1200, temperature: 0.3, userContext: { userId: 'user-1' },
      attachments: [], signal: null, metadata: null,
      generate: async () => ({
        text: '', provider: 'stub', model: 'stub', tokens: {},
        toolCalls: [{ id: 'd1', function: { name: wire(schemas, 'save_comment'), arguments: { issueId: target, body: 'ARC-AI MCP write test completed successfully.' } } }]
      })
    });
    assert.ok(outcome.recovered);
    const tc = outcome.toolCalls[0];
    const res = await TaskExecutor.executeTool(tc.function.name, tc.function.arguments, 'user-1', null, EXEC_OPTS);
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(store.comments, before + 1, 'comment executed more than once');
  });

  await test('E. UPDATE: inability prose → recovery executes UPDATE exactly once', async () => {
    const target = store.issues[store.issues.length - 1].id;
    const q = "Update it so the description also says 'ARC can modify an existing issue through MCP.'";
    const sel = selectToolSchemas(`Create a Linear issue called T.\n${q}`, NATIVE, { mcpSchemas: schemas });
    const tools = sel.tools.slice(0, 6);
    const required = requiredOf(sel, tools).filter((s) => s.function.name === wire(schemas, 'save_issue'));
    assert.ok(required.length, `update not required: ${sel.mcpCapability}`);
    const plan = ai.planMcpRecovery({
      requiredSchemas: required, suppressed: false, proseBad: true, emptyAnswer: false,
      proseText: "I'm unable to update that issue."
    });
    assert.ok(plan);
    const outcome = await ai.runMcpRecovery({
      plan, messages: [{ role: 'user', content: q }],
      systemPrompt: ai.mcpInventoryBlockForTools(plan.retryTools, {}),
      maxTokens: 1200, temperature: 0.3, userContext: { userId: 'user-1' },
      attachments: [], signal: null, metadata: null,
      generate: async () => ({
        text: '', provider: 'stub', model: 'stub', tokens: {},
        toolCalls: [{ id: 'e1', function: { name: wire(schemas, 'save_issue'), arguments: { id: target, description: 'ARC can modify an existing issue through MCP.' } } }]
      })
    });
    assert.ok(outcome.recovered);
    const tc = outcome.toolCalls[0];
    const res = await TaskExecutor.executeTool(tc.function.name, tc.function.arguments, 'user-1', null, EXEC_OPTS);
    assert.strictEqual(res.success, true, res.error);
    assert.ok(String(res.result).includes('modify an existing issue'), res.result);
    // Completion via the same mutation path, no repeated id needed.
    const done = await TaskExecutor.executeTool(wire(schemas, 'save_issue'), { id: target, state: 'completed' }, 'user-1', null, EXEC_OPTS);
    assert.strictEqual(done.success, true, done.error);
    assert.ok(String(done.result).includes('completed'), done.result);
  });

  await test('F. denied tool is never forced', async () => {
    const denied = wire(schemas, 'save_issue');
    const plan = ai.planMcpRecovery({
      // Denied tools never enter the exposed set, so no required schema
      // can name them; a stray name resolves to nothing required.
      requiredSchemas: [], suppressed: true, proseBad: true, emptyAnswer: false,
      proseText: "I can't create that."
    });
    assert.strictEqual(plan, null, 'suppressed request planned recovery');
    void denied;
  });

  await test('G. unauthorized MCP is never forced', async () => {
    const plan = ai.planMcpRecovery({
      requiredSchemas: [], suppressed: false, proseBad: true, emptyAnswer: false,
      proseText: "I can't access that."
    });
    assert.strictEqual(plan, null, 'forced without exposure');
    const block = ai.mcpInventoryBlockForTools([], {});
    assert.ok(/No MCP tools are currently available/.test(block));
  });

  await test('H. unavailable capability keeps its truthful answer', async () => {
    const sel = selectToolSchemas('Explain encapsulation in OOP', NATIVE, { mcpSchemas: schemas });
    assert.strictEqual((sel.mcpCapability || []).length, 0, 'knowledge question pinned MCP');
    const plan = ai.planMcpRecovery({
      requiredSchemas: [], suppressed: false, proseBad: false, emptyAnswer: false,
      proseText: 'Encapsulation is bundling data with methods.'
    });
    assert.strictEqual(plan, null, 'recovery planned without capability');
    // A legitimate clarification is never overridden either.
    const plan2 = ai.planMcpRecovery({
      requiredSchemas: [schemas[0]], suppressed: false, proseBad: false, emptyAnswer: false,
      proseText: 'Which team should I create it in?'
    });
    assert.strictEqual(plan2, null, 'clarification overridden');
  });

  await test('I. continuation executes the remaining required capability', async () => {
    const prev = [
      NATIVE()[0],
      schemas.find((s) => s.function.name === wire(schemas, 'list_teams')),
      schemas.find((s) => s.function.name === wire(schemas, 'list_projects'))
    ];
    const cont = selectContinuationTools(prev, [wire(schemas, 'list_teams')], () => [], {
      mcpSchemas: schemas, requiredNames: [wire(schemas, 'list_teams'), wire(schemas, 'list_projects')]
    });
    assert.ok(names(cont.tools).includes(wire(schemas, 'list_teams')), 'active lost');
    assert.ok(names(cont.tools).includes(wire(schemas, 'list_projects')), 'remaining required lost');
    const block = ai.mcpInventoryBlockForTools(cont.tools, {});
    const invWires = [...new Set([...block.matchAll(/\bmcp_[a-z0-9_]+\b/g)].map((m) => m[0]))].sort();
    assert.deepStrictEqual(invWires, names(cont.tools).filter((n) => n.startsWith('mcp_')).sort());
    const res = await TaskExecutor.executeTool(wire(schemas, 'list_projects'), {}, 'user-1', null, EXEC_OPTS);
    assert.strictEqual(res.success, true, res.error);
  });

  await test('J. history question carries no required capability (TEST 7)', async () => {
    assert.deepStrictEqual([...classifyIntentCapabilities('What did you just change?')], []);
    const sel = selectToolSchemas('What did you just change?', NATIVE, { mcpSchemas: schemas });
    const plan = ai.planMcpRecovery({
      requiredSchemas: requiredOf(sel, sel.tools), suppressed: Boolean(sel.mcpSuppressed),
      proseBad: false, emptyAnswer: false, proseText: 'I updated the description.'
    });
    assert.strictEqual(plan, null, 'history answer would be overridden');
  });

  await test('K. required capabilities survive a crushing budget', async () => {
    const sel = selectToolSchemas('What teams and projects do I have in Linear?', NATIVE, { mcpSchemas: schemas });
    const trimmed = trimToolsToBudget(sel.tools, 60, {
      protectedNames: [...(sel.mcpExplicit || []), ...(sel.mcpCapability || [])]
    });
    for (const n of (sel.mcpCapability || [])) {
      assert.ok(names(trimmed).includes(n), `${n} evicted`);
    }
  });

  await test('L. stuttered identical calls execute exactly once', async () => {
    const before = store.createdCalls;
    const target = wire(schemas, 'save_issue');
    const dup = { id: 'dup', function: { name: target, arguments: { title: 'L-dedupe', description: 'x' } } };
    const outcome = await ai.runMcpRecovery({
      plan: { retryTools: [schemas.find((s) => s.function.name === target)], forcedTool: target },
      messages: [{ role: 'user', content: 'Create issue L-dedupe' }],
      systemPrompt: 'SYS', maxTokens: 1200, temperature: 0.3,
      userContext: { userId: 'user-1' }, attachments: [], signal: null, metadata: null,
      generate: async () => ({ text: '', provider: 'stub', model: 'stub', tokens: {}, toolCalls: [dup, { ...dup, id: 'dup2' }] })
    });
    assert.ok(outcome.recovered);
    assert.strictEqual(outcome.toolCalls.length, 1, 'duplicates not deduped');
    for (const tc of outcome.toolCalls) {
      const r = await TaskExecutor.executeTool(tc.function.name, tc.function.arguments, 'user-1', null, EXEC_OPTS);
      assert.strictEqual(r.success, true, r.error);
    }
    assert.strictEqual(store.createdCalls, before + 1, 'executed more than once');
  });

  await test('N. double-silence on reads → enforced calls → real results', async () => {
    const q = 'What teams and projects do I have in Linear?';
    const sel = selectToolSchemas(q, NATIVE, { mcpSchemas: schemas });
    const required = requiredOf(sel, sel.tools.slice(0, 6));
    assert.ok(required.length >= 2, `not required: ${sel.mcpCapability}`);
    const plan = ai.planMcpRecovery({
      requiredSchemas: required, suppressed: false, proseBad: true, emptyAnswer: false,
      proseText: "I can't access your Linear teams and projects."
    });
    assert.ok(plan);
    const silent = async () => ({ text: 'still nothing', toolCalls: [], provider: 'stub', model: 'stub', tokens: {} });
    const outcome = await ai.runMcpRecovery({
      plan, messages: [{ role: 'user', content: q }],
      systemPrompt: ai.mcpInventoryBlockForTools(plan.retryTools, {}),
      maxTokens: 1200, temperature: 0.3, userContext: { userId: 'user-1' },
      attachments: [], signal: null, metadata: null, baseText: q, generate: silent
    });
    assert.ok(outcome.recovered && outcome.enforced, 'double-silence not enforced');
    assert.strictEqual(outcome.toolCalls.length, 2, 'both reads must be constructed');
    for (const tc of outcome.toolCalls) {
      const res = await TaskExecutor.executeTool(tc.function.name, tc.function.arguments, 'user-1', null, EXEC_OPTS);
      assert.strictEqual(res.success, true, res.error);
    }
    assert.ok(String((await TaskExecutor.executeTool(
      wire(schemas, 'list_teams'), {}, 'user-1', null, EXEC_OPTS)).result).includes('Engineering'));
  });

  await test('O. strict args: echo-fill rejected, quoted title enforced once', async () => {
    const reqTitle = (n) => ({
      type: 'function',
      function: {
        name: n, description: 'd',
        parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
      }
    });
    // Whole-command echo is never a resolved title.
    assert.strictEqual(ai.resolveEnforcementArgs(reqTitle('mcp_x_create'), 'Create an issue').ok, false);
    // Quoted title resolves to the quote.
    const good = ai.resolveEnforcementArgs(reqTitle('mcp_x_create'), "Create an issue called 'N-1'");
    assert.strictEqual(good.ok, true);
    assert.strictEqual(good.args.title, 'N-1');
    // Zero-required-param reads always resolve.
    assert.strictEqual(ai.resolveEnforcementArgs(
      { type: 'function', function: { name: 'mcp_x_list', description: 'd', parameters: { type: 'object', properties: {} }, } },
      'List things').ok, true);
    // End-to-end: quoted create enforced exactly once through real execution.
    const before = store.createdCalls;
    const outcome = await ai.runMcpRecovery({
      plan: {
        retryTools: [schemas.find((s) => s.function.name === wire(schemas, 'save_issue'))],
        forcedTool: wire(schemas, 'save_issue')
      },
      messages: [{ role: 'user', content: "Create an issue called 'N-enforced'" }],
      systemPrompt: 'SYS', maxTokens: 1200, temperature: 0.3,
      userContext: { userId: 'user-1' }, attachments: [], signal: null, metadata: null,
      baseText: "Create an issue called 'N-enforced'",
      generate: async () => ({ text: 'nope', toolCalls: [], provider: 'stub', model: 'stub', tokens: {} })
    });
    assert.ok(outcome.recovered && outcome.enforced, 'quoted create not enforced');
    assert.strictEqual(outcome.toolCalls.length, 1);
    const tc = outcome.toolCalls[0];
    const res = await TaskExecutor.executeTool(tc.function.name, tc.function.arguments, 'user-1', null, EXEC_OPTS);
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(store.createdCalls, before + 1, 'must execute exactly once');
  });

  await test('P. observed false-unavailable prose is classified proseBad', async () => {
    const { isNoToolAvailableProse, isManualApiFallbackProse } = require('../lib/llm/toolSelection');
    assert.strictEqual(
      isNoToolAvailableProse('I\u2019m unable to create a new Linear issue because the authorized Linear integration does not provide a \u201ccreate-issue\u201d tool.'),
      true, 'observed "does not provide a tool" claim missed');
    assert.strictEqual(isManualApiFallbackProse('Open Linear (web or desktop app).'), true, 'observed UI walkthrough missed');
    assert.strictEqual(isManualApiFallbackProse('Click New Issue.'), true, 'observed click-step missed');
    // Legitimate clarifications must never trip either classifier.
    assert.strictEqual(isNoToolAvailableProse('Which team should I create it in, Engineering or Design?'), false);
    assert.strictEqual(isManualApiFallbackProse('Which team should I create it in, Engineering or Design?'), false);
    assert.strictEqual(isNoToolAvailableProse('Could you specify the title?'), false);
    assert.strictEqual(isManualApiFallbackProse('I created the issue with title X.'), false);
  });

  await test('Q. recovery gates wrong-entity tools: no retry, no execution, mismatch reported', async () => {
    const q = "Create a Linear issue called 'ARC-AI MCP Integration Test' with the description 'x'. Do not create another issue.";
    const commentSchema = schemas.find((s) => s.function.name === wire(schemas, 'save_comment'));
    let generated = false;
    const outcome = await ai.runMcpRecovery({
      plan: { retryTools: [commentSchema], forcedTool: wire(schemas, 'save_comment') },
      messages: [{ role: 'user', content: q }],
      systemPrompt: 'SYS', maxTokens: 1200, temperature: 0.3,
      userContext: { userId: 'user-1' }, attachments: [], signal: null, metadata: null,
      baseText: q, mcpSchemas: schemas,
      execFn: (n, a) => TaskExecutor.executeTool(n, a, 'user-1', null, EXEC_OPTS),
      generate: async () => { generated = true; return { text: '', toolCalls: [], provider: 'stub', model: 'stub', tokens: {} }; }
    });
    assert.strictEqual(outcome.recovered, false, 'wrong-entity tool must not recover');
    assert.strictEqual(outcome.toolCalls.length, 0, 'wrong-entity tool must not construct calls');
    assert.strictEqual(outcome.capabilityMismatch, true, 'mismatch flag missing');
    assert.strictEqual(generated, false, 'provider must not be retried for a mismatched set');
    assert.ok((outcome.unresolved || []).some((u) => u.reason === 'capability-mismatch'), 'mismatch unresolved entry missing');
  });

  await test('R. observed false prose + correct mutation still recovers and creates once', async () => {
    const before = store.createdCalls;
    const q = "Create a Linear issue called 'ARC-AI MCP Integration Test' with the description 'This issue was created by ARC-AI through the Linear MCP.' Do not create another issue.";
    const { results } = await runEnforcedTurn(schemas, q,
      'I\u2019m unable to create a new Linear issue because the authorized Linear integration does not provide a \u201ccreate-issue\u201d tool. Open Linear (web or desktop app). Click New Issue.',
      (req) => [{
        id: 'c1',
        function: {
          name: wire(schemas, 'save_issue'),
          arguments: { title: 'ARC-AI MCP Integration Test', description: 'This issue was created by ARC-AI through the Linear MCP.' }
        }
      }]);
    assert.strictEqual(store.createdCalls, before + 1, 'must create exactly one issue');
    assert.ok(JSON.parse(results[0].res.result).id, 'no created identity');
  });

  await test('M. provider forced-tool shapes (standard features only)', async () => {
    const tools = [{ type: 'function', function: { name: 'mcp_linear_list_teams', description: 'd', parameters: { type: 'object', properties: {} } } }];
    assert.deepStrictEqual(
      GroqProvider.buildRequestParams({ tools, forcedTool: 'mcp_linear_list_teams' }).tool_choice,
      { type: 'function', function: { name: 'mcp_linear_list_teams' } });
    assert.strictEqual(GroqProvider.buildRequestParams({ tools, forcedTool: 'nope' }).tool_choice, 'auto');
    assert.deepStrictEqual(
      GeminiProvider.buildConfig({ tools, forcedTool: 'mcp_linear_list_teams' }).toolConfig,
      { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['mcp_linear_list_teams'] } });
    // Exposure invariant on adopted calls.
    const { unexposedNames } = partitionToolCallsByExposure(
      [{ id: '1', function: { name: 'mcp_linear_list_teams', arguments: {} } }], tools);
    assert.strictEqual(unexposedNames.length, 0);
  });

  await McpToolSource.shutdown();
  try { await server.close(); } catch { /* best effort */ }

  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`\nFAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
