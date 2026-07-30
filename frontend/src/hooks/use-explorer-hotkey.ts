import { useEffect } from "react";

/**
 * Registers the workspace navigator's ⌘P palette shortcut and Escape, once
 * per window. Capture phase — same technique and reason as
 * `use-terminal-shortcuts.ts`'s window listener: it must fire before
 * xterm's `attachCustomKeyEventHandler` (`terminal-pane.tsx:556`), and ⌘P
 * would otherwise trigger the WebView's own Print dialog.
 *
 * Bound once per window: by `<WorkspaceNavigator>` in the main window, by
 * `<FindPaletteOverlay>` in the popout. Both mounts are already conditional
 * on the `explorer` feature toggle, so with the toggle off neither
 * component — and therefore neither listener — exists; the hook itself
 * needs no additional gating.
 *
 * `onEscape` receives the raw event so the caller can decide whether it
 * actually owns this Escape (and only then call `preventDefault` /
 * `stopPropagation`) rather than swallowing every Escape in the window
 * unconditionally.
 */
export function useExplorerHotkey(
  onToggleFind: () => void,
  onEscape: (e: KeyboardEvent) => void,
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        e.stopPropagation();
        onToggleFind();
        return;
      }
      if (e.key === "Escape") {
        onEscape(e);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onToggleFind, onEscape]);
}
