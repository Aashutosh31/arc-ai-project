// Sarvam language support (deterministic, provider-side).
//
// STT (saaras:v3-realtime / saaras:v4) accepts any BCP-47 language code as the
// `language_code` query parameter, plus the sentinel "auto" for automatic
// detection. Detected languages are reported per transcript as BCP-47 (e.g.
// "hi-IN"); the realtime endpoint reports Odia as "or-IN".
//
// TTS (bulbul:v3) supports exactly 11 language codes:
//   bn-IN en-IN gu-IN hi-IN kn-IN ml-IN mr-IN od-IN pa-IN ta-IN te-IN
// Any other language_code is rejected. So a deterministic mapping decides the
// spoken response language: same IN-dialect code when supported, otherwise a
// language-unique fallback to English (Indian) — never a rejected code.
//
// This module is pure (no env, no IO) so the mapping is unit-testable and can
// never depend on provider/request state.
const SARVAM_TTS_LANGUAGES = Object.freeze([
  'bn-IN',
  'en-IN',
  'gu-IN',
  'hi-IN',
  'kn-IN',
  'ml-IN',
  'mr-IN',
  'od-IN',
  'pa-IN',
  'ta-IN',
  'te-IN',
]);

const SARVAM_TTS_LANGUAGE_SET = new Set(SARVAM_TTS_LANGUAGES);

// base-language (lower-cased, region stripped) -> Bulbul language_code.
// Odia is special: the realtime STT surface reports "or-IN" while the Bulbul
// TTS surface spells it "od-IN"; the mapping below treats them as one.
const BASE_TO_TTS = Object.freeze({
  en: 'en-IN',
  hi: 'hi-IN',
  bn: 'bn-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  gu: 'gu-IN',
  kn: 'kn-IN',
  ml: 'ml-IN',
  mr: 'mr-IN',
  pa: 'pa-IN',
  od: 'od-IN',
  or: 'od-IN',
});

const TTS_FALLBACK = 'en-IN';
const STT_AUTO = 'auto';

// "hi-IN" | "hi" | "hi" + junk -> "hi". Null/empty -> "". Anything that is
// not BCP-47-ish is treated as unknown (fallback path).
const sarvamLanguageBase = (code) => {
  if (typeof code !== 'string') return '';
  const trimmed = code.trim();
  if (!trimmed || trimmed.toLowerCase() === STT_AUTO) return '';
  return trimmed.split('-')[0].toLowerCase();
};

// Resolve a detected/configured language code to a Bulbul-supported code.
// Deterministic fallback: unknown or unsupported -> TTS_FALLBACK.
const sarvamTtsLanguageCode = (code) => {
  const base = sarvamLanguageBase(code);
  if (!base) return TTS_FALLBACK;
  return BASE_TO_TTS[base] || TTS_FALLBACK;
};

// Validate a `language_code` for the STT query surface. "auto" and any
// plausible BCP-47 code pass through; garbage collapses to "auto" so a
// malformed env value can never be sent upstream.
const sarvamSttLanguageCode = (code) => {
  if (typeof code !== 'string') return STT_AUTO;
  const trimmed = code.trim();
  if (!trimmed || /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/.test(trimmed)) {
    return trimmed || STT_AUTO;
  }
  return STT_AUTO;
};

const isSarvamTtsLanguage = (code) => {
  const base = sarvamLanguageBase(code);
  return Boolean(base && BASE_TO_TTS[base]);
};

module.exports = {
  SARVAM_TTS_LANGUAGES,
  SARVAM_TTS_LANGUAGE_SET,
  TTS_FALLBACK,
  STT_AUTO,
  sarvamLanguageBase,
  sarvamTtsLanguageCode,
  sarvamSttLanguageCode,
  isSarvamTtsLanguage,
};