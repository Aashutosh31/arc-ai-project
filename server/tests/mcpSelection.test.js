'use strict';

// MCP no-substitution selection tests (DB-free).
//
// Run:  cd server && node tests/mcpSelection.test.js
//
// When the requested MCP capability is removed by policy, selection must
// offer NO substitute MCP tool (previously a loosely-matching tool such as
// delayed_tool was offered and its result presented as the answer), so the
// model responds naturally that the capability is unavailable. Generic: no
// tool names or capabilities hardcoded in the implementation under test.
//
//   S-01 denied request: requested tool absent, zero MCP offered, suppressed
//   S-02 allowlisted-out request: suppressed, no substitutes
//   S-03 nonexistent tool request: empty MCP selection
//   S-04 available other tool NOT selected merely because available
//   S-05 normal MCP request still works (echo)
//   S-06 issue-style MCP request still works (github_create_issue)
//   S-07 knowledge question matches no MCP tools (unchanged)
//   S-08 native groups unaffected by suppression
//   S-09 tie/allowed-leaning request is NOT suppressed (no over-blocking)
//   S-10 suppressed selection carries blocked names for the policy note

const assert = require('assert');

const { McpToolSource, McpManager, McpRegistry } = require('../lib/mcp');
const { selectToolSchemas } = require('../lib/llm/toolSelection');
const { createFixtureServer } = require('./fixtures/mcp/testMcpServer');
const { InMemoryTransport } = require('@modelcontextprotocol/client');

const passed = [];
const failed = [];

function test(name, fn) {
  return (async () => {
    try {
      await fn();
      passed.push(name);
      console.log(`  ok - ${name}`);
    } catch (err) {
      failed.push({ name, err });
      console.error(`  FAIL - ${name}`);
      console.error(`         ${err && err.message}`);
    }
  })();
}

const makeLinked = () => {
  const server = createFixtureServer();
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  server.connect(serverEnd);
  return { server, clientEnd };
};

const initSource = () => {
  const registry = new McpRegistry();
  const manager = new McpManager({ registry });
  McpToolSource.init({ manager, registry });
  return { registry, manager };
};

const WIRE_VALUE = 'mcp_sel_get_test_value';
const WIRE_ECHO = 'mcp_sel_echo';

const setup = async (policy = {}) => {
  const { registry } = initSource();
  const pair = makeLinked();
  registry.register({
    id: 'sel-1', name: 'Sel', scope: 'global', transport: 'stdio',
    ...policy,
    testHooks: { createTransport: () => pair.clientEnd }
  });
  const pick = await McpToolSource.schemasForRequest({ workspaceId: 'ws-X', isGuest: false });
  return { pair, schemas: pick.schemas, blocked: pick.blocked };
};

const teardown = async (pair) => {
  await McpToolSource.shutdown();
  await pair.server.close();
};

const mcpNames = (tools) => tools.filter((t) => t.function.name.startsWith('mcp_')).map((t) => t.function.name);

