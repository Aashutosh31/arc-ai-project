'use strict';

// MCP tool-policy enforcement — end-to-end regression suite.
//
// Run:  cd server && node tests/mcpPolicy.test.js
//
// Guards the invariant: a tool blocked by allowedTools/deniedTools MUST NOT
// appear in LLM schemas AND MUST NOT be resolvable/executable. Covers the
// exact reported bug where _syncRegistryTools re-registered configs without
// policy fields, wiping the policy on every connect and silently
// re-exposing blocked tools (UI showed "blocked", runtime executed anyway).
//
//   R-01 denied tool excluded from schemasForRequest (post-discovery sync)
//   R-02 policy survives discovery re-registration (the wipe regression)
//   R-03 denied tool rejected by resolveTool (NOT_AUTHORIZED, no execution)
//   R-04 allowlist excludes every non-listed tool from schemas
//   R-05 allowlisted tool executes successfully (echo)
//   R-06 non-allowlisted tool cannot execute via resolveTool
//   R-07 deny overrides allow (both layers)
//   R-08 workspace isolation holds with policy present
//   R-09 guest policy holds with policy present
//   R-10 continuation cannot bypass policy
//   R-11 native tools unaffected

const assert = require('assert');

const { McpToolSource, McpManager, McpRegistry } = require('../lib/mcp');
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

// ---- helpers (mirror mcp.test.js harness) ------------------------------------

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

// Fixture tool wires (slug "policy"): get_test_value, echo, ...
const WIRE_VALUE = 'mcp_policy_get_test_value';
const WIRE_ECHO = 'mcp_policy_echo';

const baseCfg = (overrides = {}) => ({
  id: 'pol-1',
  name: 'Policy',
  scope: 'global',
  transport: 'stdio',
  ...overrides
});

const linkedCfg = (cfg, clientEnd) => ({ ...cfg, testHooks: { createTransport: () => clientEnd } });

// ---- suite --------------------------------------------------------------------

