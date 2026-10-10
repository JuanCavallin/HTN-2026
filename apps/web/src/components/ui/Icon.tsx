import type { SVGProps } from 'react';

const paths = {
  chat: 'M5 5h14v10H9l-4 4V5Z',
  graph: 'M5 12h5m0 0V5h5m-5 7v7h5M3 10h4v4H3zM15 3h5v4h-5zM15 17h5v4h-5z',
  clock: 'M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  send: 'M12 19V5m-6 6 6-6 6 6',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  pause: 'M8 5v14M16 5v14',
  play: 'm8 5 11 7-11 7V5Z',
  stop: 'M6 6h12v12H6z',
  chevron: 'm8 10 4 4 4-4',
  chevronLeft: 'm14 7-5 5 5 5',
  chevronRight: 'm10 7 5 5-5 5',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',
  shield: 'm12 3 8 3v6c0 4-5 7-8 9-3-2-8-5-8-9V6l8-3Zm-4 9 3 3 5-6',
  connect: 'm8 8 8 8M7 13l-2 2a3 3 0 0 0 4 4l2-2M13 7l2-2a3 3 0 0 1 4 4l-2 2M4 10l6-6M14 20l6-6',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  tokens: 'm12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
  cost: 'M12 3v18m4-15h-6a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H7',
  expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5',
  menu: 'M4 6h16M4 12h16M4 18h16',
  replay: 'M3 4v6h6M3 10a9 9 0 1 1 1 8',
  search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  file: 'M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6M9 16h6',
  activity: 'M2 12h5l3-8 4 16 3-8h5',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  help: 'M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  lock: 'M6 10h12v11H6zM8 10V7a4 4 0 0 1 8 0v3',
  folder: 'M3 5h7l2 3h9v12H3V5Z',
  palette:
    'M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 1.4-3.4 2 2 0 0 1 1.4-3.4H19a2 2 0 0 0 2-2A9 9 0 0 0 12 3ZM7.5 12h.01M10 8h.01M14.5 8h.01',
  zoomIn: 'M5 12h14M12 5v14',
  zoomOut: 'M5 12h14',
};

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 18,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}

/**
 * The ZEPHYR mark: the supplied Z letterform.
 *
 * A brand asset the user provided, traced from
 * `docs/frontend-design/Gemini_Generated_Image_niu0wtniu0wtniu0-removebg-preview.png`
 * rather than redrawn by eye. The letterform's one idea is that the diagonal is *split*:
 * an upper stroke hangs off the top arm and stops in mid-air at 85%, a lower stroke starts
 * in mid-air at 15% and carries into the bottom arm. They are exactly parallel (-0.707
 * run over rise), the same 9.4-unit width, and never meet — the constant 10.6-unit channel
 * between them is the mark. So this is two disjoint shapes, not one Z outline.
 *
 * The box is 97x100 because the source is that much taller than wide; don't square it off.
 * Filled geometry, not strokes, so weight scales with the glyph instead of going coarse at
 * the 22px lockup size. The channel is the first thing to close up — recheck 22px and 38px
 * after touching any number here.
 */
export function Mark({ small = false }: { small?: boolean }) {
  return (
    <svg
      className={small ? 'brand-mark small' : 'brand-mark'}
      width="30"
      height="30"
      viewBox="0 0 97 100"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M0 0H97L38.74 85H29.62L83.08 7H0Z" />
      <path d="M67.62 15H58.5L0.24 100H97V93H14.16Z" />
    </svg>
  );
}
