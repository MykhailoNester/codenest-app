/**
 * RowActionsMenu — a row's overflow, drawn on Deck (#283).
 *
 * Why this is not just `<DeckMenu>`
 * ---------------------------------
 * `components/deck/deck-menu.tsx` is the overflow Deck ships, and it is the
 * right component for a row inside a `.dk-list`: it is `position: absolute`
 * inside a `.dk-more`, so it is clipped by any ancestor that scrolls or hides
 * overflow, and it always opens downward. This one portals to `document.body`
 * and measures the viewport first, so it survives both — a row near the bottom
 * of the window flips the menu upward instead of opening it off-screen. That
 * is a capability `DeckMenu` does not have, so the structure stays and only
 * the paint changes: `.dk-menu` and `.dk-btn` now draw it.
 *
 * `components/taskboard/popover.tsx` cites this file for exactly that
 * structure, which is the other reason not to collapse it into `DeckMenu`.
 */
import {
  useState,
  useRef,
  useEffect,
  type CSSProperties,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";

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

/**
 * `.dk-menu` is `position: absolute` with a `top`/`right` measured from its
 * `.dk-more` parent. Portalled to the body there is no such parent, so the
 * placement this component computes has to replace it outright — the same
 * override `components/notification-bell.tsx` makes in `POPOVER_STYLE` for
 * its own portalled panel.
 */
const MENU_POSITION: CSSProperties = { position: "fixed", zIndex: 9000 };

/**
 * The click-catcher under the menu. Deck has no backdrop primitive that does
 * not also dim — `.dk-scrim` paints `rgba(0,0,0,.55)`, which is right for a
 * modal and wrong for a row menu. So this is a local constant: a transparent
 * sheet whose only job is the outside click.
 */
const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 8999,
};

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
        // `deck` because this portals outside the `.deck` the page draws
        // inside — without it every Deck token resolves to nothing and the
        // menu renders as an unstyled white box. `display: contents` keeps
        // the wrapper out of layout, so the two fixed children below still
        // position against the viewport.
        <div className="deck" style={{ display: "contents" }}>
          <div
            style={BACKDROP_STYLE}
            onClick={close}
            onKeyDown={(e) => e.key === "Escape" && close()}
            role="presentation"
          />
          <div
            className="dk-menu"
            role="menu"
            style={{
              ...MENU_POSITION,
              top: pos.top,
              bottom: pos.bottom,
              right: pos.right,
            }}
          >
            {actions.map((action) => (
              <button
                key={action.label}
                className={action.danger ? "danger" : undefined}
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
        </div>,
        document.body,
      )
    : null;

  return (
    <span className="dk-more">
      <button
        ref={triggerRef}
        className="dk-btn bare icon"
        type="button"
        onClick={open ? close : openMenu}
        aria-label="Row actions"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        ···
      </button>
      {dropdown}
    </span>
  );
}
