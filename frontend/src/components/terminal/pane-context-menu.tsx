import { useEffect, type ReactElement } from "react";
import { openPath, openExternalUrl } from "../../lib/ipc";
import styles from "./pane-context-menu.module.css";

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
    // Deck's tokens to nothing. `styles.scope` is `display: contents`, so
    // the wrapper carries the tokens and draws no box of its own.
    <div className={`deck ${styles.scope}`}>
      <span
        className={`dk-menu ${styles.menu}`}
        role="menu"
        style={{ left: x, top: y }}
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
                <span className={styles.shortcut}>{item.shortcut}</span>
              ) : null}
            </button>
          </span>
        ))}
      </span>
    </div>
  );
}
