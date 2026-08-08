/**
 * The Explorer panel — 1:1 port of the `.exp` aside in
 * warp-class-input-composer-prototype.html (markup lines 487-593). Mounted
 * only in the main window (`TerminalPage`), only when the `explorer`
 * feature is on — see Design decision 3 in the workspace-navigator plan for
 * why the feature read is hoisted above `TerminalsLayout` rather than
 * living in this component.
 *
 * Owns: the header actions, the three-way mode switcher, the search box
 * (which doubles as the ⌘P entry point into Find), the tree host, the
 * footer (every number sourced from `WatchState`, never hardcoded — see
 * NO MOCK UI in the task), and the resize/collapse handle. The actual IPC
 * lifecycle lives in `use-explorer-sync.ts`, mounted once here.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import { fsBuildFileIndex, openInEditor, revealInFinder } from "../../lib/ipc";
import {
  useExplorerStore,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  type TreeMode,
} from "../../stores/explorer-store";
import { useExplorerSync } from "../../hooks/use-explorer-sync";
import { useExplorerHotkey } from "../../hooks/use-explorer-hotkey";
import { useFindActions } from "../../hooks/use-find-actions";
import { rootForCwd } from "../../lib/explorer/roots";
import { formatCount } from "../../lib/format-helpers";
import { ExplorerTree } from "./explorer-tree";
import { ChangedList } from "./changed-list";
import { ExplorerFind } from "./explorer-find";
import styles from "./workspace-navigator.module.css";

const RESIZE_ARROW_STEP = 16;

const MODE_CHIPS: { key: TreeMode; label: string }[] = [
  { key: "ws", label: "Workspace" },
  { key: "proj", label: "Project" },
  { key: "chg", label: "Changed" },
];

/** Maps the shell's stable backend slugs (`fswatch/mod.rs:387-399`) to
 *  display text. Never a hardcoded count — only this label is a literal,
 *  and it is a translation of a real enum value, not a guessed number. */
function backendLabel(backend: string): string {
  switch (backend) {
    case "fsevent":
      return "FSEvents";
    case "inotify":
      return "inotify";
    case "kqueue":
      return "kqueue";
    case "poll":
      return "polling";
    case "windows":
      return "ReadDirectoryChanges";
    default:
      return "no watcher";
  }
}

