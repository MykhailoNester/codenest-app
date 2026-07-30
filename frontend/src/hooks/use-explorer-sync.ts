/**
 * Owns the workspace navigator's whole IPC lifecycle for the MAIN window.
 * Mounted once by `<WorkspaceNavigator>`. Never mounted by the popout — the
 * popout's `<FindPaletteOverlay>` builds its own indexes and never calls
 * `fsWatchSetRoots` (Design decision 5: one `FsWatchManager` is app-global,
 * two writers would fight).
 *
 * Sequencing this hook exists to get right, in order, every time the
 * watched root set changes:
 *   1. Resolve roots (`useProjects` + `getWorkspacePath` → `resolveRoots`).
 *   2. `fsWatchSetRoots` for the desired set, truncated to the last-known
 *      `maxRoots` (Design decision 6).
 *   3. `fsBuildFileIndex` for each watched root — AFTER `set_roots`, because
 *      `set_roots` prunes index counts for roots that left the watched set
 *      (`fswatch/mod.rs:543-546`); indexing first would zero the footer's
 *      file count.
 *   4. `gitStatusForRoots` for EVERY resolved root, unconditionally, in
 *      every mode — including Workspace, the default body. Issued here and
 *      not awaited by step 5, so it never delays the contractual refresh.
 *   5. Re-list every currently-expanded directory — the refresh
 *      `set_roots` contractually requires (`fswatch/mod.rs:434-440`).
 *   6. Subscribe to `fs_change_batch`: patch the tree, unless the batch (or
 *      the watcher) says not to trust it, in which case re-run step 5.
 *   7. Git refreshes beyond the mount-time call: the header ⟳ button, a
 *      debounced (400 ms) refresh on `fs_change_batch`, and a 10 s poll
 *      while Changed mode is the active body.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjects } from "../lib/api";
import {
  fsBuildFileIndex,
  fsListDir,
  fsWatchSetRoots,
  getWorkspacePath,
  gitStatusForRoots,
  useEvent,
  FS_CHANGE_BATCH_EVENT,
  type FsChangeBatch,
  type GitRootStatus,
} from "../lib/ipc";
import {
  focusedPaneCwd,
  resolveRoots,
  rootForCwd,
  type RootDescriptor,
} from "../lib/explorer/roots";
import { collectLoadedDirs } from "../lib/explorer/tree-model";
import { useTerminalStore } from "../stores/terminal-store";
import { useExplorerStore, type TreeMode } from "../stores/explorer-store";

/** Poll cadence for the Changed-mode git refresh (item 7). */
const CHANGED_MODE_POLL_MS = 10_000;
/** Debounce window before a `fs_change_batch` re-runs git status (item 7). */
const GIT_REFRESH_DEBOUNCE_MS = 400;

function desiredWatchRoots(
  activeTreeMode: TreeMode,
  roots: RootDescriptor[],
  expanded: Record<string, string[]>,
  followedRoot: RootDescriptor | null,
): string[] {
  if (activeTreeMode === "chg") {
    return roots.map((r) => r.requestedPath);
  }
  if (activeTreeMode === "proj") {
    return followedRoot ? [followedRoot.requestedPath] : [];
  }
  // Workspace mode: only roots the user has actually drilled into — a
  // collapsed project row needs no live feed, and keeping the watch set
  // small matters given `MAX_WATCHED_ROOTS = 8`.
  return roots
    .filter((r) => (expanded[r.id]?.length ?? 0) > 0)
    .map((r) => r.requestedPath);
}

export interface UseExplorerSyncResult {
  roots: RootDescriptor[];
  followedRoot: RootDescriptor | null;
  /** Re-runs the watch/index/relist cycle and a fresh git status call —
   *  wired to the panel header's ⟳ button. */
  refresh: () => void;
}

