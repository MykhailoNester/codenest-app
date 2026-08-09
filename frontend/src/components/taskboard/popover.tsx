import { useEffect, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Fixed-position dropdown panel, portalled to `document.body`. Modelled on
 * `row-actions-menu.tsx` for structure (portal, fixed position derived from
 * `getBoundingClientRect()`, flip-up when it does not fit, capture-phase
 * scroll close), but positioning is derived **during render** rather than
 * from a positioning effect: `open` arrives as a prop here (there is no
 * click handler in this component to measure in), and re-measuring on every
 * render while open means there is never a stale-position frame — the panel
 * closes on capture-phase scroll before a stale position could show anyway.
 *
 * The capture-phase Escape listener (registered on `document`, calling
 * `stopPropagation()` before `onClose`) is deliberate: `useEscapeKey` and
 * the Composer's own Escape handler are bubble-phase, so without capturing
 * first, an Escape meant to close a picker nested inside the Composer would
 * also close the Composer and discard a typed title.
 */

// Rough panel height used only to decide whether to flip up, mirroring
// row-actions-menu.tsx's ITEM_HEIGHT/MENU_PADDING estimate.
const POP_EST_HEIGHT = 320;

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
    position: "fixed",
    ...(minWidth != null ? { minWidth } : {}),
    ...(flipUp
      ? { bottom: window.innerHeight - rect.top + 4 }
      : { top: rect.bottom + 4 }),
    ...(align === "end"
      ? { right: window.innerWidth - rect.right }
      : { left: rect.left }),
  };

  return createPortal(
    <>
      <div
        className="tb-pop__backdrop"
        role="presentation"
        onClick={onClose}
      />
      <div className="tb-pop" role="dialog" aria-modal={false} style={style}>
        {children}
      </div>
    </>,
    document.body,
  );
}
