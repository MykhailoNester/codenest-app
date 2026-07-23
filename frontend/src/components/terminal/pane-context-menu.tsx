import { useEffect, type ReactElement } from "react";
import { openPath } from "../../lib/ipc";
import styles from "./pane-context-menu.module.css";

export interface ContextMenuTarget {
  /** URL detected at right-click position, if any. */
  url?: string;
  /** File-system path detected at right-click position, if any. */
  path?: string;
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

  const handleOpenLink = () => {
    if (target.url) {
      void openPath(target.url);
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

  return (
    <div
      className={styles.menu}
      style={{ left: x, top: y }}
      // Stop the mousedown from propagating so the document handler above
      // doesn't immediately close the menu that was just opened.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={styles.item}
        disabled={!hasSelection}
        onClick={() => {
          onCopy();
          onClose();
        }}
      >
        Copy
        <span className={styles.shortcut}>⌘C</span>
      </button>
      <button
        type="button"
        className={styles.item}
        onClick={() => {
          onPaste();
          onClose();
        }}
      >
        Paste
        <span className={styles.shortcut}>⌘V</span>
      </button>
      <button
        type="button"
        className={styles.item}
        onClick={() => {
          onClear();
          onClose();
        }}
      >
        Clear
        <span className={styles.shortcut}>⌘K</span>
      </button>
      {(target.url ?? target.path) ? (
        <div className={styles.separator} />
      ) : null}
      {target.url ? (
        <>
          <button
            type="button"
            className={styles.item}
            onClick={handleOpenLink}
          >
            Open Link
          </button>
          <button
            type="button"
            className={styles.item}
            onClick={handleCopyLink}
          >
            Copy Link
          </button>
        </>
      ) : null}
      {target.path ? (
        <>
          <button
            type="button"
            className={styles.item}
            onClick={handleOpenPath}
          >
            Open Path
          </button>
          <button
            type="button"
            className={styles.item}
            onClick={handleCopyPath}
          >
            Copy Path
          </button>
        </>
      ) : null}
    </div>
  );
}
