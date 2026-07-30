import { create } from "zustand";
import { listen as tauriListen } from "@tauri-apps/api/event";
import {
  openTerminal,
  closeTerminal,
  sendTerminalInput,
  getWorkspacePath,
  type PtyExitedPayload,
} from "../lib/ipc";
import { fetchSidecar } from "../lib/api";
import {
  clampSplitRatios,
  closeLeaf,
  collectLeafIds,
  collectLeaves,
  findLeaf,
  markLeafExited,
  paneKind,
  replaceLeafId,
  splitLeaf,
  updateLeafCwd,
  updateLeafTitle,
  updateSplitRatio,
  type Direction,
  type LayoutNode,
  type PaneKind,
  type PaneLeaf,
} from "../lib/layout-tree";
import {
  buildGridLayout,
  safeInjectClaudeArgs,
  type LaunchCell,
  type LaunchSpec,
} from "../lib/launch";

// Tauri's `listen` reads `window.__TAURI_INTERNALS__`, which is absent outside
// the webview (e.g. vitest), where it rejects with a `transformCallback` error
// and pollutes the test run with unhandled rejections. Guard it so importing
// this store is side-effect-free in non-Tauri environments — both the
// module-level `pty-exited` subscription and the per-pane `terminal_output`
// subscriptions become no-ops there while behaving normally inside the app.
const listen = ((...args: Parameters<typeof tauriListen>) =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    ? tauriListen(...args)
    : Promise.resolve(() => {})) as typeof tauriListen;

export interface Tab {
  id: string;
  title: string;
  layout: LayoutNode;
}

interface PersistedTab {
  id: string;
  title: string;
  layout: LayoutNode;
}

interface PersistedState {
  tabs: PersistedTab[];
  activeTabId: string;
}

const STORAGE_KEY = "codenest.terminal.state";

/** Result returned by `applyGridLayout`. */
export interface ApplyGridLayoutResult {
  openedCount: number;
  failedCount: number;
}

export interface TerminalStore {
  tabs: Tab[];
  activeTabId: string;
  focusedLeafId: string | null;
  hydrated: boolean;
  /**
   * Set synchronously at the start of `hydrateFromStorage` and cleared when it
   * finishes. Guards against the StrictMode/HMR double-mount race: `hydrated`
   * is only flipped after the async PTY allocation, so without this flag two
   * concurrent effect invocations would each seed a default tab.
   */
  hydrating: boolean;
  /**
   * When non-null, the pane with this terminalId is visually expanded to fill
   * the entire pane-area while the rest of the layout tree stays mounted
   * underneath (CSS-promoted via `.leafMaximized`).  Ephemeral — not
   * persisted across reloads.  Cleared on tab switch, when the maximized
   * leaf is closed, and when a new launch tab is created.
   */
  maximizedLeafId: string | null;

