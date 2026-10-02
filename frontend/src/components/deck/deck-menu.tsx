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
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
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
