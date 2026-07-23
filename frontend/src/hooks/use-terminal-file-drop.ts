/**
 * useTerminalFileDrop
 *
 * Subscribes to Tauri's native file-drop event for the current webview and
 * inserts any dropped file paths into the terminal pane under the cursor via
 * bracketed-paste sequences.
 *
 * # Why bracketed paste
 * Claude Code (v2.1.0+) detects a dropped/pasted image path only when it
 * arrives as a bracketed-paste sequence, not as character-by-character typed
 * input.  Its path-image handler fires on the `paste-start` / `paste-end`
 * key-name pair (verified in the claude binary: `case "[200~": key.name =
 * "paste-start"`) and reads the file when the pasted text matches
 * `/\.(png|jpe?g|gif|webp)$/i`.  The regex is end-anchored, so the path must
 * NOT be followed by a trailing newline, space, or any other character.
 *
 * Bracketed-paste sequences also work correctly in bash/zsh: both shells treat
 * ESC[200~ ... ESC[201~ as a paste bracket and insert the text verbatim.
 *
 * # Multi-file drops
 * Each dropped path gets its own independent bracketed-paste sequence,
 * concatenated back-to-back with NO separator.  A bare \r between sequences
 * would submit the first path in most shells and could interrupt Claude Code's
 * input handling.  The independent wrapping keeps each path end-anchored for
 * Claude's image regex.
 *
 * # Paste-escape injection defence
 * File names containing ESC[200~ or ESC[201~ could prematurely close the
 * bracketed-paste window and let subsequent bytes run as live input.  We strip
 * both markers from the path before wrapping.
 *
 * # Position -> pane mapping
 * Tauri reports the drop position in physical pixels.  We fetch the webview's
 * actual scale factor asynchronously (getCurrentWebview().scaleFactor()) so
 * the conversion is correct on every monitor, including HiDPI/Retina.
 * document.elementFromPoint(cssX, cssY) finds the element at the converted
 * coordinate; we walk up the DOM looking for data-terminal-id that
 * TerminalPane stamps on its root div.
 *
 * # Scope
 * Handles any dropped file path -- not restricted to screenshots.  This is the
 * expected terminal behavior and naturally covers our screenshot drag-out case.
 *
 * # File lifecycle
 * The hook does NOT delete the temp file after insertion.  The 10-minute
 * age-sweep in the Rust capture command handles cleanup; deleting immediately
 * would race with Claude Code reading the file asynchronously after paste.
 *
 * # Usage
 * Call once at the TerminalsLayout level -- covers both the embedded terminal
 * page and the detached terminals window without modifying terminal-pane.tsx
 * beyond the single data-terminal-id stamp.
 */

import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { collectLeafIds } from "../lib/layout-tree";
import { sendTerminalInput } from "../lib/ipc";
import { useTerminalStore } from "../stores/terminal-store";

// Bracketed-paste markers (ANSI/XTerm bracketed paste mode).
const BP_START = "\x1b[200~";
const BP_END = "\x1b[201~";

// Regex matching either bracketed-paste marker.  The ESC byte is inserted at
// runtime via String.fromCharCode(27) so neither a regex literal nor a
// RegExp(string) with an embedded control character is written in source —
// both forms trigger ESLint's no-control-regex rule.
const ESC = String.fromCharCode(27);
const BP_MARKER_RE = new RegExp(`${ESC}\\[20[01]~`, "g");

/**
 * Wrap `path` in bracketed-paste markers so terminals (and Claude Code) treat
 * it as a paste event rather than typed input.
 *
 * Strips embedded paste markers first to prevent a malicious filename from
 * prematurely closing the paste bracket and running subsequent bytes as live
 * terminal input.
 *
 * No trailing newline -- Claude Code's path regex is end-anchored and any
 * trailing character would break the match.
 */
function bracketedPaste(path: string): string {
  const safe = path.replace(BP_MARKER_RE, "");
  return `${BP_START}${safe}${BP_END}`;
}

/**
 * Given a point in CSS pixels, find the data-terminal-id of the
 * TerminalPane under that point.
 *
 * TerminalPane stamps data-terminal-id={terminalId} on its root div.
 * We walk up from the hit element until we find it or exhaust the tree.
 */
function terminalIdAtCssPoint(cssX: number, cssY: number): string | null {
  let el = document.elementFromPoint(cssX, cssY);
  while (el && el !== document.documentElement) {
    const id = (el as HTMLElement).dataset?.terminalId;
    if (id) return id;
    el = el.parentElement;
  }
  return null;
}

export function useTerminalFileDrop(): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;

        const { paths, position } = event.payload;
        if (paths.length === 0) return;

        // Fetch the window's actual scale factor for the current monitor.
        // More reliable than window.devicePixelRatio for setups where windows
        // span monitors with different scale factors.
        const scaleFactor = await getCurrentWindow()
          .scaleFactor()
          .catch(() => window.devicePixelRatio || 1);
        // Tauri reports `position` in physical pixels relative to the
        // NSWindow frame origin, which includes the native macOS titlebar.
        // document.elementFromPoint expects CSS pixels relative to the
        // WebView viewport (origin = below the titlebar).
        // window.outerHeight - window.innerHeight gives the titlebar height
        // in CSS pixels: it is ~28 px for standard-decoration windows and
        // exactly 0 for windows with decorations:false / transparent titlebar.
        const titlebarHeightCss = window.outerHeight - window.innerHeight;
        const cssX = position.x / scaleFactor;
        const cssY = position.y / scaleFactor - titlebarHeightCss;

        // Find which terminal pane is under the drop point.
        let targetId = terminalIdAtCssPoint(cssX, cssY);

        // Fallback: if no pane was under the pointer (e.g. dropped on the
        // tab bar), use the currently focused leaf.  Read from the store
        // directly to avoid stale-closure issues without re-subscribing.
        if (!targetId) {
          const { tabs, focusedLeafId } = useTerminalStore.getState();
          if (focusedLeafId) {
            const isVisible = tabs.some((tab) =>
              tab.layout.type === "leaf"
                ? tab.layout.terminalId === focusedLeafId
                : collectLeafIds(tab.layout).includes(focusedLeafId),
            );
            if (isVisible) targetId = focusedLeafId;
          }
        }

        if (!targetId) return;

        // Each path gets its own bracketed-paste sequence, concatenated with
        // NO separator.  A bare \r between sequences would submit/execute the
        // first path in most shells and could interrupt Claude Code.
        const input = paths.map(bracketedPaste).join("");
        void sendTerminalInput(targetId, input).catch((err) => {
          console.error("useTerminalFileDrop: sendTerminalInput failed:", err);
        });
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        console.error("useTerminalFileDrop: onDragDropEvent failed:", err);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // Empty deps: the listener is registered once per mount.  Store state is
    // read via useTerminalStore.getState() inside the handler so the closure
    // always sees the latest values without re-subscribing on every change.
  }, []);
}
