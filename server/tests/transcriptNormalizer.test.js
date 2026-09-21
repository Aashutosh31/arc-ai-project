/* Voice Runtime 4.0 — transcript normalizer unit tests.
 * Run with: node tests/transcriptNormalizer.test.js
 */
const assert = require('node:assert');
const n = require('../services/transcriptNormalizer');

let failures = 0;
const results = [];

async function check(label, fn) {
  try {
    await fn();
    results.push(`  PASS  ${label}`);
  } catch (err) {
    failures += 1;
    results.push(`  FAIL  ${label}\n        ${err.message}`);
  }
}

console.log('Transcript Normalizer Tests');
console.log('===========================');

const main = async () => {
  // ---- Context building ----
  await check('buildVoiceContext is bounded and deterministic', () => {
    const ctx = n.buildVoiceContext({ tools: ['sendEmail', 'setReminder', 'deepResearchSwarm'], maxTerms: 40 });
    assert.ok(Array.isArray(ctx.terms) && ctx.terms.length <= 40);
    assert.ok(Array.isArray(ctx.hints) && ctx.hints.length <= 40);
    assert.ok(ctx.terms.includes('sendEmail'));
    assert.ok(ctx.terms.includes('deepResearchSwarm'));
    const again = n.buildVoiceContext({ tools: ['sendEmail', 'setReminder', 'deepResearchSwarm'], maxTerms: 40 });
    assert.deepStrictEqual(ctx.terms, again.terms);
  });

  await check('context includes workspace + conversation entities when provided', () => {
    const ctx = n.buildVoiceContext({
      workspace: { name: 'ArcVoice', description: 'Voice runtime experimentation workspace' },
      conversation: [{ role: 'user', content: 'Check the GeminiStreaming pull request details please' }],
      tools: [],
      maxTerms: 120,
    });
    assert.ok(ctx.terms.includes('ArcVoice'));
    const joined = ctx.terms.join(' ').toLowerCase();
    assert.ok(joined.includes('gemini') || joined.includes('streaming'), 'conversation entity should surface');
    assert.ok(joined.includes('workspace'));
  });

  // ---- Correction: aliases ----
  await check('canonicalizes spoken aliases with full confidence', () => {
    const ctx = n.buildVoiceContext({ tools: [] });
    const res = n.normalizeTranscript('create a pull requist', ctx);
    assert.strictEqual(res.text, 'create a pull request');
    assert.ok(res.corrections.some((c) => c.to === 'request' && c.from === 'requist'));
  });

  await check('corrects near-miss vocab typos and reports heuristic confidence', () => {
    const ctx = n.buildVoiceContext({ tools: [] });
    const res = n.normalizeTranscript('delete the repozotory', ctx);
    assert.strictEqual(res.text, 'delete the repository');
    const corr = res.corrections.find((c) => c.from === 'repozotory');
    assert.ok(corr && corr.confidence >= 0.5 && corr.confidence < 1);
  });

  await check('joins two-word phrases (whats app / arc ai)', () => {
    const ctx = n.buildVoiceContext({ tools: [] });
    assert.strictEqual(n.normalizeTranscript('send a whats app message', ctx).text, 'send a WhatsApp message');
    assert.strictEqual(n.normalizeTranscript('open arc ai', ctx).text, 'open ARC AI');
  });

  await check('leaves benign transcripts untouched', () => {
    const ctx = n.buildVoiceContext({ tools: [] });
    const res = n.normalizeTranscript('what is the weather today', ctx);
    assert.strictEqual(res.text, 'what is the weather today');
    assert.strictEqual(res.corrections.length, 0);
    assert.strictEqual(res.needsClarification, false);
    assert.strictEqual(res.destructive, null);
  });

  // ---- Destructive commands ----
  await check('destructive commands always require confirmation', () => {
    const ctx = n.buildVoiceContext({ tools: [] });
    for (const cmd of ['delete the repository', 'clear my conversation', 'shut down the server', 'cancel my reminder']) {
      const res = n.normalizeTranscript(cmd, ctx);
      assert.strictEqual(res.needsClarification, true, `expected clarification for: ${cmd}`);
      assert.ok(res.destructive, `expected destructive marker for: ${cmd}`);
    }
  });

  await check('non-destructive utility verbs are not misinterpreted', () => {
    const ctx = n.buildVoiceContext({ tools: [] });
    const res = n.normalizeTranscript('set a reminder for tomorrow', ctx);
    assert.strictEqual(res.destructive, null);
    assert.strictEqual(res.needsClarification, false);
  });

  // ---- Safety: no false destructive on prepositions ----
  await check('"clear" without a resource target still gates (unknown target)', () => {
    const ctx = n.buildVoiceContext({ tools: [] });
    const res = n.normalizeTranscript('clear', ctx);
    assert.strictEqual(res.needsClarification, true);
    assert.strictEqual(res.destructive.verb, 'clear');
    assert.strictEqual(res.destructive.target, null);
  });

  console.log('');
  for (const line of results) console.log(line);
  console.log('');
  if (failures > 0) {
    console.error(`${failures} Transcript Normalizer test(s) FAILED.`);
    process.exit(1);
  }
  console.log(`All Transcript Normalizer tests completed (${results.length} passed).\n`);
};

main().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});