// The client half of #48: a new agent/skill/command file must reach an
// already-open composer picker without a restart. The shell watches `.claude/`
// and the sidecar publishes `workspace.catalog.changed`; what this file pins is
// that the event actually drops the cached catalog — a subscription that
// receives the event and invalidates nothing is the failure mode the whole
// chain is built to avoid.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";

type SseHandler = (eventName: string, data: unknown) => void;

const { subscribeMock, unsubscribeMock } = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
  unsubscribeMock: vi.fn(),
}));

vi.mock("../../lib/sse-registry", () => ({
  sseRegistry: {
    subscribe: (
      streamKey: string,
      eventNames: readonly string[],
      handler: SseHandler,
    ) => {
      subscribeMock(streamKey, eventNames, handler);
      return unsubscribeMock;
    },
  },
  WORKSPACE_SSE_EVENT_NAMES: ["workspace.catalog.changed"] as const,
}));

import { useCatalogChangeFeed } from "../use-catalog-feed";

function capturedHandler(): SseHandler {
  const call = subscribeMock.mock.calls.at(-1);
  if (!call) throw new Error("nothing subscribed");
  return call[2] as SseHandler;
}

describe("useCatalogChangeFeed", () => {
  let client: QueryClient;
  let invalidate: ReturnType<typeof vi.spyOn>;

  function wrapper({ children }: { children: ReactNode }): ReactElement {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }

  beforeEach(() => {
    subscribeMock.mockClear();
    unsubscribeMock.mockClear();
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
  });

  afterEach(() => {
    cleanup();
    client.clear();
  });

  it("subscribes to the workspace stream, not the agents one", () => {
    renderHook(() => useCatalogChangeFeed(), { wrapper });

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    const [streamKey, eventNames] = subscribeMock.mock.calls[0]!;
    expect(streamKey).toBe("workspace");
    expect(eventNames).toEqual(["workspace.catalog.changed"]);
  });

  it("drops the invocables catalog when a change event arrives", () => {
    renderHook(() => useCatalogChangeFeed(), { wrapper });
    expect(invalidate).not.toHaveBeenCalled();

    capturedHandler()("workspace.catalog.changed", {
      kind: "workspace.catalog.changed",
      reason: "rescan",
    });

    const keys = invalidate.mock.calls.map(
      (call: unknown[]) => (call[0] as { queryKey: unknown[] }).queryKey,
    );
    // Prefix keys: `useInvocables` keys on the pane's cwd
    // (`["command-center", "invocables", cwd]`), so every scope has to go —
    // an exact key would leave every other pane's picker stale.
    expect(keys).toEqual([["command-center"], ["workspace"]]);
  });

  it("closes its subscription on unmount", () => {
    const { unmount } = renderHook(() => useCatalogChangeFeed(), { wrapper });

    unmount();

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });
});
