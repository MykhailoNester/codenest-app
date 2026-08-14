// Regression coverage for the launch-prompt handoff (#32): a `PaneLaunchSpec`
// with a prompt reaches exactly the targeted agent pane's composer draft,
// unsent, exactly once — surviving a Restart without re-delivering.
//
// Mirrors the mock shape of `agent-pane-restart.test.tsx` verbatim (that file
// already drives a Restart, the hard case here too), plus a controllable
// `subscribeAgentFrames` so a test can hold `boot()` open across the consume
// line the same way `agent-pane-restart.test.tsx`'s F1 holds `agentStop` open
// across a Restart click.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TerminalsLayout } from "../../../pages/terminal";
import { useTerminalStore, type Tab } from "../../../stores/terminal-store";
import { useComposerStore } from "../../../stores/composer-store";
import { findComposerEditor } from "../../../lib/composer-focus";
import { clearPendingPrompts, stagePendingPrompt } from "../../../stores/pending-prompt-store";
import * as ipc from "../../../lib/ipc";
import type { AgentFrame } from "../../../lib/ipc";

// ---------------------------------------------------------------------------
// Mocks — same shape as `agent-pane-restart.test.tsx`'s `lib/ipc` mock.
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
// exactly as the persistence and restart tests do.
vi.mock("../../../hooks/use-terminal-file-drop", () => ({
  useTerminalFileDrop: (): void => undefined,
}));

const agentStartMock = ipc.agentStart as unknown as ReturnType<typeof vi.fn>;
const agentSendMock = ipc.agentSend as unknown as ReturnType<typeof vi.fn>;
const subscribeAgentFramesMock = ipc.subscribeAgentFrames as unknown as ReturnType<
  typeof vi.fn
>;

// jsdom stubs — local to this file (`frontend/vite.config.ts` deliberately
// has no global setupFiles).
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
 * Every test mints its own leaf id — see `agent-pane-render.test.tsx:255-264`
 * for why: the module-level `startedPanes` guard is keyed by
 * `(leafId, retryToken)`, and a reused id across two `render()` calls in one
 * file would make the second mount look like the first's remount. */
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

/** Renders `<TerminalsLayout/>` with one tab holding two agent leaves, side
 *  by side. */
function renderTwoAgentTab(leafIdA: string, leafIdB: string): void {
  const tab: Tab = {
    id: `tab-${leafIdA}-${leafIdB}`,
    title: "Agents",
    layout: {
      type: "split",
      direction: "h",
      ratio: 0.5,
      children: [
        {
          type: "leaf",
          terminalId: leafIdA,
          title: "claude",
          kind: "agent",
          cwd: "/workspace/proj",
        },
        {
          type: "leaf",
          terminalId: leafIdB,
          title: "claude",
          kind: "agent",
          cwd: "/workspace/proj",
        },
      ],
    },
  };
  useTerminalStore.setState({
    tabs: [tab],
    activeTabId: tab.id,
    focusedLeafId: leafIdA,
    hydrated: true,
    hydrating: false,
    maximizedLeafId: null,
  });
  render(<TerminalsLayout />);
}

beforeEach(() => {
  installLocalStorage();
  clearPendingPrompts();
  handlers.length = 0;
  agentStartMock.mockClear();
  agentSendMock.mockClear();
  subscribeAgentFramesMock.mockClear();
  subscribeAgentFramesMock.mockImplementation(
    async (_paneId: string, handler: (frame: AgentFrame) => void) => {
      handlers.push(handler);
      return () => undefined;
    },
  );
});

afterEach(() => {
  cleanup();
});

describe("agent pane — launch prompt seed (#32)", () => {
  it("a staged prompt lands in the composer draft on boot, unsent", async () => {
    const leafId = "agent-seed-1";
    const prompt = "please review the diff";
    stagePendingPrompt(leafId, prompt);

    renderAgentTab(leafId);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));

    expect(useComposerStore.getState().panes[leafId]?.draft).toBe(prompt);
    expect(findComposerEditor(leafId)?.value).toBe(prompt);
    expect(agentSendMock).not.toHaveBeenCalled();
  });

  it("a prompt with newlines, backticks and a fenced code block reaches the textarea intact", async () => {
    const leafId = "agent-seed-2";
    const prompt = [
      "Fix this:",
      "",
      "```ts",
      'const x = `hi ${1 + 1}`;',
      "```",
    ].join("\n");
    stagePendingPrompt(leafId, prompt);

    renderAgentTab(leafId);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));

    expect(findComposerEditor(leafId)?.value).toBe(prompt);
  });

  it("restarting a pane that already received the prompt does not re-deliver it", async () => {
    const leafId = "agent-seed-3";
    const prompt = "please review the diff";
    stagePendingPrompt(leafId, prompt);

    renderAgentTab(leafId);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));
    expect(useComposerStore.getState().panes[leafId]?.draft).toBe(prompt);

    act(() => {
      handlers[handlers.length - 1]?.({
        pane_id: leafId,
        session_id: "s1",
        kind: "exit",
        raw: { exit_code: 0 },
      });
    });
    const restartBtn = await screen.findByRole("button", { name: /restart/i });
    fireEvent.click(restartBtn);

    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(2));

    // Exactly one copy — no second delivery from the restart's boot.
    expect(useComposerStore.getState().panes[leafId]?.draft).toBe(prompt);
  });

  it("a pane with nothing staged boots with an empty draft", async () => {
    const leafId = "agent-seed-4";

    renderAgentTab(leafId);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));

    expect(useComposerStore.getState().panes[leafId]?.draft ?? "").toBe("");
    expect(findComposerEditor(leafId)?.value ?? "").toBe("");
  });

  it("a prompt staged for one pane does not reach its sibling", async () => {
    const leafIdA = "agent-seed-5a";
    const leafIdB = "agent-seed-5b";
    const prompt = "only for A";
    stagePendingPrompt(leafIdA, prompt);

    renderTwoAgentTab(leafIdA, leafIdB);
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(2));

    expect(useComposerStore.getState().panes[leafIdA]?.draft).toBe(prompt);
    expect(useComposerStore.getState().panes[leafIdB]?.draft ?? "").toBe("");
  });

  it("a seed arriving after the user has typed appends instead of overwriting", async () => {
    const leafId = "agent-seed-6";
    const prompt = "the seeded prompt";
    stagePendingPrompt(leafId, prompt);

    // Hold `ensureFrameSubscription`'s await open — `boot()` reaches the
    // consume line only after it resolves, which is the real (if small)
    // window Design decision 7 describes: the composer is already rendered
    // and typeable before the seed lands.
    let resolveSubscribe: (() => void) | undefined;
    subscribeAgentFramesMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubscribe = () => {
            handlers.push(() => undefined);
            resolve(() => undefined);
          };
        }),
    );

    renderAgentTab(leafId);

    const editor = await waitFor(() => {
      const el = findComposerEditor(leafId);
      if (!el) throw new Error("composer editor not yet mounted");
      return el;
    });
    act(() => {
      useComposerStore.getState().setDraft(leafId, "notes I already wrote");
    });

    act(() => {
      resolveSubscribe?.();
    });
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));

    expect(useComposerStore.getState().panes[leafId]?.draft).toBe(
      `notes I already wrote\n\n${prompt}`,
    );
    expect(editor.value).toBe(`notes I already wrote\n\n${prompt}`);
  });
});
