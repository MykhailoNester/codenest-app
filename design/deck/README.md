# Deck

A design concept built for what codenest-app actually is: a **supervision console**.

You are not doing the work — agents are. The questions this app has to answer are *what is
running, what is stuck, what changed while I was away, what is this costing me right now.*
Those are continuous, parallel and temporal. Cards are the wrong shape for them: a card makes
your eye re-find the same field in every box, which is exactly what fails at forty of them.

| File | What | Lines |
|---|---|---|
| `tokens.css` | Every value. Two grounds, four greys, four terminal semantics. | 106 |
| `deck.css` | The whole component set. | 190 |
| `prototype.html` | Eight screens, rendered from data through one `line()` function. | — |

Against today's frontend: **56 CSS modules, 12,857 lines, 24 named colours, 774 hardcoded
colour literals.**

## Look at it

```bash
python3 -m http.server 8793 --directory codenest-app/design/deck
```

`http://localhost:8793/prototype.html`. Bottom right: **Dark/Light**, **Colour On/Off**,
**Rows Tight/Loose**.

## The four rules

1. **One primitive.** Sessions, tasks, agents, runs, projects and alerts are all the same
   line on the same grid. `line()` in the prototype is the entire component library for
   lists — every screen calls it and nothing else.
2. **Mono is structure.** Columns only align if they are monospaced, and alignment is what
   makes forty rows readable instead of forty boxes. Sans appears in prose only.
3. **State is a character in column one, always.** `!` blocking · `×` failed · `?` waiting ·
   `=` stalled · `~` running · `✓` done · `▸` queued · `·` inert. It reads as text, so it
   survives in the terminal pane, in a log and with colour switched off.
4. **Draw almost nothing — but separate everything.** No card, no shadow, no fill on a row.
   Structure comes from three things only: the rail sits on its own ground (`--bg-1`), one
   hairline divides each section, and the gaps are big (`--group-gap: 38px`). The first draft
   had rule 4 without the second half and every section ran into the next — it read as one
   wall of text. Minimal is not the same as undifferentiated.

## Colour

Terminal semantics, because half this app is a terminal and those conventions are already
being read all day: **red broken · amber wants you · green finished · blue live.** Muted, not
ANSI-bright.

Colour is reinforcement and never the only carrier. `Colour → Off` is the test: the glyph
column keeps every state distinguishable on its own. If it did not, the glyph set would be
wrong.

## The idea worth stealing

**"Since you last looked."** Every dashboard shows current state; none shows the delta. A
supervision console is used in glances hours apart, so the first question is not *what is
true* but *what changed.* The rule across the Deck list, and the `•` on new rows, answer it.

This is the only part of the concept that needs new sidecar state — a per-user last-seen
timestamp.

## What it costs

- **The kanban board.** Status groups on one list scan far better at 200 tasks, but dragging
  a card between columns becomes a menu or a keystroke.
- **Cards.** Mission Control's tiles, agent cards, project cards — all become lines.
- **Icons in the rail.** Replaced by text plus the state glyph.
- **Comfort in long prose.** Mono at 12px is dense and aligns; descriptions stay sans, and the
  measure is capped (`--page-max: 1200px`, prose at 80ch) because a line that runs 1500px loses
  the eye on the way back.

The line truncates by design — that is what keeps a column scannable — so prose lists have to
opt out explicitly with `.dk-list.prose`.

## Readability and usability audit

Measured in the page, not eyeballed. Contrast is WCAG 2.1 against the ground; target sizes are
WCAG 2.2 SC 2.5.8.

| What | Before | After |
|---|---|---|
| Secondary text — column headers, ids, notes, status line | **2.47:1** ✗ | **5.1:1** (dark) / 5.03:1 (light) ✓ |
| Row text | 15.7:1 ✓ | 15.7:1 / 17.7:1 ✓ |
| Rules defining a focus style | **1** (a `:focus-within`) ✗ | 3 ✓ |
| Controls below 24px | 6 | 0 ✓ |
| State glyphs with a text alternative | **0 of 27** ✗ | 27 of 27 ✓ |
| Headings on the page | **1** | 4 ✓ |
| Live region on the queue | 0 | 1 ✓ |

