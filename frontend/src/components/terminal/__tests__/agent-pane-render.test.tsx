// Regression coverage for the `composer`-feature gate around `<AgentPane/>`:
// the pane tree must render — and answer `agent_start`/`agent_stop` — with no
// `QueryClientProvider`, exactly like `terminal-tab-persistence.test.tsx`
// (see the agent-pane-composer plan's Design decision 2 / B1 in the plan
// review). `<TerminalsLayout/>` is rendered directly, with no provider, so a
// regression that pulls `useEnabledFeatures()` (a react-query hook) into the
// pane tree turns this file red instead of only failing silently in the app.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { TerminalsLayout } from "../../../pages/terminal";
import { useTerminalStore, type Tab } from "../../../stores/terminal-store";
import { FEATURE_CACHE_KEY } from "../../../lib/nav-items";
import * as ipc from "../../../lib/ipc";

// ---------------------------------------------------------------------------
// Mocks — same shape as `terminal-tab-persistence.test.tsx`'s `lib/ipc` mock,
// since `split-container.tsx` now reaches `agent-pane.tsx` for every render
// of this file, not just the ones that mount an agent leaf.
// ---------------------------------------------------------------------------

vi.mock("../../../lib/ipc", async () => {
  const { useEffect } = await import("react");
  return {
    // `session-hud-store` reads both of these on mount. A vi.mock factory
    // replaces the module wholesale, so an export the rendered subtree
    // reaches must be listed here or Vitest throws on access. Returning
    // false keeps the HUD in its no-Tauri branch, which is what a jsdom
    // test should exercise.
    isTauriAvailable: vi.fn((): boolean => false),
    getGitPaneStatus: vi.fn(async () => null),
    sendTerminalInput: vi.fn(async () => undefined),
    resizeTerminal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => undefined),
    emitNativeNotification: vi.fn(async () => undefined),
    openTerminal: vi.fn(async () => ({ id: "pty-new" })),
    closeTerminal: vi.fn(async () => undefined),
    getWorkspacePath: vi.fn(async () => "/workspace"),
    agentStart: vi.fn(
      async (args: { paneId: string }) =>
        ({ pane_id: args.paneId, session_id: "session-1", pid: 1 }) as const,
    ),
    agentSend: vi.fn(async () => undefined),
    agentInterrupt: vi.fn(async () => undefined),
    agentStop: vi.fn(async () => undefined),
    agentRespondPermission: vi.fn(async () => undefined),
    subscribeAgentFrames: vi.fn(async () => () => undefined),
    useTerminalOutput: (
      id: string | null,
      handler: (chunk: string) => void,
    ): void => {
      useEffect(() => {
        if (!id) return;
        // No test here feeds output through this path — registering is
        // enough to keep `terminal-pane.tsx` from throwing on an
        // (unrendered, in these tests) shell leaf.
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
// exactly as the persistence test does.
vi.mock("../../../hooks/use-terminal-file-drop", () => ({
  useTerminalFileDrop: (): void => undefined,
}));

const agentStartMock = ipc.agentStart as unknown as ReturnType<typeof vi.fn>;
const openTerminalMock = ipc.openTerminal as unknown as ReturnType<
  typeof vi.fn
>;
const subscribeAgentFramesMock = ipc.subscribeAgentFrames as unknown as ReturnType<
  typeof vi.fn
>;
const agentStopMock = ipc.agentStop as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// localStorage stub — `useComposerFeature()` reads `FEATURE_CACHE_KEY`
// through the global; jsdom's built-in `localStorage` collides with Node's
// own `--localstorage-file` implementation in this repo's test runner (see
// the warning vitest prints), so every test file that touches the cache
// stubs a plain `Map`-backed one instead (same pattern as
// `composer-feature.test.tsx` and `terminal-store.test.ts`).
// ---------------------------------------------------------------------------

// jsdom stubs — local to this file (`frontend/vite.config.ts` deliberately
// has no global setupFiles). The third test below closes the only tab, which
// triggers `terminal-store.ts`'s "at least one tab" reseed (a fresh *shell*
// tab), so its `<TerminalPane/>` really does mount `xterm` here, exactly as
// in `terminal-tab-persistence.test.tsx`.
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

function installLocalStorage(): Map<string, string> {
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
  return store;
}

// A single tab holding only an agent leaf.
const agentTab: Tab = {
  id: "tab-agent",
  title: "Agent",
  layout: {
    type: "leaf",
    terminalId: "agent-1",
    title: "claude",
    kind: "agent",
    cwd: "/workspace/proj",
  },
};

beforeEach(() => {
  installLocalStorage();
  // `afterEach(cleanup)` below unmounts the previous test's tree, which
  // itself calls `agentStop`/`closeTerminal` via effect cleanup — clear call
  // counts here so each test's assertions read only its own render.
  agentStartMock.mockClear();
  openTerminalMock.mockClear();
  subscribeAgentFramesMock.mockClear();
  agentStopMock.mockClear();
  useTerminalStore.setState({
    tabs: [agentTab],
    activeTabId: agentTab.id,
    focusedLeafId: "agent-1",
    hydrated: true,
    hydrating: false,
    maximizedLeafId: null,
  });
});

// `afterEach(cleanup)` is mandatory: `frontend/vite.config.ts` does not set
// `globals: true`, so Testing Library's auto-cleanup never registers.
afterEach(() => {
  cleanup();
});

describe("agent pane render — composer feature gate", () => {
  it("with the feature off, an agent leaf renders the disabled notice and starts no session", async () => {
    localStorage.setItem(FEATURE_CACHE_KEY, JSON.stringify({ composer: false }));

    render(<TerminalsLayout />);

    // `findByText` throws if no match is found — reaching the assertion
    // below is itself the "disabled notice rendered" proof.
    await screen.findByText(/Agent panes are off/i);
    expect(agentStartMock).not.toHaveBeenCalled();
    expect(openTerminalMock).not.toHaveBeenCalled();
  });

  it("with the feature on, subscribes to frames before starting the session, and never opens a PTY for the agent leaf", async () => {
    localStorage.setItem(FEATURE_CACHE_KEY, JSON.stringify({ composer: true }));

    render(<TerminalsLayout />);

    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));
    expect(subscribeAgentFramesMock).toHaveBeenCalledTimes(1);
    expect(agentStartMock).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: "agent-1", cwd: "/workspace/proj" }),
    );

    const subscribeOrder = subscribeAgentFramesMock.mock.invocationCallOrder[0];
    const startOrder = agentStartMock.mock.invocationCallOrder[0];
    expect(subscribeOrder).not.toBeUndefined();
    expect(startOrder).not.toBeUndefined();
    expect(subscribeOrder as number).toBeLessThan(startOrder as number);

    // The tab holds no shell leaf at all, so `openTerminal` (the PTY-backed
    // path) is never reached for it.
    expect(openTerminalMock).not.toHaveBeenCalled();
  });

  it("closing the agent pane's tab stops its session exactly once", async () => {
    localStorage.setItem(FEATURE_CACHE_KEY, JSON.stringify({ composer: true }));

    render(<TerminalsLayout />);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await useTerminalStore.getState().closeTab(agentTab.id);
    });

    await waitFor(() => expect(agentStopMock).toHaveBeenCalledTimes(1));
    expect(agentStopMock).toHaveBeenCalledWith("agent-1");
  });
});