export function WorkspaceNavigator(): ReactElement {
  const mode = useExplorerStore((s) => s.mode);
  const lastTreeMode = useExplorerStore((s) => s.lastTreeMode);
  const setMode = useExplorerStore((s) => s.setMode);
  const enterFind = useExplorerStore((s) => s.enterFind);
  const exitFind = useExplorerStore((s) => s.exitFind);
  const query = useExplorerStore((s) => s.query);
  const setQuery = useExplorerStore((s) => s.setQuery);
  const watch = useExplorerStore((s) => s.watch);
  const selectedPath = useExplorerStore((s) => s.selectedPath);
  const panelWidth = useExplorerStore((s) => s.panelWidth);
  const panelCollapsed = useExplorerStore((s) => s.panelCollapsed);
  const setPanelWidth = useExplorerStore((s) => s.setPanelWidth);
  const setPanelCollapsed = useExplorerStore((s) => s.setPanelCollapsed);
  const collapseAll = useExplorerStore((s) => s.collapseAll);
  const setIndex = useExplorerStore((s) => s.setIndex);

  const { roots, followedRoot, refresh } = useExplorerSync();
  const { canPaste, openSelected, pasteSelected, revealSelected } =
    useFindActions();

  const [moreOpen, setMoreOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === "find") searchInputRef.current?.focus();
  }, [mode]);

  const handleToggleFind = useCallback(() => {
    if (mode === "find") exitFind();
    else enterFind();
  }, [mode, enterFind, exitFind]);

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (mode !== "find") return;
      e.preventDefault();
      e.stopPropagation();
      exitFind();
    },
    [mode, exitFind],
  );

  useExplorerHotkey(handleToggleFind, handleEscape);

  const menuTargetRoot =
    (selectedPath && rootForCwd(roots, selectedPath)) ?? roots[0] ?? null;

  const handleRevealRoot = (): void => {
    if (menuTargetRoot)
      void revealInFinder(
        menuTargetRoot.canonicalPath ?? menuTargetRoot.requestedPath,
      );
    setMoreOpen(false);
  };
  const handleOpenRoot = (): void => {
    if (menuTargetRoot)
      void openInEditor(
        menuTargetRoot.canonicalPath ?? menuTargetRoot.requestedPath,
      );
    setMoreOpen(false);
  };
  const handleCopyRootPath = (): void => {
    if (menuTargetRoot) {
      void navigator.clipboard.writeText(
        menuTargetRoot.canonicalPath ?? menuTargetRoot.requestedPath,
      );
    }
    setMoreOpen(false);
  };
  const handleRebuildIndex = (): void => {
    const watchedPaths = watch?.watchedRoots ?? [];
    const targets = roots.filter((r) =>
      watchedPaths.includes(r.canonicalPath ?? r.requestedPath),
    );
    void Promise.allSettled(
      targets.map(async (root) => {
        const index = await fsBuildFileIndex(root.requestedPath);
        setIndex(root.id, index);
      }),
    );
    setMoreOpen(false);
  };
  const handleCollapseAll = (): void => {
    collapseAll();
    setMoreOpen(false);
  };

  const onSearchFocus = (): void => {
    if (mode === "ws" || mode === "proj") enterFind();
  };

  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (mode !== "find") return;
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
  };

  const searchPlaceholder =
    mode === "chg" ? "Filter changed…" : "Search files…";

  // -- resize handle: live width follows the pointer, committed to the
  // persisted store only on pointerup so localStorage is not hammered. --
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragStartRef = useRef<{ pointerX: number; startWidth: number } | null>(
    null,
  );

  const clampWidth = (w: number): number =>
    Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, w));

  const onResizerPointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
  ): void => {
    dragStartRef.current = { pointerX: e.clientX, startWidth: panelWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizerPointerMove = (
    e: React.PointerEvent<HTMLDivElement>,
  ): void => {
    if (!dragStartRef.current) return;
    const delta = e.clientX - dragStartRef.current.pointerX;
    setDragWidth(clampWidth(dragStartRef.current.startWidth + delta));
  };
  const onResizerPointerUp = (): void => {
    if (dragStartRef.current && dragWidth !== null) {
      setPanelWidth(dragWidth);
    }
    dragStartRef.current = null;
    setDragWidth(null);
  };
  const onResizerKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setPanelWidth(clampWidth(panelWidth - RESIZE_ARROW_STEP));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setPanelWidth(clampWidth(panelWidth + RESIZE_ARROW_STEP));
    }
  };

  const widthPx = dragWidth ?? panelWidth;

  // Collapse/expand animates the panel's own width, so the body stays mounted
  // in both states — a `panelCollapsed` early-return swapping the aside for a
  // 14 px rail could not animate, because there was no shared element to
  // transition. The rail button is the only thing that swaps.
  //
  // The transition is suppressed mid-drag (`data-dragging`): a width that eases
  // toward the pointer instead of tracking it makes the resize handle feel
  // broken.
  return (
    <aside
      className={
        panelCollapsed ? `${styles.exp} ${styles.expCollapsed}` : styles.exp
      }
      style={panelCollapsed ? undefined : { width: widthPx }}
      data-dragging={dragWidth !== null ? "true" : undefined}
      data-collapsed={panelCollapsed ? "true" : "false"}
    >
      {panelCollapsed ? (
        <button
          type="button"
          className={styles.railBtn}
          aria-label="Expand Explorer panel"
          title="Expand Explorer panel"
          onClick={() => setPanelCollapsed(false)}
        >
          ⇥
        </button>
      ) : null}

      {/* `inert` while collapsed keeps the clipped body out of tab order and
          out of the accessibility tree — invisible must not mean focusable. */}
      {/* The body keeps its *expanded* width even while collapsed, so the
          narrowing aside clips it instead of reflowing every row into a 14 px
          column and back again on expand. */}
      <div
        className={styles.expbody}
        style={{ width: widthPx }}
        aria-hidden={panelCollapsed}
        inert={panelCollapsed}
      >
      <div className={styles.exphead}>
        <h3 className={styles.title}>Explorer</h3>
        <button
          type="button"
          className={styles.expicon}
          aria-label="Refresh"
          title="Refresh"
          onClick={refresh}
        >
          ⟳
        </button>
        <button
          type="button"
          className={styles.expicon}
          aria-label="More"
          title="More"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((o) => !o)}
        >
          ⋯
        </button>
        <button
          type="button"
          className={styles.expicon}
          aria-label="Collapse panel"
          title="Collapse panel"
          onClick={() => setPanelCollapsed(true)}
        >
          ⇤
        </button>
        {moreOpen && (
          <div className={styles.menu} role="menu">
            <button
              type="button"
              className={styles.menuItem}
              onClick={handleCollapseAll}
            >
              Collapse all
            </button>
            <button
              type="button"
              className={styles.menuItem}
              disabled={!menuTargetRoot}
              onClick={handleRevealRoot}
            >
              Reveal root in Finder
            </button>
            <button
              type="button"
              className={styles.menuItem}
              disabled={!menuTargetRoot}
              onClick={handleOpenRoot}
            >
              Open root in editor
            </button>
            <button
              type="button"
              className={styles.menuItem}
              disabled={!menuTargetRoot}
              onClick={handleCopyRootPath}
            >
              Copy root path
            </button>
            <button
              type="button"
              className={styles.menuItem}
              onClick={handleRebuildIndex}
            >
              Rebuild file index
            </button>
          </div>
        )}
      </div>

      <div className={styles.expmodes} role="tablist">
        {MODE_CHIPS.map((chip) => {
          const active =
            mode === chip.key || (mode === "find" && lastTreeMode === chip.key);
          const sublabel =
            chip.key === "ws"
              ? `${roots.length} roots`
              : chip.key === "proj"
                ? "follows pane"
                : "git";
          return (
            <span
              key={chip.key}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              className={`${styles.expmode} ${active ? styles.expmodeOn : ""}`}
              onClick={() => setMode(chip.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setMode(chip.key);
                }
              }}
            >
              {chip.label}
              <b className={styles.expmodeSub}>{sublabel}</b>
            </span>
          );
        })}
      </div>

      <div
        className={`${styles.expsearch} ${mode === "find" ? styles.sboxActive : ""}`}
      >
        <div className={styles.sbox}>
          <span aria-hidden="true">⌕</span>
          <input
            ref={searchInputRef}
            className={styles.q}
            value={query}
            placeholder={searchPlaceholder}
            aria-label="Search files"
            onFocus={onSearchFocus}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          <span className={styles.kbd}>⌘P</span>
        </div>
      </div>

      {mode === "ws" && (
        <ExplorerTree mode="ws" roots={roots} followedRoot={followedRoot} />
      )}
      {mode === "proj" && (
        <ExplorerTree mode="proj" roots={roots} followedRoot={followedRoot} />
      )}
      {mode === "chg" && <ChangedList roots={roots} />}
      {mode === "find" && <ExplorerFind roots={roots} />}

      <div className={styles.expfoot}>
        {watch ? (
          <>
            <span
              className={`${styles.dot} ${watch.degraded ? styles.dotWarn : ""}`}
            />
            watching {watch.rootCount} roots ·{" "}
            {formatCount(watch.indexedFileCount)} files ·{" "}
            {backendLabel(watch.backend)}
            <br />
            excluded: {watch.excludedDirs.join(" · ")}
            {watch.degraded && watch.rejected[0] && (
              <>
                <br />
                {watch.rejected[0].reason}
              </>
            )}
          </>
        ) : (
          "starting watcher…"
        )}
      </div>

      <div
        className={styles.resizer}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Explorer panel"
        tabIndex={0}
        onPointerDown={onResizerPointerDown}
        onPointerMove={onResizerPointerMove}
        onPointerUp={onResizerPointerUp}
        onKeyDown={onResizerKeyDown}
      />
      </div>
    </aside>
  );
}