export function useExplorerSync(): UseExplorerSyncResult {
  const projectsQuery = useProjects();
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  // `getWorkspacePath()` is genuinely async even when everything else is
  // synchronous (e.g. in a test), so `roots` would otherwise go through two
  // distinct values one render apart: projects-only, then projects+shared.
  // Gating on this flag means every effect keyed off the resolved root set
  // (the git-status call in particular) fires once, for the complete set —
  // never once for a partial one and again moments later for the full one.
  const [workspacePathSettled, setWorkspacePathSettled] = useState(false);
  const [canonicalByRootId, setCanonicalByRootId] = useState<
    Record<string, string>
  >({});

  const mode = useExplorerStore((s) => s.mode);
  const lastTreeMode = useExplorerStore((s) => s.lastTreeMode);
  const expanded = useExplorerStore((s) => s.expanded);
  const setWatch = useExplorerStore((s) => s.setWatch);
  const setIndex = useExplorerStore((s) => s.setIndex);
  const setGit = useExplorerStore((s) => s.setGit);
  const applyListing = useExplorerStore((s) => s.applyListing);
  const applyBatch = useExplorerStore((s) => s.applyBatch);
  const pruneExpandedRoots = useExplorerStore((s) => s.pruneExpandedRoots);

  const tabs = useTerminalStore((s) => s.tabs);
  const focusedLeafId = useTerminalStore((s) => s.focusedLeafId);

  useEffect(() => {
    let cancelled = false;
    void getWorkspacePath()
      .then((path) => {
        if (!cancelled) setWorkspacePath(path);
      })
      .catch(() => {
        // No workspace bootstrapped yet — the shared root is simply
        // omitted (see the edge-cases table); project roots still work.
      })
      .finally(() => {
        if (!cancelled) setWorkspacePathSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rawRoots = useMemo(
    () =>
      workspacePathSettled
        ? resolveRoots(projectsQuery.data ?? [], workspacePath)
        : [],
    [workspacePathSettled, projectsQuery.data, workspacePath],
  );

  const roots = useMemo(
    () =>
      rawRoots.map((root) => {
        const canonicalPath = canonicalByRootId[root.id];
        return canonicalPath ? { ...root, canonicalPath } : root;
      }),
    [rawRoots, canonicalByRootId],
  );

  useEffect(() => {
    pruneExpandedRoots(roots.map((r) => r.id));
    // pruneExpandedRoots is a stable zustand action reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots]);

  const followedCwd = useMemo(
    () => focusedPaneCwd(tabs, focusedLeafId),
    [tabs, focusedLeafId],
  );
  const followedRoot = useMemo(
    () => (followedCwd ? rootForCwd(roots, followedCwd) : null),
    [roots, followedCwd],
  );

  const activeTreeMode: TreeMode = mode === "find" ? lastTreeMode : mode;

  // -- git status: unconditional, every mode, matched back by array index --
  // JSON.stringify, not `.join(" ")` — a path containing a space (e.g. a
  // "Google Drive" or "My Project" directory, both real on macOS) would
  // otherwise collide with a distinct root set that happens to join to the
  // same string.
  const rootPathKey = JSON.stringify(roots.map((r) => r.requestedPath));
  const runGitRefresh = useCallback((): void => {
    if (roots.length === 0) return;
    void gitStatusForRoots(roots.map((r) => r.requestedPath))
      .then((results) => {
        const byId: Record<string, GitRootStatus> = {};
        results.forEach((status, i) => {
          const root = roots[i];
          if (root) byId[root.id] = status;
        });
        setGit(byId);
      })
      .catch(() => undefined);
    // roots is intentionally excluded — this closure is rebuilt whenever
    // rootPathKey changes (see the effect below), which is the real
    // "did the resolved root set change" signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPathKey, setGit]);

  useEffect(() => {
    runGitRefresh();
  }, [runGitRefresh]);

  // `useEvent` (`lib/ipc.ts`) subscribes inside a `useEffect` keyed only on
  // the event name, so it freezes whatever handler closure existed at that
  // first render forever — it never re-subscribes just because a callback
  // it calls changed identity. `runGitRefresh` itself is rebuilt every time
  // `rootPathKey` changes (roots resolve asynchronously, so it starts out
  // closed over an empty `roots`), so the `fs_change_batch` handler below
  // must never call `runGitRefresh` directly — it would call the stale,
  // permanently-empty-roots version from mount. Routing every call through
  // a ref that is kept current on every render sidesteps that without
  // touching `useEvent` itself, which other callers (e.g. `schedules.tsx`)
  // depend on freezing its handler the way it does today.
  const runGitRefreshRef = useRef(runGitRefresh);
  useEffect(() => {
    runGitRefreshRef.current = runGitRefresh;
  }, [runGitRefresh]);

  // -- watch / index / relist cycle --
  // Same JSON.stringify reasoning as `rootPathKey` above.
  const watchedPathsKey = JSON.stringify(
    desiredWatchRoots(activeTreeMode, roots, expanded, followedRoot),
  );

  const relistLoaded = useCallback((): void => {
    const trees = useExplorerStore.getState().trees;
    for (const [rootId, tree] of Object.entries(trees)) {
      for (const dirPath of collectLoadedDirs(tree)) {
        void fsListDir(dirPath)
          .then((listing) => applyListing(rootId, listing))
          .catch(() => undefined);
      }
    }
  }, [applyListing]);

  const runWatchCycle = useCallback((): void => {
    const desired = desiredWatchRoots(
      activeTreeMode,
      roots,
      expanded,
      followedRoot,
    );
    const currentMax = useExplorerStore.getState().watch?.maxRoots;
    const truncated = desired.slice(0, currentMax ?? desired.length);

    void fsWatchSetRoots(truncated).then(async (state) => {
      setWatch(state);
      const targets = roots.filter((r) => truncated.includes(r.requestedPath));
      await Promise.allSettled(
        targets.map(async (root) => {
          const index = await fsBuildFileIndex(root.requestedPath);
          setIndex(root.id, index);
          setCanonicalByRootId((prev) =>
            prev[root.id] === index.root
              ? prev
              : { ...prev, [root.id]: index.root },
          );
        }),
      );
      relistLoaded();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedPathsKey, setWatch, setIndex, relistLoaded]);

  useEffect(() => {
    runWatchCycle();
  }, [runWatchCycle]);

  // Stop watching on unmount (feature toggled off, or navigating away) so
  // the debouncer thread does not keep running for a panel nobody sees.
  useEffect(() => {
    return () => {
      void fsWatchSetRoots([]).catch(() => undefined);
    };
  }, []);

  // -- fs_change_batch: patch the tree, or re-list when it can't be trusted --
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEvent<FsChangeBatch>(FS_CHANGE_BATCH_EVENT, (batch) => {
    const watch = useExplorerStore.getState().watch;
    if (batch.rescan || watch?.degraded) {
      relistLoaded();
    } else {
      applyBatch(batch);
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Through the ref (see its declaration above) — never the frozen
    // `runGitRefresh` closure this handler was created with.
    debounceRef.current = setTimeout(
      () => runGitRefreshRef.current(),
      GIT_REFRESH_DEBOUNCE_MS,
    );
  });
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // -- 10 s git poll while Changed mode is the active body --
  useEffect(() => {
    if (mode !== "chg") return;
    const id = setInterval(runGitRefresh, CHANGED_MODE_POLL_MS);
    return () => clearInterval(id);
  }, [mode, runGitRefresh]);

  const refresh = useCallback((): void => {
    runWatchCycle();
    runGitRefresh();
  }, [runWatchCycle, runGitRefresh]);

  return { roots, followedRoot, refresh };
}
