import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";

/**
 * Popover primitive for a `.td-prop` row on the task detail page.
 *
 * Unlike `components/taskboard/popover.tsx` (fixed-position, portalled to
 * `document.body`, closes on capture-phase scroll because a fixed panel
 * goes stale under scroll), this menu is `position: absolute` inside a
 * `position: relative` `.td-pop` — the design's own layout. An absolute
 * menu tracks its trigger through scroll, so it deliberately does **not**
 * close on scroll; instead `.td-grid`'s own `overflow-y: auto` plus this
 * menu's `max-height: min(60vh,380px)` (`d3-taskdetail.css`) keep it
 * reachable. What IS copied from the taskboard popover is the part that
 * matters: the anchor lives in **state**, fed by a ref callback, and is
 * read during render (never a ref dereferenced at render time) — the
 * `react-hooks/refs` requirement — and Escape is handled on `document` in
 * the **capture** phase with `stopPropagation()` so a popover Escape can
 * never also cancel an in-progress title edit or reach any other listener.
 */

// Rough menu height used only to decide whether to flip up, mirroring
// taskboard/popover.tsx's own POP_EST_HEIGHT estimate.
const EST_HEIGHT = 320;
const DEFAULT_WIDTH = 200;

export interface TdPopoverProps {
  /** Accessible name of the field, e.g. "Status". */
  label: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Estimated menu width in px, used only for the right-edge flip test. */
  width?: number;
  renderTrigger: (ctx: {
    ref: (el: HTMLButtonElement | null) => void;
    open: boolean;
    onClick: () => void;
  }) => ReactElement;
  /** Render prop so an item can call `close()` right after firing its mutation. */
  children: (ctx: { close: () => void }) => ReactNode;
}

export function TdPopover({
  label,
  open,
  onOpenChange,
  width = DEFAULT_WIDTH,
  renderTrigger,
  children,
}: TdPopoverProps): ReactElement {
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [wrapperEl, setWrapperEl] = useState<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Closing always returns focus to the trigger first, so Escape, an
  // outside click and picking an item all leave the trigger focused.
  const close = useCallback(() => {
    anchorEl?.focus();
    onOpenChange(false);
  }, [anchorEl, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    }
    function onMouseDown(e: MouseEvent): void {
      if (wrapperEl && !wrapperEl.contains(e.target as Node)) close();
    }
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open, wrapperEl, close]);

  // Focus the current selection (or the first item) whenever the menu opens.
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (!menu) return;
    const selected = menu.querySelector<HTMLElement>('[aria-selected="true"]');
    (selected ?? menu.querySelector<HTMLElement>("button"))?.focus();
  }, [open]);

  function handleMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const menu = menuRef.current;
    if (!menu) return;
    const buttons = Array.from(
      menu.querySelectorAll<HTMLButtonElement>("button"),
    );
    if (buttons.length === 0) return;
    const currentIndex = buttons.findIndex((b) => b === document.activeElement);
    const delta = e.key === "ArrowDown" ? 1 : -1;
    const nextIndex = (currentIndex + delta + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  }

  const rect = anchorEl?.getBoundingClientRect();
  const up = rect ? rect.bottom + EST_HEIGHT + 8 >= window.innerHeight : false;
  const right = rect ? rect.left + width > window.innerWidth - 8 : false;

  return (
    <div className="td-pop" ref={setWrapperEl}>
      {renderTrigger({
        ref: setAnchorEl,
        open,
        onClick: () => onOpenChange(!open),
      })}
      {open ? (
        <div
          ref={menuRef}
          className={`td-pop__menu${up ? " is-up" : ""}${right ? " is-right" : ""}`}
          role="listbox"
          aria-label={label}
          onKeyDown={handleMenuKeyDown}
        >
          {children({ close })}
        </div>
      ) : null}
    </div>
  );
}
