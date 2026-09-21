/* Sarvam language mapping unit tests — run with: node tests/sarvamLanguage.test.js
 *
 * Pure, deterministic: no env, no IO, no keys. Verifies the Bulbul TTS
 * language allowlist, the STT "auto" sentinel, region normalization, the
 * Odia or-IN→od-IN reconciliation, and the en-IN fallback invariant.
 */

const assert = require('assert');
const {
  SARVAM_TTS_LANGUAGES,
  SARVAM_TTS_LANGUAGE_SET,
  TTS_FALLBACK,
  STT_AUTO,
  sarvamLanguageBase,
  sarvamTtsLanguageCode,
  sarvamSttLanguageCode,
  isSarvamTtsLanguage,
} = require('../services/sarvamLanguage');

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (err) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('Sarvam Language Tests');
console.log('=====================');

console.log('\n1. Allowlist');
check('Bulbul supports exactly the documented 11 languages', () => {
  assert.deepStrictEqual(
    [...SARVAM_TTS_LANGUAGES].sort(),
    ['bn-IN', 'en-IN', 'gu-IN', 'hi-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'od-IN', 'pa-IN', 'ta-IN', 'te-IN'].sort()
  );
});
check('allowlist set mirrors the array', () => {
  for (const code of SARVAM_TTS_LANGUAGES) assert.ok(SARVAM_TTS_LANGUAGE_SET.has(code));
});

console.log('\n2. Base extraction');
check('splits BCP-47 to a base language', () => {
  assert.strictEqual(sarvamLanguageBase('hi-IN'), 'hi');
  assert.strictEqual(sarvamLanguageBase('EN-us'), 'en');
  assert.strictEqual(sarvamLanguageBase('mr-IN'), 'mr');
});
check('auto and empty collapse to unknown base', () => {
  assert.strictEqual(sarvamLanguageBase('auto'), '');
  assert.strictEqual(sarvamLanguageBase(''), '');
  assert.strictEqual(sarvamLanguageBase(null), '');
  assert.strictEqual(sarvamLanguageBase(undefined), '');
  assert.strictEqual(sarvamLanguageBase(7), '');
});

console.log('\n3. TTS resolution');
check('supported IN codes resolve to themselves', () => {
  for (const code of SARVAM_TTS_LANGUAGES) assert.strictEqual(sarvamTtsLanguageCode(code), code);
});
check('region-less codes resolve to the Indian dialect', () => {
  assert.strictEqual(sarvamTtsLanguageCode('hi'), 'hi-IN');
  assert.strictEqual(sarvamTtsLanguageCode('mr'), 'mr-IN');
  assert.strictEqual(sarvamTtsLanguageCode('ta'), 'ta-IN');
});
check('realtime Odia (or-IN / or) reconciles to Bulbul od-IN', () => {
  assert.strictEqual(sarvamTtsLanguageCode('or-IN'), 'od-IN');
  assert.strictEqual(sarvamTtsLanguageCode('or'), 'od-IN');
  assert.strictEqual(sarvamTtsLanguageCode('od-IN'), 'od-IN');
  assert.ok(isSarvamTtsLanguage('or-IN'));
  assert.ok(isSarvamTtsLanguage('od-IN'));
});
check('unsupported languages fall back to en-IN deterministically', () => {
  const unsupported = ['fr-FR', 'de-DE', 'ne-NP', 'ur-PK', 'es-419', 'auto', null, '', undefined, 0, 'zh-CN'];
  for (const code of unsupported) {
    const resolved = sarvamTtsLanguageCode(code);
    assert.strictEqual(resolved, TTS_FALLBACK, `expected en-IN for ${String(code)}`);
    assert.strictEqual(TTS_FALLBACK, 'en-IN');
  }
});
check('en-US is spoken in en-IN, never a rejected code', () => {
  assert.strictEqual(sarvamTtsLanguageCode('en-US'), 'en-IN');
  assert.ok(isSarvamTtsLanguage('en-US'));
});

console.log('\n4. STT query language');
check('auto sentinel passes through', () => {
  assert.strictEqual(sarvamSttLanguageCode('auto'), 'auto');
  assert.strictEqual(sarvamSttLanguageCode(''), 'auto');
  assert.strictEqual(sarvamSttLanguageCode(undefined), 'auto');
  assert.strictEqual(sarvamSttLanguageCode(null), 'auto');
});
check('valid BCP-47 passes through unchanged', () => {
  assert.strictEqual(sarvamSttLanguageCode('hi-IN'), 'hi-IN');
  assert.strictEqual(sarvamSttLanguageCode('en-US'), 'en-US');
  assert.strictEqual(sarvamSttLanguageCode('ta'), 'ta');
});
check('malformed language collapses to auto (never sent upstream as garbage)', () => {
  assert.strictEqual(sarvamSttLanguageCode('b@d_code'), 'auto');
  assert.strictEqual(sarvamSttLanguageCode('hellö'), 'auto');
});

console.log('\nAll Sarvam language tests completed.');