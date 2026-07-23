import { useEffect } from "react";

/**
 * Attach a document-level keydown listener that calls ``handler`` when
 * Escape is pressed.
 *
 * The listener is only registered while ``enabled`` is true (default).
 * Cleanup is handled automatically on unmount or when dependencies change.
 *
 * Usage:
 *   useEscapeKey(onClose);            // always active
 *   useEscapeKey(onClose, isOpen);    // only while modal is open
 */
export function useEscapeKey(handler: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") handler();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [handler, enabled]);
}
