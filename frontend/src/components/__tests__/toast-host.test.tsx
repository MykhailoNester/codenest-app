import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastHost } from "../toast-host";

const {
  mockToast,
  mockToastError,
  mockUseNotificationsStream,
  mockEmitNativeNotification,
} = vi.hoisted(() => ({
  mockToast: vi.fn(),
  mockToastError: vi.fn(),
  mockUseNotificationsStream: vi.fn(),
  mockEmitNativeNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(mockToast, { error: mockToastError }),
}));

vi.mock("../../lib/api", () => ({
  useNotificationsStream: (cb: unknown) => mockUseNotificationsStream(cb),
}));

vi.mock("../../lib/ipc", () => ({
  emitNativeNotification: (...args: unknown[]) =>
    mockEmitNativeNotification(...args),
}));

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={makeClient()}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseNotificationsStream.mockImplementation(() => undefined);
});

function getRegisteredHandler(): (name: string, data: unknown) => void {
  const call = mockUseNotificationsStream.mock.calls[0];
  if (!call) throw new Error("useNotificationsStream not called");
  return call[0] as (name: string, data: unknown) => void;
}

describe("ToastHost", () => {
  it("calls toast() for normal-priority notification", () => {
    render(<ToastHost />, { wrapper });
    const handler = getRegisteredHandler();
    handler("notification", {
      type: "inbox_new",
      title: "New item",
      body: null,
      priority: "normal",
    });
    expect(mockToast).toHaveBeenCalledWith(
      "New item",
      expect.objectContaining({ duration: 6000 }),
    );
  });

  it("calls toast.error() and emitNativeNotification for high-priority", () => {
    render(<ToastHost />, { wrapper });
    const handler = getRegisteredHandler();
    handler("notification", {
      type: "session_failed",
      title: "Session error",
      body: "Something failed",
      priority: "high",
    });
    expect(mockToastError).toHaveBeenCalledWith(
      "Session error",
      expect.objectContaining({ duration: Infinity }),
    );
    expect(mockEmitNativeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Session error", priority: "high" }),
    );
  });

  it("does not call toast() for low-priority notification", () => {
    render(<ToastHost />, { wrapper });
    const handler = getRegisteredHandler();
    handler("notification", {
      type: "inbox_new",
      title: "Low prio",
      body: null,
      priority: "low",
    });
    expect(mockToast).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
