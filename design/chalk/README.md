# Chalk for Codenest

A monochrome pivot of the app's theme, borrowed from the Chalk design system of a
sibling product. One ground, eleven ink values, one optional chromatic token.

| File | What |
|---|---|
| `tokens.css` | Every colour, type, space and radius. Board (dark) and paper (light). |
| `chalk.css` | The component layer — 314 lines, token-only. Ships as-is into `frontend/src/styles/`. |
| `prototype.html` | Eight screens of static markup. Review device, not code to keep. |

## Look at it

```bash
python3 -m http.server 8792 --directory codenest-app/design/chalk
```

Then open `http://localhost:8792/prototype.html`. Bottom right switches **Board / Paper**, **Colour Full / Minimal / None** and
**Comfortable / Compact**. The comparison that matters is the Work Board at Minimal
against the same board at None.

## The four rules

1. **Borders, not fills.** On the board a surface is drawn by its outline. On paper an
   outline alone reads as a wireframe, so the card carries a tint there and the border
   steps back — one rule, two grounds.
2. **One ground.** No shadow, gradient, blur or glow.
3. **Mono carries fact.** Numbers, ids, paths, models and time are mono; prose is sans.
4. **Colour answers one question: how much does this want me?** A five-step ramp —
   critical, active, normal, done, inert — carries task priority, attention severity, run
   outcome and column temperature. Nothing outside that question is coloured: projects,
   agents, models, paths and counts stay mono.

## Relationship to the original Chalk

Same spacing scale, same radii, same kicker/mono/number type roles, same
borders-not-fills rule. Two deliberate departures: the ink ramp is neutral rather than
warm, and the controls run two sizes tighter (24/28/34px against 40/56px) because this
is a dense tool window, not a phone.

Nothing syncs between the two automatically.

## Checked against the real thing

The original Chalk Android app was driven with sgraph and captured on an emulator. Two corrections came out of it: chips and the search field are
full pills, not 8px rects, and Chalk does spend a little colour on a semantic number —
which is the argument for keeping `--signal`.

## Revisions after the first review

- **Board columns** no longer rank by rule weight (a code you had to learn, and worse than
  the colour coding it replaced). Dashed is provisional, the live dot is the one the
  session rows use, `--signal` means blocked, Done recedes.
- **Disabled** has a treatment: ink to `--faint`, border to hairline, filled buttons
  surrender their fill, no hover response.
- **Density** is a token set, not a rewrite — `--pad-card`, `--row-h` and the control
  heights move together under `[data-density="compact"]`.
- **Paper** gives cards a tint on a slightly grey ground, so they read as surfaces.
- `.ck-sub` added — `.ck-row__m` truncates to one line and was wrong for prose.

## The ramp

Colour was the thing the first draft got wrong in both directions. The old theme put six
hues on every card until colour carried nothing; the reply to that was strict monochrome,
which made the board harder to scan than what it replaced. The ramp is the third answer.

| Step | Dark | Light | Carries |
|---|---|---|---|
| `--u-critical` | `#d98c7f` | `#a33b28` | blocking · P1 · failed run · over budget |
| `--u-active` | `#e0b252` | `#8a6412` | stalled · P2 · in progress |
| `--u-normal` | `#8fa8c9` | `#3e5c82` | queued · P3 · to do · healthy |
| `--u-done` | `#7fc8a9` | `#2e7256` | resolved · done · passed |
| `--u-inert` | `#6a6a70` | `#85858a` | backlog · idle · muted · unmeasured |

Values are Chalk's own. Its `tokens/semantic.json` defines accent as *"waiting on you, at
most once per screen"* and negative as *"below your best — **never alarming**"*, which is
why the top of the ramp is a clay rather than a red.

**The spend limit is what protects it.** The ramp may appear on a mark, a badge, a column
head rule, and the left edge of a P1 tile. Nowhere else — no card background, no chart
series, no project badge. Shape carries the same information in parallel (filled square,
half, ring, dot), so `None` is the same app with the reinforcement removed rather than a
degraded one.
