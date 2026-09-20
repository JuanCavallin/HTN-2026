# Theme generator

The theme blocks in `src/workspace.css` are **generated**, not hand-written. Editing one
value by hand breaks the invariant the whole system rests on.

```bash
node tools/theme/generate.mjs > tools/theme/themes.generated.css   # contrast report on stderr
python tools/theme/splice.py tools/theme/themes.generated.css src/workspace.css
node --test "tests/*.test.mjs"
```

`generate.mjs` holds the reference ladder (the sage world) and the per-theme hue/chroma
settings. Every dark theme is that ladder re-hued in OKLCH at **constant lightness**, with
chroma reduced until the colour fits inside sRGB — clamping RGB instead would silently
shift lightness, which is the one thing that must not happen. `daylight` is hand-derived
against a light ground and checked the same way.

`tests/theme.test.mjs` enforces all of it: same ladder, canvas darkest, planned recessive,
contrast floors, and no colour literal anywhere outside the theme blocks.
