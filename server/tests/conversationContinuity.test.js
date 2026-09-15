/* Conversation-context continuity tests — run with: node tests/conversationContinuity.test.js
 *
 * Regression guard for the core ARC agent context bug: every processQuery
 * turn used to send ONLY the current user turn to the provider
 * (assembleBudgetedRequest built messages=[{current}]), so follow-ups like
 * "play its slowed version", "make it slower", "summarize the second
 * result", "update that page" had nothing to resolve against.
 *
 * Contract under test (no DB, no provider calls):
 *  - provider messages = bounded recent window (verbatim, chronological) +
 *    current user turn (always last, never truncated)
 *  - working/agent state (active media/search/resource/task/pending) rides
 *    in the system prompt as compact refs, never giant outputs verbatim
 *  - priority: recent turns + working state OUTRANK memory/RAG — heavy
 *    memory can never crowd out the turns that give "it" meaning
 *  - display history (100+ messages) stays separate from provider context
 *    (<= MAX_RECENT_TURNS); older dropped turns collapse into a short
 *    summary, never a substitute for recent turns
 *  - tool selection sees prior-turn background so "make it slower" still
 *    surfaces playMedia
 *  - total stays within SAFE_TOTAL_BUDGET_TOKENS (Groq safety preserved)
 *
 * Plain node. Uses the REAL contextBudget + toolSelection + tool registry.
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

console.log('Conversation Continuity Tests');
console.log('=============================');

const {
  SAFE_TOTAL_BUDGET_TOKENS,
  OUTPUT_BUDGET_DEFAULT,
  HISTORY_BUDGET_TOKENS,
  WORKING_STATE_BUDGET_TOKENS,
  MAX_RECENT_TURNS,
  PER_TURN_CHAR_CAP,
  compactRecentTurns,
  compactWorkingState,
  buildConversationSummary,
  assembleBudgetedRequest
} = require('../lib/llm/contextBudget');

const { selectToolSchemas } = require('../lib/llm/toolSelection');
const { getSchemas } = require('../tools/index');
const ALL_SCHEMAS = getSchemas();
const toolNames = (list) => list.map((s) => s.function.name);
const SYS = 'SYS. __LONG_TERM_MEMORY_SLOT____RETRIEVAL_CONTEXT_SLOT__ END.';

const assemble = (overrides = {}) => assembleBudgetedRequest({
  systemTemplate: SYS,
  baseUserText: 'follow-up',
  docText: '',
  memoryDocs: [],
  factDocs: [],
  ragItems: [],
  selectedTools: [],
  outputBudget: OUTPUT_BUDGET_DEFAULT,
  query: 'follow-up',
  ...overrides
});

async function run() {
  await check('1. Play XYZ -> "play its slowed version" keeps Turn 1 context', () => {
    const r = assemble({
      baseUserText: 'Play its slowed version.',
      query: 'Play its slowed version.',
      recentTurns: [
        { role: 'user', content: 'Play Blinding Lights by The Weeknd.' },
        { role: 'assistant', content: 'Found "Blinding Lights" — sending it to your media player now.' }
      ]
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.messages.length, 3, `window(2) + current, got ${r.messages.length}`);
    assert.ok(r.messages[0].content.includes('Blinding Lights'), 'Turn 1 user request present');
    assert.ok(r.messages[1].content.includes('Blinding Lights'), 'Turn 1 tool result present');
    assert.strictEqual(r.messages[2].content, 'Play its slowed version.', 'current turn last + verbatim');
    assert.ok(r.report.estimatedTotal <= SAFE_TOTAL_BUDGET_TOKENS);
  });

  await check('2. Search X -> "summarize the second result" keeps result refs', () => {
    const r = assemble({
      baseUserText: 'Summarize the second result.',
      query: 'Summarize the second result.',
      recentTurns: [
        { role: 'user', content: 'Search for the latest React release.' },
        { role: 'assistant', content: 'Top results: 1. React 19.2 overview (react.dev) 2. React 19.2 release notes (github.com) 3. Upgrade guide.' }
      ],
      workingState: { activeSearch: { tool: 'webSearch', query: 'latest React release', results: ['React 19.2 overview', 'React 19.2 release notes', 'Upgrade guide'] } }
    });
    assert.strictEqual(r.ok, true);
    const joined = r.messages.map((m) => m.content).join('\n');
    assert.ok(joined.includes('second result') && joined.includes('React 19.2 release notes'), 'reference resolvable');
    assert.ok(r.systemPrompt.includes('WORKING STATE') && r.systemPrompt.includes('React 19.2'), 'working state injected');
  });

  await check('3. Create page X -> "update that page" keeps page identity', () => {
    const r = assemble({
      baseUserText: 'Add a section to that page.',
      query: 'Add a section to that page.',
      recentTurns: [
        { role: 'user', content: 'Create a test page called Launch Notes.' },
        { role: 'assistant', content: 'Created page "Launch Notes" (id pg_123).' }
      ],
      workingState: { activeResource: { tool: 'mcp_notion_create-pages', ref: 'Launch Notes pg_123' } }
    });
    assert.strictEqual(r.ok, true);
    assert.ok(r.messages.map((m) => m.content).join('\n').includes('pg_123'), 'page id survives');
    assert.ok(r.systemPrompt.includes('pg_123'));
  });

  await check('4. Weather Mumbai -> "Will I need an umbrella?" keeps location', () => {
    const r = assemble({
      baseUserText: 'Will I need an umbrella?',
      query: 'Will I need an umbrella?',
      recentTurns: [
        { role: 'user', content: "What's the weather in Mumbai?" },
        { role: 'assistant', content: 'Mumbai: 29°C, heavy rain expected this evening.' }
      ]
    });
    assert.strictEqual(r.ok, true);
    assert.ok(r.messages.map((m) => m.content).join('\n').includes('Mumbai'));
  });

  await check('5. Find docs -> "open the second one" keeps result set', () => {
    const r = assemble({
      baseUserText: 'Open the second one.',
      query: 'Open the second one.',
      recentTurns: [
        { role: 'user', content: 'Find my project documents.' },
        { role: 'assistant', content: 'Found 3: 1. roadmap.md 2. architecture.md 3. budget.xlsx' }
      ]
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.messages[r.messages.length - 1].content, 'Open the second one.');
    assert.ok(r.messages.map((m) => m.content).join('\n').includes('architecture.md'));
  });

  await check('6. tool selection: "make it slower" alone misses media, with prior play context hits', () => {
    const AIService = require('../services/AIService');
    const alone = selectToolSchemas('Make it slower.', () => ALL_SCHEMAS);
    assert.ok(!toolNames(alone.tools).includes('playMedia'), 'isolated follow-up has no media signal');
    const withCtx = selectToolSchemas(
      AIService.buildToolSelectionQuery('Make it slower.', [
        { role: 'user', content: 'Play Blinding Lights.' },
        { role: 'assistant', content: 'Playing Blinding Lights now.' }
      ]),
      () => ALL_SCHEMAS
    );
    assert.ok(toolNames(withCtx.tools).includes('playMedia'), `context-aware pick has playMedia: ${toolNames(withCtx.tools)}`);
  });

  await check('7. "do it again" resurfaces prior capability via background', () => {
    const AIService = require('../services/AIService');
    const q = AIService.buildToolSelectionQuery('Do it again.', [
      { role: 'user', content: 'Search the web for quantum error correction.' }
    ]);
    const pick = selectToolSchemas(q, () => ALL_SCHEMAS);
    assert.ok(toolNames(pick.tools).includes('webSearch'), `prior web intent resurfaced: ${toolNames(pick.tools)}`);
  });

  await check('8. heavy memory NEVER crowds out recent turns', () => {
    const bigMem = (i) => ({
      query: `unrelated saved note ${i} ` + 'q'.repeat(200),
      response: `unrelated answer ${i} ` + 'r'.repeat(400),
      pinned: false,
      timestamp: new Date(Date.now() - i * 60000)
    });
    const recentTurns = [
      { role: 'user', content: 'Play Blinding Lights by The Weeknd.' },
      { role: 'assistant', content: 'Playing Blinding Lights now.' }
    ];
    const r = assemble({
      baseUserText: 'Play its slowed version.',
      query: 'Play its slowed version.',
      memoryDocs: Array.from({ length: 20 }, (_, i) => bigMem(i)),
      factDocs: Array.from({ length: 20 }, (_, i) => ({ fact: `unrelated fact ${i} ` + 'f'.repeat(150), createdAt: new Date() })),
      ragItems: Array.from({ length: 10 }, (_, i) => ({ type: 'memory', source: 'vector', score: 0.9, snippet: `chunk ${i} ` + 'z'.repeat(300) })),
      recentTurns
    });
    assert.strictEqual(r.ok, true);
    assert.ok(r.report.estimatedTotal <= SAFE_TOTAL_BUDGET_TOKENS, `total ${r.report.estimatedTotal} in budget`);
    assert.strictEqual(r.report.historyKept, 2, 'both recent turns survive heavy memory');
    assert.ok(r.report.memoryChars <= 700 * 4, 'memory held to its own cap, history sized independently');
    // Under forced total pressure, memory/RAG compact BEFORE history shrinks.
    const pressured = assemble({
      baseUserText: 'Play its slowed version.',
      query: 'Play its slowed version.',
      docText: `\n\nDOC\n` + 'd'.repeat(26000),
      selectedTools: ALL_SCHEMAS,
      memoryDocs: Array.from({ length: 20 }, (_, i) => bigMem(i)),
      factDocs: Array.from({ length: 20 }, (_, i) => ({ fact: `unrelated fact ${i} ` + 'f'.repeat(150), createdAt: new Date() })),
      ragItems: Array.from({ length: 10 }, (_, i) => ({ type: 'memory', source: 'vector', score: 0.9, snippet: `chunk ${i} ` + 'z'.repeat(300) })),
      recentTurns
    });
    assert.strictEqual(pressured.ok, true);
    const passes = pressured.report.compactionPasses;
    const firstHistoryPass = passes.findIndex((p) => p.startsWith('history-'));
    const firstMemoryPass = passes.findIndex((p) => p.startsWith('memory-') || p.startsWith('rag-'));
    assert.ok(firstMemoryPass !== -1 && (firstHistoryPass === -1 || firstMemoryPass < firstHistoryPass),
      `memory/RAG compact before history: ${passes}`);
    assert.ok(pressured.report.historyKept >= 1 || passes.includes('history-drop'),
      'history shrinks only after memory/RAG are gone');
  });

  await check('9. display vs provider: 100 stored messages -> provider window bounded', () => {
    const stored = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i} ` + 'w'.repeat(100)
    }));
    const c = compactRecentTurns(stored, HISTORY_BUDGET_TOKENS, PER_TURN_CHAR_CAP);
    assert.ok(c.turns.length <= MAX_RECENT_TURNS, `window bounded: ${c.turns.length} <= ${MAX_RECENT_TURNS}`);
    assert.ok(c.dropped > 0, 'older turns fall out of the window');
    const r = assemble({ baseUserText: 'And save that in my notes.', query: 'save', recentTurns: stored });
    assert.ok(r.messages.length <= MAX_RECENT_TURNS + 1, `provider messages bounded: ${r.messages.length}`);
    assert.strictEqual(r.messages[r.messages.length - 1].content, 'And save that in my notes.');
  });

  await check('10. working state compacts giant outputs, never verbatim', () => {
    const giant = 'x'.repeat(20000);
    const c = compactWorkingState({
      activeMedia: { title: giant },
      activeSearch: { query: 'react', results: [giant, giant, giant] }
    }, WORKING_STATE_BUDGET_TOKENS);
    assert.ok(c.chars <= WORKING_STATE_BUDGET_TOKENS * 4, `within budget: ${c.chars}`);
    assert.ok(!c.text.includes(giant.slice(0, 5000)), 'giant output truncated to refs');
  });

  await check('11. dropped older turns collapse into a summary, recent stays verbatim', () => {
    const stored = Array.from({ length: 30 }, (_, i) => ({
      role: 'user',
      content: `earlier request number ${i} about topic-${i}`
    }));
    const r = assemble({ baseUserText: 'Continue.', query: 'continue', recentTurns: stored });
    assert.strictEqual(r.ok, true);
    assert.ok(r.report.historyDropped > 0, 'oldest turns dropped from window');
    assert.ok(r.systemPrompt.includes('OLDER CONVERSATION SUMMARY'), 'summary injected as background');
    assert.ok(!r.systemPrompt.includes('topic-29') || r.messages.map((m) => m.content).join(' ').includes('topic-29'),
      'newest topics stay in verbatim turns, not only summary');
  });

  await check('12. per-turn cap: one giant turn cannot evict the window', () => {
    const r = assemble({
      baseUserText: 'Use the second one.',
      query: 'Use the second one.',
      recentTurns: [
        { role: 'user', content: 'Giant paste: ' + 'g'.repeat(20000) },
        { role: 'user', content: 'Search for the latest React release.' },
        { role: 'assistant', content: 'Results: 1. overview 2. release notes 3. guide.' }
      ]
    });
    assert.strictEqual(r.ok, true);
    const joined = r.messages.map((m) => m.content).join('\n');
    assert.ok(joined.includes('release notes'), 'small referenced turn survives the giant one');
    assert.ok(!joined.includes('g'.repeat(5000)), 'giant turn capped');
  });

  await check('13. full matrix turn fits Groq budget incl. working state + summary', () => {
    const r = assemble({
      baseUserText: 'And save that in my Notion notes.',
      query: 'And save that in my Notion notes.',
      recentTurns: [
        { role: 'user', content: 'Play Blinding Lights.' },
        { role: 'assistant', content: 'Playing Blinding Lights (vid_abc123) now.' },
        { role: 'user', content: 'Make it slower.' },
        { role: 'assistant', content: 'Slowed version queued (vid_def456).' },
        { role: 'user', content: 'Actually use the acoustic version.' },
        { role: 'assistant', content: 'Acoustic version playing (vid_ghi789).' }
      ],
      workingState: {
        activeMedia: { title: 'Blinding Lights (acoustic)', id: 'vid_ghi789' },
        activeTask: { goal: 'curate slowed/acoustic versions', stage: 'playing acoustic' }
      },
      conversationSummary: 'Earlier: user asked for Blinding Lights playback.'
    });
    assert.strictEqual(r.ok, true);
    assert.ok(r.report.estimatedTotal <= SAFE_TOTAL_BUDGET_TOKENS, `total ${r.report.estimatedTotal} <= ${SAFE_TOTAL_BUDGET_TOKENS}`);
    assert.strictEqual(r.messages[r.messages.length - 1].content, 'And save that in my Notion notes.');
    assert.ok(r.report.historyKept >= 6, `full recent window kept: ${r.report.historyKept}`);
  });

  await check('14. current turn is never truncated, even under extreme pressure', () => {
    const current = 'Please analyze this exact token: ZZZ-42. ' + 'u'.repeat(500);
    const r = assemble({
      baseUserText: current,
      query: current,
      memoryDocs: Array.from({ length: 20 }, (_, i) => ({ query: `q${i} ` + 'q'.repeat(300), response: `r${i} ` + 'r'.repeat(500), timestamp: new Date() })),
      recentTurns: Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `prior ${i} ` + 'p'.repeat(800) }))
    });
    assert.strictEqual(r.messages[r.messages.length - 1].content, current, 'current turn verbatim');
  });
}

run().then(() => {
  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  process.exit(process.exitCode || 0);
}).catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
