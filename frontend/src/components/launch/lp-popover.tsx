import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * `LpPopover` — the launch composer's selector menu, fixed-position and
 * portalled to `document.body`.
 *
 * `.lp-left`/`.lp-right` are `overflow-y: auto` (`d3-launch.css:19-20`) and
 * the mockup's own `.lp-pop__menu` is `position: absolute`
 * (`d3-launch.css:111`), so a menu opened from a pane sitting at the bottom
 * of a scrolled column would be clipped by that column. Two more reasons a
 * portal is not optional here: `.lp-scrim` sets `backdrop-filter: blur(8px)`
 * and `.lp-modal` runs a `transform` keyframe on open — either one makes its
 * subtree the containing block for a `position: fixed` descendant, so an
 * un-portalled fixed menu would be mispositioned during the open animation.
 *
 * Modelled on two existing popovers, taking different halves from each:
 * `components/taskboard/popover.tsx` (fixed position, portalled, capture-phase
 * scroll close because a fixed panel goes stale under scroll, an estimated
 * height rather than a measured one — measuring needs a layout effect +
 * `setState`, deliberately avoided) and
 * `components/task-detail/td-popover.tsx` (anchor + wrapper held in **state**,
 * fed by ref callbacks and read during render — never a ref dereferenced at
 * render time, the `react-hooks/refs` requirement — the render-prop
 * `children({close})` API, the `is-up`/`is-right` flip computation's
 * `rect ? … : false` guard, outside-mousedown close, and arrow-key roving
 * focus). The two-element outside-click check (wrapper *and* menu) is the one
 * thing `td-popover.tsx` does not need and this does: its menu is in-flow
 * inside the wrapper, this one is portalled, so it is not a descendant of it.
 *
 * The design's `.lp-pop__menu.is-up`/`.is-right` rules are inert under
 * `position: fixed` with inline offsets (`bottom: calc(100% + 5px)` would
 * resolve against the viewport, not the trigger) — see the header comment in
 * `styles/d3-launch.css`. The flip *logic* lives here and the class names are
 * still emitted as state markers; only the positioning math is inline.
 */

const DEFAULT_WIDTH = 220;

/**
 * The CSS's own `max-height: min(50vh,300px)` (`d3-launch.css:111`) used as
 * the flip estimate — an honest upper bound, since the real menu never
 * exceeds it.
 */
function estimatedMenuHeight(): number {
  return Math.min(window.innerHeight * 0.5, 300);
}

export interface LpSelectItem {
  id: string;
  label: string;
  /** A CSS colour for the `.lp-dot` swatch. `null` renders the neutral
   *  fallback; the prop is only rendered at all when the caller passes
   *  `dot`, so menu rows stay aligned when one item has no colour (D12 in
   *  the plan). */
  dot?: string | null;
}

export interface LpPopoverProps {
  /** Accessible name of the menu. */
  label: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Menu width in px — also used for the right-edge flip test. */
  width?: number;
  renderTrigger: (ctx: {
    ref: (el: HTMLButtonElement | null) => void;
    open: boolean;
    onClick: () => void;
  }) => ReactElement;
  /** Render prop so an item can call `close()` right after firing its pick. */
  children: (ctx: { close: () => void }) => ReactNode;
}

