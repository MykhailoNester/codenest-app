/**
 * Geometry for the agent composer's editor box: how tall the textarea is, how
 * the transparent-text overlay is kept on top of it, and how many rows the
 * gutter counter reports.
 *
 * All three are one measurement. `.editorTextarea` paints its own text
 * `transparent` and the visible copy comes from `.editorOverlay`, a sibling
 * that mirrors the draft with `@mention` spans — so the two boxes must wrap
 * identically and scroll together or the user sees blank space where their
 * text is. Deriving the box height, the overlay's geometry and the row count
 * from a single content measurement is what makes that hold by construction
 * rather than by three call sites agreeing.
 *
 * DOM-only leaf, like `composer-focus.ts`: imports nothing from `stores/` or
 * `lib/api`/`lib/ipc`, so it cannot add an edge that could form an import
 * cycle.
 */

/** Mirrors `.editorTextarea { min-height: 48px }` in
 * `agent-composer.module.css` — the empty box's height. */
export const COMPOSER_EDITOR_MIN_HEIGHT_PX = 48;

/** Mirrors `.editorTextarea { max-height: 264px }` in
 * `agent-composer.module.css` — the auto-grow clamp. Kept as a literal here
 * rather than read from CSS; the two must be kept in sync by hand. Raised
 * 240 -> 264 when the persistent `.wire` strip became the `{}` popover and
 * freed that vertical space for the editor. */
export const COMPOSER_EDITOR_MAX_HEIGHT_PX = 264;

/** Mirrors the shared `font-size: 12px; line-height: 1.6` rule that
 * `.editorOverlay`, `.editorTextarea` and `.editorMirror` share — 12 × 1.6.
 * Only ever used to divide a measured content height into rows, so a rounding
 * disagreement with the browser costs a row at worst, never layout. */
export const COMPOSER_EDITOR_LINE_HEIGHT_PX = 19.2;

/**
 * The draft's laid-out height in px, free of the box's own minimum.
 *
 * `scrollHeight` is floored by `min-height`, so a one-row and a two-row draft
 * both report 48 and any row count derived from either would be the same wrong
 * number. Dropping the minimum for the duration of the read is what makes the
 * small end measurable. Both properties are restored before this returns, and
 * every caller runs inside a layout effect, so the browser never paints the
 * collapsed box.
 *
 * Returns 0 where there is no layout at all (jsdom, a `display: none`
 * ancestor); callers treat that as "not measurable" rather than as zero rows.
 */
export function measureComposerContentHeight(el: HTMLTextAreaElement): number {
  const prevHeight = el.style.height;
  const prevMinHeight = el.style.minHeight;
  el.style.minHeight = "0px";
  el.style.height = "0px";
  const content = el.scrollHeight;
  el.style.minHeight = prevMinHeight;
  el.style.height = prevHeight;
  return content;
}

/** The auto-grow measurement: size the box to its content, clamped to the
 * min/max above. Returns the *unclamped* content height so a caller that also
 * needs the row count does not pay for a second reflow. */
export function resizeComposerEditor(el: HTMLTextAreaElement): number {
  const content = measureComposerContentHeight(el);
  const height = Math.min(
    Math.max(content, COMPOSER_EDITOR_MIN_HEIGHT_PX),
    COMPOSER_EDITOR_MAX_HEIGHT_PX,
  );
  el.style.height = `${height}px`;
  return content;
}

/**
 * Put the overlay exactly over the textarea's content box and at the same
 * scroll offset.
 *
 * Width is set from `clientWidth` rather than left by a CSS `right` inset for
 * the reason `measureAnchor` already sets the caret mirror's width that way:
 * past `max-height` the textarea grows a scrollbar that narrows its own line
 * box but would not narrow an inset-positioned sibling's, so the two would
 * wrap differently and the painted text would drift a line further from the
 * caret with every wrapped row.
 *
 * The scroll assignment is here — in a layout effect that runs on every draft
 * change — and not only in the textarea's `onScroll`, because React rewrites
 * the overlay's child list on each keystroke and a re-render can leave its
 * offset behind with no scroll event to put it back. That is the state where
 * the draft is intact, the caret is correct, and the box paints blank.
 */
export function syncComposerOverlay(
  textarea: HTMLTextAreaElement,
  overlay: HTMLElement,
): void {
  overlay.style.width = `${textarea.clientWidth}px`;
  overlay.style.height = `${textarea.clientHeight}px`;
  overlay.scrollTop = textarea.scrollTop;
}

/**
 * Rows the draft occupies *on screen*, which is what a counter sitting under
 * a wrapping editor reads as — not the `\n`-separated logical line count,
 * which reports 1 for a draft that visibly fills three rows.
 *
 * Never fewer than the logical count: a wrapped draft cannot occupy fewer rows
 * than it has newlines, so that floor turns a measurement that rounds a hair
 * low into a no-op instead of a wrong number. Falls back to the logical count
 * outright where nothing is measurable (`contentPx === 0`).
 */
export function composerRowCount(contentPx: number, text: string): number {
  if (text.length === 0) return 0;
  const logical = text.split("\n").length;
  if (!(contentPx > 0)) return logical;
  return Math.max(logical, Math.round(contentPx / COMPOSER_EDITOR_LINE_HEIGHT_PX));
}

/**
 * The whole editor layout in one pass: grow the box to the draft, put the
 * overlay back on top of it, and report the rows that measurement implies.
 * The composer's layout effect is the only caller — every other write path
 * reaches it by changing the draft.
 */
export function layoutComposerEditor(
  textarea: HTMLTextAreaElement,
  overlay: HTMLElement | null,
  text: string,
): number {
  const content = resizeComposerEditor(textarea);
  if (overlay) syncComposerOverlay(textarea, overlay);
  return composerRowCount(content, text);
}
