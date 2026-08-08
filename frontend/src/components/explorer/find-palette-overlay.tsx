/**
 * The popout's ⌘P surface (Design decision 11 / Popped-out windows section
 * of the research doc, §12): detached terminal windows never get the 262 px
 * panel — a popout is a focused surface the panel would eat a third of —
 * so they get this instead: the same `<ExplorerFind>` body as the main
 * panel, in a centred card over a scrim, with zero persistent chrome when
 * closed.
 *
 * Builds its own file indexes with `fsBuildFileIndex` and reads
 * `fsWatchStatus`, but NEVER calls `fsWatchSetRoots` (Design decision 5) —
 * one `FsWatchManager` is app-global, and the main window already owns it.
 * `data-modal` on the card lets `use-terminal-shortcuts.ts`'s maximize-Escape
 * guard (`:26-29`) recognise this as an unrelated modal surface and leave
 * Escape to this component instead of also restoring a maximized pane.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useProjects } from "../../lib/api";
import {
  fsBuildFileIndex,
  fsWatchStatus,
  getWorkspacePath,
} from "../../lib/ipc";
import { useExplorerStore } from "../../stores/explorer-store";
import { useExplorerHotkey } from "../../hooks/use-explorer-hotkey";
import { useFindActions } from "../../hooks/use-find-actions";
import { resolveRoots } from "../../lib/explorer/roots";
import { formatCount } from "../../lib/format-helpers";
import { ExplorerFind } from "./explorer-find";
import styles from "./workspace-navigator.module.css";
import overlayStyles from "./find-palette-overlay.module.css";

export function FindPaletteOverlay(): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [watchBackend, setWatchBackend] = useState<string | null>(null);
  const projectsQuery = useProjects();
  const setIndex = useExplorerStore((s) => s.setIndex);
  const query = useExplorerStore((s) => s.query);
  const setQuery = useExplorerStore((s) => s.setQuery);
  const indexByRootId = useExplorerStore((s) => s.indexByRootId);
  const { canPaste, openSelected, pasteSelected, revealSelected } =
    useFindActions();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void getWorkspacePath()
      .then((path) => {
        if (!cancelled) setWorkspacePath(path);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const roots = useMemo(
    () => resolveRoots(projectsQuery.data ?? [], workspacePath),
    [projectsQuery.data, workspacePath],
  );
  // JSON.stringify, not `.join(" ")` — a path containing a space (e.g. a
  // "Google Drive" or "My Project" directory, both real on macOS) would
  // otherwise collide with a distinct root set that happens to join to the
  // same string.
  const rootsKey = JSON.stringify(roots.map((r) => r.requestedPath));

  useEffect(() => {
    if (!open) return;
    void fsWatchStatus()
      .then((state) => setWatchBackend(state.backend))
      .catch(() => undefined);
    void Promise.allSettled(
      roots.map(async (root) => {
        const index = await fsBuildFileIndex(root.requestedPath);
        setIndex(root.id, index);
      }),
    );
    // roots is intentionally excluded: rootsKey is the real "did the
    // resolved root set change" signal (see use-explorer-sync.ts for the
    // same pattern).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rootsKey, setIndex]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const handleToggle = (): void => setOpen((o) => !o);
  const handleEscape = (e: KeyboardEvent): void => {
    if (!open) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
  };
  useExplorerHotkey(handleToggle, handleEscape);

  if (!open) return null;

  const totalFiles = Object.values(indexByRootId).reduce(
    (sum, i) => sum + i.count,
    0,
  );
  const indexedRoots = Object.keys(indexByRootId).length;

  return (
    <div className={overlayStyles.scrim} role="presentation">
      <div
        className={overlayStyles.card}
        data-modal
        role="dialog"
        aria-label="Find file"
      >
        <div className={styles.expsearch}>
          <div className={styles.sbox}>
            <span aria-hidden="true">⌕</span>
            <input
              ref={inputRef}
              className={styles.q}
              value={query}
              placeholder="Search files…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  openSelected();
                } else if (e.key === "Enter" && e.shiftKey) {
                  e.preventDefault();
                  if (canPaste) pasteSelected();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  revealSelected();
                }
              }}
            />
            <span className={styles.kbd}>⌘P</span>
          </div>
        </div>
        <ExplorerFind roots={roots} />
        <div className={overlayStyles.foot}>
          {formatCount(totalFiles)} files indexed across {indexedRoots}{" "}
          roots
          {watchBackend ? ` · watcher: ${watchBackend}` : ""}
        </div>
      </div>
    </div>
  );
}
