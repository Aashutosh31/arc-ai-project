// Client execution-panel regression — run with: node tests/executionPanel.test.mjs
// Plain node, no runner. Guards the non-blocking presentation-only contract:
//   - collapsed by default (details opt-in, never an auto-open debug card)
//   - compact summary strip ("Using tools…" / "Completed · N tools")
//   - dismiss/close is local UI state only (never cancels execution)
//   - panel never drives execution (no ai:stream:stop, no cancel wiring)
//   - non-blocking semantics (aria-live polite, no focus steal, collapsible)
import assert from 'node:assert';
import { readFileSync as readFs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;

async function check(label, fn) {
  try { await fn(); pass += 1; console.log(`  PASS  ${label}`); }
  catch (err) { fail += 1; process.exitCode = 1; console.error(`  FAIL  ${label}\n        ${err.message}`); }
}

console.log('Client Execution Panel Regression Tests');
console.log('=======================================');

const panelSrc = readFs(join(__dir, '..', 'src', 'components', 'ExecutionPanel.jsx'), 'utf8');
const drawerSrc = readFs(join(__dir, '..', 'src', 'pages', 'DashboardPage.jsx'), 'utf8');

await check('collapsed by default (details opt-in)', () => {
  assert.ok(/useState\(false\)/.test(panelSrc), 'expanded state must default to false');
  assert.ok(!/useState\(true\)/.test(panelSrc) || /dismissedId/.test(panelSrc), 'nothing auto-expands');
});

await check('compact summary strip states', () => {
  assert.ok(panelSrc.includes('Using tools'), 'missing running summary');
  assert.ok(panelSrc.includes('Completed'), 'missing completed summary');
  assert.ok(/tool\$\{n === 1/.test(panelSrc) || panelSrc.includes('tool${n'), 'missing tool-count summary');
});

await check('close/dismiss does not cancel execution', () => {
  assert.ok(!panelSrc.includes('cancelActiveExecution'), 'panel must not wire cancel');
  assert.ok(!panelSrc.includes('ai:stream:stop'), 'panel must never emit stop');
  assert.ok(panelSrc.includes('dismissedId'), 'dismiss must be local UI state');
  assert.ok(/setDismissedId\(executionId\)/.test(panelSrc), 'dismiss records per-execution id');
  assert.ok(panelSrc.includes('neither touches execution'), 'contract comment missing');
});

await check('presentation-only (no execution control)', () => {
  for (const banned of ['TaskExecutor', 'socket.emit', 'interruptStream', 'execution.cancel', 'execution.stop']) {
    assert.ok(!panelSrc.includes(banned), `panel must not reference ${banned}`);
  }
});

await check('non-blocking semantics', () => {
  assert.ok(panelSrc.includes('aria-live="polite"'), 'status must be polite live region');
  assert.ok(!/autoFocus/.test(panelSrc), 'panel must never steal focus');
  assert.ok(panelSrc.includes('setIsExpanded'), 'must be collapsible');
});

await check('drawer never blocks chat when empty', () => {
  assert.ok(drawerSrc.includes('&:empty'), 'drawer must collapse when panel is dismissed');
});

await check('new execution un-dismisses (still collapsed)', () => {
  assert.ok(panelSrc.includes('setDismissedId((prev) => (prev === executionId ? prev : null))') ||
    panelSrc.includes('un-dismisses'), 'next execution must restore the strip');
});

console.log(`\n${pass + fail} tests, ${pass} passed, ${fail} failed`);