const main = async () => {
  // R-01: denied tool excluded from schemasForRequest AFTER discovery sync.
  // This is the exact reported scenario: schemasForRequest triggers
  // ensureConnected → _syncRegistryTools → re-register. The denied tool must
  // still be absent afterwards.
  await test('R-01 denied tool excluded from schemasForRequest', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(linkedCfg(baseCfg({ deniedTools: [WIRE_VALUE] }), pair.clientEnd));
    const { schemas } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-X', isGuest: false });
    const names = schemas.map((s) => s.function.name);
    assert.ok(!names.includes(WIRE_VALUE), 'denied wire name absent from LLM schemas');
    assert.ok(names.includes(WIRE_ECHO), 'non-denied tool still exposed');
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // R-02: policy survives discovery re-registration (the wipe regression).
  await test('R-02 policy survives discovery sync', async () => {
    const { registry, manager } = initSource();
    const pair = makeLinked();
    registry.register(linkedCfg(
      baseCfg({ allowedTools: [WIRE_ECHO], deniedTools: [WIRE_VALUE] }), pair.clientEnd
    ));
    await manager.ensureConnected(registry.get('pol-1')); // triggers _syncRegistryTools
    const after = registry.get('pol-1');
    assert.deepStrictEqual(after.deniedTools, [WIRE_VALUE], 'deniedTools retained after sync');
    assert.deepStrictEqual(after.allowedTools, [WIRE_ECHO], 'allowedTools retained after sync');
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // R-03: resolveTool rejects the denied tool — schema null + categorized
  // failure result, and the fixture payload (42/fixture-ok) never surfaces.
  await test('R-03 denied tool rejected by resolveTool (no execution)', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(linkedCfg(baseCfg({ deniedTools: [WIRE_VALUE] }), pair.clientEnd));
    const resolved = await McpToolSource.resolveTool(WIRE_VALUE, { workspaceId: 'ws-X', isGuest: false });
    assert.ok(resolved, 'resolveTool returns a rejection handle (not null)');
    assert.strictEqual(resolved.schema, null, 'no schema for denied tool');
    const out = await resolved.execute({}, { signal: null }, null);
    assert.strictEqual(out.success, false, 'execution rejected');
    assert.strictEqual(out.errorType, 'mcp.not_authorized', 'categorized as not_authorized');
    assert.ok(!String(out.error || '').includes('42'), 'fixture payload never surfaces');
    assert.ok(!String(out.result || '').includes('fixture-ok'), 'no tool result carried');
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // R-04: allowlist excludes every non-listed tool from schemas.
  await test('R-04 allowlist excludes non-listed tools from schemas', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(linkedCfg(baseCfg({ allowedTools: [WIRE_ECHO] }), pair.clientEnd));
    const { schemas } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-X', isGuest: false });
    const names = schemas.map((s) => s.function.name);
    assert.ok(names.includes(WIRE_ECHO), 'allowlisted tool exposed');
    assert.ok(!names.includes(WIRE_VALUE), 'non-listed tool excluded from schemas');
    assert.strictEqual(names.length, 1, 'exactly one tool exposed');
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // R-05: allowlisted tool executes successfully end-to-end.
  await test('R-05 allowlisted tool executes (echo)', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(linkedCfg(baseCfg({ allowedTools: [WIRE_ECHO] }), pair.clientEnd));
    const resolved = await McpToolSource.resolveTool(WIRE_ECHO, { workspaceId: 'ws-X', isGuest: false });
    assert.ok(resolved && resolved.schema, 'allowlisted tool resolves with schema');
    const out = await resolved.execute({ text: 'ARC MCP is working' }, { signal: null }, null);
    assert.strictEqual(out.success, true, 'execution succeeds');
    assert.ok(String(out.result || '').includes('ARC MCP is working'), 'echo payload carried');
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // R-06: non-allowlisted tool cannot execute via resolveTool.
  await test('R-06 non-allowlisted tool cannot execute', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(linkedCfg(baseCfg({ allowedTools: [WIRE_ECHO] }), pair.clientEnd));
    const resolved = await McpToolSource.resolveTool(WIRE_VALUE, { workspaceId: 'ws-X', isGuest: false });
    assert.ok(resolved, 'rejection handle returned');
    const out = await resolved.execute({}, { signal: null }, null);
    assert.strictEqual(out.success, false, 'execution rejected');
    assert.strictEqual(out.errorType, 'mcp.not_authorized');
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // R-07: deny overrides allow in both layers.
  await test('R-07 deny wins over allow (schemas + execution)', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(linkedCfg(
      baseCfg({ allowedTools: [WIRE_VALUE, WIRE_ECHO], deniedTools: [WIRE_VALUE] }),
      pair.clientEnd
    ));
    const { schemas } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-X', isGuest: false });
    const names = schemas.map((s) => s.function.name);
    assert.ok(!names.includes(WIRE_VALUE), 'denied tool absent from schemas despite allowlist');
    assert.ok(names.includes(WIRE_ECHO), 'non-denied allowlisted tool present');
    const resolved = await McpToolSource.resolveTool(WIRE_VALUE, { workspaceId: 'ws-X', isGuest: false });
    const out = await resolved.execute({}, { signal: null }, null);
    assert.strictEqual(out.success, false, 'denied tool cannot execute despite allowlist');
    assert.strictEqual(out.errorType, 'mcp.not_authorized');
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // R-08: workspace isolation holds with policy present.
  await test('R-08 workspace isolation with policy', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    const pair2 = makeLinked();
    registry.register(linkedCfg(
      baseCfg({ id: 'pol-g', name: 'PolicyGlobal', deniedTools: [WIRE_VALUE] }), pair.clientEnd
    ));
    registry.register(linkedCfg(
      baseCfg({ id: 'pol-w', name: 'PolicyWs', scope: 'workspace', workspaceId: 'ws-A' }),
      pair2.clientEnd
    ));
    const { schemas: sA } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-A', isGuest: false });
    const { schemas: sB } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-B', isGuest: false });
    const namesA = sA.map((s) => s.function.name);
    const namesB = sB.map((s) => s.function.name);
    assert.ok(!namesA.includes('mcp_policyglobal_get_test_value'), 'denied global tool hidden in ws-A');
    assert.ok(!namesB.includes('mcp_policyglobal_get_test_value'), 'denied global tool hidden in ws-B');
    assert.ok(namesA.some((n) => n.startsWith('mcp_policyws_')), 'ws-A sees workspace server tools');
    assert.ok(!namesB.some((n) => n.startsWith('mcp_policyws_')), 'ws-B never sees ws-A tools');
    await McpToolSource.shutdown();
    await pair.server.close();
    await pair2.server.close();
  });

  // R-09: guest policy holds with policy present.
  await test('R-09 guest policy with denied tool', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(linkedCfg(
      baseCfg({ guestAllowed: true, deniedTools: [WIRE_VALUE] }), pair.clientEnd
    ));
    const { schemas } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-X', isGuest: true });
    const names = schemas.map((s) => s.function.name);
    assert.ok(!names.includes(WIRE_VALUE), 'denied tool hidden from guests');
    assert.ok(names.includes(WIRE_ECHO), 'guest still sees allowed guestAllowed tools');
    const resolved = await McpToolSource.resolveTool(WIRE_VALUE, { workspaceId: 'ws-X', isGuest: true });
    const out = await resolved.execute({}, { signal: null }, null);
    assert.strictEqual(out.success, false, 'guest execution of denied tool rejected');
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // R-10: continuation cannot bypass policy — a denied active tool is dropped.
  await test('R-10 continuation cannot bypass policy', async () => {
    const { registry, manager } = initSource();
    const pair = makeLinked();
    registry.register(linkedCfg(baseCfg({ deniedTools: [WIRE_VALUE] }), pair.clientEnd));
    await manager.ensureConnected(registry.get('pol-1'));
    const cont = await McpToolSource.schemasForContinuation([WIRE_VALUE, WIRE_ECHO], {
      workspaceId: 'ws-X', isGuest: false
    });
    const names = cont.map((s) => s.function.name);
    assert.ok(!names.includes(WIRE_VALUE), 'denied tool dropped from continuation');
    assert.ok(names.includes(WIRE_ECHO), 'allowed active tool retained');
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // R-11: native tools unaffected.
  await test('R-11 native tools unaffected', async () => {
    assert.strictEqual(McpToolSource.isMcpToolName('webSearch'), false);
    assert.strictEqual(McpToolSource.isMcpToolName('memorize'), false);
    const resolved = await McpToolSource.resolveTool('webSearch', { workspaceId: 'ws-X', isGuest: false });
    assert.strictEqual(resolved, null, 'native names never resolve via MCP');
    await McpToolSource.shutdown();
  });

  // R-12: full AIService→TaskExecutor path. Denied tool is absent from LLM
  // schemas, unselected by intent matching, and rejected by the REAL
  // TaskExecutor.executeTool (the model tool-call path) with no payload;
  // the allowlisted echo tool succeeds through the same path.
  await test('R-12 full model-call path: blocked rejected, allowed executes', async () => {
    const { selectToolSchemas } = require('../lib/llm/toolSelection');
    const TaskExecutor = require('../services/TaskExecutor');
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(linkedCfg(baseCfg({ deniedTools: [WIRE_VALUE] }), pair.clientEnd));

    const { schemas } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-X', isGuest: false });
    const pick = selectToolSchemas(
      'Use the MCP test tool to get the fixed test value.', () => [], { mcpSchemas: schemas }
    );
    assert.ok(
      !pick.tools.some((t) => t.function.name === WIRE_VALUE),
      'intent selection never surfaces the denied tool'
    );

    const blocked = await TaskExecutor.executeTool(WIRE_VALUE, {}, 'user-1', null,
      { workspaceId: 'ws-X', skipCreditCharge: true });
    assert.strictEqual(blocked.success, false);
    assert.strictEqual(blocked.errorType, 'mcp.not_authorized');
    assert.ok(!JSON.stringify(blocked).includes('42'), 'blocked result carries no value');

    // Non-denied echo succeeds through the identical path.
    const ok = await TaskExecutor.executeTool(WIRE_ECHO, { text: 'ARC MCP is working' }, 'user-1', null,
      { workspaceId: 'ws-X', skipCreditCharge: true });
    assert.strictEqual(ok.success, true);
    assert.ok(String(ok.result).includes('ARC MCP is working'));
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // ---- summary ---------------------------------------------------------------

  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`\nFAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