  addTab: () => Promise<void>;
  /**
   * Mark the store as hydrated without seeding any default tabs.
   * Called by `TerminalsLayout` when `skipHydration` is true (i.e., a
   * programmatic popout launch is about to call `applyGridLayout` itself).
   */
  setHydrated: () => void;
  closeTab: (tabId: string) => Promise<void>;
  setActiveTab: (tabId: string) => void;
  /**
   * `opts.kind` defaults to `"shell"` (today's path, unchanged: opens a real
   * PTY). `kind: "agent"` inserts an agent leaf with **no** PTY — `<AgentPane/>`
   * owns starting the duplex `claude` session on mount (Design decision 4 in
   * the agent-pane-composer plan) — so no agent ipc binding lands in this
   * store.
   */
  splitPane: (
    terminalId: string,
    direction: Direction,
    opts?: { kind?: PaneKind },
  ) => Promise<void>;
  closePane: (terminalId: string) => Promise<void>;
  updateRatio: (focusedTerminalId: string, ratio: number) => void;
  setFocusedLeaf: (terminalId: string | null) => void;
  /**
   * Update the pane title.  Pass `manual = true` when called from the
   * double-click rename UI so subsequent OSC 0/2 sequences are suppressed.
   */
  setLeafTitle: (terminalId: string, title: string, manual?: boolean) => void;
  /**
   * Update the tab strip label for a tab.  Called from both the tab-bar
   * double-click rename and the pane-header rename so the tab strip stays in
   * sync regardless of which rename surface the user used.
   */
  renameTab: (tabId: string, title: string) => void;
  /**
   * Update the tracked cwd for a leaf (called by the OSC 7 handler).
   * The value is used by the pane header and by `splitPane` to inherit cwd.
   */
  setLeafCwd: (terminalId: string, cwd: string) => void;
  hydrateFromStorage: () => Promise<void>;
  persistToStorage: () => void;
  /**
   * Build a grid layout from `spec`, allocate one PTY per leaf in parallel,
   * write `spec.providerCommand` to each PTY after open resolves, add the
   * resulting tab as the active tab, and return `{ openedCount, failedCount }`.
   *
   * Individual pane failures do NOT abort siblings (Promise.allSettled).
   *
   * In workspace mode (`spec.cells` is non-empty), cells listed in the array
   * get a real PTY; grid positions with no matching cell become empty-pane
   * placeholders (`leaf.empty === true`).
   */
  applyGridLayout: (spec: LaunchSpec) => Promise<ApplyGridLayoutResult>;
  /**
   * Replace an empty-pane placeholder with a real PTY.
   *
   * Allocates a new PTY with the supplied `cwd`, writes `initCommand` to it,
   * clears the `empty` flag on the leaf, and focuses the new pane.
   */
  replaceEmptyLeaf: (
    leafId: string,
    opts: { cwd?: string; initCommand?: string },
  ) => Promise<void>;
  /**
   * Toggle the maximized state for `terminalId`.  If another leaf is currently
   * maximized, it is replaced.  Also focuses the target leaf.
   */
  toggleMaximize: (terminalId: string) => void;
  /** Clear the maximized state (back to grid view). */
  restoreMaximize: () => void;
  /**
   * Mark the leaf with `terminalId` as exited across all tabs.
   * Called when a `pty-exited` event is received for that id.
   */
  markLeafExited: (terminalId: string) => void;
  /**
   * Remove a pane from whichever tab it lives in (searches ALL tabs, not just
   * the active one) and drop the tab if it becomes empty.
   *
   * Unlike `closePane`, this method does NOT re-seed the store with a new
   * default tab when the last tab is removed.  It is the correct operation for
   * the external Stop action in the detached terminals window, where the caller
   * checks whether any panes remain and closes the window if not.
   *
   * The PTY must already have been killed by the caller (`close_terminal` IPC)
   * before invoking this.
   *
   * Returns `true` if the pane was found and removed, `false` if not found
   * (idempotent — safe to call with a stale id).
   */
  closePaneForStop: (terminalId: string) => boolean;
  /**
   * Close a tab by id and kill its PTYs, but do NOT re-seed the store with a
   * new default tab when the last tab is removed (unlike `closeTab` which
   * always keeps at least one tab).
   *
   * Intended for the detached "terminals" window where zero tabs is a valid
   * terminal state — the caller is responsible for closing the window when
   * this returns `true`.
   *
   * Returns `true` when the store reaches zero tabs after the removal,
   * `false` otherwise.
   */
  closeTabNoReSeed: (tabId: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Workspace cwd resolution (Phase 4)
// ---------------------------------------------------------------------------

/**
 * Module-level cache so we only IPC once per app session.
 * `null` means not yet resolved; `undefined` means the IPC call failed and
 * we should fall back to the shell default.
 */
let cachedWorkspacePath: string | null | undefined = null;

/**
 * Resolve the Command Center workspace directory to use as the default cwd
 * when opening a new nav-bar terminal tab.
 *
 * - Returns the cached path on subsequent calls (no repeated IPC).
 * - Returns `undefined` if `get_workspace_path` throws (e.g. sidecar not yet
 *   ready, directory not yet created) so the caller can fall back to the shell
 *   default without blocking.
 */
async function resolveWorkspaceCwd(): Promise<string | undefined> {
  // Already resolved successfully.
  if (cachedWorkspacePath !== null && cachedWorkspacePath !== undefined) {
    return cachedWorkspacePath;
  }
  // Previously failed — don't retry in the same session; fall back.
  if (cachedWorkspacePath === undefined) return undefined;
  try {
    const path = await getWorkspacePath();
    cachedWorkspacePath = path;
    return path;
  } catch (err) {
    console.warn(
      "[terminal-store] workspace path unavailable; falling back to shell default",
      err,
    );
    cachedWorkspacePath = undefined;
    return undefined;
  }
}

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

function defaultLeafTitle(): string {
  return "zsh";
}

function findActiveTab(tabs: Tab[], activeTabId: string): Tab | undefined {
  return tabs.find((t) => t.id === activeTabId);
}

function nextTabTitle(tabs: Tab[]): string {
  return `Terminal ${tabs.length + 1}`;
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  tabs: [],
  activeTabId: "",
  focusedLeafId: null,
  hydrated: false,
  hydrating: false,
  maximizedLeafId: null,

  setHydrated: () => set({ hydrated: true }),

  toggleMaximize: (terminalId) => {
    const { maximizedLeafId } = get();
    if (maximizedLeafId === terminalId) {
      set({ maximizedLeafId: null });
    } else {
      set({ maximizedLeafId: terminalId, focusedLeafId: terminalId });
    }
  },

  restoreMaximize: () => set({ maximizedLeafId: null }),

  markLeafExited: (terminalId) => {
    set((state) => ({
      tabs: state.tabs.map((t) => ({
        ...t,
        layout: markLeafExited(t.layout, terminalId, true),
      })),
    }));
  },

  closePaneForStop: (terminalId) => {
    const { tabs, activeTabId, maximizedLeafId, focusedLeafId } = get();

    // Find which tab owns this pane (may not be the active tab).
    const owningTab = tabs.find((t) => {
      const leaves = collectLeaves(t.layout);
      return leaves.some((l) => l.terminalId === terminalId);
    });
    if (!owningTab) return false;

    const [newLayout, wasLastLeaf] = closeLeaf(owningTab.layout, terminalId);

    if (wasLastLeaf) {
      // Drop the tab entirely — no re-seeding.
      const remaining = tabs.filter((t) => t.id !== owningTab.id);
      const nextActive =
        activeTabId === owningTab.id ? (remaining[0]?.id ?? "") : activeTabId;
      const nextActiveTab = remaining.find((t) => t.id === nextActive);
      const nextFocused = nextActiveTab
        ? (collectLeafIds(nextActiveTab.layout)[0] ?? null)
        : null;
      const wasMaximizedInDropped = collectLeafIds(owningTab.layout).includes(
        maximizedLeafId ?? "",
      );
      set({
        tabs: remaining,
        activeTabId: nextActive,
        focusedLeafId: nextFocused,
        maximizedLeafId: wasMaximizedInDropped ? null : maximizedLeafId,
      });
      return true;
    }

    // Pane removed but tab still has siblings.
    const newFocused = collectLeafIds(newLayout)[0] ?? null;
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === owningTab.id ? { ...t, layout: newLayout } : t,
      ),
      focusedLeafId: focusedLeafId === terminalId ? newFocused : focusedLeafId,
      maximizedLeafId: maximizedLeafId === terminalId ? null : maximizedLeafId,
    }));
    return true;
  },

  addTab: async () => {
    // Resolve the workspace cwd for nav-bar tab creation (Phase 4).
    // Falls back to shell default (no cwd) if the IPC call fails.
    const cwd = await resolveWorkspaceCwd();
    const handle = await openTerminal(cwd !== undefined ? { cwd } : {});
    const leaf: PaneLeaf = {
      type: "leaf",
      terminalId: handle.id,
      title: defaultLeafTitle(),
      ...(cwd !== undefined ? { cwd } : {}),
    };
    set((state) => {
      const tab: Tab = {
        id: genId(),
        title: nextTabTitle(state.tabs),
        layout: leaf,
      };
      return {
        tabs: [...state.tabs, tab],
        activeTabId: tab.id,
        focusedLeafId: handle.id,
      };
    });
  },

  closeTab: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    // Agent leaves have no PTY — `<AgentPane/>`'s own unmount cleanup
    // `agentStop`s the session when this action removes its leaf from the
    // layout below.
    const ids = collectLeaves(tab.layout)
      .filter((l) => paneKind(l) !== "agent")
      .map((l) => l.terminalId);
    await Promise.all(
      ids.map((id) => closeTerminal(id).catch(() => undefined)),
    );

    const remaining = get().tabs.filter((t) => t.id !== tabId);
    if (remaining.length === 0) {
      set({
        tabs: [],
        activeTabId: "",
        focusedLeafId: null,
        maximizedLeafId: null,
      });
      // Re-seed with one fresh tab to maintain the invariant: terminal page
      // always has at least one tab.
      await get().addTab();
      return;
    }
    let nextActive = get().activeTabId;
    if (nextActive === tabId) {
      nextActive = remaining[0]!.id;
    }
    const nextActiveTab = remaining.find((t) => t.id === nextActive);
    const nextFocused = nextActiveTab
      ? (collectLeafIds(nextActiveTab.layout)[0] ?? null)
      : null;
    const tabIds = collectLeafIds(tab.layout);
    const wasMaximizedInClosedTab = tabIds.includes(
      get().maximizedLeafId ?? "",
    );
    set({
      tabs: remaining,
      activeTabId: nextActive,
      focusedLeafId: nextFocused,
      maximizedLeafId: wasMaximizedInClosedTab ? null : get().maximizedLeafId,
    });
  },

  closeTabNoReSeed: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return false;
    // See closeTab above — agent leaves have no PTY to close.
    const ids = collectLeaves(tab.layout)
      .filter((l) => paneKind(l) !== "agent")
      .map((l) => l.terminalId);
    await Promise.all(
      ids.map((id) => closeTerminal(id).catch(() => undefined)),
    );

    const remaining = get().tabs.filter((t) => t.id !== tabId);
    if (remaining.length === 0) {
      set({
        tabs: [],
        activeTabId: "",
        focusedLeafId: null,
        maximizedLeafId: null,
      });
      return true;
    }
    let nextActive = get().activeTabId;
    if (nextActive === tabId) {
      nextActive = remaining[0]!.id;
    }
    const nextActiveTab = remaining.find((t) => t.id === nextActive);
    const nextFocused = nextActiveTab
      ? (collectLeafIds(nextActiveTab.layout)[0] ?? null)
      : null;
    const tabIds = collectLeafIds(tab.layout);
    const wasMaximizedInClosedTab = tabIds.includes(
      get().maximizedLeafId ?? "",
    );
    set({
      tabs: remaining,
      activeTabId: nextActive,
      focusedLeafId: nextFocused,
      maximizedLeafId: wasMaximizedInClosedTab ? null : get().maximizedLeafId,
    });
    return false;
  },

  setActiveTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const focusedLeafId = collectLeafIds(tab.layout)[0] ?? null;
    set({ activeTabId: tabId, focusedLeafId, maximizedLeafId: null });
  },

  splitPane: async (terminalId, direction, opts) => {
    const { tabs, activeTabId } = get();
    const tab = findActiveTab(tabs, activeTabId);
    if (!tab) return;
    const target = findLeaf(tab.layout, terminalId);
    if (!target) return;

    if (opts?.kind === "agent") {
      // No PTY here — `<AgentPane/>` starts the duplex `claude` session on
      // mount (Design decision 4), so this store never imports an agent ipc
      // binding.
      const cwd = target.cwd ?? (await resolveWorkspaceCwd());
      const newLeaf: PaneLeaf = {
        type: "leaf",
        terminalId: genId(),
        title: "claude",
        kind: "agent",
        ...(cwd !== undefined ? { cwd } : {}),
      };
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === activeTabId
            ? {
                ...t,
                layout: splitLeaf(t.layout, terminalId, direction, newLeaf),
              }
            : t,
        ),
        focusedLeafId: newLeaf.terminalId,
      }));
      return;
    }

    const handle = await openTerminal({ cwd: target.cwd });
    const newLeaf: PaneLeaf = {
      type: "leaf",
      terminalId: handle.id,
      title: defaultLeafTitle(),
      ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
    };
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              layout: splitLeaf(t.layout, terminalId, direction, newLeaf),
            }
          : t,
      ),
      focusedLeafId: handle.id,
    }));
  },

  closePane: async (terminalId) => {
    const { tabs, activeTabId } = get();
    const tab = findActiveTab(tabs, activeTabId);
    if (!tab) return;

    // An agent leaf has no PTY — `<AgentPane/>`'s own unmount cleanup
    // `agentStop`s the session when this action removes its leaf below.
    const target = findLeaf(tab.layout, terminalId);
    if (!target || paneKind(target) !== "agent") {
      await closeTerminal(terminalId).catch(() => undefined);
    }

    const [newLayout, wasLastLeaf] = closeLeaf(tab.layout, terminalId);
    if (wasLastLeaf) {
      // Cascade: closing the last leaf in the active tab → close the tab.
      await get().closeTab(activeTabId);
      return;
    }
    const newFocused = collectLeafIds(newLayout)[0] ?? null;
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === activeTabId ? { ...t, layout: newLayout } : t,
      ),
      focusedLeafId:
        state.focusedLeafId === terminalId ? newFocused : state.focusedLeafId,
      maximizedLeafId:
        state.maximizedLeafId === terminalId ? null : state.maximizedLeafId,
    }));
  },

  updateRatio: (focusedTerminalId, ratio) => {
    const { activeTabId } = get();
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              layout: updateSplitRatio(t.layout, focusedTerminalId, ratio),
            }
          : t,
      ),
    }));
  },

  setFocusedLeaf: (terminalId) => set({ focusedLeafId: terminalId }),

  setLeafTitle: (terminalId, title, manual) => {
    set((state) => ({
      tabs: state.tabs.map((t) => ({
        ...t,
        layout: updateLeafTitle(t.layout, terminalId, title, manual),
      })),
    }));
  },

  renameTab: (tabId, title) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, title } : t,
      ),
    }));
  },

  setLeafCwd: (terminalId, cwd) => {
    set((state) => ({
      tabs: state.tabs.map((t) => ({
        ...t,
        layout: updateLeafCwd(t.layout, terminalId, cwd),
      })),
    }));
  },

  hydrateFromStorage: async () => {
    // Synchronous in-flight guard. `hydrated` is only flipped after the async
    // PTY allocation below, so two concurrent effect invocations (React
    // StrictMode double-mount in dev, or HMR) could both pass the
    // `if (hydrated) return` check in TerminalsLayout and each seed a default
    // tab — producing the "Terminal 1" + "Terminal 2" double-tab bug. Bailing
    // out synchronously on the in-progress flag prevents the duplicate seed.
    if (get().hydrated || get().hydrating) return;
    set({ hydrating: true });
    try {
      let parsed: PersistedState | null = null;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) parsed = JSON.parse(raw) as PersistedState;
      } catch {
        parsed = null;
      }

      if (!parsed || !Array.isArray(parsed.tabs) || parsed.tabs.length === 0) {
        try {
          await get().addTab();
        } catch {
          // Sidecar not ready or no PTY backend; leave store empty so the UI
          // can render a fallback message.
        }
        set({ hydrated: true });
        return;
      }

      const rebuilt: Tab[] = await Promise.all(
        parsed.tabs.map(async (tab) => {
          // Clamp every Split ratio to [0.05, 0.95] before rebuilding PTYs.
          // react-resizable-panels enforces minSize for live drags but not for
          // the initial layout restore from localStorage.
          const sanitizedLayout = clampSplitRatios(tab.layout);
          const leaves = collectLeaves(sanitizedLayout);
          let layout = sanitizedLayout;
          for (const leaf of leaves) {
            if (paneKind(leaf) === "agent") {
              // No PTY for an agent leaf — `<AgentPane/>` starts its own
              // duplex `claude` session on mount. Only a fresh id is minted
              // (the persisted id is a stale UUID from a previous run) so no
              // `agent_frame:{id}` subscription can collide with a leaf that
              // shares a serialized id by coincidence.
              layout = replaceLeafId(layout, leaf.terminalId, genId());
              continue;
            }
            const handle = await openTerminal(
              leaf.cwd !== undefined ? { cwd: leaf.cwd } : {},
            );
            layout = replaceLeafId(layout, leaf.terminalId, handle.id);
            // Re-issue the init command if one was persisted with this leaf.
            if (leaf.initCommand !== undefined) {
              // Fire-and-forget: failure here must not block layout rebuild.
              void sendTerminalInput(handle.id, leaf.initCommand).catch(
                () => undefined,
              );
            }
          }
          return { id: tab.id, title: tab.title, layout };
        }),
      );
      const activeTabId = rebuilt.some((t) => t.id === parsed.activeTabId)
        ? parsed.activeTabId
        : rebuilt[0]!.id;
      const activeTab = rebuilt.find((t) => t.id === activeTabId)!;
      set({
        tabs: rebuilt,
        activeTabId,
        focusedLeafId: collectLeafIds(activeTab.layout)[0] ?? null,
        hydrated: true,
      });
    } catch {
      try {
        await get().addTab();
      } catch {
        // ignore
      }
      set({ hydrated: true });
    } finally {
      set({ hydrating: false });
    }
  },

  persistToStorage: () => {
    try {
      const { tabs, activeTabId } = get();
      const payload: PersistedState = {
        tabs: tabs.map((t) => ({
          id: t.id,
          title: t.title,
          // Strip initCommand from every leaf before persisting.  Provider CLI
          // commands (written by applyGridLayout) must not be re-issued when the
          // embedded Terminal page is opened after a previous Launch session:
          // hydrateFromStorage calls sendTerminalInput for any leaf that carries
          // initCommand, which would auto-spawn claude (or another provider) in
          // every restored pane.  Plain shell tabs never set initCommand, so
          // this strip is a no-op for them.
          layout: stripInitCommands(t.layout),
        })),
        activeTabId,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // localStorage may be unavailable in some sandboxes; silently skip.
    }
  },

  applyGridLayout: async (spec) => {
    // Build the layout tree with placeholder ids.
    // cwd / initCommand carry the uniform values; per-cell overrides are
    // applied in the allSettled loop below.
    const layoutTemplate = buildGridLayout({
      rows: spec.rows,
      cols: spec.cols,
      cwd: spec.cwd,
      initCommand: spec.providerCommand,
    });

    const placeholderLeaves = collectLeaves(layoutTemplate);

    // Build a lookup from (row-major index) → LaunchCell when in workspace mode.
    // Row-major index: row * cols + col.
    const cellByIndex = new Map<number, LaunchCell>();
    if (spec.cells && spec.cells.length > 0) {
      for (const cell of spec.cells) {
        cellByIndex.set(cell.row * spec.cols + cell.col, cell);
      }
    }

    const workspaceMode = cellByIndex.size > 0;

    // Resolve the primary leaf index (row-major): (0,0) for uniform grids or
    // the cell with is_primary=true for workspace grids.  Fallback is always 0.
    const primaryLeafIndex = 0; // uniform grids always use (0,0)

    // Allocate one PTY per leaf in parallel; failures are isolated.
    // Each settled result carries both the placeholder id and the real PTY id
    // so we can apply all replacements sequentially after allSettled resolves,
    // avoiding the race condition that would arise from concurrent writes to
    // a shared `layout` variable.
    const results = await Promise.allSettled(
      placeholderLeaves.map(async (placeholder, leafIndex) => {
        // In workspace mode, skip PTY allocation for cells that have no spec.
        if (workspaceMode && !cellByIndex.has(leafIndex)) {
          // Return a sentinel indicating this is an empty-pane placeholder.
          return {
            placeholderId: placeholder.terminalId,
            realId: null as string | null,
            isEmpty: true,
            leafIndex,
          };
        }

        const cell = cellByIndex.get(leafIndex);
        const cwd = cell?.cwd ?? spec.cwd;
        const providerCommand = cell?.providerCommand ?? spec.providerCommand;
        // Env precedence:
        //   workspace cell → use cell.envOverlay (already merged by the modal with provider+profile)
        //   uniform mode   → use spec.env (merged by the modal from provider+profile)
        //   neither        → no overlay (inherits parent process env)
        const envOverlay: Record<string, string> | undefined =
          cell !== undefined && Object.keys(cell.envOverlay).length > 0
            ? cell.envOverlay
            : spec.env !== undefined && Object.keys(spec.env).length > 0
              ? spec.env
              : undefined;

        // B3: Generate a per-pane session UUID for deterministic Claude enrichment.
        // This UUID is stored on the agent_runs row and injected into the provider
        // command via {session_id} → `--session-id <uuid>`.  Non-Claude templates
        // omit the placeholder, so the UUID is simply unused in their case but
        // still stamped on the agent_runs row for potential future use.
        const paneSessionId = genId();

        // Inject session_id into the provider command before writing to PTY.
        //
        // renderProviderCommand intentionally leaves {session_id} verbatim when
        // sessionId is not supplied at modal time (the pane UUID doesn't exist
        // yet).  We do the final substitution here, replacing {session_id} with
        // '--session-id <uuid>'.
        //
        // After the placeholder substitution we also run safeInjectClaudeArgs as
        // a belt-and-suspenders safety net: if the template was user-created or
        // came from an un-migrated DB row and never contained the placeholder at
        // all, the flags are appended unconditionally for any `claude ...` command.
        let commandWithSession = providerCommand.includes("{session_id}")
          ? providerCommand.replace(
              "{session_id}",
              `--session-id ${paneSessionId}`,
            )
          : providerCommand;

        // Safety net: append --session-id (and --mcp-config, if present in the
        // spec but missing from the command) for claude invocations whose
        // template lacked the placeholders.
        commandWithSession = safeInjectClaudeArgs(
          commandWithSession,
          paneSessionId,
        );

        const handle = await openTerminal({
          cwd,
          ...(envOverlay !== undefined ? { env: envOverlay } : {}),
        });
        // Write the provider command (with session_id injected) after the PTY is open.
        await sendTerminalInput(handle.id, commandWithSession);

        // Determine fanout role for telemetry stamping (D6).
        const fanout = spec.promptFanout ?? "primary";
        let fanoutRole: "primary" | "secondary" | undefined;
        if (fanout === "primary") {
          fanoutRole = leafIndex === primaryLeafIndex ? "primary" : undefined;
        } else if (fanout === "every") {
          fanoutRole = leafIndex === primaryLeafIndex ? "primary" : "secondary";
        }
        // fanout === "none" → fanoutRole stays undefined

        // Post launch telemetry — fire-and-forget; never block the launch.
        // B1: include pane_id (PTY handle id) and session_id (dashboard-minted UUID)
        // so the sidecar can persist an agent_runs row linked to this pane.
        // Profile name is included (migration 051) so the AGENTS panel can filter by profile.
        void fetchSidecar("/api/v1/agents/events/launch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: cell?.providerId ?? spec.providerId,
            project_id: cell?.projectId ?? spec.projectId,
            pane_id: handle.id,
            session_id: paneSessionId,
            target: spec.target,
            rows: spec.rows,
            cols: spec.cols,
            leaf_index: leafIndex,
            model: spec.model ?? null,
            // Profile name for agent_runs.profile column
            ...(spec.profileName ? { profile: spec.profileName } : {}),
            // D6: source attribution fields (only when a source is present)
            ...(spec.source !== undefined
              ? {
                  source_kind: spec.source.kind,
                  source_id: spec.source.id,
                  prompt_preview:
                    spec.prompt && spec.prompt.length > 0
                      ? spec.prompt.slice(0, 120)
                      : null,
                  fanout_role: fanoutRole ?? null,
                }
              : {}),
          }),
        }).catch(() => undefined);
        return {
          placeholderId: placeholder.terminalId,
          realId: handle.id,
          isEmpty: false,
          leafIndex,
        };
      }),
    );

    // Apply all successful id replacements sequentially to the layout tree.
    // Empty-pane results get their leaf tagged with `empty: true`.
    let layout: LayoutNode = layoutTemplate;
    let openedCount = 0;
    let failedCount = 0;

    // Collect successfully-opened real PTY ids for prompt delivery below.
    const successfulPanes: Array<{ realId: string; leafIndex: number }> = [];

    for (const result of results) {
      if (result.status === "fulfilled") {
        const { placeholderId, realId, isEmpty, leafIndex } = result.value;
        if (isEmpty) {
          // Tag the placeholder leaf as empty; it keeps its pending-N terminalId
          // until the user opens a shell in that cell.
          layout = _setLeafEmpty(layout, placeholderId, true);
        } else if (realId !== null) {
          layout = replaceLeafId(layout, placeholderId, realId);
          openedCount++;
          successfulPanes.push({ realId, leafIndex });
        }
      } else {
        failedCount++;
      }
    }

    // ── D4: Prompt delivery ──────────────────────────────────────────────────
    // Insert the prompt into the provider's input field via a bracketed-paste
    // sequence (CSI 200 ~ … CSI 201 ~).  Claude Code (and most modern TUIs)
    // enable bracketed-paste mode and treat the wrapped text as a single paste
    // event — the text lands in the input buffer without being interpreted as
    // keystrokes, and crucially WITHOUT submitting.  The user reviews and
    // presses Enter manually.
    //
    // The write is gated by the first non-empty `terminal_output` event OR a
    // 250ms timeout — whichever fires first — so the paste arrives after the
    // TUI has set up its input handler.
    const fanout = spec.promptFanout ?? "primary";
    if (
      spec.prompt &&
      spec.prompt.length > 0 &&
      fanout !== "none" &&
      successfulPanes.length > 0
    ) {
      const promptText = `\x1b[200~${spec.prompt}\x1b[201~`;

      /**
       * For a single pane: wait for first non-empty `terminal_output` plus a
       * 600ms settle window for the TUI to enable bracketed-paste mode, OR a
       * 1200ms worst-case fallback. Then write the paste sequence.
       *
       * Why we wait past first-output: Claude Code TUI emits ANSI setup
       * sequences first; bracketed-paste mode (CSI ?2004h) is enabled later
       * in init. Writing the paste before that lands as control bytes in the
       * shell rather than as text in Claude's input field.
       */
      const deliverPrompt = async (paneId: string): Promise<void> => {
        await new Promise<void>((resolve) => {
          let resolved = false;
          let unlisten: (() => void) | undefined;

          const writeAndResolve = () => {
            if (resolved) return;
            resolved = true;
            unlisten?.();
            sendTerminalInput(paneId, promptText).then(
              () => undefined,
              (err) =>
                console.error("[prompt-delivery] write failed", paneId, err),
            );
            resolve();
          };

          const fallbackTimer = setTimeout(
            () => writeAndResolve(),
            1200,
          );

          void listen<string>(`terminal_output:${paneId}`, (raw) => {
            if (raw.payload && raw.payload.length > 0) {
              clearTimeout(fallbackTimer);
              setTimeout(() => writeAndResolve(), 600);
            }
          }).then((dispose) => {
            unlisten = dispose;
            if (resolved) dispose();
          });
        });
      };

      if (fanout === "primary") {
        // Deliver to the primary pane only (the first successful pane at index 0
        // in the successfulPanes list, which corresponds to leafIndex 0).
        const primaryPane =
          successfulPanes.find((p) => p.leafIndex === primaryLeafIndex) ??
          successfulPanes[0];
        if (primaryPane) {
          void deliverPrompt(primaryPane.realId).catch(() => undefined);
        }
      } else if (fanout === "every") {
        // Deliver to all panes in parallel; failures are isolated.
        void Promise.allSettled(
          successfulPanes.map((p) => deliverPrompt(p.realId)),
        );
      }
    }

    // Construct the new tab and make it active.
    const tabId = genId();
    const tabTitle = `Launch ${spec.rows}×${spec.cols}`;
    const newTab: Tab = {
      id: tabId,
      title: tabTitle,
      layout,
    };

    // Focus the first non-empty leaf, if any.
    const firstRealId =
      collectLeaves(layout).find((l) => !l.empty)?.terminalId ??
      collectLeafIds(layout)[0] ??
      null;

    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: tabId,
      focusedLeafId: firstRealId,
      maximizedLeafId: null,
      // Mark hydrated so the embedded TerminalsLayout's mount effect skips
      // hydrateFromStorage (which would otherwise replace this tab with the
      // persisted ones and orphan the PTYs we just opened).
      hydrated: true,
    }));

    return { openedCount, failedCount };
  },

  replaceEmptyLeaf: async (leafId, { cwd, initCommand }) => {
    const { tabs, activeTabId } = get();
    const tab = findActiveTab(tabs, activeTabId);
    if (!tab) return;

    const leaf = findLeaf(tab.layout, leafId);
    if (!leaf || !leaf.empty) return;

    const handle = await openTerminal(cwd !== undefined ? { cwd } : {});
    if (initCommand !== undefined) {
      await sendTerminalInput(handle.id, initCommand);
    }

    set((state) => {
      // Build an updated leaf: clear empty, set real terminalId, carry cwd/initCommand.
      const updatedLeaf: PaneLeaf = {
        type: "leaf",
        terminalId: handle.id,
        title: defaultLeafTitle(),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(initCommand !== undefined ? { initCommand } : {}),
      };
      return {
        tabs: state.tabs.map((t) =>
          t.id === activeTabId
            ? { ...t, layout: _replaceLeafNode(t.layout, leafId, updatedLeaf) }
            : t,
        ),
        focusedLeafId: handle.id,
      };
    });
  },
}));

