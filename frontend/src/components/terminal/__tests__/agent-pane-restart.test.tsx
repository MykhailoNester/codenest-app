// Regression coverage for the agent pane's Restart flow (code review round 1,
// findings F1 and F2 — both were shipped with zero coverage: neither
// `retryToken`, `handleRetry`, nor "Restart" was exercised by any test).
//
// F1: a Restart click must start a fresh session even while the *previous*
// session's `agent_stop` is still unresolved — the exact race the bug lived
// in, so this drives the actual interleaving (holding `agentStop` open across
// the click) rather than asserting on an end-state snapshot.
//
// F2: Restart must never discard a pending, unsent composer draft or its
// context pills — only a genuine unmount may (Design decision 12: "a composer
// draft survives a session exit and restart").

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TerminalsLayout } from "../../../pages/terminal";
import { useTerminalStore, type Tab } from "../../../stores/terminal-store";
import { useComposerStore } from "../../../stores/composer-store";
import { useAgentSessionStore } from "../../../stores/agent-session-store";
import { FEATURE_CACHE_KEY } from "../../../lib/nav-items";
import * as ipc from "../../../lib/ipc";
import type { AgentFrame } from "../../../lib/ipc";

// ---------------------------------------------------------------------------
// Mocks — same shape as `agent-pane-render.test.tsx`'s `lib/ipc` mock, plus a
// `subscribeAgentFrames` that records every handler it is given (one per
// boot, keyed by call order) so a test can inject a synthetic `exit` frame —
// the only way to reach the "Restart" bar without a real Tauri backend.
// `handlers` is declared via `vi.hoisted` so both the factory below and the
// test bodies can reference the same array (a mock factory cannot close over
// an out-of-scope module variable otherwise).
// ---------------------------------------------------------------------------

const { handlers } = vi.hoisted(() => ({
  handlers: [] as Array<(frame: AgentFrame) => void>,
}));

vi.mock("../../../lib/ipc", async () => {
  const { useEffect } = await import("react");
  return {
    sendTerminalInput: vi.fn(async () => undefined),
    resizeTerminal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => undefined),
    emitNativeNotification: vi.fn(async () => undefined),
    openTerminal: vi.fn(async () => ({ id: "pty-new" })),
    closeTerminal: vi.fn(async () => undefined),
    getWorkspacePath: vi.fn(async () => "/workspace"),
    agentStart: vi.fn(
      async (args: { paneId: string }) =>
        ({ pane_id: args.paneId, session_id: "session-x", pid: 1 }) as const,
    ),
    agentSend: vi.fn(async () => undefined),
    agentInterrupt: vi.fn(async () => undefined),
    agentStop: vi.fn(async () => undefined),
    agentRespondPermission: vi.fn(async () => undefined),
    subscribeAgentFrames: vi.fn(
      async (_paneId: string, handler: (frame: AgentFrame) => void) => {
        handlers.push(handler);
        return () => undefined;
      },
    ),
    useTerminalOutput: (
      id: string | null,
      handler: (chunk: string) => void,
    ): void => {
      useEffect(() => {
        if (!id) return;
        void handler;
      }, [id, handler]);
    },
    usePtyExited: (
      id: string | null,
      handler: (payload: { id: string; exit_code: number | null }) => void,
    ): void => {
      useEffect(() => {
        if (!id) return;
        void handler;
      }, [id, handler]);
    },
  };
});

// `useTerminalFileDrop` calls `getCurrentWebview()` on mount, which throws
// without `window.__TAURI_INTERNALS__`. Not under test here — no-op it,
// exactly as the persistence and render tests do.
vi.mock("../../../hooks/use-terminal-file-drop", () => ({
  useTerminalFileDrop: (): void => undefined,
}));

const agentStartMock = ipc.agentStart as unknown as ReturnType<typeof vi.fn>;
const agentStopMock = ipc.agentStop as unknown as ReturnType<typeof vi.fn>;
const subscribeAgentFramesMock = ipc.subscribeAgentFrames as unknown as ReturnType<
  typeof vi.fn
>;

// jsdom stubs — local to this file (`frontend/vite.config.ts` deliberately
// has no global setupFiles); none of the fixtures below hold a shell leaf, so
// these exist only in case a "at least one tab" reseed ever mounts one.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });

  class StubResizeObserver {
    observe(): void {
      /* no-op */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  }
  (
    globalThis as unknown as { ResizeObserver: typeof ResizeObserver }
  ).ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;

  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    writable: true,
    value: () => null,
  });
});

function installLocalStorage(): void {
  const store = new Map<string, string>();
  const fake: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
  };
  vi.stubGlobal("localStorage", fake);
}

