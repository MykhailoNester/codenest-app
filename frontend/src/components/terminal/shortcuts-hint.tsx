import { useState, type CSSProperties, type ReactElement } from "react";
import { createPortal } from "react-dom";

/* ── Local constants ─────────────────────────────────────────────────────
   The shortcuts panel. It `createPortal`s to `document.body`, outside the
   `.deck` the Sessions page draws inside, so the markup carries its own `deck`
   scope and the panel itself is Deck's dialog primitive — `.dk-modal` with
   `__h`/`__b` — anchored bottom-right instead of centred in a scrim. Declared
   here rather than in `components/deck/*` or `design/deck/*`, which #283 does
   not touch — the precedent is the composer's `EDITOR_*` constants and the
   launch composer's `SCRIM_STYLE`.

   Inline, so these override the `.dk-*` rules without depending on which
   stylesheet the bundler injects first. */

/** Carries Deck's tokens through the portal without drawing a box of its own:
 *  `display: contents` removes the wrapper from layout while custom properties
 *  and inherited values still pass to its children. */
const DECK_SCOPE_STYLE: CSSProperties = { display: "contents" };

/** Backdrop — closes the panel on click. No fill: this panel is a reference
 *  card, not a modal that blocks the session behind it. That is why it is not
 *  `.dk-scrim`, which dims what is underneath and centres its child. */
const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 7000,
};

const PANEL_STYLE: CSSProperties = {
  position: "fixed",
  bottom: "var(--u4)",
  right: "var(--u6)",
  zIndex: 7001,
  width: 340,
  maxHeight: "min(70vh, 560px)",
};

/** The list is the modal body; `.dk-modal__b`'s 16px page padding is the wrong
 *  rhythm for eighteen one-line rows. */
const LIST_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: "var(--u2) var(--u3)",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--u3)",
  minHeight: "var(--row)",
  padding: "0 var(--u)",
};

/** `.row + .row` as data: an adjacent-sibling rule is the other thing an
 *  inline style cannot express, so the divider is drawn from the row index. */
const ROW_DIVIDED_STYLE: CSSProperties = {
  ...ROW_STYLE,
  borderTop: "1px solid var(--line)",
};

const KEYS_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 3,
  flexShrink: 0,
};

/** One key cap. `.dk-tag` is Deck's nearest pill and is the wrong one — it
 *  carries no border, and a keystroke has to read as a key rather than as a
 *  label. */
const KBD_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 20,
  padding: "0 var(--u)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-2)",
  borderRadius: 2,
  fontFamily: "var(--mono)",
  fontSize: "var(--fs-xs)",
  color: "var(--fg-2)",
  textAlign: "center",
  whiteSpace: "nowrap",
};

const DESC_STYLE: CSSProperties = {
  flex: "1 1 auto",
  textAlign: "right",
  color: "var(--fg-3)",
  fontSize: "var(--fs-s)",
};

const TRIGGER_STYLE: CSSProperties = { marginLeft: "auto" };

interface ShortcutRow {
  keys: string[];
  label: string;
}

/**
 * Shortcut definitions pulled directly from use-terminal-shortcuts.ts, plus
 * (#22) the dock/composer navigation bindings, which come from
 * `agent-composer.tsx`'s `handleKeyDown` and `agent-activity-dock.tsx`'s row
 * keyboard handler — a future change to either has two places to mirror.
 * Update here if bindings change.
 */
const SHORTCUTS: ShortcutRow[] = [
  { keys: ["⌘", "T"], label: "New tab" },
  { keys: ["⌘", "W"], label: "Close active pane / tab" },
  { keys: ["⌘", "D"], label: "Split horizontal" },
  { keys: ["⌘", "⇧", "D"], label: "Split vertical" },
  { keys: ["⌘", "1–9"], label: "Switch to tab N" },
  { keys: ["⌘", "↩"], label: "Expand / restore pane" },
  { keys: ["Esc"], label: "Restore expanded pane" },
  { keys: ["⌘", "F"], label: "Search in terminal" },
  { keys: ["⌘", "K"], label: "Clear viewport" },
  { keys: ["⌘", "⇧", "K"], label: "Hard clear (+ scrollback)" },
  { keys: ["⌘", "="], label: "Increase font size" },
  { keys: ["⌘", "−"], label: "Decrease font size" },
  { keys: ["⌘", "0"], label: "Reset font size" },
  { keys: ["⌃", "↑ / ↓"], label: "Agent composer — move the activity-dock cursor" },
  { keys: ["↑ / ↓"], label: "Activity dock — move the cursor" },
  { keys: ["→ / ↩"], label: "Activity dock — open the highlighted agent" },
  { keys: ["← / Esc"], label: "Activity dock — back to the main transcript" },
  { keys: ["Esc"], label: "Viewing a sub-agent — back to the main transcript" },
];

export function ShortcutsHint(): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="dk-tab"
        style={TRIGGER_STYLE}
        onClick={() => setOpen((v) => !v)}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        aria-expanded={open}
      >
        ?
      </button>
      {open
        ? createPortal(
            // `deck` because this portals to `document.body`, outside the
            // `.deck` the Sessions page draws inside — without it the panel
            // would resolve Deck's tokens to nothing. `DECK_SCOPE_STYLE` is
            // `display: contents`, so the wrapper carries the tokens and
            // draws no box of its own.
            <div className="deck" style={DECK_SCOPE_STYLE}>
              <div
                style={BACKDROP_STYLE}
                onClick={() => setOpen(false)}
                role="presentation"
              />
              <div
                className="dk-modal"
                style={PANEL_STYLE}
                role="dialog"
                aria-label="Terminal keyboard shortcuts"
              >
                <div className="dk-modal__h">
                  keyboard shortcuts
                  <span className="sp" />
                  <button
                    type="button"
                    className="dk-btn bare icon"
                    onClick={() => setOpen(false)}
                    aria-label="Close shortcuts"
                  >
                    ×
                  </button>
                </div>
                <ul className="dk-modal__b" style={LIST_STYLE}>
                  {SHORTCUTS.map(({ keys, label }, row) => (
                    <li key={label} style={row === 0 ? ROW_STYLE : ROW_DIVIDED_STYLE}>
                      <span style={KEYS_STYLE}>
                        {keys.map((k, i) => (
                          <kbd key={i} style={KBD_STYLE}>
                            {k}
                          </kbd>
                        ))}
                      </span>
                      <span style={DESC_STYLE}>{label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
