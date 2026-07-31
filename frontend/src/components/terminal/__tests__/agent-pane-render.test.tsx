// Regression coverage for `<AgentPane/>`'s session lifecycle, and for the rule
// that the pane tree must render — and answer `agent_start`/`agent_stop` — with
// no `QueryClientProvider`. `<TerminalsLayout/>` is rendered directly, with no
// provider, so a regression that pulls a react-query hook into the pane tree
// (`useEnabledFeatures`, `useProviders`, …) turns this file red instead of only
// failing silently in the app. That constraint is why the provider/model
// catalog lives in a zustand store fed by a bare fetch
// (`stores/agent-catalog-store.ts`) rather than in react-query.
//
// The third test is the one that matters most in practice: closing a *sibling*
// pane must not kill a working agent session. It used to, because React
// reconciles the collapsing split by unmounting and remounting this subtree and
// the unmount cleanup read that as teardown — leaving the user staring at
// "Session ended (exit 0)" after closing the shell beside their agent.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TerminalsLayout } from "../../../pages/terminal";
import { useTerminalStore, type Tab } from "../../../stores/terminal-store";
import { useAgentCatalogStore } from "../../../stores/agent-catalog-store";
import { findLeaf } from "../../../lib/layout-tree";
import * as ipc from "../../../lib/ipc";
import type { AgentFrame } from "../../../lib/ipc";

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
    agentSetModel: vi.fn(async () => undefined),
    agentSetPermissionMode: vi.fn(async () => undefined),
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

// The Command Center's AGENTS panel lists `agent_runs` rows, so these two calls
// are what make a pane visible (and stoppable) there. Mocked rather than left to
// hit the sidecar: `fetchSidecar` would otherwise fire a real request per test.
const { recordAgentLaunchMock, recordAgentExitedMock } = vi.hoisted(() => ({
  recordAgentLaunchMock: vi.fn(),
  recordAgentExitedMock: vi.fn(),
}));

vi.mock("../../../lib/agent-run-telemetry", () => ({
  recordAgentLaunch: (payload: unknown) => recordAgentLaunchMock(payload),
  recordAgentExited: (paneId: string, exitCode: number | null) =>
    recordAgentExitedMock(paneId, exitCode),
}));

const agentStartMock = ipc.agentStart as unknown as ReturnType<typeof vi.fn>;
const openTerminalMock = ipc.openTerminal as unknown as ReturnType<
  typeof vi.fn
>;
const subscribeAgentFramesMock = ipc.subscribeAgentFrames as unknown as ReturnType<
  typeof vi.fn
>;
const agentStopMock = ipc.agentStop as unknown as ReturnType<typeof vi.fn>;
const agentSetModelMock = ipc.agentSetModel as unknown as ReturnType<
  typeof vi.fn
>;
const agentSetPermissionModeMock =
  ipc.agentSetPermissionMode as unknown as ReturnType<typeof vi.fn>;

/**
 * The claude-work provider as the sidecar serves it, seeded straight into the
 * catalog store so no HTTP is needed. `CLAUDE_CONFIG_DIR` is the field that
 * matters: the shell alias `claude-work` is
 * `CLAUDE_CONFIG_DIR=~/.claude-work command claude`, and a session started
 * without it reads the default `~/.claude` config, which fails every turn with
 * `401 OAuth access token is invalid`.
 */
