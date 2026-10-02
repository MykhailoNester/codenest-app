import { useEffect, type CSSProperties, type ReactElement } from "react";
import { openPath, openExternalUrl } from "../../lib/ipc";

/* ── Local constants ─────────────────────────────────────────────────────
   The right-click menu is Deck's `.dk-menu` — same box, same rows, same rule
   between groups. It is NOT `<DeckMenu>`: that primitive owns a trigger button
   and positions itself under it, whereas this menu has no trigger at all and
   must appear at the pointer, through a `document.body` portal. The markup it
   renders is the same, so the two look identical.

   Declared here rather than in `components/deck/*` or `design/deck/*`, which
   #283 does not touch — the precedent is the composer's `EDITOR_*` constants
   and the launch composer's `SCRIM_STYLE`. */

/** Carries Deck's tokens through the `document.body` portal without drawing a
 *  box: `display: contents` removes the wrapper from layout while custom
 *  properties and inherited values still pass to its children. */
const DECK_SCOPE_STYLE: CSSProperties = { display: "contents" };

/** Overrides `.dk-menu`'s own `position: absolute` and its `top`/`right`, which
 *  anchor it under a trigger. Inline, so no stylesheet injection order can
 *  decide it. `left`/`top` are merged in per render from the pointer. */
const MENU_STYLE: CSSProperties = {
  position: "fixed",
  top: "auto",
  right: "auto",
  zIndex: 9000,
  userSelect: "none",
};

/** The row is `.dk-menu button`; this adds only the trailing keystroke. */
const SHORTCUT_STYLE: CSSProperties = {
  marginLeft: "var(--u3)",
  float: "right",
  color: "var(--fg-4)",
  fontSize: "var(--fs-xs)",
};

export interface ContextMenuTarget {
  /** URL detected at right-click position, if any. */
  url?: string;
  /** File-system path detected at right-click position, if any. */
  path?: string;
}

interface MenuItem {
  label: string;
  shortcut?: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Draws a rule above this item — once, before each trailing group. */
  separated?: boolean;
}

interface PaneContextMenuProps {
  x: number;
  y: number;
  hasSelection: boolean;
  target: ContextMenuTarget;
  onCopy: () => void;
  onPaste: () => void;
  onClear: () => void;
  onClose: () => void;
}

export function PaneContextMenu({
  x,
  y,
  hasSelection,
  target,
  onCopy,
  onPaste,
  onClear,
  onClose,
}: PaneContextMenuProps): ReactElement {
  // Close on outside click or Escape.
  useEffect(() => {
    const handleClick = () => onClose();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // A URL goes through the opener's URL door, not its path door: `openPath`
  // stats its argument and fails on anything that is not a file, so routing a
  // link through it made this menu item silently do nothing.
  const handleOpenLink = () => {
    if (target.url) {
      void openExternalUrl(target.url).catch((err: unknown) => {
        console.error("pane-context-menu: could not open", target.url, err);
      });
    }
    onClose();
  };

  const handleCopyLink = () => {
    if (target.url) {
      void navigator.clipboard.writeText(target.url);
    }
    onClose();
  };

  const handleOpenPath = () => {
    if (target.path) {
      void openPath(target.path);
    }
    onClose();
  };

  const handleCopyPath = () => {
    if (target.path) {
      void navigator.clipboard.writeText(target.path);
    }
    onClose();
  };

  const items: MenuItem[] = [
    { label: "Copy", shortcut: "⌘C", disabled: !hasSelection, onSelect: onCopy },
    { label: "Paste", shortcut: "⌘V", onSelect: onPaste },
    { label: "Clear", shortcut: "⌘K", onSelect: onClear },
  ];
  if (target.url) {
    items.push(
      { label: "Open Link", separated: true, onSelect: handleOpenLink },
      { label: "Copy Link", onSelect: handleCopyLink },
    );
  }
  if (target.path) {
    items.push(
      // Only when the link group above did not already draw the rule.
      { label: "Open Path", separated: !target.url, onSelect: handleOpenPath },
      { label: "Copy Path", onSelect: handleCopyPath },
    );
  }

  return (
    // `deck` because this portals to `document.body`, outside the `.deck`
    // the Sessions page draws inside — without it the menu would resolve
    // Deck's tokens to nothing. `DECK_SCOPE_STYLE` is `display: contents`, so
    // the wrapper carries the tokens and draws no box of its own.
    <div className="deck" style={DECK_SCOPE_STYLE}>
      <span
        className="dk-menu"
        role="menu"
        style={{ ...MENU_STYLE, left: x, top: y }}
        // Stop the mousedown from propagating so the document handler above
        // doesn't immediately close the menu that was just opened.
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((item) => (
          <span key={item.label}>
            {item.separated === true ? <hr /> : null}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                item.onSelect();
                // The link/path handlers already close the menu; closing
                // again is a no-op and keeps every row's call site identical.
                onClose();
              }}
            >
              {item.label}
              {item.shortcut !== undefined ? (
                <span style={SHORTCUT_STYLE}>{item.shortcut}</span>
              ) : null}
            </button>
          </span>
        ))}
      </span>
    </div>
  );
}
