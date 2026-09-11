/* Context budget + tool selection tests — run with: node tests/contextBudget.test.js
 *
 * Verifies the nuclear fix for unbounded LLM context:
 *  - tool selection: generic questions get a small default set, never 22
 *  - memories compacted to bullets (never verbatim messages[] turns)
 *  - facts/RAG capped; per-category budgets enforced deterministically
 *  - explicit output budget; total stays under the safe budget incl. 300+ memories
 *  - minimal-profile refusal when even the floor overflows (no provider call)
 *  - user message never removed; tool schemas never edited
 *
 * Plain node. Uses the REAL tool registry for schema-shape assertions.
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

console.log('Context Budget + Tool Selection Tests');
console.log('=====================================');

const {
  SAFE_TOTAL_BUDGET_TOKENS,
  OUTPUT_BUDGET_DEFAULT,
  OUTPUT_BUDGET_EXTENDED,
  MEMORY_BUDGET_TOKENS,
  FACTS_BUDGET_TOKENS,
  RAG_BUDGET_TOKENS,
  estTokensForChars,
  estMessagesTokens,
  compactMemories,
  compactFacts,
  compactRag,
  trimToolsToBudget,
  assembleBudgetedRequest
} = require('../lib/llm/contextBudget');

const {
  MAX_TOOLS_PER_REQUEST,
  matchGroups,
  detectOutputIntent,
  selectToolSchemas
} = require('../lib/llm/toolSelection');

const { getSchemas } = require('../tools/index');
const ALL_SCHEMAS = getSchemas();
const toolNames = (list) => list.map((s) => s.function.name);

const bigMem = (i, qLen = 400, rLen = 800) => ({
  query: `user question ${i} ` + 'q'.repeat(qLen),
  response: `assistant answer ${i} ` + 'r'.repeat(rLen),
  pinned: false,
  timestamp: new Date(Date.now() - i * 60000)
});

async function run() {
  await check('budget constants: total 7000 headroom under 8000 TPM', () => {
    assert.strictEqual(SAFE_TOTAL_BUDGET_TOKENS, 7000);
    assert.ok(OUTPUT_BUDGET_DEFAULT >= 1000 && OUTPUT_BUDGET_DEFAULT <= 1400);
    assert.ok(SAFE_TOTAL_BUDGET_TOKENS < 8000);
  });

  await check('C. generic question gets default set, never all 22', () => {
    const pick = selectToolSchemas('Explain encapsulation', () => ALL_SCHEMAS);
    assert.ok(pick.defaulted, 'no capability matched');
    assert.ok(pick.tools.length <= 6 && pick.tools.length > 0);
    assert.ok(pick.tools.length < ALL_SCHEMAS.length, `${pick.tools.length} < ${ALL_SCHEMAS.length}`);
    assert.deepStrictEqual(pick.groups, ['memory']);
  });

  await check('C2. polymorphism likewise default-only', () => {
    const pick = selectToolSchemas('Explain polymorphism.', () => ALL_SCHEMAS);
    assert.deepStrictEqual(toolNames(pick.tools).sort(), ['memorize', 'recallMemory', 'storeUserFact'].sort());
  });

  await check('D. media request selects media tools', () => {
    const pick = selectToolSchemas('Play Sitaare by Arijit Singh.', () => ALL_SCHEMAS);
    const names = toolNames(pick.tools);
    assert.ok(names.includes('playMedia'), `has playMedia: ${names}`);
    assert.ok(!names.includes('scheduleMeeting') && !names.includes('changeTheme'), 'no calendar/theme');
  });

  await check('E. calendar request selects scheduling tools', () => {
    const pick = selectToolSchemas('Schedule a meeting tomorrow at 10.', () => ALL_SCHEMAS);
    const names = toolNames(pick.tools);
    assert.ok(names.includes('scheduleMeeting') && names.includes('checkCalendar'), `has calendar: ${names}`);
    assert.ok(!names.includes('playMedia'), 'no media');
  });

  await check('F. theme request selects changeTheme only path', () => {
    const pick = selectToolSchemas('Change theme to cyberpunk.', () => ALL_SCHEMAS);
    assert.ok(toolNames(pick.tools).includes('changeTheme'));
    assert.ok(pick.tools.length <= 6);
  });

  await check('G. no GitHub tools registered: documents absence, safe default', () => {
    assert.ok(!ALL_SCHEMAS.some((s) => /github/i.test(s.function.name)), 'registry has no github tool');
    const pick = selectToolSchemas('Create a GitHub issue for the login bug.', () => ALL_SCHEMAS);
    assert.ok(pick.defaulted, 'falls back to safe default, never all tools');
    assert.ok(pick.tools.length <= MAX_TOOLS_PER_REQUEST);
  });

  await check('multi-intent capped at 6 tools', () => {
    const pick = selectToolSchemas('remind me to check the weather and search the web for news', () => ALL_SCHEMAS);
    assert.ok(pick.tools.length <= MAX_TOOLS_PER_REQUEST, `capped: ${pick.tools.length}`);
    const names = toolNames(pick.tools);
    assert.ok(names.includes('createReminder') || names.includes('setReminder'), 'calendar survives');
  });

  await check('output intent: explanation extended, greeting default', () => {
    assert.strictEqual(detectOutputIntent('Explain encapsulation in OOP in simple terms.'), 'extended');
    assert.strictEqual(detectOutputIntent('hi'), 'default');
    assert.strictEqual(detectOutputIntent('debug this null pointer in my code'), 'extended');
  });

  await check('H. memory compaction: bullets within budget, pinned first', () => {
    const docs = [bigMem(0), bigMem(1), bigMem(2)];
    docs[2].pinned = true;
    const c = compactMemories(docs, 'unrelated filler query with no overlap whatsoever');
    assert.ok(c.chars <= MEMORY_BUDGET_TOKENS * 4, `within budget: ${c.chars}`);
    assert.ok(!c.text.includes('q'.repeat(140)), 'query truncated to cap, never verbatim');
    assert.ok(!c.text.includes('r'.repeat(220)), 'response truncated to cap, never verbatim');
    assert.ok(c.text.startsWith('- user question 2'), 'pinned doc ranked first');
    assert.strictEqual(c.kept + c.dropped, 3);
  });

  await check('relevance beats recency (no embeddings)', () => {
    const old = { query: 'user prefers C++ for DSA practice', response: 'noted, will use C++ examples', pinned: false, timestamp: new Date(Date.now() - 30 * 86400000) };
    const fresh = { query: 'what is the weather like today', response: 'sunny and warm all week long here', pinned: false, timestamp: new Date() };
    const c = compactMemories([fresh, old], 'which language should I use for DSA');
    assert.ok(c.text.includes('C++'), 'relevant older memory wins');
  });

  await check('facts capped; RAG keeps rank order and caps snippets', () => {
    const facts = Array.from({ length: 20 }, (_, i) => ({ fact: `fact number ${i} ` + 'f'.repeat(300), pinned: i === 19, createdAt: new Date() }));
    const fc = compactFacts(facts, 'zzz no overlap query');
    assert.ok(fc.chars <= FACTS_BUDGET_TOKENS * 4);
    assert.ok(fc.text.includes('fact number 19'), 'pinned fact first');
    const items = Array.from({ length: 10 }, (_, i) => ({ type: 'memory', source: 'vector', score: 0.9 - i * 0.05, snippet: `chunk ${i} ` + 'x'.repeat(500) }));
    const rc = compactRag(items, RAG_BUDGET_TOKENS);
    assert.ok(rc.chars <= RAG_BUDGET_TOKENS * 4, `rag within budget: ${rc.chars}`);
    assert.ok(rc.text.indexOf('chunk 0') < rc.text.indexOf('chunk 1'), 'rank order preserved');
  });

  await check('trimToolsToBudget never edits schemas', () => {
    const tiny = 100; // forces drops
    const trimmed = trimToolsToBudget(ALL_SCHEMAS, tiny);
    assert.ok(trimmed.length < ALL_SCHEMAS.length);
    for (const s of trimmed) {
      const orig = ALL_SCHEMAS.find((o) => o.function.name === s.function.name);
      assert.deepStrictEqual(s, orig, `${s.function.name} intact`);
    }
  });

  const heavyAssembly = () => {
    const mems = Array.from({ length: 20 }, (_, i) => bigMem(i));
    const facts = Array.from({ length: 20 }, (_, i) => ({ fact: `user fact ${i} ` + 'f'.repeat(200), pinned: false, createdAt: new Date() }));
    const rag = Array.from({ length: 10 }, (_, i) => ({ type: 'memory', source: 'vector', score: 0.9, snippet: `retrieval chunk ${i} ` + 'z'.repeat(400) }));
    const pick = selectToolSchemas('Explain encapsulation in OOP in simple terms.', () => ALL_SCHEMAS);
    return assembleBudgetedRequest({
      systemTemplate: `SYS. __LONG_TERM_MEMORY_SLOT____RETRIEVAL_CONTEXT_SLOT__ END.`,
      baseUserText: 'Explain encapsulation in OOP in simple terms.',
      docText: '',
      memoryDocs: mems,
      factDocs: facts,
      ragItems: rag,
      selectedTools: pick.tools,
      outputBudget: OUTPUT_BUDGET_EXTENDED,
      query: 'Explain encapsulation in OOP in simple terms.'
    });
  };

  await check('A. heavy-memory request fits budget, one user message, explicit output', () => {
    const r = heavyAssembly();
    assert.strictEqual(r.ok, true);
    assert.ok(r.report.estimatedInputTokens <= r.report.inputBudget,
      `input ${r.report.estimatedInputTokens} <= ${r.report.inputBudget}`);
    assert.ok(r.report.estimatedTotal <= SAFE_TOTAL_BUDGET_TOKENS,
      `total ${r.report.estimatedTotal} <= ${SAFE_TOTAL_BUDGET_TOKENS}`);
    assert.strictEqual(r.messages.length, 1, 'provider context is the current turn only');
    assert.strictEqual(r.messages[0].role, 'user');
    assert.ok(r.tools.length <= MAX_TOOLS_PER_REQUEST, `tools ${r.tools.length}`);
    assert.strictEqual(r.maxTokens, OUTPUT_BUDGET_EXTENDED);
    for (const key of ['estimatedInputTokens', 'outputBudget', 'estimatedTotal', 'safeBudget', 'toolsCount', 'toolChars', 'memoryCount', 'memoryChars', 'factsCount', 'factsChars', 'ragCount', 'ragChars', 'historyCount', 'historyChars', 'systemChars', 'userChars', 'compactionApplied', 'compactionPasses']) {
      assert.ok(key in r.report, `report has ${key}`);
    }
  });

  await check('B. 300+ memories still fit (request independent of DB size)', () => {
    const mems = Array.from({ length: 320 }, (_, i) => bigMem(i, 500, 1000));
    const r = assembleBudgetedRequest({
      systemTemplate: 'SYS. __LONG_TERM_MEMORY_SLOT____RETRIEVAL_CONTEXT_SLOT__ END.',
      baseUserText: 'Explain encapsulation in OOP in simple terms.',
      docText: '',
      memoryDocs: mems.slice(0, 20), // candidate pool as fetched
      factDocs: [],
      ragItems: [],
      selectedTools: selectToolSchemas('Explain encapsulation', () => ALL_SCHEMAS).tools,
      outputBudget: OUTPUT_BUDGET_EXTENDED,
      query: 'Explain encapsulation'
    });
    assert.strictEqual(r.ok, true);
    assert.ok(r.report.estimatedTotal <= SAFE_TOTAL_BUDGET_TOKENS);
    // Full 320-doc pool compacts the same way — budget independent of size:
    const c = require('../lib/llm/contextBudget').compactMemories(mems, 'encapsulation oop', 700);
    assert.ok(c.chars <= 700 * 4 && c.kept < 320 && c.dropped > 0, 'excess ranked out');
  });

  await check('user message never removed under pressure', () => {
    const r = heavyAssembly();
    assert.ok(r.messages[0].content.startsWith('Explain encapsulation in OOP in simple terms.'));
  });

  await check('J. gigantic input refuses without provider call', () => {
    const r = assembleBudgetedRequest({
      systemTemplate: 'SYS. __LONG_TERM_MEMORY_SLOT____RETRIEVAL_CONTEXT_SLOT__ END.',
      baseUserText: 'Q. ' + 'w'.repeat(40000),
      docText: '',
      memoryDocs: [],
      factDocs: [],
      ragItems: [],
      selectedTools: [],
      outputBudget: OUTPUT_BUDGET_DEFAULT,
      query: 'Q'
    });
    assert.strictEqual(r.ok, false, 'minimal profile still overflows');
  });

  await check('estimator sanity', () => {
    assert.strictEqual(estTokensForChars(400), 100);
    assert.strictEqual(estMessagesTokens([{ content: 'x'.repeat(400) }]), 100 + 8);
  });
}

run().then(() => {
  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  process.exit(process.exitCode || 0);
}).catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
