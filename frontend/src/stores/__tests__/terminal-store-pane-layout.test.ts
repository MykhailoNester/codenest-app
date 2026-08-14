/**
 * terminal-store-pane-layout.test.ts
 *
 * Unit tests for `applyPaneLayout` — the ordered typed pane list's store-side
 * half of `buildPaneLayout` (`lib/launch.ts`). Mirrors the mocking shape of
 * `terminal-store-workspace.test.ts` (its `applyGridLayout` counterpart).
 *
 * Covers:
 *  - agent + shell mix: exactly one PTY, opened with the shell pane's own args.
 *  - agent leaves get real ids, never `pending-N` placeholders.
 *  - the shell pane's command is written once, with its trailing newline.
 *  - no launch telemetry is posted for an agent pane (that is `<AgentPane/>`'s
 *    job, not the store's — a second post would be a second `agent_runs` row).
 *  - three agent panes keep three distinct provider/model pairs, no PTY at all.
 *  - a failed shell pane becomes an empty leaf; siblings survive.
 *  - an over-cap spec throws before any IPC or state change.
 *  - persistToStorage strips initCommand/seed but keeps kind/providerId/model/
 *    permissionMode.
 *  - two calls produce disjoint leaf ids (no cross-tab session collision).
 *  - the prompt is staged into `pending-prompt-store` for exactly the agent
 *    panes `resolvePromptTargets` names — delivery into a pane's composer is
 *    `feature/launch-prompt-seed` (#32), read by `<AgentPane/>`'s boot effect.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../../lib/ipc", () => {
  let counter = 0;
  return {
    openTerminal: vi.fn(async () => {
      counter += 1;
      return { id: `pty-${counter}` };
    }),
    closeTerminal: vi.fn(async () => undefined),
    sendTerminalInput: vi.fn(async () => undefined),
    resizeTerminal: vi.fn(async () => undefined),
    useTerminalOutput: vi.fn(),
  };
});

// fetchSidecar is fire-and-forget telemetry — stub it out.
vi.mock("../../lib/api", () => ({
  fetchSidecar: vi.fn(async () => undefined),
}));

import { useTerminalStore, TERMINAL_STORAGE_KEY } from "../terminal-store";
import { collectLeaves, paneKind } from "../../lib/layout-tree";
import type { LayoutNode } from "../../lib/layout-tree";
import type { LaunchPane, PaneLaunchSpec } from "../../lib/launch";
import {
  clearPendingPrompts,
  consumePendingPrompt,
  pendingPromptCount,
} from "../pending-prompt-store";
import * as ipc from "../../lib/ipc";
import * as api from "../../lib/api";

const openTerminalMock = ipc.openTerminal as unknown as ReturnType<
  typeof vi.fn
>;
const sendTerminalInputMock = ipc.sendTerminalInput as unknown as ReturnType<
  typeof vi.fn
>;
const fetchSidecarMock = api.fetchSidecar as unknown as ReturnType<
  typeof vi.fn
>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetStore(): void {
  useTerminalStore.setState({
    tabs: [],
    activeTabId: "",
    focusedLeafId: null,
    hydrated: false,
    hydrating: false,
    maximizedLeafId: null,
  });
}

function installLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
  });
}

function makeSpec(
  panes: LaunchPane[],
  overrides: Partial<PaneLaunchSpec> = {},
): PaneLaunchSpec {
  return {
    panes,
    split: "cols",
    target: "embedded",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("applyPaneLayout", () => {
  beforeEach(() => {
    installLocalStorage();
    resetStore();
    clearPendingPrompts();
    let counter = 0;
    openTerminalMock.mockClear();
    sendTerminalInputMock.mockClear();
    fetchSidecarMock.mockClear();
    openTerminalMock.mockImplementation(async () => {
      counter += 1;
      return { id: `pty-${counter}` };
    });
  });

  it("agent + shell: exactly one PTY, opened with the shell pane's cwd/env/shell", async () => {
    const spec = makeSpec([
      { kind: "agent", providerId: 1, model: "claude-opus-5", cwd: "/agent" },
      {
        kind: "shell",
        cwd: "/shell/proj",
        env: { FOO: "bar" },
        shell: "/bin/zsh",
        command: "npm run dev",
      },
    ]);

    const result = await useTerminalStore.getState().applyPaneLayout(spec);

    // Both leaves placed successfully — the agent leaf mounted with no PTY,
    // the shell leaf got a real one; `openedCount` counts placement, not PTY
    // allocation (only `openTerminal`'s own call count answers that).
    expect(result.openedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(openTerminalMock).toHaveBeenCalledTimes(1);
    expect(openTerminalMock).toHaveBeenCalledWith({
      cwd: "/shell/proj",
      env: { FOO: "bar" },
      shell: "/bin/zsh",
    });

    const { tabs } = useTerminalStore.getState();
    expect(tabs).toHaveLength(1);
    const leaves = collectLeaves(tabs[0]!.layout);
    expect(leaves).toHaveLength(2);
    expect(paneKind(leaves[0]!)).toBe("agent");
    expect(paneKind(leaves[1]!)).toBe("shell");
  });

  it("the agent leaf gets a real id, never a pending- placeholder", async () => {
    const spec = makeSpec([{ kind: "agent", providerId: 1 }]);
    await useTerminalStore.getState().applyPaneLayout(spec);

    const leaf = collectLeaves(useTerminalStore.getState().tabs[0]!.layout)[0]!;
    expect(leaf.terminalId).not.toMatch(/^pending-/);
  });

  it("the shell pane's command is written once, with its trailing newline", async () => {
    const spec = makeSpec([
      { kind: "shell", cwd: "/proj", command: "npm run dev" },
    ]);
    await useTerminalStore.getState().applyPaneLayout(spec);

    expect(sendTerminalInputMock).toHaveBeenCalledTimes(1);
    const [ptyId, written] = sendTerminalInputMock.mock.calls[0] as [
      string,
      string,
    ];
    expect(written).toBe("npm run dev\n");
    expect(ptyId).toMatch(/^pty-/);
  });

  it("no launch telemetry is posted for an agent pane", async () => {
    const spec = makeSpec([{ kind: "agent", providerId: 1 }], {
      projectId: 7,
      source: { kind: "task", id: 1 },
      prompt: "do the thing",
    });
    await useTerminalStore.getState().applyPaneLayout(spec);

    // `<AgentPane/>` posts its own recordAgentLaunch on mount — the store
    // must post nothing, or `persist_on_launch`'s unconditional INSERT would
    // produce a second `agent_runs` row for the same pane.
    expect(fetchSidecarMock).not.toHaveBeenCalled();
  });

  it("three agent panes keep three distinct provider/model pairs and open no PTY at all", async () => {
    const spec = makeSpec([
      { kind: "agent", providerId: 1, model: "claude-opus-5" },
      { kind: "agent", providerId: 2, model: "claude-sonnet-5" },
      { kind: "agent", providerId: 3, model: "gpt-5" },
    ]);
    const result = await useTerminalStore.getState().applyPaneLayout(spec);

    // All three mounted successfully — none needed a PTY at all.
    expect(result.openedCount).toBe(3);
    expect(result.failedCount).toBe(0);
    expect(openTerminalMock).not.toHaveBeenCalled();

    const leaves = collectLeaves(useTerminalStore.getState().tabs[0]!.layout);
    expect(leaves.map((l) => [l.providerId, l.model])).toEqual([
      [1, "claude-opus-5"],
      [2, "claude-sonnet-5"],
      [3, "gpt-5"],
    ]);
  });

  it("a shell pane whose open_terminal rejects is marked empty and its siblings survive", async () => {
    openTerminalMock.mockImplementationOnce(async () => {
      throw new Error("no such directory");
    });
    const spec = makeSpec([
      { kind: "shell", cwd: "/missing", command: "npm run dev" },
      { kind: "shell", cwd: "/ok", command: "npm test" },
    ]);

    const result = await useTerminalStore.getState().applyPaneLayout(spec);

    expect(result.openedCount).toBe(1);
    expect(result.failedCount).toBe(1);

    const leaves = collectLeaves(useTerminalStore.getState().tabs[0]!.layout);
    const empty = leaves.find((l) => l.empty === true);
    const real = leaves.find((l) => l.empty !== true);
    expect(empty).toBeDefined();
    expect(empty?.cwd).toBe("/missing");
    expect(empty?.initCommand).toBe("npm run dev\n");
    expect(real).toBeDefined();
    expect(real?.terminalId).toMatch(/^pty-/);
  });

  it("an over-cap spec throws RangeError, opens no PTY and adds no tab", async () => {
    const panes: LaunchPane[] = Array.from({ length: 9 }, () => ({
      kind: "agent" as const,
    }));
    const spec = makeSpec(panes);

    await expect(
      useTerminalStore.getState().applyPaneLayout(spec),
    ).rejects.toThrow(RangeError);
    expect(openTerminalMock).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().tabs).toHaveLength(0);
  });

  it("persistToStorage drops initCommand and seed but keeps kind, providerId, model and permissionMode", async () => {
    const spec = makeSpec(
      [
        {
          kind: "agent",
          providerId: 1,
          model: "claude-opus-5",
          permissionMode: "plan",
        },
        { kind: "shell", command: "npm run dev" },
      ],
      { projectId: 7, prompt: "fix the bug" },
    );
    await useTerminalStore.getState().applyPaneLayout(spec);
    useTerminalStore.getState().persistToStorage();

    const raw = localStorage.getItem(TERMINAL_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as {
      tabs: Array<{ layout: LayoutNode }>;
    };
    const [agentLeaf] = collectLeaves(parsed.tabs[0]!.layout);
    expect(agentLeaf?.kind).toBe("agent");
    expect(agentLeaf?.providerId).toBe(1);
    expect(agentLeaf?.model).toBe("claude-opus-5");
    expect(agentLeaf?.permissionMode).toBe("plan");
    expect(agentLeaf?.seed).toBeUndefined();
    expect(agentLeaf?.initCommand).toBeUndefined();
  });

  it("two applyPaneLayout calls produce disjoint leaf ids", async () => {
    const spec = makeSpec([{ kind: "agent", providerId: 1 }]);
    await useTerminalStore.getState().applyPaneLayout(spec);
    await useTerminalStore.getState().applyPaneLayout(spec);

    const { tabs } = useTerminalStore.getState();
    expect(tabs).toHaveLength(2);
    const idA = collectLeaves(tabs[0]!.layout)[0]!.terminalId;
    const idB = collectLeaves(tabs[1]!.layout)[0]!.terminalId;
    expect(idA).not.toBe(idB);
  });

  it("the prompt is staged for exactly the agent panes whose sendPrompt is on", async () => {
    const spec = makeSpec(
      [
        { kind: "agent", providerId: 1, sendPrompt: true },
        { kind: "agent", providerId: 2, sendPrompt: false },
        { kind: "shell", command: "npm run dev" },
      ],
      { prompt: "please run the tests" },
    );
    await useTerminalStore.getState().applyPaneLayout(spec);

    const [leafA, leafB, leafShell] = collectLeaves(
      useTerminalStore.getState().tabs[0]!.layout,
    );
    expect(consumePendingPrompt(leafA!.terminalId)).toBe(
      "please run the tests",
    );
    expect(consumePendingPrompt(leafB!.terminalId)).toBeNull();
    expect(consumePendingPrompt(leafShell!.terminalId)).toBeNull();

    // Nothing delivers the prompt into a PTY: exactly one write, the shell
    // pane's own command. Delivery into a composer draft is
    // `<AgentPane/>`'s job (#32), not the store's.
    expect(sendTerminalInputMock).toHaveBeenCalledTimes(1);
    expect(sendTerminalInputMock).toHaveBeenCalledWith(
      expect.stringMatching(/^pty-/),
      "npm run dev\n",
    );
  });

  it("a launch with no prompt stages nothing", async () => {
    const spec = makeSpec([
      { kind: "agent", providerId: 1, sendPrompt: true },
      { kind: "shell", command: "npm run dev" },
    ]);
    await useTerminalStore.getState().applyPaneLayout(spec);
    expect(pendingPromptCount()).toBe(0);
  });

  it("the staged key is the leaf's real id, never a pending-N placeholder", async () => {
    const spec = makeSpec([{ kind: "agent", providerId: 1, sendPrompt: true }], {
      prompt: "hello",
    });
    await useTerminalStore.getState().applyPaneLayout(spec);

    expect(consumePendingPrompt("pending-0")).toBeNull();
    const realId = collectLeaves(useTerminalStore.getState().tabs[0]!.layout)[0]!
      .terminalId;
    expect(consumePendingPrompt(realId)).toBe("hello");
  });

  it("two launches from the same spec stage under disjoint ids", async () => {
    const spec = makeSpec([{ kind: "agent", providerId: 1, sendPrompt: true }], {
      prompt: "hello",
    });
    await useTerminalStore.getState().applyPaneLayout(spec);
    await useTerminalStore.getState().applyPaneLayout(spec);

    const { tabs } = useTerminalStore.getState();
    const idA = collectLeaves(tabs[0]!.layout)[0]!.terminalId;
    const idB = collectLeaves(tabs[1]!.layout)[0]!.terminalId;
    expect(idA).not.toBe(idB);
    expect(consumePendingPrompt(idA)).toBe("hello");
    expect(consumePendingPrompt(idB)).toBe("hello");
  });
});
