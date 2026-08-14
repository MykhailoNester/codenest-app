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
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TerminalsLayout } from "../../../pages/terminal";
import { useTerminalStore, type Tab } from "../../../stores/terminal-store";
import { useAgentCatalogStore } from "../../../stores/agent-catalog-store";
import { findLeaf } from "../../../lib/layout-tree";
import { findComposerEditor } from "../../../lib/composer-focus";
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
    // Belt-and-braces (this file's test never clicks Stop): a factory mock
    // throws on *access* of a missing named export, not only on a call, and
    // this keeps the mock symmetric with `agent-session-hud.test.tsx`'s.
    agentStopTask: vi.fn(async () => undefined),
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
  recordAgentExited: (
    paneId: string,
    exitCode: number | null,
    sessionId?: string | null,
  ) => recordAgentExitedMock(paneId, exitCode, sessionId),
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
const agentInterruptMock = ipc.agentInterrupt as unknown as ReturnType<typeof vi.fn>;

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
    // Freeze the two async loaders. The seeded catalog is meant to be the whole
    // truth for a test, and leaving the real ones in place let a load kicked off
    // by one render settle during a later assertion and re-set `providers` —
    // which empties the model dropdown, so a `fireEvent.change` landing just
    // after it read back "" instead of the model. That was the model-switch
    // test failing on roughly one full-suite run in three.
    load: async () => undefined,
    loadWithRetry: async () => undefined,
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

/**
 * Boots one agent pane with a single open `Task` delegation (`toolu_task_1`,
 * subagent_type `"reviewer"`) — the shared starting point every #22
 * keyboard-navigation case below needs: a dock row to navigate to and a
 * composer to navigate from. Mirrors the `init` + `tool_use` frame pair the
 * "renders every view kind…"/"clicking a dock row…" tests above feed by
 * hand, factored out once there is a fourth caller.
 */
