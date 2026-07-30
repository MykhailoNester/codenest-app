// Zustand store for the workspace navigator (Explorer panel). Same shape
// convention as `stores/terminal-store.ts`: a single `create<T>()` store,
// persistence handled by a `subscribe` registered outside the store body so
// it never fires during the initial render.
//
// Only UI state that has no IPC source of truth is persisted — mode, per-root
// expansion, panel width/collapse. Trees, git status and the file index are
// always re-derived from IPC on mount (`hooks/use-explorer-sync.ts`), so they
// are never written to `localStorage`.

import { create } from "zustand";
import type {
  DirListing,
  FileIndex,
  FsChange,
  FsChangeBatch,
  GitRootStatus,
  WatchState,
} from "../lib/ipc";
import {
  patchTree,
  setChildren,
  type TreeNode,
} from "../lib/explorer/tree-model";

export type TreeMode = "ws" | "proj" | "chg";
export type ExplorerMode = TreeMode | "find";

const STORAGE_KEY = "codenest:explorer";
export const DEFAULT_PANEL_WIDTH = 262;
export const MIN_PANEL_WIDTH = 200;
export const MAX_PANEL_WIDTH = 520;

function clampPanelWidth(width: number): number {
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width));
}

interface PersistedExplorerState {
  mode: TreeMode;
  expanded: Record<string, string[]>;
  panelWidth: number;
  panelCollapsed: boolean;
}

function defaultPersisted(): PersistedExplorerState {
  return {
    mode: "ws",
    expanded: {},
    panelWidth: DEFAULT_PANEL_WIDTH,
    panelCollapsed: false,
  };
}

function isTreeMode(value: unknown): value is TreeMode {
  return value === "ws" || value === "proj" || value === "chg";
}

function readPersisted(): PersistedExplorerState {
  const fallback = defaultPersisted();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedExplorerState> | null;
    if (!parsed || typeof parsed !== "object") return fallback;
    return {
      mode: isTreeMode(parsed.mode) ? parsed.mode : fallback.mode,
      expanded:
        parsed.expanded && typeof parsed.expanded === "object"
          ? parsed.expanded
          : fallback.expanded,
      panelWidth:
        typeof parsed.panelWidth === "number"
          ? clampPanelWidth(parsed.panelWidth)
          : fallback.panelWidth,
      panelCollapsed:
        typeof parsed.panelCollapsed === "boolean"
          ? parsed.panelCollapsed
          : fallback.panelCollapsed,
    };
  } catch {
    return fallback;
  }
}

function persist(state: PersistedExplorerState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable — ignore, matching nav-group-store.ts.
  }
}

export interface ExplorerStoreState {
  mode: ExplorerMode;
  /** The tree chip Esc returns to when leaving Find. */
  lastTreeMode: TreeMode;
  query: string;
  /** One tree per root id (`project:${id}` or `shared`). */
  trees: Record<string, TreeNode>;
  /** Expanded directory paths per root id, persisted independently. */
  expanded: Record<string, string[]>;
  selectedPath: string | null;
  watch: WatchState | null;
  gitByRootId: Record<string, GitRootStatus>;
  indexByRootId: Record<string, FileIndex>;
  panelWidth: number;
  panelCollapsed: boolean;

  setMode: (mode: TreeMode) => void;
  enterFind: () => void;
  exitFind: () => void;
  setQuery: (query: string) => void;
  toggleExpand: (rootId: string, path: string) => void;
  applyListing: (rootId: string, listing: DirListing) => void;
  applyBatch: (batch: FsChangeBatch) => void;
  setWatch: (watch: WatchState) => void;
  setGit: (gitByRootId: Record<string, GitRootStatus>) => void;
  setIndex: (rootId: string, index: FileIndex) => void;
  setSelectedPath: (path: string | null) => void;
  setPanelWidth: (width: number) => void;
  setPanelCollapsed: (collapsed: boolean) => void;
  collapseAll: () => void;
  /** Drop expansion state for any root id no longer in `validRootIds` — a
   *  project removed since the last session leaves a harmless orphan key
   *  otherwise. */
  pruneExpandedRoots: (validRootIds: string[]) => void;
}

const initial =
  typeof window === "undefined" ? defaultPersisted() : readPersisted();