/** Renders `<TerminalsLayout/>` with a single tab holding one agent leaf.
 * Every test uses its own `leafId` so the module-level `startedPanes` guard
 * in `agent-pane.tsx` (keyed by `` `${leafId}:${retryToken}` ``) can never
 * see a stale entry left behind by a *previous* test in this file — the
 * `agentStop` promise F1's test deliberately holds open would otherwise leak
 * across tests. */
function renderAgentTab(leafId: string): void {
  const tab: Tab = {
    id: `tab-${leafId}`,
    title: "Agent",
    layout: {
      type: "leaf",
      terminalId: leafId,
      title: "claude",
      kind: "agent",
      cwd: "/workspace/proj",
    },
  };
  useTerminalStore.setState({
    tabs: [tab],
    activeTabId: tab.id,
    focusedLeafId: leafId,
    hydrated: true,
    hydrating: false,
    maximizedLeafId: null,
  });
  render(<TerminalsLayout />);
}

beforeEach(() => {
  installLocalStorage();
  localStorage.setItem(FEATURE_CACHE_KEY, JSON.stringify({ composer: true }));
  handlers.length = 0;
  agentStartMock.mockClear();
  agentStopMock.mockClear();
  subscribeAgentFramesMock.mockClear();
});

// `afterEach(cleanup)` is mandatory: `frontend/vite.config.ts` does not set
// `globals: true`, so Testing Library's auto-cleanup never registers.
afterEach(() => {
  cleanup();
});

describe("agent pane — Restart flow", () => {
  it("F1: starts a fresh session on Restart even while the previous session's agent_stop is still pending", async () => {
    const leafId = "agent-f1";

    // Holds the *first* `agent_stop` call open — this is the exact
    // interleaving the bug lived in: cleanup's `agentStop(...)` is
    // fire-and-forget, so a fixed `boot()` must not depend on it having
    // already resolved before starting the new session.
    let resolveStop: (() => void) | undefined;
    agentStopMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        }),
    );

    renderAgentTab(leafId);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));

    // Drive the session to "exited" so the composer is replaced by the
    // "Restart" bar, exactly as a real crash/natural exit would.
    act(() => {
      handlers[0]?.({
        pane_id: leafId,
        session_id: "s1",
        kind: "exit",
        raw: { exit_code: 0 },
      });
    });
    const restartBtn = await screen.findByRole("button", { name: /restart/i });

    fireEvent.click(restartBtn);

    // The old boot's `agent_stop` is still unresolved right now (held open
    // above) — under the pre-fix code, keyed only on `leafId`, `boot()`'s
    // `startedPanes.has(leafId)` check would still read `true` here and the
    // pane would stay dead. The fix (keyed on `leafId:retryToken`) must call
    // `agent_start` again regardless.
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(2));
    expect(agentStopMock).toHaveBeenCalledTimes(1);

    // Let the held-open stop settle so nothing is left dangling for the next
    // test (harmless here either way, since every test uses its own leafId).
    resolveStop?.();
  });

  it("F2: Restart does not discard a pending composer draft or its context pills", async () => {
    const leafId = "agent-f2a";

    renderAgentTab(leafId);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));

    act(() => {
      useComposerStore.getState().setDraft(leafId, "an unsent draft");
      useComposerStore.getState().attachContextToPane(leafId, ["/tmp/notes.md"]);
    });
    expect(useComposerStore.getState().panes[leafId]?.draft).toBe(
      "an unsent draft",
    );

    // The session exits with the draft still sitting in the composer,
    // unsent — the exact scenario F2 describes.
    act(() => {
      handlers[handlers.length - 1]?.({
        pane_id: leafId,
        session_id: "s1",
        kind: "exit",
        raw: { exit_code: 1 },
      });
    });
    const restartBtn = await screen.findByRole("button", { name: /restart/i });

    fireEvent.click(restartBtn);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(2));

    // The draft and its pill must still be there — Design decision 12 ("a
    // composer draft survives a session exit and restart").
    expect(useComposerStore.getState().panes[leafId]?.draft).toBe(
      "an unsent draft",
    );
    expect(useComposerStore.getState().panes[leafId]?.pills).toHaveLength(1);
  });

  it("a genuine unmount (closing the tab) still clears the composer draft and session state", async () => {
    const leafId = "agent-f2b";

    renderAgentTab(leafId);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));

    act(() => {
      useComposerStore.getState().setDraft(leafId, "draft that should not survive");
    });
    expect(useComposerStore.getState().panes[leafId]?.draft).toBe(
      "draft that should not survive",
    );

    const tabId = useTerminalStore.getState().tabs[0]?.id;
    if (!tabId) throw new Error("expected a tab in the store");
    await act(async () => {
      await useTerminalStore.getState().closeTab(tabId);
    });

    // F2's fix narrows *when* teardown clears state — it must not stop a
    // real unmount from clearing it.
    expect(useComposerStore.getState().panes[leafId]).toBeUndefined();
    expect(useAgentSessionStore.getState().panes[leafId]).toBeUndefined();
  });
});
