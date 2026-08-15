import { create } from "zustand";
import { listen as tauriListen } from "@tauri-apps/api/event";
import {
  openTerminal,
  closeTerminal,
  sendTerminalInput,
  getWorkspacePath,
  type PtyExitedPayload,
} from "../lib/ipc";
import { recordAgentExited } from "../lib/agent-run-telemetry";
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
  updateLeafAgentConfig,
  updateLeafCwd,
  updateLeafTitle,
  updateSplitRatio,
  type Direction,
  type LayoutNode,
  type PaneKind,
  type PaneLeaf,
} from "../lib/layout-tree";
import {
  buildPaneLayout,
  resolvePromptTargets,
  type PaneLaunchSpec,
} from "../lib/launch";
import { stagePendingPrompt } from "./pending-prompt-store";

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

/** Result returned by `applyPaneLayout`. */
export interface ApplyPaneLayoutResult {
  /**
   * Leaves successfully placed — an agent leaf counts here too, even though
   * it has no PTY behind it (`<AgentPane/>` starts the session on mount): it
   * *did* mount successfully, which is the thing this count answers for.
   * Only a shell pane can ever land in `failedCount` instead.
   */
  openedCount: number;
  /** Shell panes whose `open_terminal` rejected — rendered as `<EmptyPane/>`. */
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

