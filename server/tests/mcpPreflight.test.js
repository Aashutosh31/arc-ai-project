'use strict';

// Authoritative MCP preflight (DB-free, no provider keys).
//
// USER MESSAGE → MCP PREFLIGHT → native/LLM as needed → MCP EXECUTION →
// LLM SYNTHESIS. For qualifying requests the required MCP tools execute
// BEFORE any free provider round: the model synthesizes real results but
// can never veto an authorized capability. No new heuristics, no retry
// layers — preflight reuses the existing classifier, selection, strict
// resolver, TaskExecutor, and execution.* socket channel.
//
//   1. LIST(TEAM) → direct MCP execution
//   2. LIST(PROJECT) → direct MCP execution
//   3. multi-capability read → both execute
//   4. CREATE(ISSUE) → save_issue execution (quoted title, no echo)
//   5. UPDATE(ISSUE) → mutation execution (pasted id)
//   6. COMMENT → comment execution (pasted id + quoted body)
//   7. empty list → successful empty result (data, not failure)
//   8. denied tool → no execution
//   9. unauthorized tool → no execution
//   10. unavailable capability → truthful non-executable plan
//   11. ambiguous create context → needsClarification, nothing executed
//   12. no invented IDs
//   13. realtime plan == MCP preflight plan (event sequence)
//   14. synthesis receives actual MCP results (shapes)
//   15. historical question → no mutation
//   16. inventory consistency
//   17. continuation compatible (calls reference request.tools)
//   18. preflight precedes the free provider round (source order)
//
// Run:  cd server && node tests/mcpPreflight.test.js

const assert = require('assert');
const z = require('zod');
const { McpServer } = require('@modelcontextprotocol/server');
const { InMemoryTransport } = require('@modelcontextprotocol/client');

