/**
 * Single source of truth for the ARC-AI visual theme.
 *
 * Themes are implemented as CSS custom-property overrides in App.jsx
 * (`:root` = default, `[data-theme="hacker"]`, `[data-theme="alert"]`).
 * Every writer — Settings UI, AI changeTheme client action, future
 * controls — must go through applyTheme() so state, DOM, persistence,
 * and open UI stay consistent.
 */

export const THEMES = Object.freeze([
  { id: 'default', label: 'ARC (cyan / purple)', hint: 'Default futuristic theme' },
  { id: 'hacker', label: 'Hacker (green)', hint: 'Monochrome terminal green' },
  { id: 'alert', label: 'Alert (red)', hint: 'High-contrast red theme' },
]);

const STORAGE_KEY = 'arc-theme';
export const THEME_CHANGE_EVENT = 'arc:theme-change';

export const isValidTheme = (id) => THEMES.some((t) => t.id === id);

export const getStoredTheme = () => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isValidTheme(stored)) return stored;
  } catch {
    // storage unavailable (private mode) — fall through to default
  }
  return 'default';
};

/**
 * Apply a theme immediately: DOM attribute + persistence + notification.
 * Unknown ids are ignored so a bad AI/tool value can never break the UI.
 * Returns the effective theme id.
 */
export const applyTheme = (id) => {
  const next = isValidTheme(id) ? id : 'default';
  try {
    if (next === 'default') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', next);
  } catch {
    // DOM unavailable — persistence below still records intent
  }
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore persistence failures
  }
  try {
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: next }));
  } catch {
    // ignore dispatch failures
  }
  return next;
};
