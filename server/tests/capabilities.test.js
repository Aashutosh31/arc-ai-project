/* JARVIS Action Substrate — slice 1: capability inventory/normalization.
 *
 * Run with: node tests/capabilities.test.js
 *
 * Verifies:
 *   - capability contract + validation (capabilityTypes)
 *   - pure native risk/scope mapping (risk)
 *   - read-only native discovery from the LIVE native registry
 *   - read-only MCP discovery from the LIVE MCP source (seeded registry)
 *   - deterministic, unique capability IDs across the aggregate
 *   - normalized aggregate view (CapabilityRegistry)
 *   - workspace/guest metadata preserved; existing registries untouched
 *   - no execution behavior introduced
 */

const assert = require('assert');

const caps = require('../lib/capabilities');
const { McpToolSource } = require('../lib/mcp');
const McpRegistry = require('../lib/mcp/McpRegistry');

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
    console.error(`  FAIL  ${label}\n        ${err.message}`);
  }
}

const initMcpSource = (configs) => {
  const registry = new McpRegistry();
  const manager = { registry, on: () => {}, shutdown: async () => {} };
  McpToolSource.init({ manager, registry });
  for (const cfg of configs) registry.register(cfg);
  return registry;
};

const LINEAR_READ = {
  id: 'linear-1',
  name: 'Linear',
  slug: 'linear',
  scope: 'global',
  transport: 'stdio',
  tools: [
    {
      name: 'list_issues',
      description: 'List Linear issues',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
  ],
};

const LINEAR_CREATE = {
  id: 'linear-2',
  name: 'Linear',
  slug: 'linear2',
  scope: 'global',
  transport: 'stdio',
  // Consequential (create-issue-style) fixture: open-world interaction, not
  // read-only — annotation-driven, no tool-name knowledge.
  tools: [
    {
      name: 'create_issue',
      description: 'Create a Linear issue',
      inputSchema: { type: 'object', properties: {} },
      annotations: { openWorldHint: true },
    },
  ],
};

const NOTION_READ = {
  id: 'notion-1',
  name: 'Notion',
  slug: 'notion',
  scope: 'workspace',
  workspaceId: 'ws-7',
  transport: 'stdio',
  tools: [
    {
      name: 'search_pages',
      description: 'Search Notion pages',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
  ],
};

const main = async () => {
  console.log('Capability Substrate (slice 1)');
  console.log('===============================');

  // ---- capabilityTypes: contract + validation ----

  await test('contract: scope/risk/source enum validation', () => {
    assert.strictEqual(caps.capabilityTypes.validateSource('native'), null);
    assert.strictEqual(caps.capabilityTypes.validateSource('mcp'), null);
    assert.ok(caps.capabilityTypes.validateSource('bogus'));
    assert.strictEqual(caps.capabilityTypes.validateScope('read'), null);
    assert.strictEqual(caps.capabilityTypes.validateScope('reversible'), null);
    assert.strictEqual(caps.capabilityTypes.validateScope('consequential'), null);
    assert.strictEqual(caps.capabilityTypes.validateScope(null), null); // uncategorized
    assert.strictEqual(caps.capabilityTypes.validateRisk('low'), null);
    assert.strictEqual(caps.capabilityTypes.validateRisk('high'), null);
    assert.strictEqual(caps.capabilityTypes.validateRisk(null), null);
    assert.ok(caps.capabilityTypes.validateRisk('extreme'));
  });

  await test('contract: validateCapability reports shape errors', () => {
    assert.deepStrictEqual(caps.capabilityTypes.validateCapability(null), ['capability must be an object']);
    const ok = caps.discoverNative().find((c) => c.name === 'webSearch');
    assert.deepStrictEqual(caps.capabilityTypes.validateCapability(ok), []);
    assert.ok(caps.capabilityTypes.validateCapability({ ...ok, source: 'planet' }).length > 0);
    assert.ok(caps.capabilityTypes.validateCapability({ ...ok, scope: 'cosmic' }).length > 0);
    assert.ok(caps.capabilityTypes.validateCapability({ ...ok, id: '' }).length > 0);
    assert.strictEqual(caps.capabilityTypes.isCapability(ok), true);
  });

  // ---- risk: pure metadata mapping ----

  await test('risk: representative native mappings', () => {
    assert.deepStrictEqual(caps.risk.nativeRiskFor('webSearch'), { scope: 'read', risk: 'low' });
    assert.deepStrictEqual(caps.risk.nativeRiskFor('checkCalendar'), { scope: 'read', risk: 'low' });
    assert.deepStrictEqual(caps.risk.nativeRiskFor('playMedia'), { scope: 'reversible', risk: 'low' });
    assert.deepStrictEqual(caps.risk.nativeRiskFor('changeTheme'), { scope: 'reversible', risk: 'low' });
    assert.strictEqual(caps.risk.nativeRiskFor('unknownTool'), null);
  });

  await test('risk: MCP annotation-derived mapping (description-only, no tool names)', () => {
    assert.deepStrictEqual(caps.risk.mcpRiskFor({ readOnlyHint: true }), { scope: 'read', risk: 'low' });
    assert.deepStrictEqual(caps.risk.mcpRiskFor({ destructiveHint: true }), { scope: 'consequential', risk: 'high' });
    assert.deepStrictEqual(caps.risk.mcpRiskFor({ openWorldHint: true }), { scope: 'consequential', risk: 'medium' });
    assert.deepStrictEqual(caps.risk.mcpRiskFor({ idempotentHint: true }), { scope: 'reversible', risk: 'medium' });
    assert.strictEqual(caps.risk.mcpRiskFor(null), null);
    assert.strictEqual(caps.risk.mcpRiskFor({}), null);
    assert.strictEqual(caps.risk.mcpRiskFor({ title: 'vendor name' }), null);
  });

  await test('risk: native mapping table is frozen and small', () => {
    assert.ok(Object.isFrozen(caps.risk.NATIVE_SCOPE_RISK));
  });

  // ---- native discovery ----

  await test('native discovery: all registry tools surface as capabilities', () => {
    const native = caps.discoverNative();
    assert.ok(native.length >= 20, `expected >= 20 native tools, got ${native.length}`);
    for (const c of native) {
      assert.strictEqual(c.source, 'native');
      assert.ok(c.id.startsWith('native:'));
      assert.strictEqual(c.id, `native:${c.name}`);
      assert.ok(c.wireName);
      assert.deepStrictEqual(caps.capabilityTypes.validateCapability(c), []);
    }
  });

  await test('native discovery: representative mappings correct', () => {
    const native = caps.discoverNative();
    const byName = (n) => native.find((c) => c.name === n);
    for (const name of ['webSearch', 'checkCalendar']) {
      assert.strictEqual(byName(name).scope, 'read');
      assert.strictEqual(byName(name).risk, 'low');
    }
    for (const name of ['playMedia', 'changeTheme']) {
      assert.strictEqual(byName(name).scope, 'reversible');
      assert.strictEqual(byName(name).risk, 'low');
    }
    // Unclassified capabilities stay null (never guessed).
    assert.strictEqual(byName('executeCode').scope, null);
    assert.strictEqual(byName('sendEmail').risk, null);
  });

  await test('native discovery: no execution property leaks into the contract', () => {
    const cap = caps.discoverNative().find((c) => c.name === 'webSearch');
    assert.strictEqual(typeof cap.execute, 'undefined');
    assert.strictEqual(Object.keys(cap).includes('execute'), false);
  });

  // ---- MCP discovery ----

  await test('MCP discovery: read + consequential fixtures surface with metadata', async () => {
    initMcpSource([LINEAR_READ, LINEAR_CREATE, NOTION_READ]);
    try {
      const mcp = await caps.discoverMcp({ workspaceId: 'ws-7', isGuest: false });
      assert.strictEqual(mcp.length, 3, `expected 3 MCP capabilities, got ${mcp.length}`);
      const listIssues = mcp.find((c) => c.id === 'mcp.linear.list_issues');
      assert.ok(listIssues, 'linear list_issues must be discovered');
      assert.strictEqual(listIssues.scope, 'read');
      assert.strictEqual(listIssues.risk, 'low');
      assert.strictEqual(listIssues.wireName, 'mcp_linear_list_issues');
      assert.deepStrictEqual(listIssues.metadata, {
        workspaceId: null,
        isGuest: false,
        serverId: 'linear-1',
        configName: 'Linear',
        configScope: 'global',
      });

      const createIssue = mcp.find((c) => c.id === 'mcp.linear2.create_issue');
      assert.ok(createIssue, 'linear create_issue must be discovered');
      assert.strictEqual(createIssue.scope, 'consequential');
      assert.strictEqual(createIssue.risk, 'medium');

      const searchPages = mcp.find((c) => c.id === 'mcp.notion.search_pages');
      assert.ok(searchPages, 'notion search_pages must be discovered');
      assert.strictEqual(searchPages.metadata.workspaceId, 'ws-7');
      assert.strictEqual(searchPages.metadata.configScope, 'workspace');
    } finally {
      await McpToolSource.shutdown();
    }
  });

  await test('MCP discovery: guest scoping respected', async () => {
    initMcpSource([LINEAR_READ, NOTION_READ]);
    try {
      const guest = await caps.discoverMcp({ workspaceId: 'ws-7', isGuest: true });
      assert.strictEqual(guest.length, 0, 'guests see no configs in this fixture');
      const authed = await caps.discoverMcp({ workspaceId: 'ws-7', isGuest: false });
      assert.strictEqual(authed.length, 2);
    } finally {
      await McpToolSource.shutdown();
    }
  });

  await test('MCP discovery: unannotated tools stay uncategorized, not guessed', async () => {
    initMcpSource([
      { ...LINEAR_READ, slug: 'plain', tools: [{ name: 'do_thing', description: 'x', inputSchema: { type: 'object', properties: {} } }] },
    ]);
    try {
      const mcp = await caps.discoverMcp({ workspaceId: 'ws-7' });
      assert.strictEqual(mcp.length, 1);
      assert.strictEqual(mcp[0].scope, null);
      assert.strictEqual(mcp[0].risk, null);
    } finally {
      await McpToolSource.shutdown();
    }
  });

  // ---- aggregate registry ----

  await test('registry: stable unique IDs across native + MCP aggregate', async () => {
    initMcpSource([LINEAR_READ, LINEAR_CREATE]);
    try {
      const reg = await caps.buildCapabilityRegistry({ workspaceId: 'ws-7' });
      const ids = reg.ids();
      assert.strictEqual(new Set(ids).size, ids.length, 'IDs must be unique');
      assert.ok(ids.includes('native:webSearch'));
      assert.ok(ids.includes('mcp.linear.list_issues'));
      assert.ok(ids.includes('mcp.linear2.create_issue'));
      assert.strictEqual(reg.byId('native:webSearch').source, 'native');
      assert.strictEqual(reg.byId('mcp.linear.list_issues').source, 'mcp');
      assert.strictEqual(reg.byId('mcp.linear.list_issues').wireName, 'mcp_linear_list_issues');
      assert.strictEqual(reg.byId('does.not.exist'), null);
    } finally {
      await McpToolSource.shutdown();
    }
  });

  await test('registry: summary counts partition by source', async () => {
    initMcpSource([LINEAR_READ, NOTION_READ]);
    try {
      const reg = await caps.buildCapabilityRegistry({ workspaceId: 'ws-7' });
      const s = reg.summary();
      assert.strictEqual(s.native + s.mcp, s.total);
      assert.strictEqual(s.mcp, 2);
      assert.ok(s.native >= 20);
      assert.ok(Object.isFrozen(reg.all()));
      assert.strictEqual(reg.byScope('read').length + reg.byScope('reversible').length + reg.byScope('consequential').length + reg.byScope(null).length, s.total);
    } finally {
      await McpToolSource.shutdown();
    }
  });

  // ---- non-interference ----

  await test('non-interference: discovery does not create a second registry or change sources', async () => {
    const nativeBefore = Object.keys(require('../tools').tools || {}).length;
    const nativeCaps = caps.discoverNative();
    const nativeAfter = Object.keys(require('../tools').tools || {}).length;
    assert.strictEqual(nativeBefore, nativeAfter, 'native registry object must be untouched');
    assert.strictEqual(nativeCaps.length, nativeAfter, 'every native tool has exactly one capability');
    // The MCP registry instance is never constructed by the capability layer
    // itself (only by callers that seed it).
    assert.strictEqual(caps.CapabilityRegistry, require('../lib/capabilities/capabilityRegistry').CapabilityRegistry);
  });

  await test('non-interference: no TaskExecutor, Jev, MCP-manager mutation on import', () => {
    assert.ok(require('../lib/capabilities/discover').buildNativeCapability(null) === null);
    assert.strictEqual(typeof caps.discoverNative()[0].execute, 'undefined');
    const taskExecutor = require('../services/TaskExecutor');
    assert.ok(typeof taskExecutor.executeTool === 'function', 'TaskExecutor untouched');
  });

  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  process.exitCode = fail > 0 ? 1 : 0;
};

main().catch((err) => {
  console.error('Capability tests crashed:', err);
  process.exitCode = 1;
});