const { McpToolSource, McpManager, McpRegistry } = require('../lib/mcp');
const {
  selectToolSchemas,
  classifyIntentCapabilities,
  partitionToolCallsByExposure
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
    { description: 'List all teams in the workspace.', inputSchema: z.object({}) },
    async () => J(store.teams));
  server.registerTool('list_projects',
    { description: 'List all projects in the workspace.', inputSchema: z.object({}) },
    async () => J([{ id: 'proj-1', name: 'ARC-AI', teamId: 'team-eng' }]));
  server.registerTool('list_issues',
    { description: 'List issues in the workspace, newest first.', inputSchema: z.object({}) },
    async () => J(store.issues.map((i) => ({ id: i.id, title: i.title, state: i.state }))));
  server.registerTool('save_issue',
    {
      description: 'Create a new issue or update an existing one. Omit id to create a new issue with a title.',
      inputSchema: z.object({
        id: z.string().optional(),
        title: z.string(),
        description: z.string().optional(),
        team_id: z.string().optional(),
        state: z.string().optional()
      })
    },
    async ({ id, title, description, team_id, state }) => {
      if (!id) {
        store.createdCalls += 1;
        const issue = {
          id: `iss-${store.nextIssue}`, identifier: `ARC-${store.nextIssue}`,
          title: String(title), description: String(description || ''),
          team_id: team_id || null, state: 'open', comments: []
        };
        store.nextIssue += 1;
        store.issues.push(issue);
        return J({ id: issue.id, identifier: issue.identifier, title: issue.title, state: issue.state });
      }
      const issue = store.issues.find((i) => i.id === id);
      if (!issue) return { content: [{ type: 'text', text: 'Issue not found.' }], isError: true };
      if (typeof description === 'string') issue.description = description;
      if (typeof state === 'string') issue.state = state;
      return J({ id: issue.id, description: issue.description, state: issue.state });
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
  server.registerTool('close_record',
    {
      description: 'Close a record by id.',
      inputSchema: z.object({ id: z.string() })
    },
    async ({ id }) => J({ id, state: 'closed' }));
  return server;
};

const names = (tools) => (tools || []).map((s) => s?.function?.name).filter(Boolean);
const EXEC_OPTS = { workspaceId: 'ws-pre', skipCreditCharge: true };
const NATIVE = () => [
  { function: { name: 'memorize', description: 'save a note' } },
  { function: { name: 'recallMemory', description: 'read a note' } },
  { function: { name: 'storeUserFact', description: 'store a fact' } }
];

let schemas = [];
let liveServer = null;
const wire = (short) => schemas.map((s) => s.function.name).find((n) => n === `mcp_linear_${short}`);
const execFn = (n, a) => TaskExecutor.executeTool(n, a, 'user-1', null, EXEC_OPTS);
const fakeSocket = () => {
  const emits = [];
  return {
    emits,
    isInterrupted: false,
    emit: (event, payload) => { emits.push({ event, payload }); }
  };
};

// Full production-order front half: select → finalize → require → preflight.
const runPreflightTurn = async (query, { socket = null } = {}) => {
  const sel = selectToolSchemas(query, NATIVE, { mcpSchemas: schemas });
  const tools = sel.tools.slice(0, 6);
  const required = ai.requiredMcpSchemas(
    { mcpCapability: sel.mcpCapability }, [], tools);
  const out = await ai.runMcpPreflight({
    requiredSchemas: required,
    tools,
    baseText: query,
    intentCaps: classifyIntentCapabilities(query),
    execFn,
    socket,
    workspaceId: 'ws-pre',
    signal: null,
    title: query
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
    id: 'pre-1', name: 'Linear', scope: 'global', transport: 'stdio',
    testHooks: { createTransport: () => clientEnd }
  });
  schemas = (await McpToolSource.schemasForRequest({ workspaceId: 'ws-pre', isGuest: false })).schemas;

  await test('1. LIST(TEAM) → direct MCP execution', async () => {
    const { out } = await runPreflightTurn('What teams do I have in Linear?');
    assert.strictEqual(out.plan.source, 'mcp');
    assert.strictEqual(out.plan.executable, true);
    assert.deepStrictEqual(out.plan.tools, [wire('list_teams')]);
    assert.strictEqual(out.executed.length, 1);
    assert.ok(String(out.executed[0].content.result).includes('Engineering'), 'no real result');
  });

  await test('2. LIST(PROJECT) → direct MCP execution', async () => {
    const { out } = await runPreflightTurn('What projects do I have in Linear?');
    assert.deepStrictEqual(out.plan.tools, [wire('list_projects')]);
    assert.strictEqual(out.executed.length, 1);
    assert.ok(String(out.executed[0].content.result).includes('ARC-AI'));
  });

  await test('3. multi-capability read → both execute', async () => {
    const { out } = await runPreflightTurn('What teams and projects do I have in Linear?');
    assert.deepStrictEqual(out.plan.capabilities.sort(), ['LIST(PROJECT)', 'LIST(TEAM)']);
    assert.strictEqual(out.executed.length, 2, 'both reads must execute');
    assert.ok(out.executed.every((e) => e.content && e.content.success), 'read failed');
  });

  await test('4. CREATE(ISSUE) → save_issue execution (quoted title, no echo)', async () => {
    const before = store.createdCalls;
    const { out } = await runPreflightTurn(
      "Create a Linear issue called 'ARC-AI MCP Integration Test' with the description 'x'. Do not create another issue.");
    assert.strictEqual(out.plan.executable, true);
    assert.strictEqual(out.executed.length, 1, 'exactly one construction');
    const call = out.toolCalls[0];
    assert.strictEqual(call.function.name, wire('save_issue'));
    assert.strictEqual(call.function.arguments.title, 'ARC-AI MCP Integration Test', 'echoed title would fabricate');
    assert.strictEqual(store.createdCalls, before + 1, 'must execute exactly once');
    assert.ok(JSON.parse(out.executed[0].content.result).id, 'no created identity');
  });

  await test('5. UPDATE(ISSUE) → mutation execution (pasted id)', async () => {
    const { out } = await runPreflightTurn(
      'Close record 123e4567-e89b-12d3-a456-426614174000');
    assert.strictEqual(out.executed.length, 1);
    assert.strictEqual(out.toolCalls[0].function.name, wire('close_record'));
    assert.ok(String(out.executed[0].content.result).includes('closed'));
  });

  await test('6. COMMENT → comment execution (pasted id + quoted body)', async () => {
    const target = store.issues[0].id;
    void target;
    const uuid = '123e4567-e89b-12d3-a456-426614174001';
    store.issues.push({ id: uuid, identifier: 'ARC-X', title: 'X', description: '', state: 'open', comments: [] });
    const { out } = await runPreflightTurn(
      `Add a comment to ${uuid} saying 'ARC-AI MCP write test completed successfully.'`);
    assert.strictEqual(out.executed.length, 1);
    const call = out.toolCalls[0];
    assert.strictEqual(call.function.name, wire('save_comment'));
    assert.strictEqual(call.function.arguments.body, 'ARC-AI MCP write test completed successfully.');
    assert.strictEqual(out.executed[0].content.success, true);
  });

  await test('7. empty list → successful empty result (data, not failure)', async () => {
    store.issues.splice(0, store.issues.length);
    const { out } = await runPreflightTurn('What issues are open?');
    assert.ok(out.executed.length >= 1, 'read must execute');
    const first = out.executed[0];
    assert.strictEqual(first.content.success, true, 'empty data is not capability failure');
    assert.strictEqual(String(first.content.result), '[]');
  });

  await test('8. denied tool → no execution', async () => {
    const out = await ai.runMcpPreflight({
      requiredSchemas: [], tools: [], baseText: 'Create an issue',
      intentCaps: new Set(['CREATE']), execFn,
      socket: null, workspaceId: 'ws-pre', signal: null, title: 'x'
    });
    assert.strictEqual(out.plan.executable, false);
    assert.strictEqual(out.executed.length, 0);
  });

  await test('9. unauthorized tool → no execution', async () => {
    const out = await ai.runMcpPreflight({
      requiredSchemas: [], tools: [], baseText: 'What teams?',
      intentCaps: new Set(['LIST']), execFn,
      socket: null, workspaceId: 'ws-pre', signal: null, title: 'x'
    });
    assert.strictEqual(out.plan.executable, false);
    assert.strictEqual(out.executed.length, 0);
  });

  await test('10. unavailable capability → truthful non-executable plan', async () => {
    const { out } = await runPreflightTurn('Explain encapsulation in OOP');
    assert.strictEqual(out.plan.executable, false);
    assert.strictEqual(out.executed.length, 0);
    assert.strictEqual(out.plan.needsClarification, false);
  });

  await test('11. ambiguous create context → needsClarification, nothing executed', async () => {
    const strict = [{
      type: 'function',
      function: {
        name: wire('save_issue'),
        description: 'Create or update.',
        parameters: { type: 'object', properties: { title: { type: 'string' }, team_id: { type: 'string' } }, required: ['title', 'team_id'] }
      }
    }];
    // Force the strict shape regardless of the live fixture's optionality.
    const out = await ai.runMcpPreflight({
      requiredSchemas: strict,
      tools: strict,
      baseText: 'Create a Linear issue called T',
      intentCaps: new Set(['CREATE']),
      execFn, socket: null, workspaceId: 'ws-pre', signal: null, title: 'x'
    });
    assert.strictEqual(out.plan.executable, true, 'capability exists');
    assert.strictEqual(out.plan.needsClarification, true);
    assert.strictEqual(out.executed.length, 0, 'must not execute without scope');
  });

  await test('12. no invented IDs', async () => {
    const strict = [{
      type: 'function',
      function: {
        name: wire('save_issue'),
        description: 'Create or update.',
        parameters: { type: 'object', properties: { title: { type: 'string' }, team_id: { type: 'string' } }, required: ['title', 'team_id'] }
      }
    }];
    const out = await ai.runMcpPreflight({
      requiredSchemas: strict,
      tools: strict,
      baseText: 'Create a Linear issue called T',
      intentCaps: new Set(['CREATE']),
      execFn, socket: null, workspaceId: 'ws-pre', signal: null, title: 'x'
    });
    assert.strictEqual(out.toolCalls.length, 0, 'unresolvable scope must not construct calls');
  });

  await test('13. realtime plan == MCP preflight plan (event sequence)', async () => {
    const socket = fakeSocket();
    const { out } = await runPreflightTurn('What teams and projects do I have in Linear?', { socket });
    assert.strictEqual(out.executed.length, 2);
    const events = socket.emits.map((e) => e.event);
    assert.deepStrictEqual(events, [
      'execution.created', 'execution.started',
      'execution.step.started', 'execution.step.completed',
      'execution.step.started', 'execution.step.completed',
      'execution.completed'
    ], `sequence: ${events}`);
    const created = socket.emits[0].payload;
    assert.deepStrictEqual(
      created.steps.map((s) => s.tool),
      out.plan.tools,
      'panel steps must equal preflight plan tools');
    assert.strictEqual(socket.emits[socket.emits.length - 1].payload.status, 'COMPLETED');
    assert.ok(!events.includes('Waiting for plan'), 'no idle placeholder while executing');
  });

  await test('14. synthesis receives actual MCP results (shapes)', async () => {
    const { tools, out } = await runPreflightTurn('What teams and projects do I have in Linear?');
    assert.ok(out.toolCalls.length > 0);
    for (const tc of out.toolCalls) {
      assert.ok(typeof tc.id === 'string' && tc.id, 'call needs a stable id');
      assert.ok(tc.function && typeof tc.function.name === 'string');
    }
    for (const e of out.executed) {
      assert.ok(e.toolCallId && e.name && e.content, 'result needs call linkage');
      assert.ok(out.toolCalls.some((tc) => tc.id === e.toolCallId), 'result/call id mismatch');
    }
    const { unexposedNames } = partitionToolCallsByExposure(out.toolCalls, tools);
    assert.strictEqual(unexposedNames.length, 0, 'preflight calls must reference request.tools');
  });

  await test('15. historical question → no mutation', async () => {
    const { out } = await runPreflightTurn('What did you just change?');
    assert.strictEqual(out.plan.executable, false);
    assert.strictEqual(out.executed.length, 0);
  });

  await test('16. inventory consistency', async () => {
    const { tools } = await runPreflightTurn('What teams and projects do I have in Linear?');
    const block = ai.mcpInventoryBlockForTools(tools, {});
    const invWires = [...new Set([...block.matchAll(/\bmcp_[a-z0-9_]+\b/g)].map((m) => m[0]))].sort();
    assert.deepStrictEqual(invWires, names(tools).filter((n) => n.startsWith('mcp_')).sort());
  });

  await test('17. continuation compatible (calls reference request.tools)', async () => {
    const { tools, out } = await runPreflightTurn(
      "Create a Linear issue called 'Cont-1' with the description 'x'.");
    assert.strictEqual(out.executed.length, 1);
    const ids = out.toolCalls.map((tc) => tc.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'call ids must be unique');
    const { unexposedNames } = partitionToolCallsByExposure(out.toolCalls, tools);
    assert.strictEqual(unexposedNames.length, 0);
  });

  await test('18. preflight precedes the free provider round (source order)', async () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/AIService'), 'utf8');
    const preflightIdx = src.indexOf('runMcpPreflight({');
    const generateIdx = src.indexOf('response = await generateInitial(tools, systemPrompt);');
    assert.ok(preflightIdx > 0 && generateIdx > 0 && preflightIdx < generateIdx,
      'preflight must run before the free provider round');
    assert.ok(src.includes('Preflight-adopted turns skip the free round entirely'),
      'adoption contract missing');
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
