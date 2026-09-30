/**
 * The Workspace and Project tree bodies. One renderer, two modes:
 *  - `mode="ws"`: every resolved root as a collapsible root line, plus the
 *    virtual Shared root under its own group heading.
 *  - `mode="proj"`: a single root — the one `rootForCwd` resolves for the
 *    focused pane's cwd, or the cwd itself as an ad-hoc root when it is
 *    under no imported project.
 *
 * Expansion is lazy and one level at a time: clicking a collapsed directory
 * calls `fsListDir` once; the result is cached in `explorer-store`'s
 * `trees` map, so re-collapsing and re-expanding costs nothing further
 * unless the watcher is `degraded`, which forces a fresh `fsListDir` on
 * every expand (design decision 7 — a degraded watcher's cached state
 * cannot be trusted).
 *
 * Deck (#293): rows are `DeckLine`s on a `DeckGrid`, but the grid is a
 * `role="tree"` with `manageFocus={false}`. The tree keeps its own roving
 * tabindex because the focused row follows `selectedPath` across expands and
 * collapses, and it keeps ArrowLeft/ArrowRight, ⌘Enter and the drag payload —
 * none of which a flat grid has a word for. The state glyph in column one is
 * the row's *liveness*: `~` for a path the watcher just saw change, `×` for
 * one that could not be listed.
 */

