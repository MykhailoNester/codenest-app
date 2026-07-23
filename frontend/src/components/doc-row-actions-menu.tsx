import { useState, useRef, useEffect, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { openPath, revealInFinder } from "../lib/ipc";
import styles from "./doc-row-actions-menu.module.css";

export interface DocRowActionsMenuProps {
  docId: number;
  filePath: string;
  exists: boolean;
  onDelete: () => void;
  onPreview: () => void;
}

export function DocRowActionsMenu({
  filePath,
  exists,
  onDelete,
  onPreview,
}: DocRowActionsMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);

  function openMenu(): void {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
    });
    setError(null);
    setOpen(true);
  }

  function close(): void {
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    function onScroll(): void {
      close();
    }
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [open]);

  async function handle(action: () => Promise<void>): Promise<void> {
    setError(null);
    close();
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const dropdown = open
    ? createPortal(
        <>
          <div
            className={styles.backdrop}
            onClick={close}
            onKeyDown={(e) => e.key === "Escape" && close()}
            role="presentation"
          />
          <div
            className={styles.dropdown}
            role="menu"
            style={{ top: pos.top, right: pos.right, position: "fixed" }}
          >
            <button
              className={styles.item}
              type="button"
              role="menuitem"
              disabled={!exists}
              onClick={() => void handle(() => openPath(filePath))}
            >
              Open
            </button>
            <button
              className={styles.item}
              type="button"
              role="menuitem"
              disabled={!exists}
              onClick={() => void handle(() => revealInFinder(filePath))}
            >
              Reveal in Finder
            </button>
            <button
              className={styles.item}
              type="button"
              role="menuitem"
              onClick={() => {
                void navigator.clipboard.writeText(filePath);
                close();
              }}
            >
              Copy Path
            </button>
            <button
              className={styles.item}
              type="button"
              role="menuitem"
              disabled={!exists}
              onClick={() => {
                close();
                onPreview();
              }}
            >
              Preview
            </button>
            <div className={styles.separator} role="separator" />
            <button
              className={`${styles.item} ${styles.itemDanger}`}
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                onDelete();
              }}
            >
              Remove
            </button>
          </div>
        </>,
        document.body,
      )
    : null;

  return (
    <div className={styles.wrapper}>
      <button
        ref={triggerRef}
        className={styles.trigger}
        type="button"
        onClick={open ? close : openMenu}
        aria-label="Document actions"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        •••
      </button>
      {dropdown}
      {error !== null && <span className={styles.error}>{error}</span>}
    </div>
  );
}
