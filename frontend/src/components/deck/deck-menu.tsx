import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

export interface DeckMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draws a rule above this item — use once, before the destructive group. */
  separated?: boolean;
}

/**
 * The overflow a row uses instead of a seventh button. Closes on outside click
 * and on Escape, and returns focus to its trigger so the keyboard model the
 * grid sets up is not broken by opening a menu.
 */
export function DeckMenu({
  items,
  label = "More actions",
  trigger = "···",
}: {
  items: DeckMenuItem[];
  label?: string;
  trigger?: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        // An open menu consumes the Escape. Without this a menu inside a
        // modal closes both at once — the dialog's own Escape handler is on
        // `document` too, and capture phase is the only place to get in
        // front of it.
        e.stopPropagation();
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <span className="dk-more" ref={root}>
      <button
        ref={btn}
        type="button"
        className="dk-btn bare icon"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          // `DeckLine` activates its row on Enter/Space. Without this, opening
          // this menu from the keyboard also fires the row's `onOpen` — you
          // get the menu and a navigation at once. Only the two activation
          // keys are stopped; arrow keys still reach `DeckGrid`'s roving
          // tabindex handler.
          if (e.key === "Enter" || e.key === " ") e.stopPropagation();
        }}
      >
        {trigger}
      </button>
      {open && (
        <span className="dk-menu" role="menu">
          {items.map((it, i) => (
            <span key={i}>
              {it.separated && <hr />}
              <button
                type="button"
                role="menuitem"
                className={it.danger ? "danger" : undefined}
                disabled={it.disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  it.onSelect();
                }}
              >
                {it.label}
              </button>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
