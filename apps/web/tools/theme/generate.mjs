// Generates the theme blocks for workspace.css and checks their contrast.
//
// A theme here is NOT a hue swap over hand-picked colours. The shipped world already
// encodes an architecture: a fixed luminance ladder where the canvas is the darkest
// surface, planned structure sits below materialized work, and the accent is the brightest
// thing on screen. Every dark theme reproduces that ladder EXACTLY in OKLCH — same
// lightness per token, to the digit — and varies only hue and chroma. The light theme is
// the one deliberate exception: it re-derives the ladder against a light ground, because
// "canvas is darkest" cannot survive there. What must survive is the rule underneath it —
// planned stays recessive, executed work stays dominant.

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToOklch(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), h: (Math.atan2(B, A) * 180) / Math.PI };
}

function oklchToHex({ L, C, h }) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b2 = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b2) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b2) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b2) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.round(Math.min(255, Math.max(0, linearToSrgb(v) * 255))));
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// The shipped world, in ladder order.
const BASE = {
  canvas: '#070908',
  rail: '#090c0a',
  bg: '#0b0e0d',
  'panel-sunken': '#0e1210',
  panel: '#121614',
  'panel-2': '#151b17',
  'node-fill': '#161b17',
  'raised-panel': '#1a1f1c',
  'surface-3': '#1d231d',
  'accent-soft': '#1e251e',
  hover: '#1f2720',
  'node-planned-fill': '#0e1210',
  'node-planned-line': '#232b24',
  line: '#242a25',
  'line-2': '#2b3425',
  'edge-idle': '#2f3630',
  'line-3': '#2f3b2c',
  'line-4': '#3c4b31',
  'line-5': '#4d5e44',
  'accent-line': '#5f7a54',
  'mark-dim': '#687660',
  'faint': '#6f7c6b',
  'edge-done': '#6f8a75',
  'mark-quiet': '#798576',
  'node-planned-text': '#78856f',
  mark: '#8e9b80',
  'accent-line-2': '#98ad7c',
  quiet: '#9aa69b',
  'mark-strong': '#afc294',
  secondary: '#b0b9b0',
  'accent-text-dim': '#b1c0a4',
  'accent-text': '#c0d2a9',
  'accent-text-2': '#d0ddbd',
  accent: '#d0dfb5',
  'text-2': '#dce4d8',
  'accent-bright': '#deedbf',
  text: '#e9eee7',
  'accent-ink': '#182116',
  scrim: '#040605',
};

const ACCENT_KEYS = new Set([
  'accent-soft', 'accent-line', 'accent-line-2', 'accent-text-dim', 'accent-text',
  'accent-text-2', 'accent', 'accent-bright', 'accent-ink', 'edge-done',
]);

const THEMES = [
  { id: 'slate', hue: 248, chroma: 0.8, accentHue: 252, accentChroma: 1.5 },
  { id: 'ember', hue: 52, chroma: 1.0, accentHue: 62, accentChroma: 1.45 },
  { id: 'mono', hue: 130, chroma: 0.1, accentHue: 130, accentChroma: 0.08 },
];

// True if the colour survives the round trip without any channel being clamped.
const inGamut = ({ L, C, h }) => {
  const hex = oklchToHex({ L, C, h });
  const back = hexToOklch(hex);
  return Math.abs(back.L - L) < 0.004;
};

/**
 * Re-hue at constant lightness, reducing chroma until the colour fits inside sRGB.
 *
 * Clamping RGB channels instead would silently shift lightness, which is exactly the
 * invariant the whole theme system rests on. Losing a little saturation is the acceptable
 * cost; losing a rung of the ladder is not.
 */
const rehue = (hex, theme, key) => {
  const { L, C } = hexToOklch(hex);
  const accent = ACCENT_KEYS.has(key);
  const h = accent ? theme.accentHue : theme.hue;
  let target = C * (accent ? theme.accentChroma : theme.chroma);
  while (target > 0.001 && !inGamut({ L, C: target, h })) target -= 0.002;
  return oklchToHex({ L, C: Math.max(0, target), h });
};

