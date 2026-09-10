/**
 * Single source of truth for ARC-AI theme selection (public contract).
 *
 * Values live in styles/arc.css (daisyUI custom themes + ARC bridge).
 * This module only switches the active theme marker, persists it, and
 * notifies listeners. The catalog (ids/names/previews) lives in
 * shared/themes.json via ./themes.js — never duplicated here.
 */
import {
  DEFAULT_THEME_ID,
  isKnownTheme,
  listThemes,
  themeIds,
} from '../theme/themes.js';

export const STORAGE_KEY = 'arc-theme';
export const THEME_CHANGE_EVENT = 'arc:theme-change';
export { DEFAULT_THEME_ID, isKnownTheme, listThemes, themeIds };

/** Back-compat alias: [{ id, label, hint }]. Prefer listThemes() for pickers. */
export const THEMES = Object.freeze(
  listThemes().map((t) => ({ id: t.id, label: t.name, hint: t.description })),
);

/** Back-compat alias for isKnownTheme. Unknown ids fall back to default. */
export const isValidTheme = (id) => isKnownTheme(id);

export const getStoredTheme = () => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isKnownTheme(stored)) return stored;
  } catch {
    // storage unavailable (private mode) — fall through to default
  }
  return DEFAULT_THEME_ID;
};

/**
 * Apply a theme via the daisyUI data-theme marker.
 * Unknown ids fall back to default so a bad AI/tool value can never
 * break the UI. Returns the effective theme id.
 */
export const applyTheme = (id) => {
  const next = isKnownTheme(id) ? id : DEFAULT_THEME_ID;
  try {
    if (next === DEFAULT_THEME_ID) document.documentElement.removeAttribute('data-theme');
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