function seedCatalog(): void {
  useAgentCatalogStore.setState({
    loaded: true,
    loading: false,
    lastUsed: { providerId: null, model: null },
    providers: [
      {
        id: 1,
        name: "claude-work",
        displayName: "claude-work",
        command: "claude-work {session_id} {mcp_config} {extra_args}",
        env: { CLAUDE_CONFIG_DIR: "/Users/test/.claude-work" },
        models: [
          {
            id: 4,
            provider_id: 1,
            model_name: "claude-opus-5",
            display_name: "Opus",
            is_default: true,
            is_enabled: true,
          },
          {
            id: 5,
            provider_id: 1,
            model_name: "claude-sonnet-5",
            display_name: "Sonnet",
            is_default: false,
            is_enabled: true,
          },
        ],
        defaultModel: "claude-opus-5",
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// localStorage stub — the agent catalog persists its last-used provider/model
// pair through the global, and jsdom's built-in `localStorage` collides with
// Node's own `--localstorage-file` implementation in this repo's test runner
// (see the warning vitest prints), so every test file that touches it stubs a
// plain `Map`-backed one instead (same pattern as `terminal-store.test.ts`).
// ---------------------------------------------------------------------------

// jsdom stubs — local to this file (`frontend/vite.config.ts` deliberately
// has no global setupFiles). Tests below mount real `<TerminalPane/>` trees
// (the sibling-close case renders a shell leaf), so `xterm` really does
// initialise here, exactly as in `terminal-tab-persistence.test.tsx`.
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

/**
 * A single tab holding only an agent leaf.
 *
 * Every test mints its own leaf id, because `<AgentPane/>` keeps a
 * module-level set of `(leafId, retryToken)` pairs it has already started — the
 * StrictMode double-mount guard — and an id reused across two `render()` calls
 * in one file would make the second mount look like the first one's remount and
 * skip `agent_start` entirely. Real leaf ids are UUIDs, so they are never
 * reused in the app either.
 */
function makeAgentTab(leafId: string): Tab {
  return {
    id: `tab-${leafId}`,
    title: "Agent 1",
    layout: {
      type: "leaf",
      terminalId: leafId,
      title: "claude",
      kind: "agent",
      cwd: "/workspace/proj",
    },
  };
}

function seedTab(tab: Tab, focusedLeafId: string): void {
  useTerminalStore.setState({
    tabs: [tab],
    activeTabId: tab.id,
    focusedLeafId,
    hydrated: true,
    hydrating: false,
    maximizedLeafId: null,
  });
}

beforeEach(() => {
  installLocalStorage();
  // `afterEach(cleanup)` below unmounts the previous test's tree, which
  // itself calls `agentStop`/`closeTerminal` via effect cleanup — clear call
  // counts here so each test's assertions read only its own render.
  agentStartMock.mockClear();
  openTerminalMock.mockClear();
  subscribeAgentFramesMock.mockClear();
  agentStopMock.mockClear();
  agentSetModelMock.mockClear();
  agentSetPermissionModeMock.mockClear();
  recordAgentLaunchMock.mockClear();
  recordAgentExitedMock.mockClear();
  useAgentCatalogStore.setState({
    providers: [],
    loaded: true,
    loading: false,
    lastUsed: { providerId: null, model: null },
  });
});

// `afterEach(cleanup)` is mandatory: `frontend/vite.config.ts` does not set
// `globals: true`, so Testing Library's auto-cleanup never registers.
afterEach(() => {
  cleanup();
});

describe("agent pane render", () => {
  it("subscribes to frames before starting the session, and never opens a PTY for the agent leaf", async () => {
    seedTab(makeAgentTab("agent-sub"), "agent-sub");

    render(<TerminalsLayout />);

    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));
    expect(subscribeAgentFramesMock).toHaveBeenCalledTimes(1);
    expect(agentStartMock).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: "agent-sub", cwd: "/workspace/proj" }),
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
    const tab = makeAgentTab("agent-close");
    seedTab(tab, "agent-close");

    render(<TerminalsLayout />);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await useTerminalStore.getState().closeTab(tab.id);
    });

    await waitFor(() => expect(agentStopMock).toHaveBeenCalledTimes(1));
    expect(agentStopMock).toHaveBeenCalledWith("agent-close");
  });

  it("closing a sibling shell pane leaves the agent session running", async () => {
    // agent + shell side by side, the layout the ⌘⇧T "open shell beside"
    // button produces.
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-split",
          title: "Agent 1",
          layout: {
            type: "split",
            direction: "h",
            ratio: 0.5,
            children: [
              {
                type: "leaf",
                terminalId: "agent-sibling",
                title: "claude",
                kind: "agent",
                cwd: "/workspace/proj",
              },
              {
                type: "leaf",
                terminalId: "pty-1",
                title: "zsh",
                cwd: "/workspace/proj",
              },
            ],
          },
        },
      ],
      activeTabId: "tab-split",
      focusedLeafId: "agent-sibling",
      hydrated: true,
      hydrating: false,
      maximizedLeafId: null,
    });

    render(<TerminalsLayout />);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await useTerminalStore.getState().closePane("pty-1");
    });

    // The split collapsed to the agent leaf alone, which remounts the pane…
    await waitFor(() =>
      expect(useTerminalStore.getState().tabs[0]!.layout.type).toBe("leaf"),
    );
    // …and the session it was running must survive that: no stop, and no
    // second start either (the still-live child would reject one).
    expect(agentStopMock).not.toHaveBeenCalled();
    expect(agentStartMock).toHaveBeenCalledTimes(1);
  });

  it("starts the session with the selected provider's command, env and default model", async () => {
    seedCatalog();
    seedTab(makeAgentTab("agent-provider"), "agent-provider");

    render(<TerminalsLayout />);

    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));
    expect(agentStartMock).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: "agent-provider",
        command: "claude-work {session_id} {mcp_config} {extra_args}",
        env: { CLAUDE_CONFIG_DIR: "/Users/test/.claude-work" },
        // The provider's starred model, not a hardcoded name.
        model: "claude-opus-5",
      }),
    );

    // The resolution is written back onto the leaf, so a Restart or a reload
    // reuses the same pair rather than re-resolving from scratch.
    await waitFor(() => {
      const leaf = findLeaf(
        useTerminalStore.getState().tabs[0]!.layout,
        "agent-provider",
      );
      expect(leaf?.providerId).toBe(1);
      expect(leaf?.model).toBe("claude-opus-5");
    });
  });

  it("waits for the provider catalog before spawning, so a cold start cannot 401", async () => {
    // The regression: on a cold launch the pane mounted while the sidecar was
    // still starting, resolved "no provider", and spawned `claude` with no
    // CLAUDE_CONFIG_DIR — authenticating against the default ~/.claude config,
    // which fails every turn with `401 OAuth access token is invalid`. argv and
    // env are fixed at spawn, so there is no fixing it after the fact: the only
    // correct behaviour is not to spawn yet.
    let resolved = false;
    useAgentCatalogStore.setState({
      providers: [],
      loaded: false,
      loading: false,
      lastUsed: { providerId: null, model: null },
      // Stands in for "the sidecar is still coming up": it answers eventually.
      loadWithRetry: async () => {
        await new Promise((r) => setTimeout(r, 20));
        resolved = true;
        seedCatalog();
      },
    });

    seedTab(makeAgentTab("agent-cold"), "agent-cold");
    render(<TerminalsLayout />);

    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));
    expect(resolved).toBe(true);
    expect(agentStartMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { CLAUDE_CONFIG_DIR: "/Users/test/.claude-work" },
      }),
    );
  });

  it("switches the model of a live session over the control channel instead of restarting", async () => {
    seedCatalog();
    seedTab(makeAgentTab("agent-model"), "agent-model");

    render(<TerminalsLayout />);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));

    const select = await screen.findByLabelText("Agent model");
    await act(async () => {
      fireEvent.change(select, { target: { value: "claude-sonnet-5" } });
    });

    await waitFor(() =>
      expect(agentSetModelMock).toHaveBeenCalledWith(
        "agent-model",
        "claude-sonnet-5",
      ),
    );
    // A model switch is not a restart: the running child keeps its
    // conversation, so nothing may stop or re-start it.
    expect(agentStopMock).not.toHaveBeenCalled();
    expect(agentStartMock).toHaveBeenCalledTimes(1);
    expect(
      findLeaf(useTerminalStore.getState().tabs[0]!.layout, "agent-model")?.model,
    ).toBe("claude-sonnet-5");
  });

  it("registers the session as a run so the Command Center can list it", async () => {
    seedCatalog();
    seedTab(makeAgentTab("agent-run-reg"), "agent-run-reg");

    render(<TerminalsLayout />);
    await waitFor(() => expect(recordAgentLaunchMock).toHaveBeenCalledTimes(1));

    // The row the AGENTS panel renders, and what its Focus/Stop act on. The
    // session id is the CLI's own (off the `agent_start` handle) rather than a
    // frontend-minted one, which is what lets Claude hooks enrich the run.
    expect(recordAgentLaunchMock).toHaveBeenCalledWith({
      pane_id: "agent-run-reg",
      session_id: "session-1",
      provider: 1,
      cwd: "/workspace/proj",
      model: "claude-opus-5",
      target: "embedded",
    });
  });

  it("does not register a run when the session fails to start", async () => {
    // A phantom "running" row with no child behind it would offer a Focus that
    // goes nowhere and a Stop that stops nothing.
    seedCatalog();
    agentStartMock.mockRejectedValueOnce(new Error("spawn failed"));
    seedTab(makeAgentTab("agent-run-fail"), "agent-run-fail");

    render(<TerminalsLayout />);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/spawn failed/)).toBeTruthy());

    expect(recordAgentLaunchMock).not.toHaveBeenCalled();
  });

  it("reports the run ended when the session exits", async () => {
    // An agent pane has no PTY, so `pty-exited` never fires for it — without
    // this the panel would show the row as running forever.
    seedCatalog();
    seedTab(makeAgentTab("agent-run-exit"), "agent-run-exit");

    render(<TerminalsLayout />);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));
    const feed = subscribeAgentFramesMock.mock.calls[0]?.[1] as (
      frame: AgentFrame,
    ) => void;

    await act(async () => {
      feed({
        pane_id: "agent-run-exit",
        session_id: "session-1",
        kind: "exit",
        raw: { type: "exit", exit_code: 0 },
      });
    });

    expect(recordAgentExitedMock).toHaveBeenCalledWith("agent-run-exit", 0);
  });

  it("switches the permission mode of a live session over the control channel instead of restarting", async () => {
    seedCatalog();
    seedTab(makeAgentTab("agent-perm-mode"), "agent-perm-mode");

    render(<TerminalsLayout />);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));

    const select = await screen.findByLabelText("Permission mode");
    await act(async () => {
      fireEvent.change(select, { target: { value: "plan" } });
    });

    await waitFor(() =>
      expect(agentSetPermissionModeMock).toHaveBeenCalledWith(
        "agent-perm-mode",
        "plan",
      ),
    );
    // Shift+Tab's whole point: the conversation the mode is being changed for
    // has to survive the change.
    expect(agentStopMock).not.toHaveBeenCalled();
    expect(agentStartMock).toHaveBeenCalledTimes(1);
    // Persisted on the leaf too, so an explicit Restart boots into it rather
    // than silently dropping back to the CLI default.
    expect(
      findLeaf(
        useTerminalStore.getState().tabs[0]!.layout,
        "agent-perm-mode",
      )?.permissionMode,
    ).toBe("plan");
  });

  it("the mode dropdown shows what the CLI applied, including the manual→default alias", async () => {
    seedCatalog();
    seedTab(makeAgentTab("agent-perm-echo"), "agent-perm-echo");

    render(<TerminalsLayout />);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));
    const feed = subscribeAgentFramesMock.mock.calls[0]?.[1] as (
      frame: AgentFrame,
    ) => void;
    expect(feed).toBeTypeOf("function");

    const select = (await screen.findByLabelText(
      "Permission mode",
    )) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: "manual" } });
    });

    // The CLI answers with the mode it *applied*, which for the `manual` alias
    // is `default` — a value the dropdown has no option for, so displaying the
    // echo verbatim would blank the control.
    await act(async () => {
      feed({
        pane_id: "agent-perm-echo",
        session_id: "session-1",
        kind: "control",
        raw: {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "codenest-0",
            response: { mode: "default" },
          },
        },
      });
    });
    expect(select.value).toBe("manual");

    // A refusal is surfaced rather than leaving the dropdown claiming a mode
    // the session is not in.
    await act(async () => {
      feed({
        pane_id: "agent-perm-echo",
        session_id: "session-1",
        kind: "control",
        raw: {
          type: "control_response",
          response: {
            subtype: "error",
            request_id: "codenest-1",
            error:
              "Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions",
          },
        },
      });
    });
    expect(screen.getByText("mode switch refused")).toBeTruthy();
    expect(select.value).toBe("manual");
  });
});
