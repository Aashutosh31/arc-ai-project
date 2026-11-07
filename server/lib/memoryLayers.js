// JARVIS Phase 3 — persistent personal context.
// One canonical vocabulary for the six memory layers so models, retrieval,
// ranking, tools, and both clients agree on the same strings.
const MEMORY_LAYERS = ['profile', 'episodic', 'project', 'semantic', 'procedural', 'temporal'];

// Ranking prior, not a hard order: relevance and pins still win, but stable
// preferences (profile) and project context should survive a weak keyword
// match better than an old episodic turn.
const MEMORY_LAYER_PRIORITY = {
  profile: 24,
  project: 20,
  procedural: 16,
  semantic: 12,
  temporal: 8,
  episodic: 4,
};

const normalizeLayer = (value, fallback = 'episodic') => {
  const next = String(value || '').trim().toLowerCase();
  return MEMORY_LAYERS.includes(next) ? next : fallback;
};

// Lightweight, deterministic classification for writes that only carry free
// text/tags/category. Explicit callers can always pass a layer directly.
const inferLayerFromText = (text = '', fallback = 'semantic') => {
  const value = String(text || '').toLowerCase();
  if (!value.trim()) return fallback;
  if (/\b(profile|prefer|prefers|preference|identity|working style|tone|language)\b/.test(value)) return 'profile';
  if (/\b(project|architecture|decision|roadmap|objective|milestone|unresolved)\b/.test(value)) return 'project';
  if (/\b(procedure|workflow|step[- ]by[- ]step|how i|routine|process)\b/.test(value)) return 'procedural';
  if (/\b(deadline|due date|remind|schedule|appointment|commitment|tomorrow|next week)\b/.test(value)) return 'temporal';
  if (/\b(remember|fact|is my|my name|my email|i live|i work)\b/.test(value)) return 'semantic';
  return fallback;
};

const clamp01 = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
};

module.exports = {
  MEMORY_LAYERS,
  MEMORY_LAYER_PRIORITY,
  normalizeLayer,
  inferLayerFromText,
  clamp01,
};
