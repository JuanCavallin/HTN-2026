---
name: Zephyr
description: An instrument panel for a running agent — a dark luminance ladder where brightness means evidence.
colors:
  canvas: '#070908'
  rail: '#090c0a'
  bg: '#0b0e0d'
  panel: '#121614'
  node-fill: '#161b17'
  raised-panel: '#1a1f1c'
  surface-3: '#1d231d'
  hover: '#1f2720'
  node-planned-fill: '#0e1210'
  node-planned-line: '#232b24'
  node-planned-text: '#78856f'
  line: '#242a25'
  line-2: '#2b3425'
  line-3: '#2f3b2c'
  line-4: '#3c4b31'
  accent-line: '#5f7a54'
  edge-idle: '#2f3630'
  edge-done: '#6f8a75'
  faint: '#6f7c6b'
  quiet: '#9aa69b'
  secondary: '#b0b9b0'
  accent-text: '#c0d2a9'
  accent-text-2: '#d0ddbd'
  accent: '#d0dfb5'
  accent-bright: '#deedbf'
  accent-ink: '#182116'
  text-2: '#dce4d8'
  text: '#e9eee7'
  amber: '#e4bd79'
  amber-soft: '#222119'
  danger: '#f1a6a0'
  danger-text: '#f2bbb3'
  danger-soft: '#2c1d1c'
typography:
  display:
    fontFamily: "'Segoe UI', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: '36px'
    fontWeight: 450
    lineHeight: 1.3
    letterSpacing: '-1px'
  headline:
    fontSize: '20px'
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: '-0.55px'
  title:
    fontSize: '15px'
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: '-0.3px'
  body:
    fontSize: '13px'
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: 'normal'
  label:
    fontSize: '11px'
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: '0.2px'
  micro:
    fontSize: '10px'
    fontWeight: 500
    lineHeight: 1.7
    letterSpacing: '0.08em'
  wordmark:
    fontSize: '15px'
    fontWeight: 300
    letterSpacing: '0.22em'
rounded:
  xs: '2px'
  sm: '4px'
  control: '5px'
  md: '7px'
  lg: '8px'
  node: '10px'
  panel: '12px'
  composer: '13px'
spacing:
  xs: '6px'
  sm: '9px'
  md: '13px'
  lg: '17px'
  xl: '22px'
  '2xl': '26px'
  '3xl': '38px'
components:
  button-primary:
    backgroundColor: '{colors.accent}'
    textColor: '{colors.accent-ink}'
    rounded: '{rounded.md}'
    padding: '9px 14px'
    typography: '{typography.label}'
  button-primary-hover:
    backgroundColor: '{colors.accent-bright}'
  button-secondary:
    backgroundColor: '{colors.surface-3}'
    textColor: '{colors.accent-text-2}'
    rounded: '{rounded.md}'
    padding: '9px 14px'
    typography: '{typography.label}'
  button-secondary-hover:
    backgroundColor: '{colors.line-2}'
  button-icon:
    backgroundColor: 'transparent'
    textColor: '{colors.accent-text}'
    rounded: '{rounded.control}'
    padding: '6px'
  button-icon-hover:
    backgroundColor: '{colors.hover}'
    textColor: '{colors.text}'
  composer:
    backgroundColor: '{colors.raised-panel}'
    textColor: '{colors.text}'
    rounded: '{rounded.composer}'
    padding: '17px 18px 5px'
    typography: '{typography.body}'
  node-materialized:
    backgroundColor: '{colors.node-fill}'
    textColor: '{colors.text}'
    rounded: '{rounded.node}'
    width: '210px'
  node-planned:
    backgroundColor: '{colors.node-planned-fill}'
    textColor: '{colors.node-planned-text}'
    rounded: '{rounded.node}'
    width: '210px'
  metrics-strip:
    backgroundColor: '{colors.rail}'
    textColor: '{colors.quiet}'
    padding: '13px 26px'
    typography: '{typography.micro}'
  notice-error:
    backgroundColor: '{colors.danger-soft}'
    textColor: '{colors.danger-text}'
    rounded: '{rounded.lg}'
    padding: '13px 15px'
---

# Design System: Zephyr

## Overview

**Creative North Star: "The Instrument Panel"**

Zephyr is the glass cockpit for a running agent. The person using it is not browsing a
product; they are watching a machine work and deciding whether to let it continue. So the
interface behaves like instrumentation: dark, dense, unlit except where there is something
to report, and absolutely literal about what it knows. Nothing here is decorative, because
on an instrument panel a light that means nothing is a defect.