import {
  useEffect,
  useState,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { fsListDir, openInEditor, type GitRootStatus } from "../../lib/ipc";
import { useExplorerStore } from "../../stores/explorer-store";
import { useTerminalStore } from "../../stores/terminal-store";
import { collectLeafIds } from "../../lib/layout-tree";
import {
  focusedPaneLeaf,
  rootForCwd,
  type RootDescriptor,
} from "../../lib/explorer/roots";
import {
  EXPLORER_LIVE_PULSE_MS,
  type TreeNode,
} from "../../lib/explorer/tree-model";
import {
  DECK_ICON_CLASSES,
  iconForEntry,
  iconClassFor,
} from "../../lib/explorer/file-icons";
import {
  DECK_GS_CLASSES,
  findFileStatus,
  gsClassFor,
} from "../../lib/explorer/git-status";
import { writePathDragPayload } from "../../lib/explorer/drag-payload";
import { DECK_COLS } from "../deck/deck-cols";
import { DeckGrid, DeckLine, type DeckState } from "../deck/deck-grid";

export interface ExplorerTreeProps {
  mode: "ws" | "proj";
  roots: RootDescriptor[];
  followedRoot: RootDescriptor | null;
}

/** Indentation lives inside the name cell, so the trailing column still
 *  lines up down the whole panel however deep the row is. Depths past the
 *  fifth clamp rather than growing unbounded — a 262px panel runs out of
 *  room well before then. */
function indentFor(depth: number): number {
  return Math.min(depth, 6) * 13 - 4;
}

/** An ad-hoc root for a cwd that is under no imported project (rootForCwd
 *  returned `null`) — Project mode still needs something to render. */
function adHocRoot(cwd: string): RootDescriptor {
  const label = cwd.slice(cwd.lastIndexOf("/") + 1) || cwd;
  return {
    id: `cwd:${cwd}`,
    kind: "project",
    label,
    requestedPath: cwd,
    canonicalPath: null,
  };
}

/** The name cell: twisty, type glyph, label. */
function nameCell(
  depth: number,
  twisty: string,
  glyph: string,
  glyphClass: string,
  label: ReactElement | string,
): ReactElement {
  return (
    <span className="dk-tree__n" style={{ paddingLeft: indentFor(depth) }}>
      <span className="t" aria-hidden="true">
        {twisty}
      </span>
      <span className={`g ${glyphClass}`} aria-hidden="true">
        {glyph}
      </span>
      <span className="l">{label}</span>
    </span>
  );
}

export function ExplorerTree({
  mode,
  roots,
  followedRoot,
}: ExplorerTreeProps): ReactElement {
  const trees = useExplorerStore((s) => s.trees);
  const expanded = useExplorerStore((s) => s.expanded);
  const gitByRootId = useExplorerStore((s) => s.gitByRootId);
  const watch = useExplorerStore((s) => s.watch);
  const selectedPath = useExplorerStore((s) => s.selectedPath);
  const setSelectedPath = useExplorerStore((s) => s.setSelectedPath);
  const toggleExpand = useExplorerStore((s) => s.toggleExpand);
  const applyListing = useExplorerStore((s) => s.applyListing);

  const tabs = useTerminalStore((s) => s.tabs);
  const focusedLeafId = useTerminalStore((s) => s.focusedLeafId);

  // Paths whose listing attempt failed (a moved/deleted project, a path
  // outside the home-scope policy). Rendered as a muted, non-expandable
  // "unavailable" row rather than a silently-stuck twisty.
  const [unavailable, setUnavailable] = useState<Record<string, string>>({});

  // A single shared clock, not one timer per row: the live pulse and the
  // `moved` tag both expire relative to "now", and re-rendering once a
  // second is enough for either to visibly clear.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // Flattened visible-row order, rebuilt every render, used only for
  // ArrowUp/ArrowDown focus movement — cheap to recompute, avoids a second
  // traversal data structure kept in sync by hand.
  const rowOrder: string[] = [];
  const rowEls = new Map<string, HTMLDivElement>();

  function isExpanded(rootId: string, path: string): boolean {
    return (expanded[rootId] ?? []).includes(path);
  }

  function ensureLoaded(rootId: string, path: string): void {
    void fsListDir(path)
      .then((listing) => {
        applyListing(rootId, listing);
        setUnavailable((prev) => {
          if (!(path in prev)) return prev;
          const next = { ...prev };
          delete next[path];
          return next;
        });
      })
      .catch((err: unknown) => {
        setUnavailable((prev) => ({
          ...prev,
          [path]: err instanceof Error ? err.message : String(err),
        }));
      });
  }

  function toggleRoot(root: RootDescriptor): void {
    const path = root.requestedPath;
    if (path in unavailable) return;
    const willExpand = !isExpanded(root.id, path);
    toggleExpand(root.id, path);
    const node = trees[root.id];
    if (willExpand && (!node || node.children === null || watch?.degraded)) {
      ensureLoaded(root.id, root.canonicalPath ?? path);
    }
  }

  function toggleNode(rootId: string, node: TreeNode): void {
    if (!node.isDir || node.isSymlink) return;
    if (node.path in unavailable) return;
    const willExpand = !isExpanded(rootId, node.path);
    toggleExpand(rootId, node.path);
    if (willExpand && (node.children === null || watch?.degraded)) {
      ensureLoaded(rootId, node.path);
    }
  }

  function focusSibling(delta: number, path: string): void {
    const idx = rowOrder.indexOf(path);
    if (idx === -1) return;
    const nextPath = rowOrder[idx + delta];
    if (nextPath) rowEls.get(nextPath)?.focus();
  }

  function renderChildren(
    rootId: string,
    node: TreeNode,
    depth: number,
    git: GitRootStatus | undefined,
  ): ReactElement[] | null {
    if (!node.isDir || !isExpanded(rootId, node.path) || !node.children)
      return null;
    return node.children.map((child) => renderNode(rootId, child, depth, git));
  }

  function renderNode(
    rootId: string,
    node: TreeNode,
    depth: number,
    git: GitRootStatus | undefined,
  ): ReactElement {
    rowOrder.push(node.path);
    const nodeExpanded = node.isDir && isExpanded(rootId, node.path);
    const icon = iconForEntry(node.name, node.isDir, node.isSymlink);
    const fileStatus = !node.isDir ? findFileStatus(git, node.path) : undefined;
    const showLive =
      node.changedAt !== undefined &&
      now - node.changedAt < EXPLORER_LIVE_PULSE_MS;
    const showMoved = node.movedUntil !== undefined && node.movedUntil > now;
    const failed = node.path in unavailable;
    const selected = selectedPath === node.path;

    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          focusSibling(1, node.path);
          break;
        case "ArrowUp":
          e.preventDefault();
          focusSibling(-1, node.path);
          break;
        case "ArrowRight":
          if (node.isDir && !isExpanded(rootId, node.path)) {
            e.preventDefault();
            toggleNode(rootId, node);
          }
          break;
        case "ArrowLeft":
          if (node.isDir && isExpanded(rootId, node.path)) {
            e.preventDefault();
            toggleNode(rootId, node);
          }
          break;
        case "Enter":
          e.preventDefault();
          if (e.metaKey) {
            void openInEditor(node.path);
          } else if (node.isDir) {
            toggleNode(rootId, node);
          } else {
            setSelectedPath(node.path);
          }
          break;
        default:
          break;
      }
    };

    // The trailing column carries what the row's own state does not: why it
    // could not be listed, how many children are hidden, what git makes of
    // it — and, independently of any of those, that the watcher just saw it
    // move.
    const trail = (
      <>
        {failed ? (
          <span className="dk-meta">unavailable</span>
        ) : node.isDir && !nodeExpanded && node.childCount !== null ? (
          <span className="dk-meta">{node.childCount}</span>
        ) : !node.isDir && fileStatus ? (
          <span className={gsClassFor(fileStatus.status, DECK_GS_CLASSES)}>
            {fileStatus.status}
          </span>
        ) : null}
        {showMoved && (
          <span className="dk-tag" data-s="run" style={{ marginLeft: 5 }}>
            moved
          </span>
        )}
      </>
    );

    const state: DeckState = failed ? "fail" : showLive ? "run" : "idle";

    return (
      <div key={node.path}>
        <DeckLine
          role="treeitem"
          state={state}
          selected={selected}
          cells={[
            {
              v: nameCell(
                depth,
                node.isDir ? (nodeExpanded ? "▾" : "▸") : "",
                icon.glyph,
                iconClassFor(icon.tone, DECK_ICON_CLASSES),
                node.name,
              ),
              title: node.path,
            },
            { v: trail, cls: "r" },
          ]}
          onOpen={() => {
            setSelectedPath(node.path);
            if (node.isDir) toggleNode(rootId, node);
          }}
          rowRef={(el) => {
            if (el) rowEls.set(node.path, el);
          }}
          rowProps={{
            "aria-expanded": node.isDir ? nodeExpanded : undefined,
            "aria-selected": selected,
            "aria-disabled": failed || undefined,
            tabIndex: selected ? 0 : -1,
            draggable: true,
            onDragStart: (e) =>
              writePathDragPayload(e.dataTransfer, [node.path]),
            onKeyDown,
          }}
        />
        {renderChildren(rootId, node, depth + 1, git)}
      </div>
    );
  }

  // Root rows share the tree's roving-tabindex model with child rows
  // (exactly one row in the whole tree has `tabIndex={0}`, everything else
  // is `-1` and reachable only via the arrow-key `rowEls`/`focusSibling`
  // machinery above `.focus()`es directly, tabIndex notwithstanding). A
  // child row already claims that slot once `selectedPath` points at it;
  // root rows previously never did, so on a fresh mount — before anything
  // has been clicked — nothing under `role="tree"` was Tab-reachable at
  // all. `isDefaultFocusable` marks the one root row (the first, in
  // Workspace mode; the sole one, in Project mode) that becomes the
  // fallback Tab stop while `selectedPath` is still null.
  function renderRootRow(
    root: RootDescriptor,
    isDefaultFocusable: boolean,
  ): ReactElement {
    const node = trees[root.id];
    const git = gitByRootId[root.id];
    const nodeExpanded = isExpanded(root.id, root.requestedPath);
    const failed = root.requestedPath in unavailable;
    const showBranch =
      !!git && git.isRepo && git.error === null && git.branch !== null;
    const isTabStop =
      selectedPath === root.requestedPath ||
      (selectedPath === null && isDefaultFocusable);
    rowOrder.push(root.requestedPath);

    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusSibling(1, root.requestedPath);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusSibling(-1, root.requestedPath);
      } else if (e.key === "Enter" && !e.metaKey) {
        e.preventDefault();
        toggleRoot(root);
      } else if (e.key === "Enter" && e.metaKey) {
        e.preventDefault();
        void openInEditor(root.canonicalPath ?? root.requestedPath);
      }
    };

    const trail = failed ? (
      <span className="dk-meta">unavailable</span>
    ) : showBranch ? (
      <span className="dk-meta">
        {git?.branch}
        {git?.dirty ? <em>*</em> : null}
      </span>
    ) : (
      ""
    );

    return (
      <div key={root.id}>
        <DeckLine
          role="treeitem"
          className="is-root"
          state={failed ? "fail" : "idle"}
          cells={[
            {
              v: nameCell(
                1,
                nodeExpanded ? "▾" : "▸",
                root.kind === "shared" ? "⬡" : "◆",
                root.kind === "shared" ? "dk-tree__g-sql" : "dk-tree__g-dir",
                root.label,
              ),
              title: root.canonicalPath ?? root.requestedPath,
            },
            { v: trail, cls: "r" },
          ]}
          onOpen={() => toggleRoot(root)}
          rowRef={(el) => {
            if (el) rowEls.set(root.requestedPath, el);
          }}
          rowProps={{
            "aria-expanded": nodeExpanded,
            "aria-disabled": failed || undefined,
            tabIndex: isTabStop ? 0 : -1,
            draggable: true,
            onDragStart: (e) =>
              writePathDragPayload(e.dataTransfer, [
                root.canonicalPath ?? root.requestedPath,
              ]),
            onKeyDown,
          }}
        />
        {nodeExpanded && node?.children
          ? node.children.map((child) => renderNode(root.id, child, 2, git))
          : null}
      </div>
    );
  }

  if (mode === "ws") {
    if (roots.length === 0) {
      return (
        <div className="dk-note">
          No projects imported yet — import one from Projects.
        </div>
      );
    }
    return (
      <DeckGrid
        cols={DECK_COLS.tree}
        className="tree"
        role="tree"
        manageFocus={false}
        label="Workspace"
      >
        {roots.map((root, i) =>
          root.kind === "shared" ? (
            <div key={`grp:${root.id}`}>
              <div
                className="dk-head"
                style={{ gridTemplateColumns: "1fr auto" }}
              >
                <span>Shared · workspace</span>
                <span>.claude/</span>
              </div>
              {renderRootRow(root, i === 0)}
            </div>
          ) : (
            renderRootRow(root, i === 0)
          ),
        )}
      </DeckGrid>
    );
  }

  // mode === "proj"
  const followedLeaf = focusedPaneLeaf(tabs, focusedLeafId);
  const followedCwd = followedLeaf?.cwd ?? null;
  if (!focusedLeafId || !followedCwd) {
    return (
      <div className="dk-note">
        Focus a terminal pane to follow its directory.
      </div>
    );
  }

  const activeRoot =
    followedRoot ?? rootForCwd(roots, followedCwd) ?? adHocRoot(followedCwd);
  const tabIndex =
    tabs.findIndex((tab) =>
      collectLeafIds(tab.layout).includes(focusedLeafId),
    ) + 1;

  return (
    <DeckGrid
      cols={DECK_COLS.tree}
      className="tree"
      role="tree"
      manageFocus={false}
      label="Project"
    >
      <div className="dk-head" style={{ gridTemplateColumns: "1fr auto" }}>
        <span>
          following pane {tabIndex || 1}
          {followedLeaf?.exited ? " (pane exited)" : ""}
        </span>
        <span>OSC 7</span>
      </div>
      {renderRootRow(activeRoot, true)}
    </DeckGrid>
  );
}