export function LpPopover({
  label,
  open,
  onOpenChange,
  width = DEFAULT_WIDTH,
  renderTrigger,
  children,
}: LpPopoverProps): ReactElement {
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [wrapperEl, setWrapperEl] = useState<HTMLDivElement | null>(null);
  const [menuEl, setMenuEl] = useState<HTMLDivElement | null>(null);

  // Closing always returns focus to the trigger first, so Escape, an
  // outside click and picking an item all leave the trigger focused.
  const close = useCallback(() => {
    anchorEl?.focus();
    onOpenChange(false);
  }, [anchorEl, onOpenChange]);

  // Subscribe-only while open: never calls setState itself, only ever
  // `close()` (which calls the caller's `onOpenChange`).
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== "Escape") return;
      // Capture phase + stopPropagation: an Escape meant to close this menu
      // must not also reach the dialog's own (bubble-phase) Escape handler.
      e.stopPropagation();
      close();
    }
    function onScroll(): void {
      // A fixed-position panel goes stale the instant its scrolling ancestor
      // moves — closing it beats leaving a detached panel on screen.
      close();
    }
    function onMouseDown(e: MouseEvent): void {
      const target = e.target as Node;
      if (wrapperEl?.contains(target)) return;
      if (menuEl?.contains(target)) return;
      close();
    }
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open, wrapperEl, menuEl, close]);

  // Focus the current selection (or the first item) whenever the menu opens.
  useEffect(() => {
    if (!open || !menuEl) return;
    const selected = menuEl.querySelector<HTMLElement>('[aria-selected="true"]');
    (selected ?? menuEl.querySelector<HTMLElement>("button"))?.focus();
  }, [open, menuEl]);

  function handleMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (!menuEl) return;
    const buttons = Array.from(menuEl.querySelectorAll<HTMLButtonElement>("button"));
    if (buttons.length === 0) return;
    const currentIndex = buttons.findIndex((b) => b === document.activeElement);
    const delta = e.key === "ArrowDown" ? 1 : -1;
    const nextIndex = (currentIndex + delta + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  }

  // A render that happens before the ref callback has run must not call
  // `getBoundingClientRect()` on null — the `rect ? … : false` shape from
  // `td-popover.tsx:111-113`.
  const rect = anchorEl?.getBoundingClientRect();
  const estH = estimatedMenuHeight();
  const up = rect
    ? rect.bottom + estH > window.innerHeight - 12 && rect.top - estH > 12
    : false;
  const right = rect ? rect.left + width > window.innerWidth - 12 : false;

  const style: CSSProperties = {
    position: "fixed",
    width,
    ...(rect
      ? up
        ? { bottom: window.innerHeight - rect.top + 5 }
        : { top: rect.bottom + 5 }
      : {}),
    ...(rect
      ? right
        ? { right: window.innerWidth - rect.right }
        : { left: rect.left }
      : {}),
  };

  return (
    <div className="lp-pop" ref={setWrapperEl}>
      {renderTrigger({
        ref: setAnchorEl,
        open,
        onClick: () => onOpenChange(!open),
      })}
      {open && anchorEl !== null
        ? createPortal(
            <div
              ref={setMenuEl}
              className={`lp-pop__menu${up ? " is-up" : ""}${right ? " is-right" : ""}`}
              role="listbox"
              aria-label={label}
              style={style}
              onKeyDown={handleMenuKeyDown}
            >
              {children({ close })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export interface LpSelectProps {
  label: string;
  /** The selected item's id. */
  value: string;
  items: readonly LpSelectItem[];
  onPick: (id: string) => void;
  width?: number;
  disabled?: boolean;
  /** Shown when `items` is empty or the select is otherwise disabled. */
  placeholder?: string;
}

export function LpSelect({
  label,
  value,
  items,
  onPick,
  width,
  disabled = false,
  placeholder = "—",
}: LpSelectProps): ReactElement {
  const [open, setOpen] = useState(false);
  const isDisabled = disabled || items.length === 0;
  const selected = items.find((it) => it.id === value) ?? null;

  return (
    <LpPopover
      label={label}
      open={open && !isDisabled}
      onOpenChange={setOpen}
      width={width}
      renderTrigger={({ ref, open: isOpen, onClick }) => (
        <button
          ref={ref}
          type="button"
          className={`lp-select${isOpen ? " is-open" : ""}`}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          disabled={isDisabled}
          onClick={onClick}
        >
          <span className="lp-select__v">{selected?.label ?? placeholder}</span>
          <span className="lp-select__caret" aria-hidden="true">
            ▾
          </span>
        </button>
      )}
    >
      {({ close }) =>
        items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={item.id === value}
            className={`lp-pop__i${item.id === value ? " is-sel" : ""}`}
            onClick={() => {
              onPick(item.id);
              close();
            }}
          >
            {item.dot !== undefined ? (
              <span
                className="lp-dot"
                aria-hidden="true"
                style={{ background: item.dot ?? "var(--fg-4)" }}
              />
            ) : null}
            <span>{item.label}</span>
            {item.id === value ? (
              <span className="lp-pop__c" aria-hidden="true">
                ✓
              </span>
            ) : null}
          </button>
        ))
      }
    </LpPopover>
  );
}
