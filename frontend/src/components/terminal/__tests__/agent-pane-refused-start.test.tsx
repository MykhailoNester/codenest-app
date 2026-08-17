// Regression coverage for #42 — an `agent_start` the shell refuses because the
// pane already holds a session slot ("agent session already running for pane
// …", `mod.rs`'s D10 guard).
//
// The reported failure was not the refusal itself but what the pane did with
// it: the composer stayed fully enabled — input, Send and Queue — over a pane
// that had no session of its own, and the refusal only became visible after the
// user's prompt had round-tripped, under a status line still reading `running`
// from the previous session's frames.
//
// The three resolutions pinned here are the three the pane can be in when the
// slot is occupied: our own stop still landing (a Restart), somebody's live
// session for this pane id (attach), and nothing live at all (clear and retry).
// The fourth case — unrecoverable — must gate the composer instead of letting a
// send discover it.
//
// Mock shape is `agent-pane-restart.test.tsx`'s verbatim, plus `listLivePanes`:
// that is what the pane asks in order to tell case 2 from case 3.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { TerminalsLayout } from "../../../pages/terminal";
import { useTerminalStore, type Tab } from "../../../stores/terminal-store";
import { useAgentSessionStore } from "../../../stores/agent-session-store";
import { FEATURE_CACHE_KEY } from "../../../lib/nav-items";
import * as ipc from "../../../lib/ipc";
import type { AgentFrame } from "../../../lib/ipc";

const { handlers } = vi.hoisted(() => ({
  handlers: [] as Array<(frame: AgentFrame) => void>,
}));

vi.mock("../../../lib/ipc", async () => {
  const { useEffect } = await import("react");
  return {
    isTauriAvailable: vi.fn((): boolean => false),
    getGitPaneStatus: vi.fn(async () => null),
    sendTerminalInput: vi.fn(async () => undefined),
    resizeTerminal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => undefined),
    emitNativeNotification: vi.fn(async () => undefined),
    openTerminal: vi.fn(async () => ({ id: "pty-new" })),
    closeTerminal: vi.fn(async () => undefined),
    getWorkspacePath: vi.fn(async () => "/workspace"),
    listLivePanes: vi.fn(async () => [] as string[]),
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
    useTerminalOutput: (id: string | null, handler: (chunk: string) => void): void => {
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

vi.mock("../../../hooks/use-terminal-file-drop", () => ({
  useTerminalFileDrop: (): void => undefined,
}));

const agentStartMock = ipc.agentStart as unknown as ReturnType<typeof vi.fn>;
const agentStopMock = ipc.agentStop as unknown as ReturnType<typeof vi.fn>;
const listLivePanesMock = ipc.listLivePanes as unknown as ReturnType<typeof vi.fn>;

/** The shell's own refusal string — matched, not paraphrased. */
function duplicateRefusal(paneId: string): Error {
  return new Error(`agent session already running for pane ${paneId}`);
}

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
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    StubResizeObserver as unknown as typeof ResizeObserver;

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

/** One tab, one agent leaf — a fresh `leafId` per test, so `agent-pane.tsx`'s
 *  module-level `startedPanes`/`pendingStops` can never carry state across. */
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

function composer(): HTMLElement {
  const el = document.querySelector("[data-agent-composer]");
  if (!(el instanceof HTMLElement)) throw new Error("composer not rendered");
  return el;
}

function button(name: RegExp): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

beforeEach(() => {
  installLocalStorage();
  localStorage.setItem(FEATURE_CACHE_KEY, JSON.stringify({ composer: true }));
  handlers.length = 0;
  agentStartMock.mockClear();
  agentStopMock.mockClear();
  listLivePanesMock.mockClear().mockResolvedValue([]);
  useAgentSessionStore.setState({ panes: {}, sessionAllowed: {} });
});

afterEach(() => {
  cleanup();
});

describe("agent pane — a refused agent_start", () => {
  it("attaches to the live session already holding the slot instead of killing or wedging it", async () => {
    const leafId = "agent-refused-live";
    // The shell holds a live child for this pane id — the other window showing
    // this leaf, or a frontend that lost its record of a session still running.
    agentStartMock.mockRejectedValueOnce(duplicateRefusal(leafId));
    listLivePanesMock.mockResolvedValue([leafId]);

    renderAgentTab(leafId);

    // Generous timeouts throughout: `boot()` awaits the agent catalog before it
    // starts anything, and under a loaded full-suite run that wait alone can
    // outlast Testing Library's 1s default.
    await waitFor(
      () => expect(useAgentSessionStore.getState().panes[leafId]?.status).toBe("idle"),
      { timeout: 10_000 },
    );
    // The working session is left alone: not stopped, not replaced.
    expect(agentStopMock).not.toHaveBeenCalled();
    expect(agentStartMock).toHaveBeenCalledTimes(1);
    // And the composer is live, because `agent_send` writes to that session.
    expect(composer().dataset.session).toBe("live");
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("clears a slot with nothing live behind it and starts once more", async () => {
    const leafId = "agent-refused-stale";
    // A reservation from a start that never published: the slot is occupied,
    // but `list_live_panes` reports no live session for the pane.
    agentStartMock.mockRejectedValueOnce(duplicateRefusal(leafId));
    listLivePanesMock.mockResolvedValue(["some-other-pane"]);

    renderAgentTab(leafId);

    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(2), {
      timeout: 10_000,
    });
    expect(agentStopMock).toHaveBeenCalledTimes(1);
    // Recovered without the user ever seeing the refusal.
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(composer().dataset.session).toBe("live");
  });

  it("refuses input instead of accepting a prompt when the refusal cannot be recovered", async () => {
    const leafId = "agent-refused-wedged";
    // Both attempts refused and nothing live to attach to — the one case where
    // the pane genuinely has no session. This is the shape of the bug: the
    // composer used to stay fully enabled here, and the banner only appeared
    // after a prompt had been sent.
    agentStartMock.mockRejectedValue(duplicateRefusal(leafId));
    listLivePanesMock.mockResolvedValue([]);

    renderAgentTab(leafId);

    const retry = await screen.findByRole("button", { name: /retry/i }, { timeout: 10_000 });
    expect(retry).not.toBeNull();
    expect(composer().dataset.session).toBe("none");
    expect(button(/^Send/).disabled).toBe(true);
    expect(button(/Queue/).disabled).toBe(true);
    expect(composer().textContent).toContain("no session for this pane");
  });

  it("does not gate the composer while a start is merely in flight", async () => {
    const leafId = "agent-start-pending";
    // Nothing has failed yet: a slow start must not read as a refused one.
    let resolveStart: ((v: unknown) => void) | undefined;
    agentStartMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );

    renderAgentTab(leafId);

    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1), {
      timeout: 10_000,
    });
    expect(composer().dataset.session).toBe("live");
    resolveStart?.({ pane_id: leafId, session_id: "s1", pid: 1 });
  });
});
