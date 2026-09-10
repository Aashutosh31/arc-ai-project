/**
 * Client-side theme catalog helpers.
 *
 * Values (tokens) live in CSS: daisyUI custom themes + the ARC bridge in
 * styles/arc.css. This module is metadata only (ids, names, previews) —
 * the single source is shared/themes.json, also consumed by the server
 * changeTheme tool. No token values here, no competing engine.
 */
import catalog from '../../../shared/themes.json';

export const DEFAULT_THEME_ID = catalog.defaultId;

const BY_ID = new Map(catalog.themes.map((t) => [t.id, t]));

export const isKnownTheme = (id) => BY_ID.has(id);

export const themeIds = () => catalog.themes.map((t) => t.id);

export const listThemes = () =>
  catalog.themes.map((t) => ({
    id: t.id,
    name: t.name,
    category: t.category,
    description: t.description,
    colorScheme: t.colorScheme,
    preview: [...t.preview],
  }));

export const getThemeMeta = (id) => BY_ID.get(id) || BY_ID.get(DEFAULT_THEME_ID);
