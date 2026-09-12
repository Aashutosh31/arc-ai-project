/* Tool-continuation regression tests — run with: node tests/toolContinuation.test.js
 *
 * Guards the invariant: a tool-continuation turn MUST carry the tool
 * definitions referenced by its active tool calls. Sending tools=[] with
 * assistant.tool_calls present makes Groq reject the request
 * ("tool choice is none, but model called a tool").
 *
 * Plain node. Uses the REAL tool registry for schema-identity assertions.
 */

const assert = require('assert');

let pass = 0;
let fail = 0;

async function check(label, fn) {
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

console.log('Tool Continuation Regression Tests');
console.log('==================================');

const {
  activeToolNamesFromCalls,
  selectContinuationTools,
  selectToolSchemas
} = require('../lib/llm/toolSelection');

const { getSchemas } = require('../tools/index');
const ALL = getSchemas();
const names = (list) => list.map((s) => s.function.name);

async function run() {
  await check('active names extracted from assistant tool_calls', () => {
    assert.deepStrictEqual(
      activeToolNamesFromCalls([
        { id: 'a', function: { name: 'webSearch', arguments: '{}' } },
        { id: 'b', function: { name: 'webSearch', arguments: '{}' } },
        { id: 'c', function: { name: 'getTime', arguments: '{}' } }
      ]),
      ['webSearch', 'getTime']
    );
    assert.deepStrictEqual(activeToolNamesFromCalls([]), []);
    assert.deepStrictEqual(activeToolNamesFromCalls(null), []);
  });

  await check('3. webSearch continuation keeps webSearch (never [])', () => {
    const prev = selectToolSchemas('Search the web for the latest AI news', () => ALL).tools;
    assert.ok(names(prev).includes('webSearch'), 'initial selects webSearch');
    const cont = selectContinuationTools(prev, ['webSearch'], () => ALL);
    assert.ok(cont.tools.length > 0, 'continuation non-empty');
    assert.ok(names(cont.tools).includes('webSearch'), 'active tool retained');
  });

  await check('4. active tool missing from previous set is looked up, not dropped', () => {
    // Simulates a remapped/executed name (e.g. calendarIntent mapping) that
    // was not in the offered subset: registry lookup must cover it.
    const prev = selectToolSchemas('Explain encapsulation', () => ALL).tools; // memory trio
    const cont = selectContinuationTools(prev, ['getTime'], () => ALL);
    assert.ok(names(cont.tools).includes('getTime'), 'getTime recovered from registry');
  });

  await check('5/6. getTime + playMedia continuations preserved', () => {
    for (const active of ['getTime', 'playMedia']) {
      const prev = selectToolSchemas('Explain encapsulation', () => ALL).tools;
      const cont = selectContinuationTools(prev, [active], () => ALL);
      assert.ok(names(cont.tools).includes(active), `${active} preserved`);
      assert.ok(cont.tools.length > 0);
    }
  });

  await check('7. cap applies to filler only; mandatory tools always retained', () => {
    const prev = ALL.slice(0, 10);
    const cont = selectContinuationTools(prev, ['webSearch', 'getTime'], () => ALL, { maxTools: 2 });
    const got = names(cont.tools);
    assert.ok(got.includes('webSearch') && got.includes('getTime'), 'both mandatory kept');
    assert.ok(cont.tools.length <= 2, 'cap respected');
  });

  await check('unknown active names skipped gracefully, no throw', () => {
    const cont = selectContinuationTools([], ['noSuchTool'], () => ALL);
    assert.deepStrictEqual(cont.tools, []);
    assert.deepStrictEqual(cont.activeNames, ['noSuchTool']);
  });

  await check('empty active calls returns previous set capped (safe no-op)', () => {
    const prev = selectToolSchemas('Search the web', () => ALL).tools;
    const cont = selectContinuationTools(prev, [], () => ALL);
    assert.deepStrictEqual(names(cont.tools), names(prev).slice(0, 6));
  });

  await check('8. normal no-tool requests still avoid all 22', () => {
    const pick = selectToolSchemas('Explain encapsulation', () => ALL);
    assert.ok(pick.tools.length < ALL.length && pick.tools.length <= 6);
  });

  await check('continuation schemas are intact registry entries', () => {
    const prev = selectToolSchemas('Search the web for the latest AI news', () => ALL).tools;
    const cont = selectContinuationTools(prev, ['webSearch'], () => ALL);
    for (const s of cont.tools) {
      const orig = ALL.find((o) => o.function.name === s.function.name);
      assert.deepStrictEqual(s, orig, `${s.function.name} unedited`);
    }
  });
}

run().then(() => {
  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  process.exit(process.exitCode || 0);
}).catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