  /**
   * Add a tab. `opts.kind` defaults to `"agent"` — the composer is the default
   * session surface, so ⌘T and the tab bar's `+` open a native agent pane with
   * no PTY behind it. `kind: "shell"` is the explicit opt-in (⌥⌘T, the tab
   * bar's shell button) and is the only path that allocates a PTY.
   */
  addTab: (opts?: { kind?: PaneKind }) => Promise<void>;
  /**
   * Mark the store as hydrated without seeding any default tabs.
   * Called by `TerminalsLayout` when `skipHydration` is true (i.e., a
   * programmatic popout launch is about to call `applyPaneLayout` itself).
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
  /**
   * Record the provider/model/permission mode an agent leaf runs with, so a
   * restart (and the next relaunch) reuses it. Searches every tab, not just
   * the active one —
   * the composer's selectors are reachable in a hidden tab's pane too.
   */
  setLeafAgentConfig: (
    terminalId: string,
    config: {
      providerId?: number | null;
      model?: string | null;
      permissionMode?: string | null;
    },
  ) => void;
  /**
   * Whether `terminalId` still names a leaf in any tab.
   *
   * `<AgentPane/>` asks this from its unmount cleanup to tell the two cases
   * apart that React cannot: a *teardown* (pane closed, tab closed, window
   * gone — the leaf is gone from the store, so the session must be stopped)
   * versus a *remount* (a sibling pane closed, so the split collapsed and the
   * subtree was reconciled at a new position — the leaf is still there, so the
   * session must survive). Before this existed, closing a shell pane beside an
   * agent pane killed the agent session and left "Session ended" behind.
   */
  leafExists: (terminalId: string) => boolean;
  hydrateFromStorage: () => Promise<void>;
  persistToStorage: () => void;
  /**
   * Build a pane-list layout from `spec` (`buildPaneLayout`), open one PTY per
   * shell pane, add the resulting tab as the active tab, and return
   * `{ openedCount, failedCount }`.
   *
   * An agent leaf gets no PTY and no `recordAgentLaunch` call from here —
   * `<AgentPane/>` starts the session and posts its own launch telemetry on
   * mount, using the leaf's `seed` for attribution. `spec.prompt` is also
   * transported onto the built layout as a `promptPreview` on an agent leaf's
   * `seed`, unconditionally.
   *
   * This action's other side effect: for every index `resolvePromptTargets`
   * resolves off `spec` (honouring each pane's `sendPrompt`, or the legacy
   * `promptFanout` when no pane states one), the prompt is staged under that
   * leaf's real id via `stagePendingPrompt` before the tab is committed to
   * state — `<AgentPane/>`'s boot effect is the reader (#32).
   *
   * Individual shell-pane failures do NOT abort siblings (`Promise.allSettled`);
   * a failed leaf becomes an `<EmptyPane/>` (`empty: true`) rather than a dead
   * reference to a PTY that was never opened.
   *
   * Throws `RangeError` (via `buildPaneLayout`) before touching any state or
   * IPC when `spec.panes.length` is out of range — a rejected spec leaves no
   * half-built tab.
   */
  applyPaneLayout: (spec: PaneLaunchSpec) => Promise<ApplyPaneLayoutResult>;
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

/** Matches the pane-header title `splitPane` gives an agent sibling. */
function defaultAgentTitle(): string {
  return "claude";
}

function findActiveTab(tabs: Tab[], activeTabId: string): Tab | undefined {
  return tabs.find((t) => t.id === activeTabId);
}

/**
 * Tab strip labels are numbered per kind, so an "Agent 1" and a "Shell 1" can
 * coexist and the strip says what each tab actually is. Counting the tabs whose
 * first leaf is of that kind (rather than `tabs.length`) keeps the numbering
 * stable when the two kinds are interleaved.
 */
function nextTabTitle(tabs: Tab[], kind: PaneKind): string {
  const label = kind === "agent" ? "Agent" : "Shell";
  const sameKind = tabs.filter((t) => {
    const first = collectLeaves(t.layout)[0];
    return (
      first !== undefined &&
      (paneKind(first) === "agent") === (kind === "agent")
    );
  }).length;
  return `${label} ${sameKind + 1}`;
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

  addTab: async (opts) => {
    // Resolve the workspace cwd for nav-bar tab creation (Phase 4).
    // Falls back to shell default (no cwd) if the IPC call fails.
    const cwd = await resolveWorkspaceCwd();
    const kind: PaneKind = opts?.kind ?? "agent";

    // An agent tab allocates no PTY — `<AgentPane/>` starts the duplex
    // `claude` session on mount — so this is the one branch that can add a tab
    // without awaiting the shell.
    const leaf: PaneLeaf =
      kind === "agent"
        ? {
            type: "leaf",
            terminalId: genId(),
            title: defaultAgentTitle(),
            kind: "agent",
            ...(cwd !== undefined ? { cwd } : {}),
          }
        : {
            type: "leaf",
            terminalId: (await openTerminal(cwd !== undefined ? { cwd } : {}))
              .id,
            title: defaultLeafTitle(),
            ...(cwd !== undefined ? { cwd } : {}),
          };

    set((state) => {
      const tab: Tab = {
        id: genId(),
        title: nextTabTitle(state.tabs, kind),
        layout: leaf,
      };
      return {
        tabs: [...state.tabs, tab],
        activeTabId: tab.id,
        focusedLeafId: leaf.terminalId,
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
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
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

  setLeafAgentConfig: (terminalId, config) => {
    set((state) => ({
      tabs: state.tabs.map((t) => ({
        ...t,
        layout: updateLeafAgentConfig(t.layout, terminalId, config),
      })),
    }));
  },

  leafExists: (terminalId) =>
    get().tabs.some((t) => findLeaf(t.layout, terminalId) !== null),

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

      // `allSettled`, not `all`: a single leaf whose PTY cannot be allocated
      // (its cwd was deleted, the shell binary moved, the sidecar is mid-start)
      // used to reject the whole batch, fall through to the outer catch, and
      // re-seed the store with ONE fresh tab — silently discarding every other
      // restored tab. Now a failed tab is dropped on its own and the rest of
      // the strip survives.
      const settled = await Promise.allSettled(
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
      const rebuilt: Tab[] = settled
        .filter(
          (r): r is PromiseFulfilledResult<Tab> => r.status === "fulfilled",
        )
        .map((r) => r.value);
      if (rebuilt.length < parsed.tabs.length) {
        console.warn(
          `[terminal-store] dropped ${parsed.tabs.length - rebuilt.length} tab(s) whose panes could not be restored`,
        );
      }
      if (rebuilt.length === 0) {
        // Every restored tab failed — fall back to one fresh tab rather than
        // leaving the page empty.
        await get()
          .addTab()
          .catch(() => undefined);
        set({ hydrated: true });
        return;
      }
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
          // Strip initCommand and seed from every leaf before persisting. A
          // provider CLI command (written by applyPaneLayout) must not be
          // re-issued when the embedded Terminal page is opened after a
          // previous Launch session: hydrateFromStorage calls
          // sendTerminalInput for any leaf that carries initCommand, which
          // would auto-spawn claude (or another provider) in every restored
          // pane. A rehydrated agent leaf must not re-stamp its launch
          // attribution either — `seed` is read once by `<AgentPane/>` on the
          // mount that actually launched it, not by a restart days later.
          // Plain shell tabs never set either field, so this strip is a
          // no-op for them.
          layout: stripLaunchOnlyFields(t.layout),
        })),
        activeTabId,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // localStorage may be unavailable in some sandboxes; silently skip.
    }
  },

  applyPaneLayout: async (spec) => {
    // Throws before any side effect (RangeError for an out-of-range pane
    // count) — a rejected spec leaves no half-built tab.
    const layoutTemplate = buildPaneLayout(spec);
    const placeholders = collectLeaves(layoutTemplate);

    // `i` ↔ `spec.panes[i]`: both splits `buildPaneLayout` can produce are
    // built left/top-first, so `collectLeaves` returns leaves in the same
    // order the spec's `panes` array was given in.
    const results = await Promise.allSettled(
      placeholders.map(async (placeholder, i) => {
        const pane = spec.panes[i];
        if (pane === undefined) {
          // Unreachable — `buildPaneLayout` emits exactly one leaf per pane.
          throw new Error(`applyPaneLayout: no pane at index ${i}`);
        }

        if (pane.kind === "agent") {
          // No IPC at all — `<AgentPane/>` starts the duplex `claude` session
          // (and posts its own `recordAgentLaunch`, with this leaf's `seed`
          // for attribution) on mount.
          return { placeholderId: placeholder.terminalId, realId: genId() };
        }

        const env =
          pane.env !== undefined && Object.keys(pane.env).length > 0
            ? pane.env
            : undefined;
        const handle = await openTerminal({
          ...(pane.cwd !== undefined ? { cwd: pane.cwd } : {}),
          ...(env !== undefined ? { env } : {}),
          ...(pane.shell !== undefined ? { shell: pane.shell } : {}),
        });
        // `placeholder.initCommand` (not `pane.command`) — it already carries
        // the trailing-newline normalisation `buildPaneLayout` applied.
        if (placeholder.initCommand !== undefined) {
          await sendTerminalInput(handle.id, placeholder.initCommand);
        }
        return { placeholderId: placeholder.terminalId, realId: handle.id };
      }),
    );

    // Apply all replacements sequentially: concurrent writes to one `layout`
    // variable would race.
    let layout: LayoutNode = layoutTemplate;
    let openedCount = 0;
    let failedCount = 0;

    // Launch prompt handoff (#32): which pane indices get `spec.prompt`, and
    // the text itself (empty when absent — `resolvePromptTargets` already
    // returns `[]` for that case, so `promptText.length > 0` below is the
    // single guard both conditions share).
    const promptText = spec.prompt ?? "";
    const promptTargets = new Set(resolvePromptTargets(spec));

    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        layout = replaceLeafId(
          layout,
          result.value.placeholderId,
          result.value.realId,
        );
        openedCount++;
        // Only the fulfilled branch: a rejected pane keeps its `pending-N`
        // id and becomes an `<EmptyPane/>` below, which never mounts an
        // `<AgentPane/>` — staging for it would leak an entry that can never
        // be consumed. Agent panes never reject (they do no IPC here), so in
        // practice every target is fulfilled. Staged under the leaf's real
        // id, before the `set(...)` below commits the tab, so the entry is
        // in place before React can mount the pane.
        if (promptText.length > 0 && promptTargets.has(i)) {
          stagePendingPrompt(result.value.realId, promptText);
        }
        return;
      }
      failedCount++;
      // A rejected shell pane keeps its `pending-N` id and is tagged empty
      // instead, so it renders `<EmptyPane/>` with a working retry rather
      // than a `<TerminalPane/>` bound to a PTY that was never opened.
      const placeholder = placeholders[i];
      if (placeholder !== undefined) {
        layout = _setLeafEmpty(layout, placeholder.terminalId, true);
      }
    });

    const tabId = genId();
    const newTab: Tab = {
      id: tabId,
      // No meaning for "rows×cols" here — a pane list has no dimensions. A
      // per-kind label (e.g. "2 agents + 1 shell") is a UI concern the
      // composer (#30) can rename this into.
      title: `Launch ${spec.panes.length}`,
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
      // hydrateFromStorage, which would otherwise replace this tab with the
      // persisted ones and orphan the PTYs/agent panes we just opened.
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
// Private helpers for leaf manipulation
// ---------------------------------------------------------------------------

/**
 * Recursively strip `initCommand` and `seed` from every leaf in the layout
 * tree.
 *
 * Used by `persistToStorage` so neither survives into localStorage: a shell
 * pane's command (written by `applyPaneLayout`) must not be replayed when
 * the embedded Terminal page next calls
 * `hydrateFromStorage`, and an agent leaf's launch attribution (`seed`) must
 * not be re-stamped onto a run a rehydrate restarts days later. Plain shell
 * tabs never set either field, so this is a no-op for them.
 *
 * Copy-and-delete rather than the field-by-field rebuild this replaced: that
 * rebuild enumerated every field it wanted to keep and had silently dropped
 * `permissionMode` from the list (dormant only because no leaf had both
 * `initCommand` and `permissionMode` at once) — a second stripped field would
 * have made that trap worse. `{...node}` plus `delete` cannot forget a field
 * that already exists on `PaneLeaf`, which is the same idiom
 * `updateLeafAgentConfig` (`layout-tree.ts`) uses.
 */
function stripLaunchOnlyFields(node: LayoutNode): LayoutNode {
  if (node.type === "leaf") {
    if (node.initCommand === undefined && node.seed === undefined) return node;
    const next: PaneLeaf = { ...node };
    delete next.initCommand;
    delete next.seed;
    return next;
  }
  const left = stripLaunchOnlyFields(node.children[0]);
  const right = stripLaunchOnlyFields(node.children[1]);
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

  // Notify the sidecar so the run row transitions to ended.
  recordAgentExited(paneId, exit_code ?? null);
});

export const TERMINAL_STORAGE_KEY = STORAGE_KEY;