function rootNodeFor(existing: TreeNode | undefined, path: string): TreeNode {
  if (existing) return existing;
  const name = path.slice(path.lastIndexOf("/") + 1) || path;
  return {
    path,
    name,
    isDir: true,
    isSymlink: false,
    childCount: null,
    children: null,
  };
}

export const useExplorerStore = create<ExplorerStoreState>((set) => ({
  mode: initial.mode,
  lastTreeMode: initial.mode,
  query: "",
  trees: {},
  expanded: initial.expanded,
  selectedPath: null,
  watch: null,
  gitByRootId: {},
  indexByRootId: {},
  panelWidth: initial.panelWidth,
  panelCollapsed: initial.panelCollapsed,

  setMode: (mode) => set({ mode, lastTreeMode: mode, query: "" }),

  enterFind: () =>
    set((state) => ({ mode: "find", lastTreeMode: state.lastTreeMode })),

  exitFind: () => set((state) => ({ mode: state.lastTreeMode, query: "" })),

  setQuery: (query) => set({ query }),

  toggleExpand: (rootId, path) =>
    set((state) => {
      const current = state.expanded[rootId] ?? [];
      const next = current.includes(path)
        ? current.filter((p) => p !== path)
        : [...current, path];
      return { expanded: { ...state.expanded, [rootId]: next } };
    }),

  applyListing: (rootId, listing) =>
    set((state) => {
      const base = rootNodeFor(state.trees[rootId], listing.path);
      const updated = setChildren(base, listing.path, listing.entries);
      return { trees: { ...state.trees, [rootId]: updated } };
    }),

  applyBatch: (batch) =>
    set((state) => {
      if (batch.changes.length === 0) return state;
      const now = Date.now();
      const byRoot = new Map<string, FsChange[]>();
      for (const change of batch.changes) {
        const list = byRoot.get(change.root);
        if (list) {
          list.push(change);
        } else {
          byRoot.set(change.root, [change]);
        }
      }
      if (byRoot.size === 0) return state;
      let changed = false;
      const nextTrees = { ...state.trees };
      for (const [rootId, tree] of Object.entries(state.trees)) {
        const changes = byRoot.get(tree.path);
        if (changes && changes.length > 0) {
          nextTrees[rootId] = patchTree(tree, changes, now);
          changed = true;
        }
      }
      return changed ? { trees: nextTrees } : state;
    }),

  setWatch: (watch) => set({ watch }),

  setGit: (gitByRootId) =>
    set((state) => ({ gitByRootId: { ...state.gitByRootId, ...gitByRootId } })),

  setIndex: (rootId, index) =>
    set((state) => ({
      indexByRootId: { ...state.indexByRootId, [rootId]: index },
    })),

  setSelectedPath: (path) => set({ selectedPath: path }),

  setPanelWidth: (width) => set({ panelWidth: clampPanelWidth(width) }),

  setPanelCollapsed: (collapsed) => set({ panelCollapsed: collapsed }),

  collapseAll: () => set({ expanded: {} }),

  pruneExpandedRoots: (validRootIds) =>
    set((state) => {
      const validSet = new Set(validRootIds);
      const nextExpanded: Record<string, string[]> = {};
      let changed = false;
      for (const [rootId, paths] of Object.entries(state.expanded)) {
        if (validSet.has(rootId)) {
          nextExpanded[rootId] = paths;
        } else {
          changed = true;
        }
      }
      return changed ? { expanded: nextExpanded } : state;
    }),
}));

// Persist on any change to the persisted slice. Subscribed outside the
// store body so the callback never fires during the store's own module
// initialization / first render.
useExplorerStore.subscribe((state, prev) => {
  if (
    state.mode === prev.mode &&
    state.expanded === prev.expanded &&
    state.panelWidth === prev.panelWidth &&
    state.panelCollapsed === prev.panelCollapsed
  ) {
    return;
  }
  persist({
    // Persist the last real tree chip, not a transient "find" — Esc/reload
    // should land back on the tree the user was looking at.
    mode: state.mode === "find" ? state.lastTreeMode : state.mode,
    expanded: state.expanded,
    panelWidth: state.panelWidth,
    panelCollapsed: state.panelCollapsed,
  });
});

// Re-exported so callers building the desired watch set (Design decision 6)
// don't need to know the store's internal default; kept in one place.
export function getExplorerState(): ExplorerStoreState {
  return useExplorerStore.getState();
}
