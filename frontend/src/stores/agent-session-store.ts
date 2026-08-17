import { create } from "zustand";
import {
  applyFrame as applyReducerFrame,
  appendUserTurn,
  emptyConversation,
  type ConversationState,
} from "../lib/agent-conversation";
import { agentRespondPermission, type AgentFrame } from "../lib/ipc";
import { useComposerStore } from "./composer-store";
import { useTerminalStore } from "./terminal-store";

/**
 * What the wire says, per agent pane — frames reduced into a
 * `ConversationState`, plus the per-pane "allow for this session" policy
 * (Design decision 7). Separate from `composer-store.ts` (what the user is
 * composing), which has a different lifetime (a draft survives a session
 * exit and restart).
 *
 * Imports `composer-store.ts` and `terminal-store.ts` — never the reverse —
 * keeping the store dependency graph a DAG (Design decision 11): this store
 * calls `composerStore`'s state directly (never the other way around) for
 * the `result`-frame flush, and `terminalStore.markLeafExited` for the
 * `exit` frame.
 */
interface AgentSessionStore {
  panes: Record<string, ConversationState>;
  /** paneId → session keys already auto-allowed (Design decision 7). */
  sessionAllowed: Record<string, string[]>;

  ensurePane: (paneId: string) => void;
  applyFrame: (paneId: string, frame: AgentFrame) => void;
  markStarting: (paneId: string) => void;
  /**
   * This pane's `agent_start` was refused because the shell already holds a
   * live session for it, and the pane attached to that session instead of
   * spawning a second child or wedging (#42).
   *
   * `idle` is the honest reading of what is then known: a session exists and
   * accepts input, and nothing this side has seen says a turn is in flight. It
   * is also self-correcting — an attached session mid-turn is emitting frames
   * into the same subscription, so the very next one moves the status to
   * `running` (or to `exited` if it died between the refusal and here).
   */
  markAttached: (paneId: string) => void;
  /** Optimistic user turn + status "running" — the CLI never echoes a plain
   * user message (Design decision 5), so this is the only place one is
   * added for a message this pane itself sent. */
  markSendStart: (paneId: string, text: string) => void;
  allowSession: (paneId: string, sessionKey: string) => void;
  resolvePermission: (paneId: string, requestId: string) => void;
  reset: (paneId: string) => void;
  /** Empty the rendered conversation while keeping the session — what `/clear`
   *  means. Distinct from `reset`, which drops the pane's whole entry and is
   *  for a session that has genuinely gone away. */
  clearContext: (paneId: string) => void;
}

export const useAgentSessionStore = create<AgentSessionStore>((set, get) => ({
  panes: {},
  sessionAllowed: {},

  ensurePane: (paneId) => {
    set((state) => {
      if (paneId in state.panes) return state;
      return { panes: { ...state.panes, [paneId]: emptyConversation() } };
    });
  },

  markStarting: (paneId) => {
    set((state) => ({
      panes: {
        ...state.panes,
        [paneId]: { ...(state.panes[paneId] ?? emptyConversation()), status: "starting" },
      },
    }));
  },

  markAttached: (paneId) => {
    set((state) => ({
      panes: {
        ...state.panes,
        [paneId]: { ...(state.panes[paneId] ?? emptyConversation()), status: "idle" },
      },
    }));
  },

  markSendStart: (paneId, text) => {
    set((state) => ({
      panes: {
        ...state.panes,
        [paneId]: appendUserTurn(state.panes[paneId] ?? emptyConversation(), text, Date.now()),
      },
    }));
  },

  allowSession: (paneId, sessionKey) => {
    set((state) => {
      const existing = state.sessionAllowed[paneId] ?? [];
      if (existing.includes(sessionKey)) return state;
      return {
        sessionAllowed: { ...state.sessionAllowed, [paneId]: [...existing, sessionKey] },
      };
    });
  },

  resolvePermission: (paneId, requestId) => {
    set((state) => {
      const pane = state.panes[paneId];
      if (!pane) return state;
      return {
        panes: {
          ...state.panes,
          [paneId]: {
            ...pane,
            permissions: pane.permissions.filter((p) => p.requestId !== requestId),
          },
        },
      };
    });
  },

  reset: (paneId) => {
    set((state) => {
      if (!(paneId in state.panes) && !(paneId in state.sessionAllowed)) return state;
      const panes = { ...state.panes };
      delete panes[paneId];
      const sessionAllowed = { ...state.sessionAllowed };
      delete sessionAllowed[paneId];
      return { panes, sessionAllowed };
    });
  },

  clearContext: (paneId) => {
    set((state) => {
      const pane = state.panes[paneId];
      if (!pane) return state;
      return {
        panes: {
          ...state.panes,
          [paneId]: {
            ...pane,
            // Everything that *is* the transcript.
            turns: [],
            streaming: false,
            streamText: "",
            thinking: false,
            thinkingTokens: 0,
            lastResult: null,
            // `sessionId`, `status`, `model`, `permissionMode`, `startedAt`,
            // `exitCode` and `usage` are deliberately untouched: this is a
            // context reset, not a teardown. The process is still alive and
            // still the same session, so anything describing the *session*
            // rather than the conversation has to survive — resetting them is
            // what made `/clear` look like an exit.
          },
        },
      };
    });
  },

  applyFrame: (paneId, frame) => {
    const now = Date.now();
    set((state) => {
      const prev = state.panes[paneId] ?? emptyConversation();
      let next = applyReducerFrame(prev, frame, now);

      // A `permission` whose sessionKey was already allowed "for this
      // session" (Design decision 7) is auto-answered and dropped from the
      // queue in the same commit — it must never render, not even briefly.
      if (frame.kind === "permission") {
        const added = next.permissions[next.permissions.length - 1];
        const allowedKeys = state.sessionAllowed[paneId] ?? [];
        if (added && allowedKeys.includes(added.sessionKey)) {
          next = {
            ...next,
            permissions: next.permissions.filter((p) => p.requestId !== added.requestId),
          };
          void agentRespondPermission({
            paneId,
            requestId: added.requestId,
            allow: true,
            updatedInput: added.input,
          }).catch((err: unknown) => {
            console.error("[agent-session-store] auto-allow respond failed", paneId, err);
          });
        }
      }

      return { panes: { ...state.panes, [paneId]: next } };
    });

    if (frame.kind === "result") {
      // A queued prompt is about to be flushed (composer-store's own FIFO
      // pop) — render it as the optimistic user turn at the moment it is
      // actually sent, not when it was queued. Reads composer-store's state
      // directly rather than composer-store importing this store back
      // (Design decision 11: composer-store never imports this module).
      const queuedNext = useComposerStore.getState().panes[paneId]?.queued[0];
      if (queuedNext !== undefined) {
        get().markSendStart(paneId, queuedNext);
      }
      useComposerStore.getState().flushQueue(paneId);
    } else if (frame.kind === "exit") {
      useTerminalStore.getState().markLeafExited(paneId);
    }
  },
}));
