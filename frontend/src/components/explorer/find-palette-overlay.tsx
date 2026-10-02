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

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
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

/**
 * The ⌘P card's two shapes (#283).
 *
 * `.dk-scrim` centres its child in the viewport; a find palette belongs near
 * the top, where the eye already is and where the result list grows downward
 * instead of pushing the field about as it fills. That is the one thing
 * overridden here — the dim and the inset stay Deck's.
 *
 * The z-index is the popout's own stacking order rather than the main
 * window's: this card has to sit over a maximized terminal pane, which
 * `.dk-scrim`'s 60 is under. It was 8000 before and stays 8000.
 */
const SCRIM_STYLE: CSSProperties = {
  placeItems: "start center",
  paddingTop: "12vh",
  zIndex: 8000,
};

/**
 * `.dk-modal` is 680px and caps at 85vh. A file palette is a narrow column of
 * paths and wants neither — the same inline-override move
 * `components/notification-bell.tsx` makes for its own popover.
 */
const CARD_STYLE: CSSProperties = {
  width: "520px",
  maxWidth: "92vw",
  maxHeight: "70vh",
};

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
    <div className="dk-scrim" style={SCRIM_STYLE} role="presentation">
      <div
        className="dk-modal"
        style={CARD_STYLE}
        data-modal
        role="dialog"
        aria-label="Find file"
      >
        <div className="dk-side__row">
          <div className="dk-field">
            <span aria-hidden="true" className="dim">
              ⌕
            </span>
            <input
              ref={inputRef}
              value={query}
              placeholder="search files…"
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
            <kbd className="dim" style={{ fontSize: "var(--fs-xs)" }}>
              ⌘P
            </kbd>
          </div>
        </div>
        <ExplorerFind roots={roots} />
        {/* `.dk-modal__f` is the footer Deck already draws for a panel — the
            rule above it and the flush-right cluster. A status line carries no
            buttons, so `.dk-meta` holds the text at the footnote tier. */}
        <div className="dk-modal__f">
          <span className="dk-meta">
            {formatCount(totalFiles)} files indexed across {indexedRoots} roots
            {watchBackend ? ` · watcher: ${watchBackend}` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