const main = async () => {
  // S-01: denied request → absent, suppressed, no substitutes.
  await test('S-01 denied request offers zero MCP tools', async () => {
    const { pair, schemas, blocked } = await setup({ deniedTools: [WIRE_VALUE] });
    const pick = selectToolSchemas(
      'Use the MCP test tool to get the fixed test value.', () => [], { mcpSchemas: schemas, mcpBlocked: blocked }
    );
    assert.ok(!schemas.some((s) => s.function.name === WIRE_VALUE), 'requested tool absent from schemas');
    assert.strictEqual(mcpNames(pick.tools).length, 0, 'no substitute MCP tool offered');
    assert.strictEqual(pick.mcpSuppressed, true, 'suppression flagged');
    await teardown(pair);
  });

  // S-02: allowlisted-out request → suppressed.
  await test('S-02 allowlisted-out request suppressed', async () => {
    const { pair, schemas, blocked } = await setup({ allowedTools: [WIRE_ECHO] });
    const pick = selectToolSchemas(
      'Use the MCP test tool to get the fixed test value.', () => [], { mcpSchemas: schemas, mcpBlocked: blocked }
    );
    assert.strictEqual(mcpNames(pick.tools).length, 0, 'no substitute offered');
    assert.strictEqual(pick.mcpSuppressed, true);
    await teardown(pair);
  });

  // S-03: nonexistent tool request → empty MCP selection.
  await test('S-03 nonexistent tool request matches nothing', async () => {
    const { pair, schemas, blocked } = await setup({});
    const pick = selectToolSchemas(
      'Use the MCP frobnicate tool to wobble the quantum flux capacitor.', () => [],
      { mcpSchemas: schemas, mcpBlocked: blocked }
    );
    assert.strictEqual(mcpNames(pick.tools).length, 0, 'no MCP tool matches a nonexistent capability');
    assert.strictEqual(pick.mcpSuppressed, false, 'no suppression without a blocked target');
    await teardown(pair);
  });

  // S-04: availability alone never selects (the substitution case).
  await test('S-04 available tools not selected merely for being available', async () => {
    const { pair, schemas, blocked } = await setup({ deniedTools: [WIRE_VALUE] });
    const pick = selectToolSchemas(
      'Use the MCP test tool to get the fixed test value.', () => [], { mcpSchemas: schemas, mcpBlocked: blocked }
    );
    const names = mcpNames(pick.tools);
    assert.ok(!names.some((n) => n.includes('delayed')), 'delayed_tool not substituted');
    assert.ok(!names.some((n) => n.includes('invalid_args')), 'invalid_args_tool not substituted');
    assert.ok(!names.some((n) => n.includes('weather')), 'weather tool not substituted');
    await teardown(pair);
  });

  // S-05: normal echo request still works.
  await test('S-05 echo request selects echo', async () => {
    const { pair, schemas, blocked } = await setup({});
    const pick = selectToolSchemas(
      'Use the MCP echo tool to echo: ARC MCP is working.', () => [], { mcpSchemas: schemas, mcpBlocked: blocked }
    );
    const names = mcpNames(pick.tools);
    assert.ok(names.includes(WIRE_ECHO), 'echo selected');
    assert.strictEqual(pick.mcpSuppressed, false, 'no suppression for allowed requests');
    await teardown(pair);
  });

  // S-06: issue-style request still works.
  await test('S-06 issue request selects github_create_issue', async () => {
    const { pair, schemas, blocked } = await setup({});
    const pick = selectToolSchemas(
      'Please create a GitHub issue for the login bug', () => [], { mcpSchemas: schemas, mcpBlocked: blocked }
    );
    assert.ok(
      pick.tools.some((t) => t.function.name === 'mcp_sel_github_create_issue'),
      'issue tool selected'
    );
    assert.strictEqual(pick.mcpSuppressed, false);
    await teardown(pair);
  });

  // S-07: knowledge question unchanged.
  await test('S-07 knowledge question matches no MCP tools', async () => {
    const { pair, schemas, blocked } = await setup({});
    const pick = selectToolSchemas(
      'Explain encapsulation in OOP', () => [], { mcpSchemas: schemas, mcpBlocked: blocked }
    );
    assert.strictEqual(mcpNames(pick.tools).length, 0);
    await teardown(pair);
  });

  // S-08: native groups unaffected by suppression.
  await test('S-08 native selection unaffected by suppression', async () => {
    const { pair, schemas, blocked } = await setup({ deniedTools: [WIRE_VALUE] });
    const native = [
      { function: { name: 'memorize', description: 'remember', parameters: {} } }
    ];
    const pick = selectToolSchemas(
      'Use the MCP test tool to get the fixed test value. Remember that I like tea.',
      () => native, { mcpSchemas: schemas, mcpBlocked: blocked }
    );
    assert.ok(pick.tools.some((t) => t.function.name === 'memorize'), 'native memory tool still selected');
    assert.strictEqual(mcpNames(pick.tools).length, 0, 'still no MCP substitute');
    await teardown(pair);
  });

  // S-09: request leaning at an allowed tool is NOT suppressed.
  await test('S-09 allowed-leaning request not suppressed', async () => {
    const { pair, schemas, blocked } = await setup({ deniedTools: [WIRE_VALUE] });
    const pick = selectToolSchemas(
      'Use the MCP echo tool to echo hello.', () => [], { mcpSchemas: schemas, mcpBlocked: blocked }
    );
    assert.ok(mcpNames(pick.tools).includes(WIRE_ECHO), 'allowed tool offered');
    assert.strictEqual(pick.mcpSuppressed, false, 'no over-blocking');
    await teardown(pair);
  });

  // S-10: suppression carries blocked names for the truthful policy note.
  await test('S-10 suppression names the blocked capability', async () => {
    const { pair, schemas, blocked } = await setup({ deniedTools: [WIRE_VALUE] });
    const pick = selectToolSchemas(
      'Use the MCP test tool to get the fixed test value.', () => [], { mcpSchemas: schemas, mcpBlocked: blocked }
    );
    assert.ok(
      Array.isArray(pick.mcpBlockedNames) && pick.mcpBlockedNames.includes(WIRE_VALUE),
      'blocked wire named for the policy note'
    );
    await teardown(pair);
  });

  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`\nFAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