The whole visual system is one idea — **brightness is evidence**. The canvas is the darkest
thing in the app and everything rises off it in a fixed order: unexecuted structure barely
above the ground, materialized work above that, the accent reserved for the single thing
that is live or chosen. There are no shadows anywhere in this system. Depth is entirely
tonal, which is why the ladder is generated rather than hand-written: one hand-edited value
puts a surface on the wrong rung and the reading breaks silently.

The five worlds (`sage`, `slate`, `ember`, `mono`, `daylight`) are the same ladder re-hued
in OKLCH at constant lightness. Changing theme changes the hue of the instrument, never its
architecture. `daylight` is the one deliberate exception: on a light ground "canvas is
darkest" cannot hold, so it inverts to "canvas is quietest, executed work is most inked" —
the rule underneath survives, which is the part that matters.

**Key Characteristics:**

- A generated OKLCH luminance ladder, identical across every dark world
- Zero shadows; depth is tonal layering only
- One typeface, no monospace — measurement is a size and weight, not a costume
- The accent appears on the live, selected, or chosen thing and nowhere else
- Unknown measurements render `—`, never `0`
- Planned structure is dim and dashed; it never borrows the appearance of executed work

## Colors

A low-chroma dark green-grey ground with a single pale sage accent, plus two reserved
signal hues that never vary by theme.

### Primary

- **Pale Sage** (`accent`): the one bright thing. It marks the live node, the selected
  route, the primary action, the caret, the focus ring, and the text selection. If more
  than one thing on screen is this color, the screen is wrong.
- **Sage Lift** (`accent-bright`): the hover state of the primary action, and the top rung
  of the ladder. Never used at rest.
- **Sage Ink** (`accent-ink`): the near-black that sits _on_ the accent. Type on the accent
  is this, never the page text color.

### Secondary

- **Sage Text** / **Sage Text Bright** (`accent-text`, `accent-text-2`): accent-tinted type
  for secondary buttons, text links and inline emphasis. These carry the brand into copy
  without spending the accent itself.
- **Edge Done** (`edge-done`): a completed connection on the graph. Distinct from the
  accent so "finished" never reads as "live."

### Tertiary

- **Amber** (`amber`, `amber-soft`): awaiting a human — pending approval, degraded
  provider, a warning. It is the same value in all five worlds on purpose.
- **Alarm Rose** (`danger`, `danger-text`, `danger-soft`): failure, cancellation,
  destructive controls. Also theme-invariant.

### Neutral

- **Canvas** (`canvas`): the graph ground, and the darkest surface in the app.
- **Rail** / **Bg** / **Panel** / **Raised Panel** (`rail`, `bg`, `panel`, `raised-panel`):
  the four working surfaces, in rising order. A surface's rung states its relationship to
  the canvas; it is not a style choice.
- **Planned Fill** / **Planned Line** / **Planned Text** (`node-planned-*`): the recessive
  set. Deliberately below `node-fill`, because unexecuted structure must sit under
  reported work.
- **Line 1–4** (`line`, `line-2`, `line-3`, `line-4`): hairline dividers, rising with the
  surface they separate.
- **Text** / **Text 2** / **Secondary** / **Quiet** / **Faint**: the type ramp, brightest
  to dimmest. `faint` is for labels that must be present but not read first.

### Named Rules

**The Ladder Rule.** Every dark world is the same OKLCH lightness ladder, re-hued. Tokens
are generated by `tools/theme/generate.mjs` and spliced into `src/workspace.css`. Hand-edit
one value and you break the invariant `tests/theme.test.mjs` exists to protect — regenerate
instead.

**The One Bright Thing Rule.** `accent` and `accent-bright` mark what is live, selected, or
chosen. They are never used to make a section look important.

**The Sealed Blocks Rule.** No color literal may appear anywhere outside the theme blocks
at the top of `src/workspace.css`. A test enforces it. A one-off hex is how a ladder dies.

**The Signal Invariance Rule.** Amber and alarm rose do not re-hue with the theme. A person
who learns "amber means a human is needed" in `sage` must not have to relearn it in `ember`.

## Typography

**UI Font:** Segoe UI (with `ui-sans-serif`, `system-ui`, `-apple-system`,
`BlinkMacSystemFont`, `sans-serif`)
**Label/Mono Font:** none — see The No Costume Rule.

**Character:** One neutral humanist sans doing every job, separated by size and weight
rather than by family. The result reads as instrumentation rather than as an editorial
product: calm, narrow in range, and unremarkable in exactly the way a gauge face should be.

