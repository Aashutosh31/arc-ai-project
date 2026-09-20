// Voice Runtime 2.0 — persisted voice settings (no credentials).
//
// Preserves existing voice behavior; adds only:
//   voice provider, voice name, speaking speed, streaming enable, fallback.

const STORAGE_KEY = 'arc.voice.settings.v2';

const DEFAULTS = Object.freeze({
  provider: 'server', // 'server' | 'browser'
  voice: 'Kore',
  rate: 1.0,
  streamingEnabled: true,
  fallbackEnabled: true,
});

export const getVoiceSettings = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      provider: typeof parsed.provider === 'string' ? parsed.provider : DEFAULTS.provider,
      voice: typeof parsed.voice === 'string' ? parsed.voice : DEFAULTS.voice,
      rate: Number.isFinite(Number(parsed.rate)) ? Math.min(2, Math.max(0.5, Number(parsed.rate))) : DEFAULTS.rate,
      streamingEnabled: parsed.streamingEnabled !== false,
      fallbackEnabled: parsed.fallbackEnabled !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
};

export const saveVoiceSettings = (patch) => {
  const next = { ...getVoiceSettings(), ...(patch || {}) };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // persistence is best-effort
  }
  return next;
};

export const VOICE_SETTINGS_DEFAULTS = DEFAULTS;
