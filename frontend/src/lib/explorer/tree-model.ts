// Pure tree model + watcher-batch patching for the workspace navigator.
// No React, no IPC — `use-explorer-sync.ts` is the only caller that talks to
// the shell; this module only ever transforms data it is handed.

import type { DirEntryInfo, FsChange } from "../ipc";

export interface TreeNode {
  path: string;
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  /** Dirs only; `null` for a file, an unreadable dir, or one past the
   *  shell's per-listing budget. */
  childCount: number | null;
  /** `null` means "not loaded" — a collapsed folder with no fetched rows. */
  children: TreeNode[] | null;
  /** Set when a watcher event touches this node; drives the `.live` pulse. */
  changedAt?: number;
  /** Expiry timestamp for the `moved` tag after a paired rename. */
  movedUntil?: number;
}

/** The prototype's `.live` pulse (`livein` keyframes) runs for this long. */
const LIVE_PULSE_MS = 2_400;
/**
 * The `moved` tag is a static badge, not an animation — giving it longer
 * than the live pulse means a user who glances over after the pulse fades
 * still sees which row just moved.
 */
const MOVED_TAG_MS = 5_000;

export function nodeFromEntry(entry: DirEntryInfo): TreeNode {
  return {
    path: entry.path,
    name: entry.name,
    isDir: entry.isDir,
    isSymlink: entry.isSymlink,
    childCount: entry.childCount,
    children: null,
  };
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

/**
 * Dirs first, then case-insensitive name — the same ordering
 * `fs_list_dir` applies server-side (`src-tauri/src/commands/fs_nav.rs:124-128`).
 * Duplicated here (rather than shared) because an inserted row from a
 * watcher event has no server round-trip to sort it.
 */
function compareEntries(a: TreeNode, b: TreeNode): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

/** Insert `node` into an already-sorted `children` array, returning a new
 *  array (the input is never mutated). */
export function insertSorted(children: TreeNode[], node: TreeNode): TreeNode[] {
  const next = children.slice();
  let insertAt = next.length;
  for (let i = 0; i < next.length; i++) {
    const existing = next[i];
    if (existing && compareEntries(node, existing) < 0) {
      insertAt = i;
      break;
    }
  }
  next.splice(insertAt, 0, node);
  return next;
}

/**
 * Find the node at `targetPath` and replace it with `updater(node)`,
 * returning a new tree with structural sharing on every untouched branch.
 * Returns `root` unchanged (same reference) when `targetPath` is not
 * present anywhere in the already-loaded part of the tree.
 */
function updateNode(
  root: TreeNode,
  targetPath: string,
  updater: (node: TreeNode) => TreeNode,
): TreeNode {
  if (root.path === targetPath) return updater(root);
  if (!root.children) return root;
  let changed = false;
  const nextChildren = root.children.map((child) => {
    const updated = updateNode(child, targetPath, updater);
    if (updated !== child) changed = true;
    return updated;
  });
  return changed ? { ...root, children: nextChildren } : root;
}

/** Find the node at `targetPath` anywhere in the already-loaded tree. */
function findNode(root: TreeNode, targetPath: string): TreeNode | null {
  if (root.path === targetPath) return root;
  if (!root.children) return null;
  for (const child of root.children) {
    const found = findNode(child, targetPath);
    if (found) return found;
  }
  return null;
}

/** Cache one directory's listing into the tree at `path`. Pure — returns a
 *  new tree; a `path` not present in the (already-loaded) tree is a no-op. */
export function setChildren(
  root: TreeNode,
  path: string,
  entries: DirEntryInfo[],
): TreeNode {
  return updateNode(root, path, (node) => ({
    ...node,
    children: entries.map(nodeFromEntry),
  }));
}

function applyCreated(root: TreeNode, change: FsChange, now: number): TreeNode {
  const parentPath = dirname(change.path);
  return updateNode(root, parentPath, (parent) => {
    if (!parent.children) {
      // A closed folder has no rows to patch — but the collapsed count
      // must still reflect the new entry so it doesn't quietly go stale.
      return {
        ...parent,
        childCount: parent.childCount === null ? null : parent.childCount + 1,
      };
    }
    if (parent.children.some((c) => c.path === change.path)) return parent;
    const node: TreeNode = {
      path: change.path,
      name: basename(change.path),
      isDir: change.isDir ?? false,
      isSymlink: false,
      childCount: null,
      children: null,
      changedAt: now,
    };
    return { ...parent, children: insertSorted(parent.children, node) };
  });
}

function applyRemoved(root: TreeNode, path: string): TreeNode {
  const parentPath = dirname(path);
  return updateNode(root, parentPath, (parent) => {
    if (!parent.children) return parent;
    const filtered = parent.children.filter((c) => c.path !== path);
    if (filtered.length === parent.children.length) return parent;
    return { ...parent, children: filtered };
  });
}

function applyModified(root: TreeNode, path: string, now: number): TreeNode {
  return updateNode(root, path, (node) => ({ ...node, changedAt: now }));
}

function applyMoved(root: TreeNode, change: FsChange, now: number): TreeNode {
  const fromPath = change.fromPath;
  if (!fromPath) {
    // Malformed batch (moved with no source) — nothing to relocate from.
    return applyCreated(root, change, now);
  }

  const existing = findNode(root, fromPath);
  if (!existing) {
    // The source isn't anything we have loaded — degrade to a plain
    // creation at the destination, mirroring the shell's own degradation
    // when a rename's source falls outside every watched root
    // (`src-tauri/src/fswatch/mod.rs:200-205`).
    return applyCreated(root, { ...change, fromPath: null }, now);
  }

  const newParentPath = dirname(change.path);
  const newParent = findNode(root, newParentPath);
  if (!newParent || !newParent.children) {
    // Nowhere loaded to show the destination — degrade to a removal of the
    // source, mirroring the shell's degradation when a rename's
    // destination falls outside every watched root.
    return applyRemoved(root, fromPath);
  }

  const withoutOld = applyRemoved(root, fromPath);
  const moved: TreeNode = {
    ...existing,
    path: change.path,
    name: basename(change.path),
    movedUntil: now + MOVED_TAG_MS,
  };
  return updateNode(withoutOld, newParentPath, (parent) => {
    if (!parent.children) return parent;
    if (parent.children.some((c) => c.path === moved.path)) return parent;
    return { ...parent, children: insertSorted(parent.children, moved) };
  });
}

/**
 * Apply one watcher batch to `root`, in order. Pure and structural-sharing
 * — never rebuilds the tree, only patches the branches a change touches.
 * See the workspace-navigator plan's Design decision 8 for the mapping this
 * mirrors from the shell's own event degradations.
 */
export function patchTree(
  root: TreeNode,
  changes: FsChange[],
  now: number,
): TreeNode {
  let next = root;
  for (const change of changes) {
    switch (change.kind) {
      case "created":
        next = applyCreated(next, change, now);
        break;
      case "removed":
        next = applyRemoved(next, change.path);
        break;
      case "modified":
        next = applyModified(next, change.path, now);
        break;
      case "moved":
        next = applyMoved(next, change, now);
        break;
    }
  }
  return next;
}

/** Every directory whose children have been fetched — the input to the
 *  refresh `fs_watch_set_roots` contractually requires after a swap, and to
 *  the re-list a `degraded`/`rescan` batch falls back to. */
export function collectLoadedDirs(root: TreeNode): string[] {
  const result: string[] = [];
  const walk = (node: TreeNode): void => {
    if (node.children !== null) {
      result.push(node.path);
      for (const child of node.children) walk(child);
    }
  };
  walk(root);
  return result;
}

export const EXPLORER_LIVE_PULSE_MS = LIVE_PULSE_MS;
