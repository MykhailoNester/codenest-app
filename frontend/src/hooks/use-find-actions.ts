/**
 * The three Find-mode actions (prototype `.x-find` actions section, minus
 * the omitted "Add to composer" row — see `explorer-find.tsx`'s file
 * comment), bound to `explorer-store`'s `selectedPath`.
 *
 * Shared by two callers that both need to act on "whichever result is
 * selected": `<ExplorerFind>`'s action-row buttons, and the search input's
 * keyboard shortcuts in `<WorkspaceNavigator>` / `<FindPaletteOverlay>`
 * (Enter / ⇧Enter / ⌘Enter) — one place to keep the disabled/enabled
 * reasoning and the IPC calls in sync.
 */

import { openInEditor, revealInFinder } from "../lib/ipc";
import { pastePathsIntoTerminal } from "./use-terminal-file-drop";
import { useExplorerStore } from "../stores/explorer-store";
import { useTerminalStore } from "../stores/terminal-store";
import { focusedPaneLeaf } from "../lib/explorer/roots";

export interface FindActions {
  hasSelection: boolean;
  canPaste: boolean;
  openSelected: () => void;
  pasteSelected: () => void;
  revealSelected: () => void;
}

export function useFindActions(): FindActions {
  const selectedPath = useExplorerStore((s) => s.selectedPath);
  const focusedLeafId = useTerminalStore((s) => s.focusedLeafId);
  const tabs = useTerminalStore((s) => s.tabs);
  // A dead pane's cwd is still worth following (Project mode keeps showing
  // it), but pasting into it would fire into a closed PTY — so the paste
  // action is disabled rather than silently swallowed by sendTerminalInput.
  const focusedLeafAlive =
    focusedLeafId !== null && focusedPaneLeaf(tabs, focusedLeafId)?.exited !== true;

  return {
    hasSelection: selectedPath !== null,
    canPaste: selectedPath !== null && focusedLeafAlive,
    openSelected: () => {
      if (selectedPath) void openInEditor(selectedPath);
    },
    pasteSelected: () => {
      if (selectedPath && focusedLeafId && focusedLeafAlive) {
        pastePathsIntoTerminal(focusedLeafId, [selectedPath]);
      }
    },
    revealSelected: () => {
      if (selectedPath) void revealInFinder(selectedPath);
    },
  };
}
