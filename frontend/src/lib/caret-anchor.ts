/**
 * Left/bottom offsets for a panel that opens upward from the caret line — the
 * composer sits at the bottom of the pane, so a downward-opening menu would
 * be clipped by the pane edge (the existing `.pickerPanel` already opens
 * upward the same way). Anchoring by `left` + `bottom` removes all flip logic
 * and makes the geometry a single pure function.
 */

export interface CaretAnchorInput {
  /** px, marker rect relative to the mirror's own (unscrolled) box. */
  markerLeft: number;
  markerTop: number;
  /** The textarea's own scroll offset — subtracted from `markerTop` because
   *  the mirror that produced it does not scroll with the textarea. */
  scrollTop: number;
  /** The `.editorStack` box the mirror and the panel are both positioned in. */
  hostWidth: number;
  hostHeight: number;
  /** The mirror's inset inside the host (10/8 today). */
  padLeft: number;
  padTop: number;
  panelWidth: number;
  gapPx: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function caretAnchor(i: CaretAnchorInput): { left: number; bottom: number } {
  const bottom = Math.max(0, i.hostHeight - (i.padTop + i.markerTop - i.scrollTop) + i.gapPx);
  const left = clamp(i.padLeft + i.markerLeft, 0, Math.max(0, i.hostWidth - i.panelWidth));
  return { left, bottom };
}