### Hierarchy

- **Display** (450, 36px, 1.3, -1px): the empty-state heading only. One per screen, and
  most screens have none.
- **Headline** (500, 20px, 1.4, -0.55px): page and section headings.
- **Title** (500, 15px, 1.5, -0.3px): panel headings, node titles, the wordmark's size peer.
- **Body** (400, 13px, 1.65): conversation messages and the composer. The conversation lane
  caps at 860px so the measure stays readable when the graph pane is collapsed.
- **Label** (500, 11px, 0.2px): buttons, tabs, controls, inline links.
- **Micro** (500, 10px, 0.08em): measurements, counts, provenance, status. The densest and
  most-used size in the app.
- **Wordmark** (300, 15px, 0.22em, uppercased via CSS): "Zephyr" in the nav. Set with
  `text-transform` rather than typed in caps so the accessible name stays "Zephyr" instead
  of being announced letter by letter.

### Named Rules

**The No Costume Rule.** There is no monospace face in this system. Numbers are
distinguished by size, weight and color, not by pretending to be code. Use a tabular
variant if digits jitter; do not reach for a mono family.

**The Em Dash Rule.** An unknown measurement renders `—`. It never renders `0`, `-`, `n/a`
or an empty cell. A measured zero renders `0` and must remain distinguishable from unknown.

## Layout

A single full-height shell (`100dvh`, `min-height: 480px`) holding one hybrid grid: a
conversation lane, a draggable rail, the graph as the dominant region, and an inspector
column that is `0px` wide until something is selected. A fixed metrics strip spans the full
width at the bottom and never scrolls away — on an instrument panel the gauges do not leave
the frame.

Selection animates `grid-template-columns` over 300ms, so the inspector reads as the layout
reflowing rather than as a panel dropping on top of the graph. The lane defaults to 364px
and the inspector to 336px; while the rail is being dragged an inline `--lane-width`
overrides every breakpoint at once, so there is only ever one source of truth for the
width. Drag clamps at 260px and 62%, and either pane can be collapsed entirely.

Navigation is a drawer at every width. There is no permanent side rail, because the graph
is the thing the user came to watch and a persistent 218px of chrome is 218px of it gone.

Breakpoints: 1700px (wide), 1250px, 1000px, 760px. Below 900px the graph's minimum zoom
drops to 0.22 so a narrow pane shows every rank rather than cropping the ends off. At
390×844 the Activity tab is auto-selected and the page must not scroll horizontally.

Spacing is hand-tuned per region rather than driven by a strict scale; the recurring steps
are 6 / 9 / 13 / 17 / 22 / 26 / 38px. Density is high by intent — this surface is read at a
glance during a run, not browsed.

## Elevation & Depth

**There are no shadows in this system.** Not one `box-shadow` exists in `workspace.css`, and
none should be added. Depth is expressed entirely as tonal layering against the luminance
ladder: a surface's lightness _is_ its elevation, and a 1px hairline at the matching rung
separates it from its neighbour.

This is why the ladder is generated. With shadows, a surface that lands on the wrong rung
still looks layered. Without them, the rung is the only cue — so a hand-edited value does
not look slightly off, it makes the hierarchy unreadable.

### Named Rules

**The Canvas Floor Rule.** In every dark world, `canvas` is the darkest surface in the app
and nothing may sit below it. In `daylight` the rule inverts to its light-ground equivalent:
`canvas` is the quietest surface and executed work carries the most ink.

**The Recessive Plan Rule.** Planned structure sits _below_ materialized work on the ladder
in all five worlds, `daylight` included. Dimming is not a styling preference here; it is the
visual form of "we have not observed this yet."

## Shapes

Rectangular and quiet, with a small radius scale that rises with the size of the thing:
2–5px for chips, grips and icon buttons; 7–8px for buttons and notices; 10px for graph
nodes; 12–13px for panels and the composer. Nothing is pill-shaped except genuine circles
(`50%`), which appear only as the 6px junction marker on a node with more than one route in
or out.

Borders are always 1px and always a `line-*` token. Weight is never used for emphasis; the
line's rung does that work.

The one form with semantic meaning is the **dashed border**, which marks a planned node and
appears nowhere else. Dashed means "told to us, not observed."

## Components

### Buttons

- **Shape:** gently rounded (7px), `9px 14px`, 11px/500 label, 8px icon gap.
- **Primary:** pale sage ground with sage-ink type — the only filled-accent control on a
  screen.
