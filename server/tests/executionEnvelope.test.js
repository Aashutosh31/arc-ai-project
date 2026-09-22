'use strict';

// JARVIS Action Substrate — slice 2: EXECUTION ENVELOPE integration tests.
//
// Proves that the envelope wraps the EXISTING single governed execution choke
// point (TaskExecutor.executeTool) additively:
//   envelope.concurrency / lifecycle Isolated from providers (DB-free)
//   native success/failure/abort paths
//   MCP read + failure paths via a Linear-shaped in-memory server
//   normalization stable / serde-safe
//   existing result shapes preserved
//   timeout + cancellation METADATA recorded without behavior change
//   safe observability only (never tool inputs/outputs/secrets)
//   capability metadata sourced from the authoritative registry
//   no duplicate registry or second execution path
//
// Run:  cd server && node tests/executionEnvelope.test.js

const assert = require('assert');
const z = require('zod');
const { McpServer } = require('@modelcontextprotocol/server');
const { InMemoryTransport } = require('@modelcontextprotocol/client');

const TaskExecutor = require('../services/TaskExecutor');
const { McpToolSource, McpManager, McpRegistry } = require('../lib/mcp');
const toolRegistry = require('../tools');
const caps = require('../lib/capabilities');
const { createExecutionEnvelope } = require('../lib/capabilities/executionEnvelope');
const { STATUS } = require('../lib/capabilities/envelopeClassification');
const observability = require('../lib/capabilities/observability');

let pass = 0;
let fail = 0;

async function test(label, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    fail += 1;
    process.exitCode = 1;
    console.error(`  FAIL  ${label}\n        ${err && err.stack ? err.message : String(err)}`);
  }
}

// ---- log capture for "safe fields only" + "each event once" proofs ----

const captureLogs = async (fn) => {
  const lines = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...a) => { lines.push({ type: 'log', args: a }); };
  console.warn = (...a) => { lines.push({ type: 'warn', args: a }); };
  console.error = (...a) => { lines.push({ type: 'error', args: a }); };
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 5)); // flush enqueueMicrotask emissions
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return lines;
};

const capLines = (lines) => lines.filter((l) => String(l.args && l.args[0]).includes('[Capability]'));
const capMeta = (line) => {
  const meta = line.args && line.args.length > 1 ? line.args[1] : null;
  return meta ? JSON.stringify(meta) : '';
};

// ---- fixtures ----

const EXEC_OPTS = { workspaceId: 'ws-env', skipCreditCharge: true, conversationId: 'conv-env' };

const createLinearServer = () => {
  const store = {
    issues: [
      { id: 'iss-1', title: 'Envelope integration', state: 'open' },
      { id: 'iss-2', title: 'Substrate slice 2', state: 'open' }
    ]
  };
  const server = new McpServer({
    name: 'linear-shaped-envelope',
    version: '1.0.0'
  });
  server.registerTool(
    'list_issues',
    {
      description: 'List all issues in the workspace, newest first.',
      inputSchema: z.object({ state: z.string().optional() }),
      annotations: { readOnlyHint: true, title: 'Linear Issues' }
    },
    async ({ state }) => {
      const rows = state ? store.issues.filter((i) => i.state === state) : store.issues;
      return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
    }
  );
  server.registerTool(
    'explode',
    {
      description: 'Always fails deterministically.',
      inputSchema: z.object({})
    },
    async () => {
      throw new Error('deterministic MCP failure');
    }
  );
  return server;
};

let mcpWire;
let mcpCanonical;
let mcpFailureWire;

const setupMcp = async () => {
  const registry = new McpRegistry();
  const manager = new McpManager({ registry });
  McpToolSource.init({ manager, registry });
  const liveServer = createLinearServer();
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await liveServer.connect(serverEnd);
  registry.register({
    id: 'env-linear-1',
    name: 'Linear',
    slug: 'linear',
    scope: 'global',
    transport: 'stdio',
    testHooks: { createTransport: () => clientEnd }
  });
  const { schemas } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-env', isGuest: false });
  mcpWire = schemas.find((s) => s.function.name.includes('list_issues')).function.name;
  mcpFailureWire = schemas.find((s) => s.function.name.includes('explode')).function.name;
  mcpCanonical = McpToolSource.registry.toolByWireName(mcpWire).canonicalName;
  return { registry, manager, liveServer };
};