async function bootPaneWithSubagent(
  leafId: string,
): Promise<{ feed: (frame: AgentFrame) => void; textarea: HTMLTextAreaElement }> {
  seedCatalog();
  seedTab(makeAgentTab(leafId), leafId);

  render(<TerminalsLayout />);
  await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));
  const feed = subscribeAgentFramesMock.mock.calls[0]?.[1] as (
    frame: AgentFrame,
  ) => void;

  await act(async () => {
    feed({
      pane_id: leafId,
      session_id: "session-1",
      kind: "init",
      raw: { type: "system", subtype: "init", model: "claude-opus-5" },
    });
  });
  await act(async () => {
    feed({
      pane_id: leafId,
      session_id: "session-1",
      kind: "tool_use",
      raw: {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_task_1",
              name: "Task",
              input: { description: "Review the diff", subagent_type: "reviewer" },
            },
          ],
        },
      },
    });
  });

  const textarea = findComposerEditor(leafId);
  if (textarea === null) throw new Error("composer textarea not found");
  return { feed, textarea };
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
  agentInterruptMock.mockClear();
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
// `vi.unstubAllGlobals()` is #22's addition: two cases below need a
// *deferring* `requestAnimationFrame` stub (the
// `composer-focus-restore.test.tsx:36-43,62` idiom) to observe the picker's
// post-pick focus/caret restore mid-flight, and installing one locally only
// works if it cannot leak into every other test in this file. `localStorage`
// is re-stubbed by `beforeEach` regardless, and the `beforeAll` globals above
// are installed with `Object.defineProperty`, not `vi.stubGlobal`, so nothing
// else here is affected.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
    // Wait for the *option*, not just the select. The option list is fed by the
    // catalog store, so `findByLabelText` can resolve a render earlier — and
    // jsdom silently assigns "" when the requested value has no option yet,
    // which made this assertion fail on roughly one full-suite run in three.
    await waitFor(() =>
      expect(
        select.querySelector('option[value="claude-sonnet-5"]'),
      ).not.toBeNull(),
    );
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

  it("a launch seed's attribution reaches recordAgentLaunch", async () => {
    // Pins D7 / #31's "Telemetry parity": a leaf built by `buildPaneLayout`
    // carries this attribution as `seed`, and `<AgentPane/>` must spread it
    // into the same launch row a hand-split pane posts — with none of it
    // (see the test above), so a programmatic launch does not silently drop
    // source/project/prompt attribution the old PTY path used to stamp.
    seedCatalog();
    const leafId = "agent-run-seed";
    useTerminalStore.setState({
      tabs: [
        {
          id: `tab-${leafId}`,
          title: "Agent 1",
          layout: {
            type: "leaf",
            terminalId: leafId,
            title: "claude",
            kind: "agent",
            cwd: "/workspace/proj",
            seed: {
              projectId: 7,
              profileName: "work",
              sourceKind: "task",
              sourceId: 31,
              promptPreview: "fix the flaky test",
            },
          },
        },
      ],
      activeTabId: `tab-${leafId}`,
      focusedLeafId: leafId,
      hydrated: true,
      hydrating: false,
      maximizedLeafId: null,
    });

    render(<TerminalsLayout />);
    await waitFor(() => expect(recordAgentLaunchMock).toHaveBeenCalledTimes(1));

    expect(recordAgentLaunchMock).toHaveBeenCalledWith({
      pane_id: leafId,
      session_id: "session-1",
      provider: 1,
      cwd: "/workspace/proj",
      model: "claude-opus-5",
      target: "embedded",
      project_id: 7,
      profile: "work",
      source_kind: "task",
      source_id: 31,
      prompt_preview: "fix the flaky test",
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

    // Scoped to the session that ended: the leaf id alone would also match a
    // replacement started by a Restart.
    expect(recordAgentExitedMock).toHaveBeenCalledWith(
      "agent-run-exit",
      0,
      "session-1",
    );
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

  it("a Task in flight shows the Agents group in the dock and a badge in the composer", async () => {
    seedCatalog();
    seedTab(makeAgentTab("agent-subagent"), "agent-subagent");

    render(<TerminalsLayout />);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));
    const feed = subscribeAgentFramesMock.mock.calls[0]?.[1] as (
      frame: AgentFrame,
    ) => void;
    expect(feed).toBeTypeOf("function");

    await act(async () => {
      feed({
        pane_id: "agent-subagent",
        session_id: "session-1",
        kind: "init",
        raw: { type: "system", subtype: "init", model: "claude-opus-5" },
      });
    });

    // Nothing delegated yet — neither surface should exist.
    expect(screen.queryByTestId("composer-subagent-badge")).toBeNull();

    await act(async () => {
      feed({
        pane_id: "agent-subagent",
        session_id: "session-1",
        kind: "tool_use",
        raw: {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_task_1",
                name: "Task",
                input: { description: "Review the diff", subagent_type: "reviewer" },
              },
            ],
          },
        },
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("composer-subagent-badge")).toBeTruthy(),
    );
    expect(screen.getByTestId("composer-subagent-badge").textContent).toContain(
      "1 sub-agent",
    );
    expect(screen.getByTestId("dock-group-agents").textContent).toContain(
      "reviewer",
    );

    await act(async () => {
      feed({
        pane_id: "agent-subagent",
        session_id: "session-1",
        kind: "tool_result",
        raw: {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_task_1",
                content: "Looks good.",
                is_error: false,
              },
            ],
          },
        },
      });
    });

    await waitFor(() =>
      expect(screen.queryByTestId("composer-subagent-badge")).toBeNull(),
    );
    // The composer badge disappears — it reads `activeSubagents`, live-only —
    // but the dock's row for this delegation survives: the most useful
    // moment to read a sub-agent's result is right after it ends.
    expect(screen.getByTestId("dock-group-agents")).not.toBeNull();
    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );
    expect(screen.getByTestId("dock-agent-rows").textContent).toContain("reviewer");
  });

  it("a Workflow run shows the Workflows group in the dock and a badge in the composer", async () => {
    seedCatalog();
    seedTab(makeAgentTab("agent-orchestration"), "agent-orchestration");

    render(<TerminalsLayout />);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));
    const feed = subscribeAgentFramesMock.mock.calls[0]?.[1] as (
      frame: AgentFrame,
    ) => void;
    expect(feed).toBeTypeOf("function");

    await act(async () => {
      feed({
        pane_id: "agent-orchestration",
        session_id: "session-1",
        kind: "init",
        raw: { type: "system", subtype: "init", model: "claude-opus-5" },
      });
    });

    // Nothing orchestrating yet — neither surface should exist.
    expect(screen.queryByTestId("composer-orchestration-badge")).toBeNull();
    expect(screen.queryByTestId("dock-group-workflows")).toBeNull();

    await act(async () => {
      feed({
        pane_id: "agent-orchestration",
        session_id: "session-1",
        kind: "system",
        raw: {
          type: "system",
          subtype: "task_started",
          task_id: "wt8nboga7",
          tool_use_id: "toolu_01As1tHX8yBzfjZ8DS1Sdpyp",
          description: "Two-phase probe",
          task_type: "local_workflow",
          workflow_name: "wire-probe",
        },
      });
    });

    await act(async () => {
      feed({
        pane_id: "agent-orchestration",
        session_id: "session-1",
        kind: "system",
        raw: {
          type: "system",
          subtype: "task_progress",
          task_id: "wt8nboga7",
          description: "Alpha: blue",
          usage: { total_tokens: 0, tool_uses: 0, duration_ms: 54 },
          workflow_progress: [
            { type: "workflow_phase", index: 1, title: "Alpha" },
            { type: "workflow_phase", index: 2, title: "Beta" },
            {
              type: "workflow_agent",
              index: 1,
              label: "red",
              phaseIndex: 1,
              phaseTitle: "Alpha",
              state: "start",
            },
            {
              type: "workflow_agent",
              index: 2,
              label: "blue",
              phaseIndex: 1,
              phaseTitle: "Alpha",
              state: "start",
            },
          ],
        },
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("composer-orchestration-badge")).toBeTruthy(),
    );
    expect(screen.getByTestId("composer-orchestration-badge").textContent).toContain(
      "0/2 agents",
    );
    expect(screen.getByTestId("dock-group-workflows").textContent).toContain(
      "wire-probe",
    );

    await act(async () => {
      feed({
        pane_id: "agent-orchestration",
        session_id: "session-1",
        kind: "system",
        raw: {
          type: "system",
          subtype: "task_notification",
          task_id: "wt8nboga7",
          status: "completed",
          summary: 'Dynamic workflow "Two-phase probe" completed',
        },
      });
    });

    await waitFor(() =>
      expect(screen.queryByTestId("composer-orchestration-badge")).toBeNull(),
    );
    // The composer badge disappears — it reads `activeOrchestrations`,
    // live-only — but the dock's row for this run survives, with the
    // wire-probe fixture's own name still on it.
    expect(screen.getByTestId("dock-group-workflows")).not.toBeNull();
    fireEvent.click(
      screen.getByTestId("dock-group-workflows").querySelector("button") as HTMLButtonElement,
    );
    expect(screen.getByTestId("dock-workflow-rows").textContent).toContain("wire-probe");
  });

  it("renders every view kind inside the pane's single viewport, with the composer outside it", async () => {
    seedCatalog();
    seedTab(makeAgentTab("agent-viewport"), "agent-viewport");

    render(<TerminalsLayout />);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));
    const feed = subscribeAgentFramesMock.mock.calls[0]?.[1] as (
      frame: AgentFrame,
    ) => void;
    expect(feed).toBeTypeOf("function");

    await act(async () => {
      feed({
        pane_id: "agent-viewport",
        session_id: "session-1",
        kind: "init",
        raw: { type: "system", subtype: "init", model: "claude-opus-5" },
      });
    });

    // Enough to make a sub-agent selectable — deliberately not fed the
    // completion (`tool_result`), which would drop it back out of the picker.
    await act(async () => {
      feed({
        pane_id: "agent-viewport",
        session_id: "session-1",
        kind: "tool_use",
        raw: {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_task_1",
                name: "Task",
                input: { description: "Review the diff", subagent_type: "reviewer" },
              },
            ],
          },
        },
      });
    });

    // Same for the workflow — started and progressing, never notified done.
    await act(async () => {
      feed({
        pane_id: "agent-viewport",
        session_id: "session-1",
        kind: "system",
        raw: {
          type: "system",
          subtype: "task_started",
          task_id: "wt8nboga7",
          tool_use_id: "toolu_01As1tHX8yBzfjZ8DS1Sdpyp",
          description: "Two-phase probe",
          task_type: "local_workflow",
          workflow_name: "wire-probe",
        },
      });
    });
    await act(async () => {
      feed({
        pane_id: "agent-viewport",
        session_id: "session-1",
        kind: "system",
        raw: {
          type: "system",
          subtype: "task_progress",
          task_id: "wt8nboga7",
          description: "Alpha: blue",
          usage: { total_tokens: 0, tool_uses: 0, duration_ms: 54 },
          workflow_progress: [
            { type: "workflow_phase", index: 1, title: "Alpha" },
            { type: "workflow_phase", index: 2, title: "Beta" },
            {
              type: "workflow_agent",
              index: 1,
              label: "red",
              phaseIndex: 1,
              phaseTitle: "Alpha",
              state: "start",
            },
            {
              type: "workflow_agent",
              index: 2,
              label: "blue",
              phaseIndex: 1,
              phaseTitle: "Alpha",
              state: "start",
            },
          ],
        },
      });
    });

    // `getBy*` throws on a second match, which is what pins exactly one
    // viewport — the whole point of hoisting the contract out of the views.
    const viewport = screen.getByTestId("agent-pane-viewport");

    expect(
      viewport.contains(screen.getByTestId("agent-conversation")),
    ).toBe(true);

    // The dock (Zone B) already has something to report — the in-flight
    // Task and Workflow fed above — so it exists from here on; captured now
    // so the two view switches below can prove it never remounts.
    const dock = screen.getByTestId("agent-activity-dock");

    const picker = screen.getByTestId("composer-view-picker");
    // jsdom silently assigns "" when the requested option is absent, which is
    // the flake the model-switch test above already documents — wait for the
    // option to exist rather than racing the picker's own re-render.
    await waitFor(() =>
      expect(
        picker.querySelector('option[value="sub:toolu_task_1"]'),
      ).not.toBeNull(),
    );
    await act(async () => {
      fireEvent.change(picker, { target: { value: "sub:toolu_task_1" } });
    });

    let panel = screen.getByTestId("agent-view-panel");
    expect(panel.dataset.viewKind).toBe("subagent");
    expect(viewport.contains(panel)).toBe(true);
    expect(screen.queryByTestId("agent-conversation")).toBeNull();
    expect(screen.getByTestId("agent-pane-viewport")).toBe(viewport);
    // Zone B did not remount or move when Zone A switched to the sub-agent view.
    expect(screen.getByTestId("agent-activity-dock")).toBe(dock);

    await waitFor(() =>
      expect(
        picker.querySelector('option[value="wf:wt8nboga7"]'),
      ).not.toBeNull(),
    );
    await act(async () => {
      fireEvent.change(picker, { target: { value: "wf:wt8nboga7" } });
    });

    panel = screen.getByTestId("agent-view-panel");
    expect(panel.dataset.viewKind).toBe("workflow");
    expect(viewport.contains(panel)).toBe(true);
    expect(screen.queryByTestId("agent-conversation")).toBeNull();
    expect(screen.getByTestId("agent-pane-viewport")).toBe(viewport);
    // Nor when it switched again to the workflow view.
    expect(screen.getByTestId("agent-activity-dock")).toBe(dock);

    // The composer is a *sibling* of the viewport under `.body`, which is the
    // structural reason it cannot move when the view changes — layout itself
    // is unobservable in jsdom, so siblinghood plus the CSS rule is the
    // checkable half of that guarantee.
    const composer = document.querySelector("[data-agent-composer]");
    expect(composer).not.toBeNull();
    expect(viewport.contains(composer)).toBe(false);
    expect(composer!.parentElement).toBe(viewport.parentElement);

    // The ticket's core structural guarantee: the dock is a sibling of the
    // viewport, never its child, and sits between it and the composer —
    // A → B → C, in that order, inside `.body`.
    expect(viewport.contains(dock)).toBe(false);
    expect(dock.parentElement).toBe(viewport.parentElement);
    expect(
      viewport.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      dock.compareDocumentPosition(composer!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("clicking a dock row moves Zone A and the composer picker together", async () => {
    seedCatalog();
    seedTab(makeAgentTab("agent-dock-select"), "agent-dock-select");

    render(<TerminalsLayout />);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));
    const feed = subscribeAgentFramesMock.mock.calls[0]?.[1] as (
      frame: AgentFrame,
    ) => void;
    expect(feed).toBeTypeOf("function");

    await act(async () => {
      feed({
        pane_id: "agent-dock-select",
        session_id: "session-1",
        kind: "init",
        raw: { type: "system", subtype: "init", model: "claude-opus-5" },
      });
    });

    await act(async () => {
      feed({
        pane_id: "agent-dock-select",
        session_id: "session-1",
        kind: "tool_use",
        raw: {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_task_1",
                name: "Task",
                input: { description: "Review the diff", subagent_type: "reviewer" },
              },
            ],
          },
        },
      });
    });

    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );
    fireEvent.click(
      screen.getByTestId("dock-agent-row").querySelector("button") as HTMLButtonElement,
    );

    // "One selection state, not two": a second `useState` in the dock would
    // leave the picker on `main` and fail the second assertion here even
    // though the panel switched.
    expect(screen.getByTestId("agent-view-panel").dataset.viewKind).toBe("subagent");
    expect(
      (screen.getByTestId("composer-view-picker") as HTMLSelectElement).value,
    ).toBe("sub:toolu_task_1");
  });

  it("auto-scroll measures the viewport — the element that actually scrolls", async () => {
    seedCatalog();
    seedTab(makeAgentTab("agent-scroll-viewport"), "agent-scroll-viewport");

    render(<TerminalsLayout />);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));
    const feed = subscribeAgentFramesMock.mock.calls[0]?.[1] as (
      frame: AgentFrame,
    ) => void;
    expect(feed).toBeTypeOf("function");

    const viewport = screen.getByTestId("agent-pane-viewport");

    // jsdom has no layout — its own `scrollTop` setter is a no-op without a
    // real box — so the geometry `<AgentPane/>`'s stick-to-bottom effect
    // (Effect C, `agent-pane.tsx`) reads and writes has to be stubbed onto
    // this exact instance.
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      value: 4000,
    });
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 300,
    });
    let scrollTop = 0;
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    await act(async () => {
      feed({
        pane_id: "agent-scroll-viewport",
        session_id: "session-1",
        kind: "assistant",
        raw: {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
          },
        },
      });
    });

    // If the pane ever measured a different (non-scrolling) element instead
    // of this viewport, this stays 0 and the regression is caught here
    // instead of silently in production. A first-ever `main` view has no
    // scroll memory, so Effect B pins it to the bottom on mount and Effect C
    // keeps it there for this first frame.
    expect(scrollTop).toBe(4000);
  });

  it("each view remembers its own scroll position and its own stick-to-bottom", async () => {
    seedCatalog();
    seedTab(makeAgentTab("agent-scroll-memory"), "agent-scroll-memory");

    render(<TerminalsLayout />);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));
    const feed = subscribeAgentFramesMock.mock.calls[0]?.[1] as (
      frame: AgentFrame,
    ) => void;
    expect(feed).toBeTypeOf("function");

    const viewport = screen.getByTestId("agent-pane-viewport");

    // Same jsdom-has-no-layout stub as the test above.
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      value: 4000,
    });
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 300,
    });
    let scrollTop = 0;
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    await act(async () => {
      feed({
        pane_id: "agent-scroll-memory",
        session_id: "session-1",
        kind: "init",
        raw: { type: "system", subtype: "init", model: "claude-opus-5" },
      });
    });

    await act(async () => {
      feed({
        pane_id: "agent-scroll-memory",
        session_id: "session-1",
        kind: "assistant",
        raw: {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
        },
      });
    });
    // A first-ever `main` view has no memory, so it starts pinned — the new
    // frame drove it to the bottom.
    expect(scrollTop).toBe(4000);

    // The user scrolls up and away from the bottom.
    scrollTop = 1000;
    fireEvent.scroll(viewport);

    // Make a sub-agent selectable, without ending it — same shape as the
    // "renders every view kind" test above.
    await act(async () => {
      feed({
        pane_id: "agent-scroll-memory",
        session_id: "session-1",
        kind: "tool_use",
        raw: {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_task_1",
                name: "Task",
                input: { description: "Review the diff", subagent_type: "reviewer" },
              },
            ],
          },
        },
      });
    });

    const picker = screen.getByTestId("composer-view-picker");
    await waitFor(() =>
      expect(
        picker.querySelector('option[value="sub:toolu_task_1"]'),
      ).not.toBeNull(),
    );

    // Switching to a view this mount has never shown starts pinned to the
    // bottom — not yanked to 1000, and not left wherever `main` happened to
    // leave `scrollTop`.
    await act(async () => {
      fireEvent.change(picker, { target: { value: "sub:toolu_task_1" } });
    });
    expect(scrollTop).toBe(4000);

    // Switching back to `main` restores exactly where the user had scrolled
    // to before switching away — the "returns to where the user was" half.
    await act(async () => {
      fireEvent.change(picker, { target: { value: "main" } });
    });
    expect(scrollTop).toBe(1000);

    // And a new frame arriving on `main` must not yank it back down: the
    // user was scrolled away from the bottom there, and switching views is
    // not itself a reason to re-pin. This is the "does not yank either to
    // the bottom" half.
    await act(async () => {
      feed({
        pane_id: "agent-scroll-memory",
        session_id: "session-1",
        kind: "assistant",
        raw: {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "still here" }] },
        },
      });
    });
    expect(scrollTop).toBe(1000);
  });

  // -------------------------------------------------------------------------
  // Keyboard navigation between agent views (#22) — the composer's
  // `Ctrl+↑`/`Ctrl+↓`, the dock's own arrow/Enter/Escape handling, and the
  // two focus-hand-back paths (D6/D16) that keep "the composer keeps focus
  // for typing at all times" true for both the keyboard and the pointer.
  // -------------------------------------------------------------------------

  it("Ctrl+ArrowDown in the composer moves the dock cursor without touching the draft", async () => {
    const { textarea } = await bootPaneWithSubagent("agent-kbd-ctrl-down");

    fireEvent.change(textarea, { target: { value: "a draft in progress" } });
    textarea.focus();

    fireEvent.keyDown(textarea, { key: "ArrowDown", ctrlKey: true });

    const option = screen.getByTestId("dock-agent-row").querySelector("button");
    expect(option?.dataset.highlighted).toBe("true");
    expect(document.activeElement).toBe(option);
    expect(textarea.value).toBe("a draft in progress");
  });

  it("a bare ArrowUp in a non-empty draft is left to the textarea", async () => {
    const { textarea } = await bootPaneWithSubagent("agent-kbd-bare-arrow");

    fireEvent.change(textarea, { target: { value: "a draft in progress" } });
    textarea.focus();

    const event = createEvent.keyDown(textarea, { key: "ArrowUp" });
    fireEvent(textarea, event);

    // The ticket's hardest guarantee: nobody intercepted the keystroke, so
    // the textarea's native caret movement is untouched.
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector("[data-highlighted]")).toBeNull();
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe("a draft in progress");
  });

  it("clicking a dock row highlights it but leaves the caret in the composer", async () => {
    const { textarea } = await bootPaneWithSubagent("agent-kbd-click-highlight");

    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );
    fireEvent.click(
      screen.getByTestId("dock-agent-row").querySelector("button") as HTMLButtonElement,
    );

    // jsdom's `fireEvent.click` does not move focus by itself, which is
    // exactly what makes this assertion meaningful: the only way
    // `activeElement` could have changed here is a *programmatic* `.focus()`
    // — the dock's focus effect firing on a highlight-only change, which is
    // the bug plan D15 exists to prevent.
    expect(document.activeElement).toBe(textarea);
    expect(
      screen.getByTestId("dock-agent-row").querySelector("button")?.dataset.highlighted,
    ).toBe("true");
    expect(screen.getByTestId("agent-view-panel").dataset.viewKind).toBe("subagent");
  });

  it("picking a sub-agent from the composer picker returns focus to the textarea, and Escape then returns to the main transcript", async () => {
    // A *deferring* rAF stub, not a synchronous one — see
    // `composer-focus-restore.test.tsx`'s own comment for why a synchronous
    // stub would let a caret-offset assertion pass for the wrong reason.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    function flushFrames(): void {
      for (let guard = 0; guard < 8 && frames.length > 0; guard += 1) {
        for (const cb of frames.splice(0, frames.length)) cb(0);
      }
    }

    const { textarea } = await bootPaneWithSubagent("agent-kbd-picker-focus");
    fireEvent.change(textarea, { target: { value: "hi there" } });
    // `fireEvent.change` assigns through the DOM setter, which resets the
    // selection to end-of-text first — the explicit range below is what
    // plants the mid-draft caret this test actually cares about.
    textarea.setSelectionRange(3, 3);

    const picker = screen.getByTestId("composer-view-picker") as HTMLSelectElement;
    await waitFor(() =>
      expect(picker.querySelector('option[value="sub:toolu_task_1"]')).not.toBeNull(),
    );
    await act(async () => {
      fireEvent.change(picker, { target: { value: "sub:toolu_task_1" } });
    });
    flushFrames();

    expect(screen.getByTestId("agent-view-panel").dataset.viewKind).toBe("subagent");
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(3);

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.getByTestId("agent-conversation")).not.toBeNull();
    expect(screen.queryByTestId("agent-view-panel")).toBeNull();
    expect(picker.value).toBe("main");
  });

  it("Enter on the highlighted row opens it in Zone A and returns focus to the composer at the same caret offset", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    function flushFrames(): void {
      for (let guard = 0; guard < 8 && frames.length > 0; guard += 1) {
        for (const cb of frames.splice(0, frames.length)) cb(0);
      }
    }

    const { textarea } = await bootPaneWithSubagent("agent-kbd-enter-open");
    fireEvent.change(textarea, { target: { value: "hello world" } });
    textarea.setSelectionRange(5, 5);
    textarea.focus();

    fireEvent.keyDown(textarea, { key: "ArrowDown", ctrlKey: true });
    const option = screen.getByTestId("dock-agent-row").querySelector("button") as HTMLButtonElement;
    expect(document.activeElement).toBe(option);

    fireEvent.keyDown(option, { key: "Enter" });
    flushFrames();

    expect(screen.getByTestId("agent-view-panel").dataset.viewKind).toBe("subagent");
    expect(
      (screen.getByTestId("composer-view-picker") as HTMLSelectElement).value,
    ).toBe("sub:toolu_task_1");
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(5);
    expect(textarea.value).toBe("hello world");
  });

  it("Escape while viewing a sub-agent returns to the main transcript, and a second Escape interrupts", async () => {
    const { feed, textarea } = await bootPaneWithSubagent("agent-kbd-escape-back");

    const picker = screen.getByTestId("composer-view-picker") as HTMLSelectElement;
    await waitFor(() =>
      expect(picker.querySelector('option[value="sub:toolu_task_1"]')).not.toBeNull(),
    );
    await act(async () => {
      fireEvent.change(picker, { target: { value: "sub:toolu_task_1" } });
    });
    expect(screen.getByTestId("agent-view-panel")).not.toBeNull();

    textarea.focus();
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.getByTestId("agent-conversation")).not.toBeNull();
    expect(screen.queryByTestId("agent-view-panel")).toBeNull();
    expect(agentInterruptMock).not.toHaveBeenCalled();

    // A second Escape, now that Zone A is back on `main`, still interrupts —
    // the drill-in layering (plan D9) costs the running session nothing.
    await act(async () => {
      feed({
        pane_id: "agent-kbd-escape-back",
        session_id: "session-1",
        kind: "system",
        raw: { type: "system", subtype: "status", status: "requesting" },
      });
    });
    fireEvent.keyDown(textarea, { key: "Escape" });
    await waitFor(() => expect(agentInterruptMock).toHaveBeenCalledWith("agent-kbd-escape-back"));
  });

  it("Escape on a focused dock row leaves the drill-in and returns focus to the composer", async () => {
    const { textarea } = await bootPaneWithSubagent("agent-kbd-escape-row");

    const picker = screen.getByTestId("composer-view-picker") as HTMLSelectElement;
    await waitFor(() =>
      expect(picker.querySelector('option[value="sub:toolu_task_1"]')).not.toBeNull(),
    );
    await act(async () => {
      fireEvent.change(picker, { target: { value: "sub:toolu_task_1" } });
    });
    // Real (unstubbed) `requestAnimationFrame` here — `waitFor` polls with
    // real timers, which is enough to observe the picker's own focus
    // hand-back (D16) land before the next step.
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(screen.getByTestId("agent-view-panel")).not.toBeNull();

    fireEvent.keyDown(textarea, { key: "ArrowDown", ctrlKey: true });
    const option = screen.getByTestId("dock-agent-row").querySelector("button");
    expect(document.activeElement).toBe(option);

    fireEvent.keyDown(option as HTMLButtonElement, { key: "Escape" });
    expect(screen.getByTestId("agent-conversation")).not.toBeNull();
    expect(screen.queryByTestId("agent-view-panel")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it("Escape on a focused dock row still works while the pane is maximized", async () => {
    const LEAF = "agent-kbd-escape-maximized";
    const { textarea } = await bootPaneWithSubagent(LEAF);

    const picker = screen.getByTestId("composer-view-picker") as HTMLSelectElement;
    await waitFor(() =>
      expect(picker.querySelector('option[value="sub:toolu_task_1"]')).not.toBeNull(),
    );
    await act(async () => {
      fireEvent.change(picker, { target: { value: "sub:toolu_task_1" } });
    });

    useTerminalStore.getState().toggleMaximize(LEAF);
    expect(useTerminalStore.getState().maximizedLeafId).toBe(LEAF);

    textarea.focus();
    fireEvent.keyDown(textarea, { key: "ArrowDown", ctrlKey: true });
    const option = screen.getByTestId("dock-agent-row").querySelector("button");
    expect(document.activeElement).toBe(option);

    fireEvent.keyDown(option as HTMLButtonElement, { key: "Escape" });

    expect(screen.getByTestId("agent-conversation")).not.toBeNull();
    expect(screen.queryByTestId("agent-view-panel")).toBeNull();
    // The dock's own Escape handling won, not the maximize-restore shortcut.
    expect(useTerminalStore.getState().maximizedLeafId).toBe(LEAF);
  });

  it("keyboard switching preserves each view's scroll position", async () => {
    const LEAF = "agent-kbd-scroll-memory";
    const { textarea } = await bootPaneWithSubagent(LEAF);

    const viewport = screen.getByTestId("agent-pane-viewport");
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 4000 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 300 });
    let scrollTop = 0;
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    // `main` is pinned to the bottom by default; the user scrolls away.
    scrollTop = 1000;
    fireEvent.scroll(viewport);

    textarea.focus();
    fireEvent.keyDown(textarea, { key: "ArrowDown", ctrlKey: true });
    const option = screen.getByTestId("dock-agent-row").querySelector("button") as HTMLButtonElement;
    fireEvent.keyDown(option, { key: "Enter" });

    // A view this mount has never shown starts pinned to the bottom — not
    // left wherever `main` happened to leave `scrollTop`.
    expect(scrollTop).toBe(4000);

    fireEvent.keyDown(textarea, { key: "Escape" });

    // Back on `main`, the exact offset the user had scrolled to survives the
    // keyboard round trip — the same single scroll-memory implementation
    // (#23) the composer picker already exercises, not a second one.
    expect(scrollTop).toBe(1000);
  });
});