// ---------------------------------------------------------------------------
// Private helpers for workspace-mode leaf manipulation
// ---------------------------------------------------------------------------

/**
 * Recursively strip `initCommand` from every leaf in the layout tree.
 *
 * Used by `persistToStorage` to prevent provider CLI commands (e.g. the
 * `claude` invocation written by `applyGridLayout`) from being replayed when
 * the embedded Terminal page next calls `hydrateFromStorage`.  Plain shell
 * tabs never set `initCommand`, so this is a no-op for them.
 */
function stripInitCommands(node: LayoutNode): LayoutNode {
  if (node.type === "leaf") {
    if (node.initCommand === undefined) return node;
    // Return a new leaf with initCommand omitted so it is not written to
    // localStorage and therefore not re-issued by hydrateFromStorage.
    return {
      type: node.type,
      terminalId: node.terminalId,
      title: node.title,
      ...(node.cwd !== undefined ? { cwd: node.cwd } : {}),
      ...(node.profileId !== undefined ? { profileId: node.profileId } : {}),
      ...(node.kind !== undefined ? { kind: node.kind } : {}),
      ...(node.empty !== undefined ? { empty: node.empty } : {}),
      ...(node.manualTitle !== undefined
        ? { manualTitle: node.manualTitle }
        : {}),
      ...(node.exited !== undefined ? { exited: node.exited } : {}),
    } satisfies PaneLeaf;
  }
  const left = stripInitCommands(node.children[0]);
  const right = stripInitCommands(node.children[1]);
  if (left === node.children[0] && right === node.children[1]) return node;
  return { ...node, children: [left, right] };
}

