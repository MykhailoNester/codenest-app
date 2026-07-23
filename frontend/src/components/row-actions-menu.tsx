import { useState, useRef, useEffect, type ReactElement } from "react";
import { createPortal } from "react-dom";
import styles from "./row-actions-menu.module.css";

export interface RowAction {
  label: string;
  icon?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

export interface RowActionsMenuProps {
  actions: RowAction[];
}

const ITEM_HEIGHT = 34;
const MENU_PADDING = 16;

export function RowActionsMenu({ actions }: RowActionsMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    top?: number;
    bottom?: number;
    right: number;
  }>({ top: 0, right: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);

  function openMenu(): void {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const estimatedHeight = actions.length * ITEM_HEIGHT + MENU_PADDING;
    const right = window.innerWidth - rect.right;
    const fitsBelow = rect.bottom + estimatedHeight + 4 < window.innerHeight;
    setPos(
      fitsBelow
        ? { top: rect.bottom + 4, right }
        : { bottom: window.innerHeight - rect.top + 4, right },
    );
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
            style={{
              top: pos.top,
              bottom: pos.bottom,
              right: pos.right,
              position: "fixed",
            }}
          >
            {actions.map((action) => (
              <button
                key={action.label}
                className={`${styles.item}${action.danger ? ` ${styles.itemDanger}` : ""}`}
                type="button"
                role="menuitem"
                disabled={action.disabled}
                onClick={() => {
                  close();
                  action.onSelect();
                }}
              >
                {action.label}
              </button>
            ))}
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
        aria-label="Row actions"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        •••
      </button>
      {dropdown}
    </div>
  );
}
