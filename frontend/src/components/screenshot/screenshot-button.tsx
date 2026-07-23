/**
 * ScreenshotButton — topbar icon-button that opens the screenshot ring.
 *
 * Placed in the `.d3-omni-row` beside `NotificationBell`.  Matches the bell's
 * button style exactly (32 px, transparent → bg-2 on hover, fg-2 → fg-1).
 *
 * Features:
 *   - Camera icon via the shared `Icon` component (name="camera").
 *   - CSS-only hover tooltip showing the action label + current hotkey.
 *   - One-time "first-use" hint popover the first time the button is clicked;
 *     persisted in localStorage("screenshot.hintSeen") so it never re-shows.
 *   - Hotkey read from `useTerminalSettings()` so it stays correct if the user
 *     changes the binding in Settings › Terminal › Screenshot.
 */

import {
  useRef,
  useState,
  useEffect,
  useCallback,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { openScreenshotRing } from "../../lib/ipc";
import { useTerminalSettings, SCREENSHOT_HOTKEY_DEFAULT } from "../../lib/api";
import { Icon } from "../icon";
import styles from "./screenshot-button.module.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HINT_STORAGE_KEY = "screenshot.hintSeen";
const HINT_AUTO_DISMISS_MS = 6000;

// ---------------------------------------------------------------------------
// Helper — format hotkey for display, e.g. "Ctrl+Shift+2" → readable label
// ---------------------------------------------------------------------------

function formatHotkey(hotkey: string): string {
  return hotkey
    .replace(/\bCtrl\b/g, "⌃")
    .replace(/\bShift\b/g, "⇧")
    .replace(/\bAlt\b/g, "⌥")
    .replace(/\bMeta\b/g, "⌘")
    .replace(/\+/g, " ");
}

// ---------------------------------------------------------------------------
// One-time hint popover
// ---------------------------------------------------------------------------

interface HintPopoverProps {
  hotkey: string;
  anchorRect: DOMRect;
  onDismiss: () => void;
}

function HintPopover({
  hotkey,
  anchorRect,
  onDismiss,
}: HintPopoverProps): ReactElement {
  // Position the popover below the anchor button, right-aligned to its right edge.
  const top = anchorRect.bottom + 8;
  // Right-align: fixed `right` = window width – button right edge.
  const right = window.innerWidth - anchorRect.right;

  // Auto-dismiss after HINT_AUTO_DISMISS_MS.
  useEffect(() => {
    const t = setTimeout(onDismiss, HINT_AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [onDismiss]);

  // Click-outside to dismiss.
  useEffect(() => {
    function handler(e: MouseEvent): void {
      // Let the click that opened the hint finish first.
      const target = e.target as Element | null;
      if (target?.closest(`.${styles.hint}`)) return;
      onDismiss();
    }
    // Use a short delay so the opening click doesn't immediately close it.
    const id = setTimeout(
      () => document.addEventListener("mousedown", handler),
      50,
    );
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", handler);
    };
  }, [onDismiss]);

  return createPortal(
    <div className={styles.hint} style={{ top, right }}>
      <div className={styles.hintHeader}>
        <Icon name="camera" size={15} className={styles.hintIcon} />
        <div className={styles.hintBody}>
          <p className={styles.hintTitle}>Screenshot ring</p>
          <p className={styles.hintText}>
            Press <kbd className={styles.hintKbd}>{formatHotkey(hotkey)}</kbd>{" "}
            anytime — even when the dashboard is not focused — to open the ring.
          </p>
        </div>
      </div>
      <div className={styles.hintDismiss}>
        <button
          type="button"
          className={styles.hintDismissBtn}
          onClick={onDismiss}
        >
          Got it
        </button>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ScreenshotButton(): ReactElement {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [showHint, setShowHint] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const { data: terminalSettings } = useTerminalSettings();
  const hotkey =
    terminalSettings?.screenshot_hotkey ?? SCREENSHOT_HOTKEY_DEFAULT;

  // Dismiss the one-time hint and persist the flag.
  const dismissHint = useCallback(() => {
    setShowHint(false);
    try {
      localStorage.setItem(HINT_STORAGE_KEY, "1");
    } catch {
      // localStorage may be unavailable in some environments — ignore.
    }
  }, []);

  function handleClick(): void {
    // Open the ring (same entry point as the global hotkey).
    void openScreenshotRing().catch((err: unknown) => {
      console.error("open_screenshot_ring failed:", err);
    });

    // Show the one-time hint if it hasn't been seen yet.
    const seen = (() => {
      try {
        return localStorage.getItem(HINT_STORAGE_KEY) === "1";
      } catch {
        return true; // treat as seen if localStorage is unavailable
      }
    })();
    if (!seen && buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect());
      setShowHint(true);
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.btn}
        aria-label="Open screenshot ring"
        onClick={handleClick}
      >
        <Icon name="camera" size={16} />
        {/* CSS-only tooltip — shown via :hover in CSS, no JS required */}
        <span className={styles.tooltip} aria-hidden="true">
          Screenshot
          <kbd className={styles.tooltipKbd}>{formatHotkey(hotkey)}</kbd>
        </span>
      </button>

      {showHint && anchorRect !== null && (
        <HintPopover
          hotkey={hotkey}
          anchorRect={anchorRect}
          onDismiss={dismissHint}
        />
      )}
    </>
  );
}
