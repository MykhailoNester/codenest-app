import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { PaneHud } from "../../lib/api";
import type { GitPaneStatus } from "../../lib/ipc";

type SseHandler = (eventName: string, data: unknown) => void;

function makeHud(overrides: Partial<PaneHud> = {}): PaneHud {
  return {
    pane_id: "pane-1",
    session_id: "sess-1",
    status: "active",
    model: "claude-opus-4-5",
    context_tokens: null,
    context_window: null,
    cost_usd: 0,
    started_at: "2026-01-01T00:00:00",
    ended_at: null,
    current_tool: null,
    current_tool_started_at: null,
    thinking: false,
    todo_done: null,
    todo_total: null,
    ...overrides,
  };
}

describe("session-hud-store", () => {
  let startSessionHudFeed: typeof import("../session-hud-store").startSessionHudFeed;
  let useSessionHud: typeof import("../session-hud-store").useSessionHud;
  let useGitPaneStatus: typeof import("../session-hud-store").useGitPaneStatus;
  let useSessionHudStore: typeof import("../session-hud-store").useSessionHudStore;
  let fetchPaneHuds: ReturnType<typeof vi.fn>;
  let getGitPaneStatus: ReturnType<typeof vi.fn>;
  let isTauriAvailable: ReturnType<typeof vi.fn>;
  let subscribeMock: ReturnType<typeof vi.fn>;
  let capturedHandler: SseHandler | null;

  beforeEach(async () => {
    vi.resetModules();

    fetchPaneHuds = vi.fn(async () => [] as PaneHud[]);
    vi.doMock("../../lib/api", () => ({ fetchPaneHuds }));

    getGitPaneStatus = vi.fn(async () => null as GitPaneStatus | null);
    isTauriAvailable = vi.fn(() => true);
    vi.doMock("../../lib/ipc", () => ({ getGitPaneStatus, isTauriAvailable }));

    capturedHandler = null;
    subscribeMock = vi.fn(
      (_key: string, _names: readonly string[], handler: SseHandler) => {
        capturedHandler = handler;
        return vi.fn();
      },
    );
    vi.doMock("../../lib/sse-registry", () => ({
      sseRegistry: { subscribe: subscribeMock },
      SSE_EVENT_NAMES: ["snapshot", "prompt", "pre_tool", "post_tool", "stop"],
    }));

    const mod = await import("../session-hud-store");
    startSessionHudFeed = mod.startSessionHudFeed;
    useSessionHud = mod.useSessionHud;
    useGitPaneStatus = mod.useGitPaneStatus;
    useSessionHudStore = mod.useSessionHudStore;
  });

  afterEach(() => {
    cleanup();
    vi.doUnmock("../../lib/api");
    vi.doUnmock("../../lib/ipc");
    vi.doUnmock("../../lib/sse-registry");
    vi.useRealTimers();
  });

  it("hydrates from the GET fetch and subscribes to SSE exactly once", async () => {
    fetchPaneHuds.mockResolvedValueOnce([makeHud({ pane_id: "pane-1" })]);

    await act(async () => {
      startSessionHudFeed();
      startSessionHudFeed(); // idempotent — a second call must not double-fetch
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchPaneHuds).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(useSessionHudStore.getState().byPane["pane-1"]?.session_id).toBe(
      "sess-1",
    );
  });

  it("merges a delta into byPane by pane_id, leaving other panes alone", async () => {
    await act(async () => {
      startSessionHudFeed();
      await Promise.resolve();
    });
    useSessionHudStore.setState({
      byPane: { "pane-b": makeHud({ pane_id: "pane-b", session_id: "sess-b" }) },
    });

    act(() => {
      capturedHandler?.("prompt", {
        hud: makeHud({ pane_id: "pane-a", session_id: "sess-a" }),
      });
    });

    const { byPane } = useSessionHudStore.getState();
    expect(byPane["pane-a"]?.session_id).toBe("sess-a");
    expect(byPane["pane-b"]?.session_id).toBe("sess-b");
  });

  it("ignores messages with no hud field", async () => {
    await act(async () => {
      startSessionHudFeed();
      await Promise.resolve();
    });

    act(() => {
      capturedHandler?.("update", { kind: "launch", event: {} });
    });

    expect(useSessionHudStore.getState().byPane).toEqual({});
  });

  it("re-seeds byPane wholesale on a snapshot event", async () => {
    await act(async () => {
      startSessionHudFeed();
      await Promise.resolve();
    });

    act(() => {
      capturedHandler?.("prompt", {
        hud: makeHud({ pane_id: "pane-2", session_id: "sess-2" }),
      });
    });
    expect(useSessionHudStore.getState().byPane["pane-2"]).toBeDefined();

    // A reconnect snapshot lists only pane-1 — pane-2 must disappear.
    act(() => {
      capturedHandler?.("snapshot", {
        hud: [makeHud({ pane_id: "pane-1", session_id: "sess-1-fresh" })],
      });
    });

    const { byPane } = useSessionHudStore.getState();
    expect(byPane["pane-1"]?.session_id).toBe("sess-1-fresh");
    expect(byPane["pane-2"]).toBeUndefined();
  });

  it("polls a registered cwd once immediately via useGitPaneStatus", async () => {
    getGitPaneStatus.mockResolvedValueOnce({
      branch: "develop",
      dirty: false,
      ahead: 0,
    } satisfies GitPaneStatus);

    const { result } = renderHook(() => useGitPaneStatus("/repo"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(getGitPaneStatus).toHaveBeenCalledWith("/repo");
    expect(result.current?.branch).toBe("develop");
  });

  it("shares one poll per distinct cwd across multiple panes (D12)", async () => {
    vi.useFakeTimers();
    const hookA = renderHook(() => useGitPaneStatus("/repo"));
    const hookB = renderHook(() => useGitPaneStatus("/repo"));
    await act(async () => {
      await Promise.resolve();
    });
    getGitPaneStatus.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(getGitPaneStatus).toHaveBeenCalledTimes(1);
    hookA.unmount();
    hookB.unmount();
  });

  it("stops polling once the last registered pane for a cwd unmounts", async () => {
    vi.useFakeTimers();
    const hook = renderHook(() => useGitPaneStatus("/repo"));
    await act(async () => {
      await Promise.resolve();
    });
    hook.unmount();
    getGitPaneStatus.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(getGitPaneStatus).not.toHaveBeenCalled();
  });

  it("never calls invoke when isTauriAvailable is false", async () => {
    isTauriAvailable.mockReturnValue(false);
    const hook = renderHook(() => useGitPaneStatus("/repo"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(getGitPaneStatus).not.toHaveBeenCalled();
    expect(hook.result.current).toBeNull();
  });

  it("useSessionHud returns null for a pane with no entry", () => {
    const { result } = renderHook(() => useSessionHud("nope"));
    expect(result.current).toBeNull();
  });
});
