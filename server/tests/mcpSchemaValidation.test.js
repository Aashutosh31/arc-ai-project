'use strict';

// MCP argument-schema fidelity + pre-execution validation tests.
//
// Run:  cd server && node tests/mcpSchemaValidation.test.js
//
// Real failure pinned here: the model generated
//   position = { type: "end" }            (object)
// for mcp_notion_notion-update-page where the live schema declares
//   position = string,
// and the invalid call burned a provider round-trip + HTTP 400
// (tool_use_failed) before anything validated it.
//
// Generic invariant (no tool/vendor names in the implementation):
// arguments sent to an MCP tool must conform to the selected tool's actual
// inputSchema. The execution boundary validates first: mismatch -> structured
// failure, no execution, no coercion, no invented defaults; existing
// recovery/replanning handles it. Unknown schema shapes fail OPEN.
//
// The "real-like" schemas below mirror the OBSERVED live call shape
// (command/content/page_id/position/allow_async) and the OBSERVED rejection
// (position must be a string). They are test-local and labeled as such —
// the shared 43-tool fixture is untouched.

const assert = require('assert');

const passed = [];
const failed = [];
function test(name, fn) {
  return (async () => {
    try { await fn(); passed.push(name); console.log(`  ok - ${name}`); }
    catch (err) { failed.push({ name, err }); console.error(`  FAIL - ${name}`); console.error(`         ${err && err.message}`); }
  })();
}

// Real-like (NOT verbatim live): observed argument names + observed
// position-must-be-string constraint.
const updatePageSchema = () => ({
  type: 'function',
  function: {
    name: 'mcp_x_update-page',
    description: 'Update a page properties or content. Commands: insert_content appends markdown at position.',
    parameters: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Target page identifier' },
        command: { type: 'string', enum: ['insert_content', 'update_properties'], description: 'Operation to perform' },
        content: { type: 'string', description: 'Markdown content' },
        position: { type: 'string', description: 'Where to insert: e.g. end' },
        allow_async: { type: 'boolean', description: 'Run asynchronously' }
      },
      required: ['page_id', 'command']
    }
  }
});

const VALID_CALL = {
  allow_async: false,
  command: 'insert_content',
  content: '## Restart Update Test\nARC survived the backend restart and resolved the existing page.',
  page_id: '3dcd784862fc8136ac3bd15b0a1057cc',
  position: 'end'
};
const INVALID_CALL = { ...VALID_CALL, position: { type: 'end' } };

