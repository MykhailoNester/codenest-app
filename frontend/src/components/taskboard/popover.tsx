import { useEffect, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Fixed-position dropdown panel, portalled to `document.body`, drawn on Deck
 * (#283). Modelled on `row-actions-menu.tsx` for structure (portal, fixed
 * position derived from `getBoundingClientRect()`, flip-up when it does not
 * fit, capture-phase scroll close), but positioning is derived **during
 * render** rather than from a positioning effect: `open` arrives as a prop
 * here (there is no click handler in this component to measure in), and
 * re-measuring on every render while open means there is never a
 * stale-position frame — the panel closes on capture-phase scroll before a
 * stale position could show anyway.
 *
 * The capture-phase Escape listener (registered on `document`, calling
 * `stopPropagation()` before `onClose`) is deliberate: `useEscapeKey` and
 * the Composer's own Escape handler are bubble-phase, so without capturing
 * first, an Escape meant to close a picker nested inside the Composer would
 * also close the Composer and discard a typed title.
 *
 * None of that behaviour changed in the Deck conversion — only the chrome.
 * `components/row-actions-menu.tsx` cites this file as its structural model
 * and is unaffected: nothing it borrows (the portal, the measured fixed
 * position, the flip, the capture-phase listeners) was touched.
 */

// Rough panel height used only to decide whether to flip up, mirroring
// row-actions-menu.tsx's ITEM_HEIGHT/MENU_PADDING estimate.
const POP_EST_HEIGHT = 320;

/* ── Local constants ──────────────────────────────────────────────────────
   Deck has no anchored-popover primitive. `.dk-modal` is the panel — border,
   ground, capped height, and the `min-width: 0` opt-out from the 900px row
   floor under 1100px — so this takes it and overrides only the two things a
   centred dialog would otherwise decide: where it sits and how wide it is.
   Same move `components/notification-bell.tsx` makes for the bell. */

/** `.dk-modal` is `width: min(680px, 100%)`, sized for a dialog. A dropdown
 *  hugs its anchor instead; these are `.tb-pop`'s widths verbatim. */
const PANEL_STYLE: CSSProperties = {
  zIndex: 200,
  width: "auto",
  minWidth: 200,
  maxWidth: 280,
};

/** The click-outside catcher. One below the panel, and transparent — it exists
 *  to receive a click, not to dim anything (`.dk-scrim` would darken the page
 *  behind a dropdown, which no picker in this app does). */
const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 199,
  background: "transparent",
};

export interface PopoverProps {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  align?: "start" | "end";
  minWidth?: number;
  children: ReactNode;
}

export function Popover({
  anchor,
  open,
  onClose,
  align = "start",
  minWidth,
  children,
}: PopoverProps): ReactElement | null {
  // Subscribe-only effect: never calls setState itself, only invokes the
  // caller's onClose. Keeping position derivation out of an effect avoids
  // react-hooks/set-state-in-effect entirely.
  useEffect(() => {
    if (!open) return;
    function onScroll(): void {
      onClose();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose]);

  if (!open || !anchor) return null;

  const rect = anchor.getBoundingClientRect();
  const flipUp = rect.bottom + POP_EST_HEIGHT + 4 >= window.innerHeight;

  const style: CSSProperties = {
    ...PANEL_STYLE,
    position: "fixed",
    ...(minWidth != null ? { minWidth } : {}),
    // Every edge is written, including the ones this placement does not use.
    // `.dk-modal` itself sets none, but a half-specified `inset` leaves
    // whatever a future rule sets in place and stretches the panel across the
    // viewport — the kind of silent breakage that is invisible until it ships.
    ...(flipUp
      ? { top: "auto", bottom: window.innerHeight - rect.top + 4 }
      : { top: rect.bottom + 4, bottom: "auto" }),
    ...(align === "end"
      ? { left: "auto", right: window.innerWidth - rect.right }
      : { left: rect.left, right: "auto" }),
  };

  return createPortal(
    // `deck` because this portals to `document.body`, outside the `.deck` the
    // page draws inside — without it every Deck token resolves to nothing and
    // the panel renders as an unstyled white box. `display: contents` keeps
    // the wrapper out of layout (`launch/launch-composer.tsx` set the
    // precedent, `components/notification-bell.tsx` follows it).
    <div className="deck" style={{ display: "contents" }}>
      <div style={BACKDROP_STYLE} role="presentation" onClick={onClose} />
      <div className="dk-modal" role="dialog" aria-modal={false} style={style}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
