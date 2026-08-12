import { useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import styles from "./shortcuts-hint.module.css";

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
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        aria-expanded={open}
      >
        ?
      </button>
      {open
        ? createPortal(
            <div
              className={styles.backdrop}
              onClick={() => setOpen(false)}
              role="presentation"
            >
              <div
                className={styles.panel}
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-label="Terminal keyboard shortcuts"
              >
                <div className={styles.header}>
                  <span className={styles.title}>Keyboard Shortcuts</span>
                  <button
                    type="button"
                    className={styles.close}
                    onClick={() => setOpen(false)}
                    aria-label="Close shortcuts"
                  >
                    ×
                  </button>
                </div>
                <ul className={styles.list}>
                  {SHORTCUTS.map(({ keys, label }) => (
                    <li key={label} className={styles.row}>
                      <span className={styles.keys}>
                        {keys.map((k, i) => (
                          <kbd key={i} className={styles.kbd}>
                            {k}
                          </kbd>
                        ))}
                      </span>
                      <span className={styles.desc}>{label}</span>
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