const main = async () => {
  const adapter = require('../lib/mcp/McpToolAdapter');
  const { validateArgsAgainstSchema } = require('../lib/mcp/schemaValidate');

  await test('V-01 provider schema preserves position as string (fidelity)', () => {
    const arc = adapter.toArcSchema(
      { name: 'update-page', description: 'Update a page.', inputSchema: updatePageSchema().function.parameters },
      'mcp_x_update-page'
    );
    const params = arc.function.parameters;
    assert.strictEqual(params.properties.position.type, 'string', 'position type stripped!');
    assert.deepStrictEqual(params.required, ['page_id', 'command'], 'required list altered!');
    assert.deepStrictEqual(params.properties.command.enum, ['insert_content', 'update_properties'], 'enum dropped!');
    assert.strictEqual(params.properties.allow_async.type, 'boolean');
  });

  await test('V-02 valid string position passes validation', () => {
    const r = validateArgsAgainstSchema(VALID_CALL, updatePageSchema().function.parameters);
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  });

  await test('V-03 object position fails validation with a pointer path', () => {
    const r = validateArgsAgainstSchema(INVALID_CALL, updatePageSchema().function.parameters);
    assert.strictEqual(r.ok, false, 'object position must not validate');
    assert.ok(r.errors.some((e) => e.path === 'position' && e.expected === 'string'),
      `expected /position string error, got ${JSON.stringify(r.errors)}`);
  });

  await test('V-04 execution boundary rejects invalid call WITHOUT touching the server', async () => {
    let serverCalls = 0;
    const fakeConn = {
      callTool: async () => { serverCalls += 1; return { content: [{ type: 'text', text: 'ok' }] }; }
    };
    const entry = {
      wireName: 'mcp_x_update-page', configId: 'cfg-1', canonicalName: 'mcp.x.update-page',
      originalToolName: 'update-page', inputSchema: updatePageSchema().function.parameters
    };
    const exec = adapter.createExecAdapter(fakeConn, entry);
    const out = await exec(INVALID_CALL, {}, null);
    assert.strictEqual(out.success, false, 'must fail');
    assert.strictEqual(serverCalls, 0, 'server must never be hit');
    assert.strictEqual(out.errorType, 'mcp.invalid_arguments');
    assert.strictEqual(out.retryable, false);
    assert.ok(out.error.includes('position'), 'error names the bad field');
    assert.ok(!out.error.includes('{'), 'no raw object echoed');
  });

  await test('V-05 execution boundary passes valid call through to the server', async () => {
    let seen = null;
    const fakeConn = {
      callTool: async (name, args) => { seen = { name, args }; return { content: [{ type: 'text', text: 'updated' }] }; }
    };
    const entry = {
      wireName: 'mcp_x_update-page', configId: 'cfg-1', canonicalName: 'mcp.x.update-page',
      originalToolName: 'update-page', inputSchema: updatePageSchema().function.parameters
    };
    const out = await adapter.createExecAdapter(fakeConn, entry)(VALID_CALL, {}, null);
    assert.strictEqual(out.success, true, JSON.stringify(out));
    assert.strictEqual(seen.args.position, 'end', 'args forwarded verbatim (no coercion)');
  });

  await test('V-06 missing required + enum violations rejected pre-execution', () => {
    const schema = updatePageSchema().function.parameters;
    assert.strictEqual(validateArgsAgainstSchema({ command: 'insert_content' }, schema).ok, false, 'missing page_id');
    assert.strictEqual(validateArgsAgainstSchema({ page_id: 'p', command: 'nuke_it' }, schema).ok, false, 'bad enum');
    // Optional + explicit-null optional values never block.
    assert.strictEqual(validateArgsAgainstSchema({ page_id: 'p', command: 'insert_content', position: null }, schema).ok, true);
    // false/0 are values, not missing.
    const numSchema = { type: 'object', properties: { n: { type: 'integer' }, b: { type: 'boolean' } }, required: ['n', 'b'] };
    assert.strictEqual(validateArgsAgainstSchema({ n: 0, b: false }, numSchema).ok, true);
  });

  await test('V-07 nested objects + arrays validate structurally', () => {
    const schema = {
      type: 'object',
      properties: {
        filter: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        ids: { type: 'array', items: { type: 'string' } }
      },
      required: ['filter']
    };
    assert.strictEqual(validateArgsAgainstSchema({ filter: { q: 'x' }, ids: ['a'] }, schema).ok, true);
    assert.strictEqual(validateArgsAgainstSchema({ filter: {}, ids: ['a'] }, schema).ok, false, 'nested required');
    assert.strictEqual(validateArgsAgainstSchema({ filter: { q: 'x' }, ids: ['a', 7] }, schema).ok, false, 'array item type');
  });

  await test('V-08 unknown schema shapes fail OPEN (no false rejects)', () => {
    assert.strictEqual(validateArgsAgainstSchema({ anything: [1, { x: null }] }, null).ok, true);
    assert.strictEqual(validateArgsAgainstSchema({ anything: 1 }, {}).ok, true);
    // anyOf/oneOf/allOf are SUPPORTED constructs (enforced); fail-open
    // applies to genuinely uninterpreted keywords (not/if-then/pattern...).
    assert.strictEqual(validateArgsAgainstSchema({ a: 1 }, { not: { type: 'string' } }).ok, true, 'not ignored -> pass');
    assert.strictEqual(validateArgsAgainstSchema({ a: 1 }, { if: { type: 'string' } }).ok, true, 'if ignored -> pass');
    assert.strictEqual(validateArgsAgainstSchema('scalar', { type: 'object', properties: {} }).ok, true, 'no required -> pass');
  });

  await test('V-09 validation failure classifies replan (no retry loop)', () => {
    const recovery = require('../services/ToolRecoveryManager');
    const c = recovery.classifyFailure({
      toolName: 'mcp_x_update-page',
      result: { success: false, error: 'MCP argument validation failed for mcp_x_update-page: position: expected string, received object. Call was not executed.', errorType: 'mcp.invalid_arguments' }
    });
    assert.strictEqual(c.shouldRetry, false, 'identical args must not retry');
    assert.strictEqual(c.shouldReplan, true, 'recovery/synthesis must handle it');
  });

  await test('V-10 valid fixture-tool call passes the boundary end-to-end', async () => {
    // Real exec-adapter + real fixture server over a linked transport: a
    // well-formed call (echo {text}) must succeed exactly as before the
    // boundary existed (mirrors mcp.test.js wiring).
    const { createFixtureServer } = require('./fixtures/mcp/testMcpServer');
    const { InMemoryTransport } = require('@modelcontextprotocol/client');
    const { McpServerConnection } = require('../lib/mcp/McpServerConnection');
    const server = createFixtureServer();
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    await server.connect(serverEnd);
    const conn = new McpServerConnection({
      id: 'cfg-val', name: 'Val', slug: 'val', scope: 'global',
      transport: 'stdio', command: 'true', auth: { type: 'none' }, enabled: true,
      testHooks: { createTransport: () => clientEnd }
    }, {});
    await conn.connect({});
    const echo = conn.getToolEntry('echo');
    assert.ok(echo, 'fixture echo tool discovered');
    const out = await echo.execute({ text: 'hello-boundary' }, {}, null);
    assert.strictEqual(out.success, true, JSON.stringify(out).slice(0, 300));
    await conn.disconnect();
  });

  // ---- compositional fidelity + live-shape validation + recovery ----
  const LIVE_POSITION = () => require('./fixtures/notionRealSchemas')
    .find((s) => s.function.name === 'mcp_notion_notion-update-page').function.parameters;

  await test('F-11 adapter preserves anyOf without top-level type', () => {
    const p = adapter.toArcSchema(
      { name: 'u', description: 'u', inputSchema: { type: 'object', properties: { position: LIVE_POSITION().properties.position } } },
      'mcp_x_u'
    ).function.parameters.properties.position;
    assert.ok(Array.isArray(p.anyOf) && p.anyOf.length === 2, `anyOf lost: ${JSON.stringify(p).slice(0, 120)}`);
    assert.ok(p.type === undefined, `type must not default to string, got ${p.type}`);
  });

  await test('F-12 oneOf/nested/enum/required preserved inside composition', () => {
    const schema = {
      type: 'object',
      properties: {
        mode: { oneOf: [{ type: 'string', enum: ['a'] }, { type: 'integer' }] },
        nested: { anyOf: [{ type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }] }
      }
    };
    const out = adapter.toArcSchema({ name: 'u', description: 'u', inputSchema: schema }, 'mcp_x_u').function.parameters;
    assert.ok(Array.isArray(out.properties.mode.oneOf) && out.properties.mode.oneOf.length === 2);
    assert.strictEqual(out.properties.mode.oneOf[0].enum[0], 'a');
    assert.deepStrictEqual(out.properties.nested.anyOf[0].required, ['x']);
    // Groq layer mirrors the same fidelity (singleton export).
    const gp = require('../lib/llm/providers/GroqProvider');
    const gout = gp.sanitizeSchema(schema).properties;
    assert.ok(Array.isArray(gout.mode.oneOf) && gout.mode.oneOf.length === 2, 'groq oneOf lost');
    assert.ok(Array.isArray(gout.nested.anyOf) && gout.nested.anyOf.length === 1, 'groq nested anyOf lost');
    assert.ok(gout.nested.anyOf[0].properties.x.type === 'string');
  });

  await test('F-13 live-shape provider schema matches source structure', () => {
    const live = LIVE_POSITION();
    const arcPos = adapter.toArcSchema(
      { name: 'u', description: 'u', inputSchema: { type: 'object', properties: { position: live.properties.position } } },
      'mcp_x_u'
    ).function.parameters.properties.position;
    assert.deepStrictEqual(Object.keys(arcPos).sort(), ['anyOf', 'description']);
    assert.ok(arcPos.anyOf.every((b) => b.type === 'object' && Array.isArray(b.required)));
    const gp = require('../lib/llm/providers/GroqProvider');
    const gpos = gp.sanitizeSchema(
      { type: 'object', properties: { position: live.properties.position } }
    ).properties.position;
    assert.ok(Array.isArray(gpos.anyOf) && gpos.anyOf.length === 2, 'groq must keep anyOf');
    assert.ok(gpos.type === undefined, 'groq must not force string');
  });

  await test('F-14 anyOf: one branch match passes, none fails', () => {
    const def = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
    assert.strictEqual(validateArgsAgainstSchema({ v: 's' }, { type: 'object', properties: { v: def } }).ok, true);
    assert.strictEqual(validateArgsAgainstSchema({ v: 3 }, { type: 'object', properties: { v: def } }).ok, true);
    assert.strictEqual(validateArgsAgainstSchema({ v: true }, { type: 'object', properties: { v: def } }).ok, false);
  });

  await test('F-15 oneOf: exactly-one passes, zero/two fail (no anyOf collapse)', () => {
    const def = { oneOf: [{ type: 'string' }, { type: 'string', enum: ['a'] }] };
    const wrap = (v) => validateArgsAgainstSchema({ v }, { type: 'object', properties: { v: def } });
    assert.strictEqual(wrap('b').ok, true, 'exactly one branch');
    assert.strictEqual(wrap('a').ok, false, 'both branches match -> must fail oneOf');
    assert.strictEqual(wrap(9).ok, false, 'no branch matches');
  });

  await test('F-16 allOf: all must validate', () => {
    const def = { allOf: [{ type: 'object' }, { properties: { x: { type: 'string' } }, required: ['x'] }] };
    const wrap = (v) => validateArgsAgainstSchema({ v }, { type: 'object', properties: { v: def } });
    assert.strictEqual(wrap({ x: 's' }).ok, true);
    assert.strictEqual(wrap({}).ok, false);
  });

  await test('F-17 live position: object passes, string fails, server untouched', async () => {
    const liveParams = LIVE_POSITION();
    assert.strictEqual(validateArgsAgainstSchema({ ...VALID_CALL, position: { type: 'end' } }, liveParams).ok, true);
    assert.strictEqual(validateArgsAgainstSchema({ ...VALID_CALL, position: 'end' }, liveParams).ok, false);
    const { position: _omit, ...noPosition } = VALID_CALL;
    assert.strictEqual(validateArgsAgainstSchema(noPosition, liveParams).ok, true, 'omitted optional position');
    let serverCalls = 0;
    const fakeConn = { callTool: async () => { serverCalls += 1; return { content: [{ type: 'text', text: 'ok' }] }; } };
    const entry = {
      wireName: 'mcp_notion_notion-update-page', configId: 'cfg-1', canonicalName: 'mcp.notion.notion-update-page',
      originalToolName: 'notion-update-page', inputSchema: liveParams
    };
    const exec = adapter.createExecAdapter(fakeConn, entry);
    const bad = await exec({ ...VALID_CALL, position: 'end' }, {}, null);
    assert.strictEqual(bad.success, false);
    assert.strictEqual(bad.errorType, 'mcp.invalid_arguments');
    assert.strictEqual(serverCalls, 0);
    serverCalls = 0;
    const good = await exec({ ...VALID_CALL, position: { type: 'end' } }, {}, null);
    assert.strictEqual(good.success, true, JSON.stringify(good).slice(0, 200));
    assert.strictEqual(serverCalls, 1);
  });

  await test('F-18 live command enum + required pair enforced', () => {
    const liveParams = LIVE_POSITION();
    assert.strictEqual(validateArgsAgainstSchema({ page_id: 'p', command: 'insert_content', content: 'c' }, liveParams).ok, true);
    assert.strictEqual(validateArgsAgainstSchema({ page_id: 'p', command: 'bogus_command' }, liveParams).ok, false);
    assert.strictEqual(validateArgsAgainstSchema({ command: 'insert_content' }, liveParams).ok, false, 'page_id required');
    assert.strictEqual(validateArgsAgainstSchema({ page_id: 'p' }, liveParams).ok, false, 'command required');
  });

  await test('F-19 live server validation text classifies validation/no-retry/replan', () => {
    const recovery = require('../services/ToolRecoveryManager');
    const c = recovery.classifyFailure({
      toolName: 'mcp_notion_notion-update-page',
      result: { success: false, error: 'Input validation error: position: Invalid input', errorType: 'MCP_TOOL_ERROR' }
    });
    assert.strictEqual(c.type, 'validation');
    assert.strictEqual(c.shouldRetry, false, 'identical args must not retry');
    assert.strictEqual(c.shouldReplan, true);
  });

  await test('F-20 unrelated failures keep existing retry behavior', () => {
    const recovery = require('../services/ToolRecoveryManager');
    const transient = recovery.classifyFailure({
      toolName: 'mcp_x_t',
      result: { success: false, error: 'upstream timeout after 30000ms', errorType: 'mcp.tool_execution_error' }
    });
    assert.strictEqual(transient.shouldRetry, true, 'transient keeps retry');
    const nativeInvalid = recovery.classifyFailure({
      toolName: 'executeCode',
      result: { success: false, error: 'invalid input: expected number' }
    });
    assert.strictEqual(nativeInvalid.type, 'malformed', 'non-MCP invalid keeps legacy path');
    assert.strictEqual(nativeInvalid.shouldRetry, true);
  });

  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
};

main().catch((err) => { console.error('Harness error:', err); process.exit(1); });
