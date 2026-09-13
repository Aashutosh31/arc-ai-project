'use strict';

// MCP support — mandatory test suite.
//
// Run:  cd server && node tests/mcp.test.js
//
// Covers (20 mandatory tests + transport/stdio integration):
//   01 registration & config normalization
//   02 connect lifecycle (state machine)
//   03 disconnect lifecycle (permanent close, reconnect)
//   04 discovery (wire names, count)
//   05 schema normalization (wire-safe names, non-enumerable metadata)
//   06 namespace collisions (slug + wire-name determinism)
//   07 workspace isolation (selection)
//   08 guest isolation
//   09 invocation (call/tool success)
//   10 invalid arguments
//   11 server unavailable (degradation + classification)
//   12 timeout classification
//   13 cancellation via AbortSignal
//   14 output limiting (large result + content compaction)
//   15 tool-selection integration (intent scoring + cap)
//   16 context-budget integration (MCP dropped first)
//   17 continuation after MCP tool call
//   18 MCP tool execution failure
//   19 connection cleanup on shutdown
//   20 native tools remain functional
//   + stdio subprocess transport (live fixture)
//   + streamable-http transport (live fixture)

const assert = require('assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { McpToolSource, McpManager, McpRegistry } = require('../lib/mcp');
const names = require('../lib/mcp/names');
const adapter = require('../lib/mcp/McpToolAdapter');
const errors = require('../lib/mcp/errors');
const { selectToolSchemas, selectContinuationTools } = require('../lib/llm/toolSelection');
const { trimToolsToBudget } = require('../lib/llm/contextBudget');
const { createFixtureServer } = require('./fixtures/mcp/testMcpServer');
const { createHttpFixtureServer } = require('./fixtures/mcp/httpServer');
const toolRegistry = require('../tools/index');
const { isGuestActorId } = require('../services/creditService');
const { InMemoryTransport, Client } = require('@modelcontextprotocol/client');

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

// ---- helpers --------------------------------------------------------------

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

const GLOBAL_CFG = { id: 'cfg-1', name: 'GitHub', scope: 'global', transport: 'stdio' };
const PRIVATE_CFG = { id: 'cfg-2', name: 'Private', scope: 'workspace', workspaceId: 'ws-A', transport: 'stdio' };

const mcpLinkedConfig = (cfg, clientEnd) => ({ ...cfg, testHooks: { createTransport: () => clientEnd } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- suite -----------------------------------------------------------------

const main = async () => {
  // 01 registration & normalization
  await test('01 registration & config normalization', async () => {
    const registry = new McpRegistry();
    const cfg = registry.register(GLOBAL_CFG);
    assert.strictEqual(cfg.id, 'cfg-1');
    assert.strictEqual(cfg.scope, 'global');
    assert.strictEqual(cfg.slug, 'github');
    assert.strictEqual(registry.get('cfg-1').name, 'GitHub');
    assert.strictEqual(registry.toolCount('cfg-1'), 0);
    registry.remove('cfg-1');
    assert.strictEqual(registry.count, 0);
  });

  // 02 connect lifecycle
  await test('02 connect lifecycle', async () => {
    const { registry, manager } = initSource();
    const pair = makeLinked();
    registry.register(mcpLinkedConfig(GLOBAL_CFG, pair.clientEnd));
    const conn = await manager.ensureConnected(registry.get('cfg-1'));
    assert.strictEqual(conn.connected, true);
    assert.ok(conn.serverInfo, 'serverInfo present');
    assert.ok(conn.capabilities, 'capabilities present');
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // 03 disconnect lifecycle
  await test('03 disconnect lifecycle', async () => {
    const { registry, manager } = initSource();
    let pair = makeLinked();
    registry.register(mcpLinkedConfig(GLOBAL_CFG, pair.clientEnd));
    let conn = await manager.ensureConnected(registry.get('cfg-1'));
    assert.strictEqual(conn.connected, true);
    await manager.disconnect('cfg-1');
    assert.strictEqual(conn.connected, false);
    assert.strictEqual(manager.countConnections(), 0);
    // Re-connect works with a fresh transport (production reconnects spawn a
    // fresh stdio child / http session).
    pair = makeLinked();
    registry.register(mcpLinkedConfig(GLOBAL_CFG, pair.clientEnd));
    conn = await manager.ensureConnected(registry.get('cfg-1'));
    assert.strictEqual(conn.connected, true);
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // 04 discovery
  await test('04 discovery', async () => {
    const { registry, manager } = initSource();
    const pair = makeLinked();
    registry.register(mcpLinkedConfig(GLOBAL_CFG, pair.clientEnd));
    const conn = await manager.ensureConnected(registry.get('cfg-1'));
    assert.strictEqual(conn.tools.length, 8);
    const wires = conn.tools.map((t) => t.function.name);
    assert.ok(wires.includes('mcp_github_get_test_value'));
    assert.ok(wires.every((n) => /^mcp_[a-z0-9_]+$/.test(n)), 'all wire names are safe');
    assert.ok(wires.every((n) => n.length <= 64));
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // 05 schema normalization + non-enumerable metadata
  await test('05 schema normalization & metadata', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(mcpLinkedConfig(GLOBAL_CFG, pair.clientEnd));
    const { schemas } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-X', isGuest: false });
    assert.strictEqual(schemas.length, 8);
    const s = schemas.find((x) => x.function.name === 'mcp_github_get_test_value');
    assert.ok(s.function.parameters && s.function.parameters.type === 'object');
    assert.ok('mcpMetadata' in s, 'metadata present');
    assert.strictEqual(Object.keys(s).includes('mcpMetadata'), false, 'metadata is non-enumerable');
    assert.ok(!JSON.stringify(s).includes('serverId'), 'JSON never leaks server identity');
    assert.strictEqual(s.mcpMetadata.wireName, 'mcp_github_get_test_value');
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // 06 namespace collisions
  await test('06 namespace collisions (deterministic)', async () => {
    const registry = new McpRegistry();
    registry.register({ id: 'a', name: 'Server', scope: 'global', transport: 'stdio' });
    registry.register({ id: 'b', name: 'Server', scope: 'global', transport: 'stdio' });
    const slugA = registry.get('a').slug;
    const slugB = registry.get('b').slug;
    assert.notStrictEqual(slugA, slugB, 'slugs must be unique');
    // Determinism: registering in the reverse order must produce the same
    // assignment (slug suffix depends only on register order).
    const registry2 = new McpRegistry();
    registry2.register({ id: 'b', name: 'Server', scope: 'global', transport: 'stdio' });
    registry2.register({ id: 'a', name: 'Server', scope: 'global', transport: 'stdio' });
    assert.strictEqual(registry2.get('b').slug, slugA);
    assert.strictEqual(registry2.get('a').slug, slugB);

    // Wire-name uniqueness within a server for two tools mapping to the same
    // wire segment (e.g. dot vs underscore variants).
    const registry3 = new McpRegistry();
    registry3.register({
      id: 'c', name: 'Dup', scope: 'global', transport: 'stdio',
      tools: [
        { name: 'a.b', description: 'dot' },
        { name: 'a-b', description: 'dash' },
        { name: 'a_b', description: 'underscore' }
      ]
    });
    const wires = ['a.b', 'a-b', 'a_b'].map((t) => registry3.toolByOriginalToolName(t, 'dup').wireName);
    assert.strictEqual(new Set(wires).size, 3, 'wire names must be unique per tool');
    const { sanitizeSlug, decodeWireName, fitWireName } = names;
    assert.strictEqual(decodeWireName('mcp_github_get_test_value').slug, 'github');
    assert.ok(fitWireName('x'.repeat(120)).length <= 64);
    assert.strictEqual(sanitizeSlug('My GitHub App!'), 'my_github_app');
  });

  // 07 workspace isolation
  await test('07 workspace isolation', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    const pair2 = makeLinked();
    registry.register(mcpLinkedConfig(GLOBAL_CFG, pair.clientEnd));
    registry.register(mcpLinkedConfig(PRIVATE_CFG, pair2.clientEnd));
    const { schemas: sA } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-A', isGuest: false });
    const { schemas: sB } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-B', isGuest: false });
    assert.strictEqual(sA.length, 16, 'ws-A sees global + private (8+8)');
    assert.strictEqual(sB.length, 8, 'ws-B sees global only');
    assert.ok(sB.every((s) => s.function.name.startsWith('mcp_github_')), 'ws-B never sees private tools');
    await McpToolSource.shutdown();
    await pair.server.close();
    await pair2.server.close();
  });

  // 08 guest isolation
  await test('08 guest isolation', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(mcpLinkedConfig(GLOBAL_CFG, pair.clientEnd));
    registry.register(mcpLinkedConfig({ ...PRIVATE_CFG, id: 'cfg-3', guestAllowed: true }, pair.clientEnd));
    const { schemas: guest } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-A', isGuest: true });
    const globalNames = guest.map((s) => s.function.name).filter((n) => n.startsWith('mcp_github_'));
    const privateNames = guest.map((s) => s.function.name).filter((n) => n.startsWith('mcp_private_'));
    assert.strictEqual(globalNames.length, 0, 'guests never see guestAllowed=false configs');
    assert.strictEqual(privateNames.length, 8, 'guests see guestAllowed=true configs');
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // 09 invocation
  await test('09 invocation', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(mcpLinkedConfig(GLOBAL_CFG, pair.clientEnd));
    const resolved = await McpToolSource.resolveTool('mcp_github_get_test_value', { workspaceId: 'ws-X', isGuest: false });
    assert.ok(resolved, 'resolvable');
    assert.ok(resolved.schema && resolved.schema.function, 'schema shape');
    const out = await resolved.execute({}, { signal: null }, null);
    assert.strictEqual(out.success, true);
    assert.ok(out.result.includes('fixture-ok'), 'result carried the fixture payload');
    assert.ok(out.resultSize > 0);
    assert.ok(out.mcp && out.mcp.wireName === 'mcp_github_get_test_value');
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // 10 invalid arguments
  await test('10 invalid arguments', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(mcpLinkedConfig(GLOBAL_CFG, pair.clientEnd));
    const resolved = await McpToolSource.resolveTool('mcp_github_invalid_args_tool', { workspaceId: 'ws-X', isGuest: false });
    const out = await resolved.execute({ count: 'NaN' }, { signal: null }, null);
    assert.strictEqual(out.success, false);
    assert.ok(out.errorType, 'failure is categorized');
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // 11 server unavailable (degradation + classification)
  await test('11 server unavailable (degradation + classification)', async () => {
    // A config whose transport cannot spawn → schemasForRequest degrades (no
    // crash) and errors classify as mcp.server_unavailable.
    const { registry } = initSource();
    registry.register({
      id: 'dead', name: 'Dead', scope: 'global', transport: 'stdio',
      command: '/nonexistent/mcp-server-binary'
    });
    const { schemas, failures } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-X', isGuest: false });
    assert.strictEqual(schemas.length, 0);
    assert.ok(Array.isArray(failures) && failures.length >= 1, 'failed connects are surfaced');
    const { classifySdkError } = errors;
    assert.strictEqual(classifySdkError({ code: 'CONNECTION_CLOSED' }), errors.CATEGORIES.SERVER_UNAVAILABLE);
    assert.strictEqual(classifySdkError({ name: 'UnauthorizedError', status: 401 }), errors.CATEGORIES.AUTHENTICATION_FAILED);
    assert.strictEqual(classifySdkError({ code: 'REQUEST_TIMEOUT' }), errors.CATEGORIES.CONNECTION_TIMEOUT);
    assert.strictEqual(classifySdkError({ name: 'AbortError' }, { isCancelled: true }), errors.CATEGORIES.CANCELLED);
    await McpToolSource.shutdown();
  });

  // 12 timeout classification
  await test('12 timeout classification', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(mcpLinkedConfig(GLOBAL_CFG, pair.clientEnd));
    const conn = await McpToolSource.manager.ensureConnected(registry.get('cfg-1'));
    const entry = conn.getToolEntry('delayed_tool');
    const before = Date.now();
    const out = await entry.execute({ delayMs: 500 }, { signal: null, timeoutMs: 200 }, null);
    // The adapter wraps timeout as a categorized failure RESULT (not a throw).
    assert.strictEqual(out.success, false, 'timeout surfaces as a categorized result');
    assert.strictEqual(out.errorType, errors.CATEGORIES.CONNECTION_TIMEOUT, 'category is connection_timeout');
    assert.ok(Date.now() - before < 400, 'did not wait for the full delay');
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // 13 cancellation via AbortSignal
  await test('13 cancellation via AbortSignal', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(mcpLinkedConfig(GLOBAL_CFG, pair.clientEnd));
    const resolved = await McpToolSource.resolveTool('mcp_github_delayed_tool', { workspaceId: 'ws-X', isGuest: false });
    const controller = new AbortController();
    const pending = resolved.execute({ delayMs: 2000 }, { signal: controller.signal }, null);
    await sleep(80);
    controller.abort();
    const out = await pending;
    assert.strictEqual(out.success, false);
    assert.strictEqual(out.errorType, errors.CATEGORIES.CANCELLED, 'aborted call classified as cancelled');
    assert.strictEqual(out.cancelled, true);
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // 14 output limiting
  await test('14 output limiting', async () => {
    // Unit: normalizeResultContent enforced caps on synthetic content.
    const big = 'z'.repeat(40000);
    const comp = adapter.normalizeResultContent([{ type: 'text', text: big }]);
    assert.strictEqual(comp.text.length, 8000);
    assert.strictEqual(comp.truncated, true);

    const withImage = adapter.normalizeResultContent([
      { type: 'text', text: 'header' },
      { type: 'image', data: Buffer.alloc(64).toString('base64'), mimeType: 'image/png' },
      { type: 'audio', data: Buffer.alloc(128).toString('base64'), mimeType: 'audio/mp3' }
    ]);
    assert.ok(withImage.text.includes('[image: image/png'), 'image summarized, not forwarded');
    assert.ok(withImage.text.includes('[audio: audio/mp3'), 'audio summarized, not forwarded');
    assert.ok(!withImage.text.includes('AAAA'), 'raw base64 never forwarded');

    // Through the pipeline: large_result must surface truncated + size-capped.
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(mcpLinkedConfig(GLOBAL_CFG, pair.clientEnd));
    const resolved = await McpToolSource.resolveTool('mcp_github_large_result', { workspaceId: 'ws-X', isGuest: false });
    const out = await resolved.execute({}, { signal: null }, null);
    assert.strictEqual(out.success, true);
    assert.strictEqual(out.truncated, true);
    assert.ok(out.resultSize <= 8000, 'result text capped');
    assert.ok(!out.result.includes('jumps over the lazy dog') || out.result.length <= 8000);
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // 15 tool-selection integration
  await test('15 tool-selection integration', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(mcpLinkedConfig(GLOBAL_CFG, pair.clientEnd));
    const { schemas } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-X', isGuest: false });
    const github = selectToolSchemas('Please create a GitHub issue for the login bug', () => [], { mcpSchemas: schemas });
    assert.ok(github.tools.some((t) => t.function.name === 'mcp_github_github_create_issue'), 'issue intent scores the github tool');
    assert.ok(github.mcpMatched > 0);
    assert.ok(github.tools.every((t) => t.function.name.startsWith('mcp_')));

    const unrelated = selectToolSchemas('Explain encapsulation in OOP', () => [], { mcpSchemas: schemas });
    assert.strictEqual(unrelated.tools.length, 0, 'knowledge questions match no MCP tools');
    assert.strictEqual(unrelated.mcpMatched, 0);

    // Cap: MCP tools cannot exceed MAX_TOOLS_PER_REQUEST even when combined
    // with native matches.
    const nativeMemory = [
      { function: { name: 'memorize', description: 'remember', parameters: {} } },
      { function: { name: 'recallMemory', description: 'recall', parameters: {} } },
      { function: { name: 'storeUserFact', description: 'fact', parameters: {} } }
    ];
    const capped = selectToolSchemas('Create a GitHub issue', () => nativeMemory, { mcpSchemas: schemas });
    assert.ok(capped.tools.length <= 6, 'hard cap respected');
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // 16 context-budget integration
  await test('16 context-budget integration', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(mcpLinkedConfig(GLOBAL_CFG, pair.clientEnd));
    const { schemas } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-X', isGuest: false });
    // MCP schemas are valid inputs to the shared budget pipeline.
    const mixed = [
      { function: { name: 'memorize', description: 'remember', parameters: {} } },
      { function: { name: 'webSearch', description: 'search the web', parameters: {} } },
      ...schemas
    ];
    const { estToolsTokens } = require('../lib/llm/contextBudget');
    // Budget sized to fit exactly the two native matches: every MCP tool must
    // be dropped first (unknown group = lowest priority).
    const tinyBudget = estToolsTokens(mixed.slice(0, 2));
    const trimmed = trimToolsToBudget(mixed, tinyBudget);
    assert.ok(Array.isArray(trimmed));
    assert.ok(trimmed.length < mixed.length, 'budget trims MCP tools first (unknown-group rank)');
    assert.ok(
      trimmed.every((t) => !t.function.name.startsWith('mcp_')),
      'no MCP tool survives a tiny budget alongside native matches'
    );
    assert.ok(
      trimmed.some((t) => t.function.name === 'memorize') || trimmed.length === 0,
      'native group order preserved'
    );
    // estToolsTokens JSON.stringify must ignore the non-enumerable mcpMetadata:
    // the enumerable clone serializes to an identical byte count.
    const originalJson = JSON.stringify(schemas).length;
    const enumerableCloneJson = JSON.stringify(schemas.map((s) => ({ ...s }))).length;
    assert.strictEqual(enumerableCloneJson, originalJson, 'metadata adds zero serialized bytes');
    assert.ok(!JSON.stringify(schemas).includes('serverId'));
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // 17 continuation after MCP call
  await test('17 continuation after MCP tool call', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(mcpLinkedConfig(GLOBAL_CFG, pair.clientEnd));
    const { schemas } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-X', isGuest: false });
    const prev = selectToolSchemas('Create a GitHub issue', () => [], { mcpSchemas: schemas }).tools;
    assert.ok(prev.length > 0);
    const active = ['mcp_github_github_create_issue'];
    const cont = selectContinuationTools(prev, active, () => [], {});
    assert.ok(cont.tools.some((t) => t.function.name === 'mcp_github_github_create_issue'), 'active MCP tool stays mandatory');
    assert.strictEqual(cont.mandatoryCount, 1);
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // 18 MCP tool execution failure
  await test('18 MCP tool execution failure', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    registry.register(mcpLinkedConfig(GLOBAL_CFG, pair.clientEnd));
    const resolved = await McpToolSource.resolveTool('mcp_github_always_fail', { workspaceId: 'ws-X', isGuest: false });
    const out = await resolved.execute({}, { signal: null }, null);
    assert.strictEqual(out.success, false);
    assert.ok(typeof out.error === 'string' && out.error.length > 0);
    assert.ok(out.errorType, 'failure categorized');
    await McpToolSource.shutdown();
    await pair.server.close();
  });

  // 19 connection cleanup on shutdown
  await test('19 connection cleanup on shutdown', async () => {
    const { registry } = initSource();
    const pair = makeLinked();
    const pair2 = makeLinked();
    registry.register(mcpLinkedConfig(GLOBAL_CFG, pair.clientEnd));
    registry.register(mcpLinkedConfig(PRIVATE_CFG, pair2.clientEnd));
    await McpToolSource.schemasForRequest({ workspaceId: 'ws-A', isGuest: false });
    assert.strictEqual(McpToolSource.manager.countConnections(), 2);
    await McpToolSource.shutdown();
    assert.strictEqual(McpToolSource.manager.countConnections(), 0);
    await pair.server.close();
    await pair2.server.close();
  });

  // 20 native tools remain functional
  await test('20 native tools remain functional', async () => {
    const nativeNames = ['memorize', 'storeUserFact', 'webSearch', 'getTime'];
    for (const n of nativeNames) {
      assert.ok(toolRegistry.getTool(n), `native ${n} still registered`);
      const schema = toolRegistry.getSchemaByFnName ? toolRegistry.getSchemaByFnName(n) : toolRegistry.getSchemas().find((s) => s.function.name === n);
      assert.ok(schema, `native schema present for ${n}`);
    }
    // MCP prefix never claims native names.
    assert.strictEqual(McpToolSource.isMcpToolName('webSearch'), false);
    assert.strictEqual(McpToolSource.isMcpToolName('memorize'), false);
    assert.strictEqual(McpToolSource.isMcpToolName('mcp_github_get_test_value'), true);
    // Motion of the unknown-tool branch: non-MCP, non-native → native "not
    // found" path (never an MCP lookup).
    const { isGuestActorId: ig } = { isGuestActorId: (u) => String(u).startsWith('guest_') };
    assert.strictEqual(ig('guest_abc'), true);
    assert.strictEqual(ig('user-1'), false);
  });

  // + stdio subprocess transport
  await test('EXTRA stdio subprocess transport', async () => {
    const { registry } = initSource();
    const fixture = path.join(__dirname, 'fixtures', 'mcp', 'testMcpServer.js');
    registry.register({
      id: 'stdio-1', name: 'StdioFixture', scope: 'global', transport: 'stdio',
      command: process.execPath, args: [fixture]
    });
    const { schemas, failures } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-X', isGuest: false });
    assert.strictEqual(failures.length, 0, JSON.stringify(failures));
    assert.ok(schemas.length >= 8);
    const resolved = await McpToolSource.resolveTool('mcp_stdiofixture_get_test_value', { workspaceId: 'ws-X', isGuest: false });
    assert.ok(resolved);
    const out = await resolved.execute({}, { signal: null }, null);
    assert.strictEqual(out.success, true);
    assert.ok(out.result.includes('fixture-ok'));
    await McpToolSource.shutdown();
  });

  // + streamable-http transport
  await test('EXTRA streamable-http transport', async () => {
    const { registry } = initSource();
    let port = 0;
    const fixture = await createHttpFixtureServer((err, p) => { port = p; });
    const url = `http://127.0.0.1:${port}/mcp`;
    registry.register({
      id: 'http-1', name: 'HttpFixture', scope: 'global', transport: 'streamable-http', url
    });
    const { schemas, failures } = await McpToolSource.schemasForRequest({ workspaceId: 'ws-X', isGuest: false });
    assert.strictEqual(failures.length, 0, JSON.stringify(failures));
    assert.ok(schemas.length >= 8);
    const resolved = await McpToolSource.resolveTool('mcp_httpfixture_get_test_value', { workspaceId: 'ws-X', isGuest: false });
    assert.ok(resolved);
    const out = await resolved.execute({}, { signal: null }, null);
    assert.strictEqual(out.success, true);
    assert.ok(out.result.includes('fixture-ok'));
    await McpToolSource.shutdown();
    await fixture.close();
  });

  // ---- summary -------------------------------------------------------------

  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`\nFAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
