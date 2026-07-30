import { create } from "zustand";
import { agentSend } from "../lib/ipc";
import { buildUserMessageText, type UserMessagePill } from "../lib/agent-conversation";
import { collectLeaves, paneKind } from "../lib/layout-tree";
import { useTerminalStore } from "./terminal-store";

/**
 * What the user is composing for a given agent pane — draft text, context
 * pills, a queue of held prompts, and fan-out scope. Separate from
 * `agent-session-store.ts`'s `ConversationState` (what the wire says) because
 * the two have different lifetimes: a composer draft survives a session exit
 * and restart (Design decision 12 in the agent-pane-composer plan).
 *
 * This module never imports `agent-session-store.ts` — the store dependency
 * graph is a DAG (`agent-session-store` → `composer-store` → `terminal-store`;
 * Design decision 11), so the optimistic "user turn" a manual Send produces is
 * wired at the component layer (`agent-composer.tsx`, which safely imports
 * both stores) via `resolveSendTargets` below, and the queued-flush case is
 * wired by `agent-session-store.ts` itself peeking this store's `queued`
 * array before calling `flushQueue`.
 */

/**
 * The MIME type an internal HTML5 drag carries a `JSON.stringify(string[])`
 * payload of absolute paths under (C3 in the plan). The workspace-navigator
 * branch in this same run implements the producing half against this exact
 * literal — do not rename it.
 */
export const CODENEST_PATHS_MIME = "application/x-codenest-paths";

export type ContextPill =
  | { id: string; kind: "file"; path: string }
  | { id: string; kind: "task"; taskId: number; title: string; description: string | null }
  | { id: string; kind: "template"; slug: string; title: string; body: string };

interface PaneComposer {
  draft: string;
  pills: ContextPill[];
  queued: string[];
  fanoutAll: boolean;
}

function emptyPaneComposer(): PaneComposer {
  return { draft: "", pills: [], queued: [], fanoutAll: false };
}

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

// ---------------------------------------------------------------------------
// Prompt history persistence — real, but local (Design decision 8: no
// sidecar table/endpoint exists for this yet).
// ---------------------------------------------------------------------------

const HISTORY_STORAGE_KEY = "codenest.composer.history";
const HISTORY_CAP = 20;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

function persistHistory(history: string[]): void {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // localStorage may be unavailable in some sandboxes; silently skip
    // (same defensive shape as terminal-store.persistToStorage).
  }
}

/** Prepend `entry` to `history`, deduping an exact repeat and capping length. */
function pushHistory(history: string[], entry: string): string[] {
  if (entry.length === 0) return history;
  return [entry, ...history.filter((h) => h !== entry)].slice(0, HISTORY_CAP);
}

interface ComposerStore {
  panes: Record<string, PaneComposer>;
  history: string[];
  /** The last agent pane the user interacted with — the drop target for
   * `attachComposerContext` (C3), which arrives with no pane id of its own. */
  targetPaneId: string | null;

  setTargetPane: (paneId: string | null) => void;
  setDraft: (paneId: string, draft: string) => void;
  addPills: (paneId: string, pills: ContextPill[]) => void;
  removePill: (paneId: string, pillId: string) => void;
  /** Adds one `file` pill per unique path not already attached. */
  attachContextToPane: (paneId: string, paths: string[]) => void;
  /** C3 — delegates to `targetPaneId`; a no-op when it is null (the sibling
   * branch may call this before any agent pane exists). */
  attachComposerContext: (paths: string[]) => void;
  setFanoutAll: (paneId: string, value: boolean) => void;
  send: (paneId: string) => Promise<void>;
  queue: (paneId: string) => void;
  flushQueue: (paneId: string) => void;
  /** Refills the editor with a past prompt — never re-sends on click (a
   * stray click re-firing a prompt into a live session is destructive and
   * unrecoverable). */
  recall: (index: number, paneId: string) => void;
  clearPane: (paneId: string) => void;
}

/** Every `kind === "agent"` leaf id in the active tab, `paneId` first (and
 * always included even if, for some reason, it is not found among them).
 * Exported so `agent-composer.tsx` can resolve the same target list the
 * store's own `send` uses — without either side importing the other store. */
export function resolveSendTargets(paneId: string, fanoutAll: boolean): string[] {
  if (!fanoutAll) return [paneId];
  const { tabs, activeTabId } = useTerminalStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  const agentIds = tab
    ? collectLeaves(tab.layout)
        .filter((l) => paneKind(l) === "agent")
        .map((l) => l.terminalId)
    : [];
  return agentIds.includes(paneId) ? agentIds : [paneId, ...agentIds];
}

function pillToMessagePill(pill: ContextPill): UserMessagePill {
  switch (pill.kind) {
    case "file":
      return { kind: "file", path: pill.path };
    case "task":
      return { kind: "task", taskId: pill.taskId, title: pill.title, description: pill.description };
    case "template":
      return { kind: "template", slug: pill.slug, title: pill.title, body: pill.body };
  }
}