/** Tag (or untag) the `empty` flag on the leaf matching `targetId`. */
function _setLeafEmpty(
  root: LayoutNode,
  targetId: string,
  isEmpty: boolean,
): LayoutNode {
  if (root.type === "leaf") {
    if (root.terminalId !== targetId) return root;
    return { ...root, empty: isEmpty };
  }
  return {
    ...root,
    children: [
      _setLeafEmpty(root.children[0], targetId, isEmpty),
      _setLeafEmpty(root.children[1], targetId, isEmpty),
    ],
  };
}

/** Replace the leaf matching `targetId` with an entirely new `PaneLeaf` node. */
function _replaceLeafNode(
  root: LayoutNode,
  targetId: string,
  newLeaf: PaneLeaf,
): LayoutNode {
  if (root.type === "leaf") {
    if (root.terminalId !== targetId) return root;
    return newLeaf;
  }
  return {
    ...root,
    children: [
      _replaceLeafNode(root.children[0], targetId, newLeaf),
      _replaceLeafNode(root.children[1], targetId, newLeaf),
    ],
  };
}

// Persist on any tab/layout change. Subscribe outside the store body so the
// callback doesn't fire during initial render.
useTerminalStore.subscribe((state, prev) => {
  if (state.tabs === prev.tabs && state.activeTabId === prev.activeTabId)
    return;
  if (!state.hydrated) return; // skip until first hydrate completes
  state.persistToStorage();
});

// B2: Global pty-exited listener — calls /agents/runs/exited so the sidecar
// can flip the agent_runs row to status='ended'.  This is the liveness sink
// for ALL providers (no provider-specific hooks required).  The "Stop" action
// in the Agents panel calls close_terminal(pane_id) → Rust fires pty-exited
// → this listener → sidecar marks the run ended.
//
// Also delegates to the store's markLeafExited so the terminal UI shows the
// exited state.
void listen<PtyExitedPayload>("pty-exited", (raw) => {
  const { id: paneId, exit_code } = raw.payload;

  // Mark the leaf exited in the terminal layout (existing behaviour).
  useTerminalStore.getState().markLeafExited(paneId);

  // Notify the sidecar — fire-and-forget; never block UI.
  void fetchSidecar("/api/v1/agents/runs/exited", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pane_id: paneId, exit_code: exit_code ?? null }),
  }).catch(() => undefined);
});

export const TERMINAL_STORAGE_KEY = STORAGE_KEY;