What the audit actually caught, all of it invisible by eye:

- **`--fg-4` was failing at 2.47:1** and it was carrying column headers, stat labels, row ids and
  every note — the text you read to orient yourself. Both faint tiers moved up
  (`--fg-3` → `#7f8388`, `--fg-4` → `#6b6f74`) and `--fg-4` is now **decoration and disabled only**;
  no text uses it. It still clears 3:1 for non-text contrast.
- **No focus ring existed anywhere.** Every row is a `<button>`, so you could tab the whole app
  and never see where you were. `:focus-visible` now draws an inset 2px ring in `--run`.
- **The state glyph was a CSS `::before` and nothing else** — not readable by a screen reader, not
  copyable, and gone entirely if the stylesheet fails. Rule 3 claimed it "reads as text"; it did
  not. Each `.dk-s` now carries `role="img"` and an `aria-label` from `STATE_WORD`.
- **`.dk-seg` was 24px including its borders**, making the buttons inside it 22px of hit area. The
  wrapper is 26px so the targets are 24.
- **Truncated cells had no way back to the full value.** Any cell over 28 characters now gets a
  `title`.

### Both remaining findings are now fixed

**The grids are real grids.** A row was one `<button>`, so assistive tech got a flat run of
buttons and the columns meant nothing. `enhanceGrids()` runs after every render and gives each
list `role="grid"` with an `aria-label` from its heading, `aria-rowcount`/`aria-rowindex`, rows as
`role="row"`, cells as `role="gridcell"` and the head as `role="columnheader"`. Across the twelve
screens that is **28 grids and 545 cells**.

The tension was real — a `role="row"` cannot also be a button — and resolving it turned into a
usability win rather than a compromise. Rows are now grid rows driven by a **roving tabindex**:

| Key | Does |
|---|---|
| `↑` `↓` | move between rows, stopping at the ends |
| `Home` `End` | jump to first / last |
| `Enter` `Space` | activate the row |

Verified by dispatching the keys: `0→1→2`, `↑→1`, `End→3`, `Home→0`, and `↑` at the top holds at
0, with exactly one tabbable row per grid. A console should be drivable without the mouse, and now
it is. The `state` column header is present for the grid but wrapped in `.sr`, since the column is
14px wide.

**The 10px floor is gone.** The whole small end moved up a point — `--fs` 12→13, `--fs-s` 11→12,
`--fs-xs` 10→11, `--lh` 16→18, `--row` 28→30. Nothing renders below 11px any more. The fixed
columns were widened to match (13px type clipped ids and `DailyMotivation` at the old widths).

## Where an action goes

Deck had three button shapes and no rule, so a delete looked exactly like a copy, rows grew
seven buttons each, and two tabs with no gap rendered as one word — `ActivityComments`. The
vocabulary below is the fix; the placement rule is the part that keeps it fixed.

| Shape | Class | Use |
|---|---|---|
| Primary | `.dk-btn.pri` | **One per surface.** The thing you came to do — launch, create. |
| Default | `.dk-btn` | A named secondary action. |
| Bare | `.dk-btn.bare` | Inside a row or a dense cluster, where a border would be noise. |
| Destructive | `.dk-btn.danger` | The only button that carries colour, because it is the only one whose mistake cannot be undone. |
| Icon | `.dk-btn.icon` | Square, one glyph — an overflow trigger or a close. |
| Overflow | `<DeckMenu>` | Everything that did not fit. |

**The rules:**

1. **One primary per surface**, in the title bar. If a screen seems to need two, one of them is
   secondary.
2. **A row carries at most two inline actions.** The third onward goes in `<DeckMenu>`. Projects
   carried seven, which is how this rule was found.
3. **Destructive actions are never adjacent to the primary**, and on a row they live in the
   overflow, last, behind a separator (`separated: true`).
4. **Every action lives in a container.** "Delete task" used to float below the Timestamps card
   in nothing at all.
5. **Clusters use `.dk-actions`**, never bare siblings — without its gap, buttons butt together
   and read as one word.

`DeckMenu` closes on outside click and on Escape, and returns focus to its trigger, so opening
one does not break the roving tabindex the grid sets up.
