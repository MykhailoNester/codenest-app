/**
 * The Workspace and Project tree bodies (prototype `.x-ws` / `.x-proj`,
 * markup lines 513-558). One renderer, two modes:
 *  - `mode="ws"`: every resolved root as a collapsible `.rootrow`, plus the
 *    virtual Shared root under its own `.grp` header.
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
import { iconForEntry, iconClassFor } from "../../lib/explorer/file-icons";
import { findFileStatus, gsClassFor } from "../../lib/explorer/git-status";
import { writePathDragPayload } from "../../lib/explorer/drag-payload";
import styles from "./workspace-navigator.module.css";

export interface ExplorerTreeProps {
  mode: "ws" | "proj";
  roots: RootDescriptor[];
  followedRoot: RootDescriptor | null;
}

function depthClass(depth: number): string {
  switch (depth) {
    case 1:
      return styles.d1 ?? "";
    case 2:
      return styles.d2 ?? "";
    case 3:
      return styles.d3 ?? "";
    case 4:
      return styles.d4 ?? "";
    case 5:
      return styles.d5 ?? "";
    default:
      return styles.dMax ?? "";
  }
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

  // A single shared clock, not one timer per row: the `.live` pulse and the
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

    return (
      <div key={node.path}>
        <div
          role="treeitem"
          aria-expanded={node.isDir ? nodeExpanded : undefined}
          aria-selected={selected}
          tabIndex={selected ? 0 : -1}
          ref={(el) => {
            if (el) rowEls.set(node.path, el);
          }}
          className={[
            styles.row,
            depthClass(depth),
            selected ? styles.rowSelected : "",
            showMoved ? styles.movedRow : "",
            failed ? styles.unavailable : "",
          ]
            .filter(Boolean)
            .join(" ")}
          draggable
          onDragStart={(e) => writePathDragPayload(e.dataTransfer, [node.path])}
          onClick={() => {
            setSelectedPath(node.path);
            if (node.isDir) toggleNode(rootId, node);
          }}
          onKeyDown={onKeyDown}
        >
          {showLive && <span className={styles.live} aria-hidden="true" />}
          <span className={styles.tw} aria-hidden="true">
            {node.isDir ? (nodeExpanded ? "▾" : "▸") : ""}
          </span>
          <span
            className={`${styles.ic} ${iconClassFor(icon.tone, styles)}`}
            aria-hidden="true"
            title={node.isSymlink ? "link" : undefined}
          >
            {icon.glyph}
          </span>
          <span className={styles.nm}>{node.name}</span>
          {failed && <span className={styles.cnt}>unavailable</span>}
          {!failed &&
            node.isDir &&
            !nodeExpanded &&
            node.childCount !== null && (
              <span className={styles.cnt}>{node.childCount}</span>
            )}
          {!failed && !node.isDir && fileStatus && (
            <span
              className={`${styles.gs} ${gsClassFor(fileStatus.status, styles)}`}
            >
              {fileStatus.status}
            </span>
          )}
          {showMoved && <span className={styles.mvtag}>moved</span>}
        </div>
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

    return (
      <div key={root.id}>
        <div
          role="treeitem"
          aria-expanded={nodeExpanded}
          tabIndex={isTabStop ? 0 : -1}
          ref={(el) => {
            if (el) rowEls.set(root.requestedPath, el);
          }}
          className={[
            styles.row,
            styles.rootrow,
            styles.d1,
            failed ? styles.unavailable : "",
          ]
            .filter(Boolean)
            .join(" ")}
          draggable
          onDragStart={(e) =>
            writePathDragPayload(e.dataTransfer, [
              root.canonicalPath ?? root.requestedPath,
            ])
          }
          onClick={() => toggleRoot(root)}
          onKeyDown={onKeyDown}
        >
          <span className={styles.tw} aria-hidden="true">
            {nodeExpanded ? "▾" : "▸"}
          </span>
          <span
            className={`${styles.ic} ${root.kind === "shared" ? styles.icShared : styles.icDir}`}
            aria-hidden="true"
          >
            {root.kind === "shared" ? "⬡" : "◆"}
          </span>
          <span className={styles.nm}>{root.label}</span>
          {failed && <span className={styles.cnt}>unavailable</span>}
          {!failed && showBranch && (
            <span className={styles.branch}>
              {git?.branch}
              {git?.dirty ? <em>*</em> : null}
            </span>
          )}
        </div>
        {nodeExpanded && node?.children
          ? node.children.map((child) => renderNode(root.id, child, 2, git))
          : null}
      </div>
    );
  }

  if (mode === "ws") {
    if (roots.length === 0) {
      return (
        <div className={styles.tree}>
          <div className={styles.empty}>
            No projects imported yet — import one from Projects.
          </div>
        </div>
      );
    }
    return (
      <div className={styles.tree} role="tree" aria-label="Workspace">
        {roots.map((root, i) =>
          root.kind === "shared" ? (
            <div key={`grp:${root.id}`}>
              <div className={styles.grp}>
                Shared · workspace
                <span className={styles.grpCnt}>.claude/</span>
              </div>
              {renderRootRow(root, i === 0)}
            </div>
          ) : (
            renderRootRow(root, i === 0)
          ),
        )}
      </div>
    );
  }

  // mode === "proj"
  const followedLeaf = focusedPaneLeaf(tabs, focusedLeafId);
  const followedCwd = followedLeaf?.cwd ?? null;
  if (!focusedLeafId || !followedCwd) {
    return (
      <div className={styles.tree}>
        <div className={styles.empty}>
          Focus a terminal pane to follow its directory.
        </div>
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
    <div className={styles.tree} role="tree" aria-label="Project">
      <div className={styles.grp}>
        following pane {tabIndex || 1}
        {followedLeaf?.exited ? " (pane exited)" : ""}
        <span className={styles.grpCnt}>OSC 7</span>
      </div>
      {renderRootRow(activeRoot, true)}
    </div>
  );
}
