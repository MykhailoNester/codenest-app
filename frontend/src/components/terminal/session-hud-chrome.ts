/**
 * The session-state strip's chrome, shared by `<SessionHud/>` (shell panes,
 * sidecar facts) and `<AgentSessionHud/>` (agent panes, wire facts) so the two
 * are visually one thing — the split mirrors `session-hud-format.ts`, which
 * already shares this strip's number formatting.
 *
 * The motion cues live beside it in `session-hud-motion.tsx`, which
 * `react-refresh/only-export-components` requires to be its own module.
 *
 * ── Local constants ──────────────────────────────────────────────────────
 * On Deck: the cells are mono at `--fs-s`, the separators are `--line`, the
 * ctx and todo gauges are Deck's own `.dk-meter` (markup, in both call sites),
 * and every colour is a Deck token. What is left is geometry and tone the
 * design system has no opinion about, declared here rather than in
 * `components/deck/*` or `design/deck/*`, which #283 does not touch — the
 * precedent is the composer's `EDITOR_*` constants.
 *
 * The prototype's `--hud-pink` went with the bridge: Deck's palette has four
 * semantics and no fifth, so the token figures take `--fg-2` and the meaning is
 * carried by the `ctx`/`todo` labels beside them.
 */

import { cloneElement, type CSSProperties, type ReactElement } from "react";

/**
 * The strip itself.
 *
 * `scrollbarWidth: "none"` is the standard property. The old stylesheet also
 * carried a `::-webkit-scrollbar { display: none }` rule, which has no inline
 * form, and `deck.css` styles `:where(.deck) ::-webkit-scrollbar` at 10px for
 * every scroller in the app. So on a WebKit older than Safari 18.2 a strip
 * narrow enough to overflow will show that 10px bar. The fix belongs in
 * `deck.css` as a "no scrollbar" utility, which #283 does not touch.
 */
export const STRIP_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flex: "0 0 auto",
  background: "var(--bg-1)",
  borderBottom: "1px solid var(--line)",
  padding: "var(--u) var(--u2)",
  fontFamily: "var(--mono)",
  fontSize: "var(--fs-s)",
  overflowX: "auto",
  scrollbarWidth: "none",
};

/** "No live agent session bound to this pane" — extended (D11) to a pane whose
 *  process has exited. Deck draws no filters, so this is opacity alone; the
 *  colour semantics stay readable rather than turning grey. */
export const STRIP_DIMMED_STYLE: CSSProperties = { ...STRIP_STYLE, opacity: 0.45 };

/** The strip as the dock's metrics line — its *last* child since #38, so the
 *  composer's own top border is always what rules the seam beneath it and the
 *  strip's own bottom border would double that rule. The rule *above* it comes
 *  from the groups' bottom border when groups are showing, else from the dock's
 *  top border. `<SessionHud/>` (shell panes) never uses these two. */
export const STRIP_DOCKED_STYLE: CSSProperties = { ...STRIP_STYLE, borderBottom: 0 };

export const STRIP_DOCKED_DIMMED_STYLE: CSSProperties = {
  ...STRIP_DOCKED_STYLE,
  opacity: 0.45,
};

export const CELL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--u)",
  padding: "0 var(--u2)",
  borderRight: "1px solid var(--line)",
  whiteSpace: "nowrap",
  flex: "none",
};

/** `.cell:last-child` as data — a structural pseudo-class is one of the things
 *  an inline style cannot express, so the trailing hairline is dropped by
 *  `hudCells()` below rather than by the cascade. */
export const CELL_LAST_STYLE: CSSProperties = { ...CELL_STYLE, borderRight: 0 };

export const KEY_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  fontSize: "var(--fs-xs)",
  letterSpacing: "1.1px",
  textTransform: "uppercase",
};

export const VALUE_STYLE: CSSProperties = {
  color: "var(--fg)",
  fontVariantNumeric: "tabular-nums",
};

/** The model name — live, because it names what is answering you. */
export const VALUE_ACC_STYLE: CSSProperties = { ...VALUE_STYLE, color: "var(--run)" };
export const VALUE_OK_STYLE: CSSProperties = { ...VALUE_STYLE, color: "var(--ok)" };
export const VALUE_WARN_STYLE: CSSProperties = { ...VALUE_STYLE, color: "var(--warn)" };
/** Same token as `VALUE_ACC_STYLE`, kept apart because the two say different
 *  things: one names the model, the other marks a figure as informational. */
export const VALUE_INFO_STYLE: CSSProperties = { ...VALUE_STYLE, color: "var(--run)" };
export const VALUE_NUM_STYLE: CSSProperties = { ...VALUE_STYLE, color: "var(--fg-2)" };
export const VALUE_MUTED_STYLE: CSSProperties = { ...VALUE_STYLE, color: "var(--fg-3)" };

export const THINK_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--u)",
  color: "var(--warn)",
};

/** One assembled cell, typed so `hudCells` can restyle the last of them. */
export type HudCell = ReactElement<{ style?: CSSProperties }>;

/**
 * Drops the trailing hairline from the last cell. The cells are assembled into
 * an array before the strip knows how many there are, so the "last" case is
 * applied here instead of by a `:last-child` rule.
 */
export function hudCells(cells: HudCell[]): ReactElement[] {
  if (cells.length === 0) return cells;
  return cells.map((cell, i) =>
    i === cells.length - 1 ? cloneElement(cell, { style: CELL_LAST_STYLE }) : cell,
  );
}