// Light theme: re-derived by hand against a light ground, then checked like the rest.
const DAYLIGHT = {
  canvas: '#eef1e7',
  rail: '#e9ede1',
  bg: '#f3f5ee',
  'panel-sunken': '#e6ebdd',
  panel: '#fafbf6',
  'panel-2': '#f0f3e9',
  'node-fill': '#ffffff',
  'raised-panel': '#ffffff',
  'surface-3': '#edf1e4',
  'accent-soft': '#e2ebd2',
  hover: '#e6ecd9',
  'node-planned-fill': '#eef1e8',
  'node-planned-line': '#d2dac6',
  line: '#d9e0cd',
  'line-2': '#cad4ba',
  'edge-idle': '#c6cfba',
  'line-3': '#bcc8a9',
  'line-4': '#a4b490',
  'line-5': '#8da077',
  'accent-line': '#7a9260',
  'mark-dim': '#88957c',
  faint: '#6f7c68',
  'edge-done': '#6f9079',
  'mark-quiet': '#77846f',
  'node-planned-text': '#76836c',
  mark: '#66745c',
  'accent-line-2': '#5e7b3a',
  quiet: '#55614f',
  'mark-strong': '#4a6634',
  secondary: '#454f41',
  'accent-text-dim': '#455733',
  'accent-text': '#3a4c25',
  'accent-text-2': '#31421c',
  accent: '#44652a',
  'text-2': '#272f26',
  'accent-bright': '#35521c',
  text: '#161c16',
  'accent-ink': '#ffffff',
  scrim: '#262c22',
};

const STATUS_DARK = {
  amber: '#e4bd79',
  'amber-text': '#e3cb97',
  'amber-line': '#b39a62',
  'amber-line-dim': '#46412a',
  'amber-soft': '#222119',
  'amber-soft-2': '#25231a',
  danger: '#f1a6a0',
  'danger-text': '#f2bbb3',
  'danger-line': '#b17873',
  'danger-soft': '#2c1d1c',
};
const STATUS_LIGHT = {
  amber: '#8a6212',
  'amber-text': '#6f4e08',
  'amber-line': '#b89547',
  'amber-line-dim': '#e0d3ab',
  'amber-soft': '#f6efdc',
  'amber-soft-2': '#f2ead2',
  danger: '#a3342c',
  'danger-text': '#872a23',
  'danger-line': '#c97b74',
  'danger-soft': '#f8e6e4',
};

// ---- contrast ------------------------------------------------------------------------
const relLum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [relLum(a), relLum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// The pairs that actually carry text or carry a state distinction.
const PAIRS = [
  ['text', 'bg', 4.5],
  ['text', 'panel', 4.5],
  ['text', 'node-fill', 4.5],
  ['text-2', 'panel', 4.5],
  ['secondary', 'panel', 4.5],
  ['secondary', 'rail', 4.5],
  ['quiet', 'panel', 4.5],
  ['quiet', 'rail', 4.5],
  ['faint', 'panel', 3],
  ['accent-text', 'panel', 4.5],
  ['accent-ink', 'accent', 4.5],
  ['node-planned-text', 'node-planned-fill', 3],
  ['accent', 'canvas', 3],
  ['edge-done', 'canvas', 3],
];

function build(id, tokens, status) {
  return { id, tokens: { ...tokens, ...status } };
}

const worlds = [
  build('sage', BASE, STATUS_DARK),
  ...THEMES.map((t) =>
    build(
      t.id,
      Object.fromEntries(Object.entries(BASE).map(([k, v]) => [k, rehue(v, t, k)])),
      STATUS_DARK,
    ),
  ),
  build('daylight', DAYLIGHT, STATUS_LIGHT),
];

let failures = 0;
for (const world of worlds) {
  const bad = [];
  for (const [fg, bg, min] of PAIRS) {
    const ratio = contrast(world.tokens[fg], world.tokens[bg]);
    if (ratio < min) bad.push(`${fg}/${bg} ${ratio.toFixed(2)} < ${min}`);
  }
  failures += bad.length;
  console.error(`${world.id.padEnd(9)} ${bad.length ? 'FAIL  ' + bad.join('; ') : 'ok'}`);
}

const ORDER = [...Object.keys(BASE), ...Object.keys(STATUS_DARK)];
const emit = (world, selector, extra = '') => {
  const lines = ORDER.map((k) => `  --${k}: ${world.tokens[k]};`);
  return `${selector} {\n${extra}${lines.join('\n')}\n}`;
};

const css = [
  emit(worlds[0], ":root,\n[data-theme='sage']", '  color-scheme: dark;\n'),
  ...worlds.slice(1, 4).map((w) => emit(w, `[data-theme='${w.id}']`, '  color-scheme: dark;\n')),
  emit(worlds[4], "[data-theme='daylight']", '  color-scheme: light;\n'),
].join('\n');

console.log(css);
console.error(failures ? `\n${failures} contrast failures` : '\nall contrast floors met');