const teardownMcp = async () => {
  await McpToolSource.shutdown();
};

const main = async () => {
  console.log('Execution Envelope (slice 2)');
  console.log('===============================');

  // ---- 1. unique executionId ----
  await test('envelope receives unique executionId per invocation', async () => {
    const e1 = createExecutionEnvelope({ toolName: 'getTime', executionOptions: EXEC_OPTS });
    const e2 = createExecutionEnvelope({ toolName: 'getTime', executionOptions: EXEC_OPTS });
    assert.ok(e1.executionId !== e2.executionId, 'ids must differ');
    assert.match(e1.executionId, /^cap-/);
    assert.match(e2.executionId, /^cap-/);
  });

  // ---- 2. native success achieves 'succeeded' ----
await test('native success -> terminal succeeded, existing shape preserved', async () => {
      const direct = await toolRegistry.getTool('getTime').execute({}, { userId: 'env-1' }, null);
      const lines = await captureLogs(async () => {
        const r = await TaskExecutor.executeTool('getTime', {}, 'env-1', null, EXEC_OPTS);
        assert.strictEqual(r.success, true, 'result must still be success');
        assert.strictEqual(typeof r.time, 'string');
      });
      assert.ok(capLines(lines).some((l) => capMeta(l).includes('"status":"succeeded"')));
      assert.ok(capLines(lines).every((l) => !capMeta(l).includes('"failed"')));
      assert.ok(direct.success === true);
    });

    // ---- 3. native failure achieves 'failed', shape unchanged ----
    await test('native failure -> terminal failed, existing shape preserved', async () => {
      const original = toolRegistry.tools.webSearch.execute;
      toolRegistry.tools.webSearch.execute = async () => ({
        success: false,
        error: 'deterministic native failure',
        errorType: 'mcp.tool_execution_error'
      });
      try {
        const lines = await captureLogs(async () => {
          const r = await TaskExecutor.executeTool('webSearch', { query: 'x' }, 'env-1', null, { ...EXEC_OPTS });
          assert.strictEqual(r.success, false);
          assert.strictEqual(r.error, 'deterministic native failure');
        });
        assert.ok(capLines(lines).some((l) => capMeta(l).includes('"status":"failed"')));
        assert.ok(capLines(lines).some((l) => capMeta(l).includes('"errorType":"tool"')));
      } finally {
        toolRegistry.tools.webSearch.execute = original;
      }
    });

    // ---- 4. cancelled execution produces 'cancelled' ----
    await test('cancelled execution -> terminal cancelled, result shape preserved', async () => {
      const ac = new AbortController();
      ac.abort();
      const lines = await captureLogs(async () => {
        const r = await TaskExecutor.executeTool('getTime', {}, 'env-1', null, {
          ...EXEC_OPTS, signal: ac.signal
        });
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.cancelled, true);
      });
      assert.ok(capLines(lines).some((l) => capMeta(l).includes('"status":"cancelled"')));
    });

  // ---- 5. duration recorded ----
  await test('duration is recorded on terminal', async () => {
    const e = createExecutionEnvelope({ toolName: 'getTime', userId: 'env-1', executionOptions: EXEC_OPTS });
    e.start();
    await new Promise((r) => setTimeout(r, 15));
    const result = { success: true };
    e.finalize(result);
    assert.ok(typeof e.durationMs === 'number', 'duration must be a number');
    assert.ok(e.durationMs >= 10, `duration should reflect the wait (>=10ms), got ${e.durationMs}`);
    assert.ok(e.completedAtMs - e.startedAtMs === e.durationMs);
  });

  // ---- 6. start + terminal emitted once ----
  await test('start and terminal lifecycle events emitted exactly once', async () => {
    const lines = await captureLogs(async () => {
      await TaskExecutor.executeTool('getTime', {}, 'env-1', null, EXEC_OPTS);
    });
    const events = capLines(lines).map((l) => String(l.args[0]));
    const started = events.filter((e) => e.includes('capability.execution.started'));
    const succeeded = events.filter((e) => e.includes('capability.execution.succeeded'));
    assert.strictEqual(started.length, 1, `expected 1 started, got ${started.length}`);
    assert.strictEqual(succeeded.length, 1, `expected 1 succeeded, got ${succeeded.length}`);
  });

  // ---- 7. terminal returned / cannot be emitted twice ----
  await test('terminal state cannot be emitted twice', async () => {
    const lines = await captureLogs(async () => {
      const e = createExecutionEnvelope({ toolName: 'getTime', executionOptions: EXEC_OPTS });
      e.start();
      const r1 = e.finalize({ success: true });
      const r2 = e.finalize({ success: false, error: 'late failure' });
      assert.ok(r1.success === true);
      assert.ok(r2.success === false, 'second finalize passes the caller object through unchanged');
      assert.strictEqual(e.status, STATUS.SUCCEEDED, 'status must stay the FIRST terminal');
      assert.strictEqual(e.errorType, null, 'errorType stays the FIRST terminal');
    });
    assert.strictEqual(capLines(lines).filter((l) => l.args[0].includes('succeeded')).length, 1);
  });

  // ---- 8. MCP execution produces the same normalized envelope ----
  await test('MCP execution -> same envelope, succeeded terminal', async () => {
    const mcp = await setupMcp();
    try {
      const lines = await captureLogs(async () => {
        const r = await TaskExecutor.executeTool(mcpWire, { state: 'open' }, 'env-1', null, EXEC_OPTS);
        assert.strictEqual(r.success, true, 'MCP read must succeed');
        assert.ok(String(r.result).includes('Envelope integration'));
      });
      const started = capLines(lines).filter((l) => l.args[0].includes('started'));
      assert.strictEqual(started.length, 1);
      assert.ok(capLines(lines).some((l) => capMeta(l).includes('"status":"succeeded"')));
    } finally {
      await teardownMcp();
    }
  });

  // ---- 9. native result shape unchanged ----
  await test('native result shape remains byte-for-byte the tool contract', async () => {
    // getTime's fullISO has ms precision; a direct call a ms later legitimately
    // differs. The envelope contract is PASSTHROUGH: the exact result object
    // produced by the tool must come back untouched. Prove with a
    // deterministic stub so the identity is comparable byte-for-byte.
    const FROZEN = Object.freeze({
      success: true,
      value: 42,
      nested: Object.freeze({ list: [1, 2, 3] })
    });
    const original = toolRegistry.tools.getTime.execute;
    toolRegistry.tools.getTime.execute = async () => FROZEN;
    try {
      const r = await TaskExecutor.executeTool('getTime', {}, 'env-1', null, EXEC_OPTS);
      assert.strictEqual(r, FROZEN, 'envelope must return the exact tool result object');
    } finally {
      toolRegistry.tools.getTime.execute = original;
    }
    // Live path still exercises the real tool (shape + success preserved).
    const real = await TaskExecutor.executeTool('getTime', {}, 'env-1', null, EXEC_OPTS);
    assert.strictEqual(real.success, true);
    assert.strictEqual(typeof real.time, 'string');
    assert.strictEqual(typeof real.fullISO, 'string');
  });

  // ---- 10. MCP result shape unchanged ----
  await test('MCP result shape remains byte-for-byte the adapter contract', async () => {
    const mcp = await setupMcp();
    try {
      const r = await TaskExecutor.executeTool(mcpWire, {}, 'env-1', null, EXEC_OPTS);
      // Adapter contract fields preserved: success, result (string), mcp metadata.
      assert.strictEqual(r.success, true);
      assert.strictEqual(typeof r.result, 'string');
      assert.ok(r.mcp && r.mcp.canonicalName === mcpCanonical, 'mcp metadata must survive');
      assert.ok(typeof r.mcp.durationMs === 'number', 'mcp.durationMs (adapter contract) must survive');
    } finally {
      await teardownMcp();
    }
  });

  // ---- 11. timeout metadata recorded, behavior unchanged ----
  await test('timeout metadata recorded without changing timeout behavior', async () => {
    const e = createExecutionEnvelope({ toolName: 'getTime', userId: 'env-1', executionOptions: { ...EXEC_OPTS, timeoutMs: 5000 } });
    assert.strictEqual(e.declaredTimeoutMs, 5000, 'explicit caller timeout must be recorded');
    // No timeout introduced: a tool call still completes normally.
    const r = await TaskExecutor.executeTool('getTime', {}, 'env-1', null, { ...EXEC_OPTS, timeoutMs: 5000 });
    assert.strictEqual(r.success, true);
  });

  await test('MCP timeout declaration records the existing MCP default', async () => {
    const mcp = await setupMcp();
    try {
      const lines = await captureLogs(async () => {
        await TaskExecutor.executeTool(mcpWire, {}, 'env-1', null, EXEC_OPTS);
      });
      // Adapter's default REQUEST_TIMEOUT_MS is surfaced as declared, NOT new.
      const started = capLines(lines).find((l) => l.args[0].includes('started'));
      assert.ok(started, 'started event must exist');
      assert.ok(/\"timeoutMs\":[0-9]+/.test(capMeta(started)), 'timeoutMs declared in safe fields');
    } finally {
      await teardownMcp();
    }
  });

  // ---- 12. cancellation metadata recorded, behavior unchanged ----
  await test('cancellation metadata recorded without changing cancellation behavior', async () => {
    const ac = new AbortController();
    const e = createExecutionEnvelope({
      toolName: 'getTime', userId: 'env-1', signal: ac.signal, executionOptions: EXEC_OPTS
    });
    assert.strictEqual(e.signalProvided, true);
    assert.strictEqual(e.signalAbortedAtStart, false);
    assert.strictEqual(e.cancellationDeclaration, 'cooperative');
    // Existing abort path still shapes the result (pre-start guard).
    ac.abort();
    const r = await TaskExecutor.executeTool('getTime', {}, 'env-1', null, { ...EXEC_OPTS, signal: ac.signal });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.cancelled, true);
  });

  // ---- 13. sensitive fields absent from logs ----
  await test('observability prunes everything off the whitelist', () => {
    const pruned = observability._prune({
      executionId: 'cap-x',
      capabilityId: 'native:getTime',
      toolName: 'getTime',
      source: 'native',
      workspaceId: 'w',
      status: 'running',
      args: { query: 'SECRET QUERY' },
      userQuery: 'super secret',
      password: 'hunter2',
      token: 'abc123',
      apiKey: 'key',
      result: { content: 'huge output' },
      error: 'stack trace details',
      output: 'payload',
      secret: true,
      randomField: 'drop me'
    });
    assert.deepStrictEqual(pruned, {
      executionId: 'cap-x',
      capabilityId: 'native:getTime',
      toolName: 'getTime',
      source: 'native',
      workspaceId: 'w',
      status: 'running'
    });
  });

  await test('integration logs never contain tool inputs, outputs, or secrets', async () => {
    const lines = await captureLogs(async () => {
      await TaskExecutor.executeTool('webSearch', { query: 'TOP SECRET QUERY TERM' }, 'env-1', null, EXEC_OPTS);
    });
    for (const line of capLines(lines)) {
      const meta = JSON.stringify(line.args[1]);
      assert.ok(!meta.includes('TOP SECRET QUERY TERM'), 'query leaked into a log');
      assert.ok(!meta.includes('password') && !meta.includes('token') && !meta.includes('apiKey'), 'secret key names leaked');
      assert.ok(!meta.includes('"result"') || !meta.includes('content'), 'output payload leaked');
      const keys = Object.keys(line.args[1] || {});
      for (const k of keys) {
        assert.ok(observability.SAFE_FIELDS.has(k), `unexpected log field: ${k}`);
      }
    }
  });

  // ---- 14. capability metadata from authoritative registry ----
  await test('capability metadata sourced from the authoritative capability registry', async () => {
    // Native: envelope resolve == registry byId.
    const reg = await caps.buildCapabilityRegistry({ workspaceId: 'ws-env' });
    const fromReg = reg.byId('native:getTime');
    const resolved = caps.resolveExecutionCapability('getTime', { isGuest: false });
    assert.ok(fromReg && resolved, 'native capability must resolve');
    assert.strictEqual(resolved.id, fromReg.id);
    assert.strictEqual(resolved.source, fromReg.source);
    assert.strictEqual(resolved.risk, fromReg.risk);
    assert.strictEqual(resolved.scope, fromReg.scope);
  });

  await test('MCP capability metadata matches the authoritative registry entry', async () => {
    const mcp = await setupMcp();
    try {
      const resolved = caps.resolveExecutionCapability(mcpWire, { isGuest: false });
      const entry = McpToolSource.registry.toolByWireName(mcpWire);
      const config = McpToolSource.registry.get(entry.configId);
      assert.ok(resolved, 'MCP capability must resolve');
      assert.strictEqual(resolved.source, 'mcp');
      assert.strictEqual(resolved.id, entry.canonicalName, 'id must be the authoritative canonical name');
      assert.strictEqual(resolved.name, entry.originalToolName);
      assert.strictEqual(resolved.wireName, entry.wireName);
      assert.strictEqual(resolved.serverSlug, entry.serverSlug);
      assert.strictEqual(resolved.metadata.serverId, config.id, 'metadata must come from the same registry config');
      assert.strictEqual(resolved.metadata.configName, config.name);
      assert.strictEqual(resolved.metadata.configScope, config.scope);
    } finally {
      await teardownMcp();
    }
  });

  // ---- 15. context/workspace identity preserved ----
  await test('user/workspace/conversation context preserved in the envelope', async () => {
    const e = createExecutionEnvelope({
      toolName: 'getTime',
      userId: 'env-user-7',
      workspaceId: 'ws-env',
      conversationId: 'conv-env',
      executionOptions: EXEC_OPTS
    });
    assert.strictEqual(e.userId, 'env-user-7');
    assert.strictEqual(e.workspaceId, 'ws-env');
    assert.strictEqual(e.conversationId, 'conv-env');
    const s = e.summary();
    assert.strictEqual(s.userId, 'env-user-7');
    assert.strictEqual(s.workspaceId, 'ws-env');
  });

  // ---- 16. no duplicate registry / execution path ----
  await test('no duplicate registry or second execution path is created', async () => {
    assert.strictEqual(typeof caps.tools, 'undefined', 'facade must not expose a duplicate tool registry');
    assert.strictEqual(typeof caps.registry, 'undefined', 'facade must not expose a duplicate registry');
    assert.strictEqual(typeof caps.executeTool, 'undefined', 'facade must not expose an execution engine');
    // The envelope resolves MCP from the SAME McpToolSource registry.
    assert.strictEqual(
      caps.resolveExecutionCapability,
      require('../lib/capabilities/executionEnvelope').resolveCapability
    );
  });

  await test('envelope execution leaves the live registries untouched', async () => {
    const mcp = await setupMcp();
    try {
      const nativeSchemaCount = toolRegistry.getSchemas().length;
      const mcpVisible = McpToolSource.registry.countToolsVisibleToWorkspace('ws-env', false);
      await TaskExecutor.executeTool('getTime', {}, 'env-1', null, EXEC_OPTS);
      await TaskExecutor.executeTool(mcpWire, {}, 'env-1', null, EXEC_OPTS);
      assert.strictEqual(toolRegistry.getSchemas().length, nativeSchemaCount, 'native schemas must be unchanged');
      assert.strictEqual(
        McpToolSource.registry.countToolsVisibleToWorkspace('ws-env', false),
        mcpVisible,
        'MCP visible tool count must be unchanged'
      );
    } finally {
      await teardownMcp();
    }
  });

  // ---- 17. provider-visible tool selection unchanged ----
  await test('provider-visible tool selection unchanged after envelope executions', async () => {
    const { selectToolSchemas } = require('../lib/llm/toolSelection');
    const nativeSchemas = toolRegistry.getSchemas();
    const query = 'What teams do I have?';
    const before = selectToolSchemas(query, nativeSchemas, { mcpSchemas: [] });
    await TaskExecutor.executeTool('getTime', {}, 'env-1', null, EXEC_OPTS);
    await TaskExecutor.executeTool('checkCalendar', {}, 'env-1', null, EXEC_OPTS);
    const after = selectToolSchemas(query, toolRegistry.getSchemas(), { mcpSchemas: [] });
    assert.deepStrictEqual(after.tools, before.tools, 'tool selection must be byte-identical');
    assert.strictEqual(after.intent, before.intent);
  });

  // ---- MCP failure path ----
  await test('MCP failure reaches the existing failure path with normalized envelope', async () => {
    const mcp = await setupMcp();
    try {
      const r = await TaskExecutor.executeTool(mcpFailureWire, {}, 'env-1', null, EXEC_OPTS);
      assert.strictEqual(r.success, false);
      assert.ok(r.errorType, 'adapter category must flow through');
      assert.strictEqual(typeof r.mcp.canonicalName, 'string');
    } finally {
      await teardownMcp();
    }
  });

  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  process.exitCode = fail > 0 ? 1 : 0;
};

main().catch((err) => {
  console.error('Execution envelope tests crashed:', err);
  process.exitCode = 1;
});