- **Hover / Focus:** primary lifts to `accent-bright`; secondary swaps ground to `line-2`
  and its border to `accent-line`. Focus is a 2px `accent` outline at 4px offset (2px on
  fields).
- **Secondary:** `surface-3` ground, 1px `line-3` border, accent-tinted type.
- **Icon:** transparent at rest, `hover` ground on hover, 5px radius, 6px padding.
- **Disabled:** a disabled control keeps its shape and states its reason in adjacent copy.
  "Pause unavailable" stays visibly disabled once a run has finished, rather than
  disappearing — pause/resume itself is implemented and enabled while a run is live.

### Cards / Containers

- **Corner Style:** 12px panels, 10px nodes.
- **Background:** the surface's own rung — `panel` for docks, `raised-panel` for the
  composer, `node-fill` for a materialized node.
- **Shadow Strategy:** none. See Elevation & Depth.
- **Border:** 1px, `line`–`line-4` matched to the surface.
- **Internal Padding:** 22–26px for docks, 13–17px for inline notices.

### Inputs / Fields

- **Style:** the composer is a `raised-panel` block with a 1px `line-4` border at 13px
  radius; the textarea itself is borderless and transparent inside it, 13px/1.65, resizing
  between 65px and 180px.
- **Focus:** the container's border shifts to `mark-strong` over 150ms — the field lights
  up as one object rather than the textarea gaining its own ring.
- **Placeholder:** `secondary`, which clears the 4.5:1 floor. Never `faint`.

### Navigation

- A drawer at every width, opened by a labelled toggle. Items are 11px/500. The theme
  picker lives inside the drawer, not in a settings page.
- The wordmark is uppercased in CSS at 0.22em tracking beside the Z mark at 22px.

### The Trace Node (signature)

A fixed 210px card carrying heading, status, description and a measurement footer, in one
of three mutually exclusive states that the product forbids blurring:

- **Planned** — `node-planned-*`, dashed border, dimmed, and carrying **no** measurements
  (`—`, never `0`). Structure we were told about.
- **Materialized** — `node-fill`, solid `line-3` border, full-brightness type, real numbers.
  Work actually reported.
- **Unplanned** — solid `accent-line` border and a `Runtime` flag. Work the runtime invented
  that was never in the plan.
- **Revised** — `accent` border, for a node whose route a human changed.

Off-path nodes drop to 0.58 opacity unless selected. A junction dot (6px, `mark` border,
`canvas` fill) marks more than one route in or out. State transitions run 300ms on
background, border, color and opacity together so a node _becoming_ real is legible as a
change rather than a repaint.

### Browser Surfaces

Themed deliberately, not left to the browser: `::selection` is accent on sage-ink, the
caret is accent, scrollbars are `thin` with a `line-2` thumb on a transparent track, focus
rings are 2px accent at 4px offset, link underline offset is 4px, and `progress` fills with
`mark-strong`.

## Do's and Don'ts

### Do:

- **Do** regenerate the theme with `node tools/theme/generate.mjs` and
  `python tools/theme/splice.py`, then run `node --test "tests/*.test.mjs"`. Never hand-edit
  a token.
- **Do** place a new surface on an existing rung of the ladder and give it the matching
  1px `line-*` border.
- **Do** render an unknown measurement as `—`, and keep a measured `0` distinguishable
  from it.
- **Do** spend the accent on exactly one thing per screen: the live, selected, or chosen
  item.
- **Do** keep planned structure recessive and dashed in all five worlds, `daylight`
  included.
- **Do** label provenance truthfully — live, mock, fixture and replay are four different
  things and must look like it.
- **Do** theme the browser's own surfaces (selection, caret, scrollbar, focus ring) from
  the palette.

### Don't:

- **Don't** add a `box-shadow`. This system has none; depth is tonal.
- **Don't** write a color literal outside the theme blocks in `src/workspace.css`. A test
  fails on it, and the ladder is the reason.
- **Don't** introduce a monospace face to make numbers look technical.
- **Don't** re-hue amber or alarm rose per theme; their constancy is what makes them
  readable.
- **Don't** give a planned node measurements, or let it borrow the appearance of executed
  work.
- **Don't** put a permanent navigation rail back. The drawer exists so the graph keeps the
  width.
- **Don't** use border weight above 1px for emphasis; move the line up a rung instead.
- **Don't** silently fall back to preview behaviour on a live run — a failed live request
  shows as an error, never as a successful mock.
