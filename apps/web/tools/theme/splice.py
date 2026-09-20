import sys

themes_path, css_path = sys.argv[1], sys.argv[2]
themes = open(themes_path, encoding='utf-8').read()
s = open(css_path, encoding='utf-8').read()

start = s.index(':root {')
end = s.index('\n}\n', start) + 3

header = """/* Theme worlds.
 *
 * Every dark world is the SAME luminance ladder re-hued in OKLCH — identical lightness per
 * token, only hue and chroma move. That is what keeps the architecture intact across
 * themes: the canvas stays the darkest surface, planned structure stays below materialized
 * work, and the accent stays the brightest thing on screen.
 *
 * `daylight` is the deliberate exception. On a light ground "canvas is darkest" cannot
 * hold, so it is re-derived: the canvas becomes the quietest surface and executed work the
 * most inked. The rule underneath survives, which is the part that matters.
 *
 * Generated and contrast-checked against the pairs that carry text; see DESIGN.md.
 * Do not hand-edit a single value in isolation — it breaks the ladder.
 */
"""

tail = """
:root {
  --font-ui: 'Segoe UI', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  --radius: 12px;
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  /* Aliases kept so sibling pages and older rules keep resolving. */
  --sage: var(--accent);
  --sage-ink: var(--accent-ink);
  --edge-active: var(--accent);
}
"""

open(css_path, 'w', encoding='utf-8').write(header + themes + '\n' + tail + s[end:])
print('spliced')
