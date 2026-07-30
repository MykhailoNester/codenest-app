/**
 * In-window HTML5 drop target for a `TerminalPane`.
 *
 * A drag that starts on a workspace-navigator tree row and ends on a shell
 * pane is an ordinary HTML5 drag inside one webview — it never reaches
 * Tauri's `onDragDropEvent` (that path is for OS/Finder drops and stays
 * exactly as it is; see `use-terminal-file-drop.ts`), so it needs its own
 * `onDrop` handler. No coordinate math is needed here, unlike the Tauri
 * OS-drop path: an HTML5 `DragEvent` already targets the element directly.
 */

import { useState, type DOMAttributes } from "react";
import {
  CODENEST_PATHS_MIME,
  readPathDragPayload,
} from "../lib/explorer/drag-payload";
import { pastePathsIntoTerminal } from "./use-terminal-file-drop";

export interface UsePanePathDropResult {
  dropActive: boolean;
  handlers: Pick<
    DOMAttributes<HTMLDivElement>,
    "onDragOver" | "onDragEnter" | "onDragLeave" | "onDrop"
  >;
}

export function usePanePathDrop(terminalId: string): UsePanePathDropResult {
  const [dropActive, setDropActive] = useState(false);

  const acceptsDrag = (dt: DataTransfer): boolean =>
    dt.types.includes(CODENEST_PATHS_MIME);

  return {
    dropActive,
    handlers: {
      onDragOver: (e) => {
        if (!acceptsDrag(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      },
      onDragEnter: (e) => {
        if (!acceptsDrag(e.dataTransfer)) return;
        e.preventDefault();
        setDropActive(true);
      },
      onDragLeave: () => {
        setDropActive(false);
      },
      onDrop: (e) => {
        // Never let the drop bubble to a parent handler regardless of
        // whether it turns out to be a Codenest paths drag.
        e.preventDefault();
        e.stopPropagation();
        setDropActive(false);

        const paths = readPathDragPayload(e.dataTransfer);
        if (paths) {
          pastePathsIntoTerminal(terminalId, paths);
          return;
        }
        // Not a recognised Codenest drag — fall back to text/plain, one
        // path per line, matching writePathDragPayload's own fallback shape.
        const text = e.dataTransfer.getData("text/plain");
        if (text) {
          const fallbackPaths = text.split("\n").filter((p) => p.length > 0);
          if (fallbackPaths.length > 0) {
            pastePathsIntoTerminal(terminalId, fallbackPaths);
          }
        }
      },
    },
  };
}