export const useComposerStore = create<ComposerStore>((set, get) => ({
  panes: {},
  history: loadHistory(),
  targetPaneId: null,

  setTargetPane: (paneId) => set({ targetPaneId: paneId }),

  setDraft: (paneId, draft) => {
    set((state) => ({
      panes: {
        ...state.panes,
        [paneId]: { ...(state.panes[paneId] ?? emptyPaneComposer()), draft },
      },
    }));
  },

  addPills: (paneId, pills) => {
    if (pills.length === 0) return;
    set((state) => {
      const pane = state.panes[paneId] ?? emptyPaneComposer();
      const existingIds = new Set(pane.pills.map((p) => p.id));
      const additions = pills.filter((p) => !existingIds.has(p.id));
      if (additions.length === 0) return state;
      return {
        panes: {
          ...state.panes,
          [paneId]: { ...pane, pills: [...pane.pills, ...additions] },
        },
      };
    });
  },

  removePill: (paneId, pillId) => {
    set((state) => {
      const pane = state.panes[paneId];
      if (!pane) return state;
      return {
        panes: {
          ...state.panes,
          [paneId]: { ...pane, pills: pane.pills.filter((p) => p.id !== pillId) },
        },
      };
    });
  },

  attachContextToPane: (paneId, paths) => {
    set((state) => {
      const pane = state.panes[paneId] ?? emptyPaneComposer();
      const existingPaths = new Set(
        pane.pills.filter((p) => p.kind === "file").map((p) => p.path),
      );
      const additions: ContextPill[] = [];
      for (const path of paths) {
        if (existingPaths.has(path)) continue;
        existingPaths.add(path);
        additions.push({ id: genId(), kind: "file", path });
      }
      if (additions.length === 0) return state;
      return {
        panes: {
          ...state.panes,
          [paneId]: { ...pane, pills: [...pane.pills, ...additions] },
        },
      };
    });
  },

  attachComposerContext: (paths) => {
    const target = get().targetPaneId;
    if (!target) return;
    get().attachContextToPane(target, paths);
  },

  setFanoutAll: (paneId, value) => {
    set((state) => ({
      panes: {
        ...state.panes,
        [paneId]: { ...(state.panes[paneId] ?? emptyPaneComposer()), fanoutAll: value },
      },
    }));
  },

  send: async (paneId) => {
    const pane = get().panes[paneId] ?? emptyPaneComposer();
    const messagePills = pane.pills.map(pillToMessagePill);
    const text = buildUserMessageText(messagePills, pane.draft);
    if (text.trim().length === 0) return;

    const targets = resolveSendTargets(paneId, pane.fanoutAll);
    await Promise.all(
      targets.map((target) =>
        agentSend(target, text).catch((err: unknown) => {
          console.error("[composer-store] agentSend failed", target, err);
        }),
      ),
    );

    const rawDraft = pane.draft;
    set((state) => ({
      panes: {
        ...state.panes,
        [paneId]: { ...(state.panes[paneId] ?? emptyPaneComposer()), draft: "" },
      },
      history: pushHistory(state.history, rawDraft),
    }));
    persistHistory(get().history);
  },

  queue: (paneId) => {
    const pane = get().panes[paneId] ?? emptyPaneComposer();
    const messagePills = pane.pills.map(pillToMessagePill);
    const text = buildUserMessageText(messagePills, pane.draft);
    if (text.trim().length === 0) return;
    set((state) => {
      const current = state.panes[paneId] ?? emptyPaneComposer();
      return {
        panes: {
          ...state.panes,
          [paneId]: { ...current, draft: "", queued: [...current.queued, text] },
        },
      };
    });
  },

  flushQueue: (paneId) => {
    const pane = get().panes[paneId];
    if (!pane || pane.queued.length === 0) return;
    const [next, ...rest] = pane.queued;
    set((state) => ({
      panes: {
        ...state.panes,
        [paneId]: { ...(state.panes[paneId] ?? emptyPaneComposer()), queued: rest },
      },
    }));
    if (next !== undefined) {
      void agentSend(paneId, next).catch((err: unknown) => {
        console.error("[composer-store] flushQueue agentSend failed", paneId, err);
      });
    }
  },

  recall: (index, paneId) => {
    const text = get().history[index];
    if (text === undefined) return;
    set((state) => ({
      panes: {
        ...state.panes,
        [paneId]: { ...(state.panes[paneId] ?? emptyPaneComposer()), draft: text },
      },
    }));
  },

  clearPane: (paneId) => {
    set((state) => {
      if (!(paneId in state.panes)) return state;
      const panes = { ...state.panes };
      delete panes[paneId];
      return { panes };
    });
  },
}));
