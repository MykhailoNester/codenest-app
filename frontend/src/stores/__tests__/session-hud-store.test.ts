import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SessionHudPane } from "../../lib/api";

// Mock EventSource before importing the store so the D9 hydration guard
// (`typeof EventSource !== "undefined"`) is satisfied — same idiom as
// `lib/__tests__/sse-registry.test.ts`.
class FakeEventSource {}

type SseHandler = (eventName: string, data: unknown) => void;

function makePane(overrides: Partial<SessionHudPane> = {}): SessionHudPane {
  return {
    pane_id: "pane-1",
    session_id: "sess-1",
    status: "active",
    model: "claude-opus-4-5",
    model_display: null,
    context_tokens: null,
    context_window: null,
    cost_usd: 0,
    started_at: "2026-01-01T00:00:00",
    current_tool: null,
    current_tool_started_at: null,
    thinking: false,
    todo_done: null,
    todo_total: null,
    ...overrides,
  };
}

describe("session-hud-store", () => {
  let acquireSessionHudStream: typeof import("../session-hud-store").acquireSessionHudStream;
  let useSessionHudPane: typeof import("../session-hud-store").useSessionHudPane;
  let resetForTests: typeof import("../session-hud-store")._resetSessionHudStoreForTests;
  let fetchSessionHud: ReturnType<typeof vi.fn>;
  let subscribeMock: ReturnType<typeof vi.fn>;
  let unsubscribeMock: ReturnType<typeof vi.fn>;
  let capturedHandler: SseHandler | null;

  beforeEach(async () => {
    vi.resetModules();
    (
      globalThis as unknown as { EventSource: typeof FakeEventSource }
    ).EventSource = FakeEventSource;

    fetchSessionHud = vi.fn(async () => ({ panes: [] }));
    vi.doMock("../../lib/api", () => ({ fetchSessionHud }));

    unsubscribeMock = vi.fn();
    capturedHandler = null;
    subscribeMock = vi.fn(
      (_key: string, _names: readonly string[], handler: SseHandler) => {
        capturedHandler = handler;
        return unsubscribeMock;
      },
    );
    vi.doMock("../../lib/sse-registry", () => ({
      sseRegistry: { subscribe: subscribeMock },
      SSE_EVENT_NAMES: [
        "snapshot",
        "session_started",
        "prompt",
        "pre_tool",
        "post_tool",
        "stop",
        "session_ended",
        "session_removed",
        "update",
      ],
    }));

    const mod = await import("../session-hud-store");
    acquireSessionHudStream = mod.acquireSessionHudStream;
    useSessionHudPane = mod.useSessionHudPane;
    resetForTests = mod._resetSessionHudStoreForTests;
  });

  afterEach(() => {
    resetForTests();
    vi.doUnmock("../../lib/api");
    vi.doUnmock("../../lib/sse-registry");
    delete (globalThis as { EventSource?: unknown }).EventSource;
  });

  it("hydrates from the snapshot fetch on first acquire", async () => {
    fetchSessionHud.mockResolvedValueOnce({
      panes: [makePane({ pane_id: "pane-1" })],
    });
    const { result } = renderHook(() => useSessionHudPane("pane-1"));

    let release = (): void => undefined;
    await act(async () => {
      release = acquireSessionHudStream();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchSessionHud).toHaveBeenCalledTimes(1);
    expect(result.current?.session_id).toBe("sess-1");
    release();
  });

  it("skips the hydration fetch when EventSource is undefined", () => {
    delete (globalThis as { EventSource?: unknown }).EventSource;

    const release = acquireSessionHudStream();
    expect(fetchSessionHud).not.toHaveBeenCalled();
    release();
  });

  it("opens exactly one SSE subscription for many acquires", () => {
    const release1 = acquireSessionHudStream();
    const release2 = acquireSessionHudStream();
    const release3 = acquireSessionHudStream();

    expect(subscribeMock).toHaveBeenCalledTimes(1);

    release1();
    release2();
    release3();
  });

  it("releases the subscription when the last subscriber goes away", () => {
    const release1 = acquireSessionHudStream();
    const release2 = acquireSessionHudStream();

    release1();
    expect(unsubscribeMock).not.toHaveBeenCalled();

    release2();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it("applies a delta to the matching pane only", async () => {
    const { result: paneA } = renderHook(() => useSessionHudPane("pane-a"));
    const { result: paneB } = renderHook(() => useSessionHudPane("pane-b"));
    let release = (): void => undefined;

    await act(async () => {
      release = acquireSessionHudStream();
      await Promise.resolve();
    });

    act(() => {
      capturedHandler?.("prompt", {
        hud: makePane({ pane_id: "pane-a", session_id: "sess-a" }),
      });
    });

    expect(paneA.current?.session_id).toBe("sess-a");
    expect(paneB.current).toBeNull();
    release();
  });

  it('removes the pane when a delta arrives with status "ended"', async () => {
    const { result } = renderHook(() => useSessionHudPane("pane-1"));
    let release = (): void => undefined;

    await act(async () => {
      release = acquireSessionHudStream();
      await Promise.resolve();
    });

    act(() => {
      capturedHandler?.("stop", { hud: makePane({ status: "active" }) });
    });
    expect(result.current).not.toBeNull();

    act(() => {
      capturedHandler?.("session_ended", {
        hud: makePane({ status: "ended" }),
      });
    });
    expect(result.current).toBeNull();
    release();
  });

  it("ignores messages with no hud field", async () => {
    const { result } = renderHook(() => useSessionHudPane("pane-1"));
    let release = (): void => undefined;

    await act(async () => {
      release = acquireSessionHudStream();
      await Promise.resolve();
    });

    act(() => {
      capturedHandler?.("update", { kind: "launch", event: {} });
    });

    expect(result.current).toBeNull();
    release();
  });

  it("re-seeds wholesale on a snapshot event", async () => {
    const { result: keptPane } = renderHook(() => useSessionHudPane("pane-1"));
    const { result: droppedPane } = renderHook(() =>
      useSessionHudPane("pane-2"),
    );
    let release = (): void => undefined;

    await act(async () => {
      release = acquireSessionHudStream();
      await Promise.resolve();
    });

    act(() => {
      capturedHandler?.("prompt", {
        hud: makePane({ pane_id: "pane-2", session_id: "sess-2" }),
      });
    });
    expect(droppedPane.current?.session_id).toBe("sess-2");

    // A reconnect snapshot only lists pane-1 — pane-2 must disappear.
    act(() => {
      capturedHandler?.("snapshot", {
        hud: [makePane({ pane_id: "pane-1", session_id: "sess-1-fresh" })],
      });
    });

    expect(keptPane.current?.session_id).toBe("sess-1-fresh");
    expect(droppedPane.current).toBeNull();
    release();
  });
});
