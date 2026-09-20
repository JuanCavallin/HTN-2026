/**
 * Theme worlds.
 *
 * Each dark world is the same luminance ladder as the default, re-hued in OKLCH: identical
 * lightness per token, only hue and chroma move. That is deliberate — it keeps the design's
 * architecture intact across themes (canvas darkest, planned below materialized, accent
 * brightest) instead of letting a hue swap quietly destroy it.
 *
 * `daylight` is the one re-derivation rather than a re-hue: on a light ground the canvas
 * cannot be the darkest surface, so it becomes the quietest one and executed work becomes
 * the most inked. Every world is contrast-checked against the pairs that carry text.
 *
 * The values live in `workspace.css` under `[data-theme='…']`. This module only owns which
 * one is active.
 */
export const THEMES = [
  {
    id: 'sage',
    label: 'Sage',
    note: 'The default. Warm green-grey, lit graph on a near-black canvas.',
    swatch: ['#070908', '#1f2720', '#d0dfb5'],
  },
  {
    id: 'slate',
    label: 'Slate',
    note: 'The same ladder shifted cool. Blue-violet accent.',
    swatch: ['#07080b', '#1e2430', '#bcc8ff'],
  },
  {
    id: 'ember',
    label: 'Ember',
    note: 'Warm ground, amber accent. Reads well under stage lighting.',
    swatch: ['#0a0805', '#292014', '#f2ce7c'],
  },
  {
    id: 'mono',
    label: 'Mono',
    note: 'Chroma pulled almost to zero. Nothing competes with the graph.',
    swatch: ['#080908', '#232522', '#dfe1de'],
  },
  {
    id: 'daylight',
    label: 'Daylight',
    note: 'Light ground, re-derived rather than inverted. For bright rooms.',
    swatch: ['#eef1e7', '#d9e0cd', '#44652a'],
  },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

export const DEFAULT_THEME: ThemeId = 'sage';
const STORAGE_KEY = 'zephyr.theme';

const isTheme = (value: unknown): value is ThemeId =>
  THEMES.some((theme) => theme.id === value);

/** Per-viewer convenience only. A blocked or cleared store simply means the default. */
export function readStoredTheme(): ThemeId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme: ThemeId) {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private windows and blocked site data are fine; the theme just will not persist.
  }
}
