import { useEffect } from "react";
import { useTerminalStore, type TerminalStore } from "../stores/terminal-store";
import { sendTerminalInput } from "../lib/ipc";
import { findLeaf, paneKind, type PaneLeaf } from "../lib/layout-tree";
import { readComposerFeature } from "../lib/composer-feature";

/** The leaf `store.focusedLeafId` names, within the active tab's layout. */
function findFocusedLeaf(store: TerminalStore): PaneLeaf | null {
  const tab = store.tabs.find((t) => t.id === store.activeTabId);
  if (!tab || !store.focusedLeafId) return null;
  return findLeaf(tab.layout, store.focusedLeafId);
}

/**
 * Window-level keyboard shortcuts for the terminal page.
 *
 * Registered in the capture phase so app-level Cmd-shortcuts
 * (`Cmd+T`, `Cmd+W`, `Cmd+D`, `Cmd+Shift+D`, `Cmd+1..9`) intercept the
 * keystroke before xterm.js or the macOS WebView default — without this,
 * `Cmd+W` would close the entire window and `Cmd+T` would do nothing
 * because xterm swallows the event.
 *
 * Other Cmd-combinations (`Cmd+C`, `Cmd+V`, `Cmd+K`, etc.) are not handled
 * here and continue to flow through to xterm / the shell as expected.
 */
export function useTerminalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const store = useTerminalStore.getState();

      // Esc — collapse a maximized pane back to grid view.  Only fires when
      // a pane is maximized; otherwise the keystroke flows to xterm/shell.
      if (e.key === "Escape" && store.maximizedLeafId !== null) {
        // Bail out if any modal-ish overlay — or the composer / permission
        // dialog, which each own Escape themselves (interrupt / deny) — owns
        // the keypress already.
        const t = e.target as HTMLElement | null;
        const isInModal =
          t?.closest?.(
            "[data-modal], [data-agent-composer], [data-permission-dialog]",
          ) !== null &&
          t?.closest?.(
            "[data-modal], [data-agent-composer], [data-permission-dialog]",
          ) !== undefined;
        if (!isInModal) {
          e.preventDefault();
          e.stopPropagation();
          store.restoreMaximize();
          return;
        }
      }

      if (!e.metaKey) return;
      const key = e.key.toLowerCase();

      // ⌘⇧T (shell sibling from an agent pane) / ⌘⇧A (agent sibling from a
      // shell pane) — both dark unless `composer` is on. Placed here, above
      // the text-field bail below, because both require Shift plus a letter
      // (so neither can shadow native text editing) and the composer's own
      // `<textarea>` must still receive them while focused. Each falls
      // through to the branches further down when its own guard fails: ⌘⇧T
      // still reaches the plain `key === "t"` branch (opens a new tab)
      // everywhere it does today (`readComposerFeature` — no React, no
      // provider — is safe to call on every keystroke).
      const composerOn = readComposerFeature();
      if (composerOn && e.shiftKey && key === "t" && store.focusedLeafId) {
        const leaf = findFocusedLeaf(store);
        if (leaf && paneKind(leaf) === "agent") {
          e.preventDefault();
          e.stopPropagation();
          void store.splitPane(leaf.terminalId, "h");
          return;
        }
      }
      if (composerOn && e.shiftKey && key === "a" && store.focusedLeafId) {
        const leaf = findFocusedLeaf(store);
        if (leaf && paneKind(leaf) !== "agent") {
          e.preventDefault();
          e.stopPropagation();
          void store.splitPane(leaf.terminalId, "h", { kind: "agent" });
          return;
        }
      }

      // Bail out for meta-key combos only when a GENUINE text field owns focus
      // (e.g. the inline tab/pane rename input) so Cmd+Left/Right/Backspace edit
      // it natively. xterm's hidden keyboard proxy is itself a
      // <textarea class="xterm-helper-textarea"> living inside the `.xterm`
      // root; when a pane — or a Claude session inside it — has focus that
      // textarea owns focus, so we must NOT bail there or every shortcut
      // (Cmd+W/T/D/1-9 and the Cmd+arrow line-nav) would die whenever the
      // terminal is focused (only working when the tab itself was clicked).
      const t2 = e.target as HTMLElement | null;
      const isTerminalInput = !!t2?.closest?.(".xterm");
      if (
        !isTerminalInput &&
        (t2 instanceof HTMLInputElement || t2 instanceof HTMLTextAreaElement)
      ) {
        return;
      }

      // ⌘← — move to beginning of line (readline Ctrl-A, \x01)
      if (e.key === "ArrowLeft" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (store.focusedLeafId) void sendTerminalInput(store.focusedLeafId, "\x01");
        return;
      }
      // ⌘→ — move to end of line (readline Ctrl-E, \x05)
      if (e.key === "ArrowRight" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (store.focusedLeafId) void sendTerminalInput(store.focusedLeafId, "\x05");
        return;
      }
      // ⌘⌫ — delete to beginning of line (readline Ctrl-U, \x15).
      // Guard !shiftKey for consistency with ⌘←/⌘→ and to leave
      // ⌘⇧⌫ free for a future binding.
      if (e.key === "Backspace" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (store.focusedLeafId) void sendTerminalInput(store.focusedLeafId, "\x15");
        return;
      }

      // Cmd+Enter — toggle maximize on the focused pane (Warp parity).
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (store.focusedLeafId) store.toggleMaximize(store.focusedLeafId);
        return;
      }

      // Cmd+Shift+E — toggle maximize on the focused pane (legacy shortcut kept).
      if (key === "e" && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (store.focusedLeafId) store.toggleMaximize(store.focusedLeafId);
        return;
      }

      if (key === "d" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (store.focusedLeafId) void store.splitPane(store.focusedLeafId, "h");
        return;
      }
      if (key === "d" && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (store.focusedLeafId) void store.splitPane(store.focusedLeafId, "v");
        return;
      }
      if (key === "w") {
        e.preventDefault();
        e.stopPropagation();
        // Close the focused pane only. The store cascades to closing the
        // tab when the last pane is removed; the tab is then re-seeded so
        // the user is never left with zero terminals.
        if (store.focusedLeafId) void store.closePane(store.focusedLeafId);
        return;
      }
      if (key === "t") {
        e.preventDefault();
        e.stopPropagation();
        void store.addTab();
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const index = Number(e.key) - 1;
        const target = store.tabs[index];
        if (target) {
          e.preventDefault();
          e.stopPropagation();
          store.setActiveTab(target.id);
        }
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
