import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NotificationBell } from "../notification-bell";
import { notifRoute } from "../../lib/notification-route";
import type { Notification } from "../../lib/api";

const mockUseNotifications = vi.fn();
vi.mock("../../lib/api", () => ({
  useNotifications: (...args: unknown[]) => mockUseNotifications(...args),
  markNotificationRead: vi.fn().mockResolvedValue({}),
  markAllNotificationsRead: vi.fn().mockResolvedValue({ updated: 0 }),
  dismissNotification: vi.fn().mockResolvedValue({}),
}));

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseNotifications.mockReturnValue({ data: [] });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeNotif(
  id: number,
  read: boolean,
  overrides: Partial<Notification> = {},
): Notification {
  return {
    id,
    type: "inbox_new",
    title: `Item ${id}`,
    body: null,
    payload_json: null,
    target: null,
    priority: "low",
    read_at: read ? "2026-05-08T10:00:00" : null,
    created_at: "2026-05-08T10:00:00",
    ...overrides,
  };
}

// ─── notifRoute unit tests ────────────────────────────────────────────────────

describe("notifRoute", () => {
  it("task_assigned with task_id deep-links to /tasks/:id", () => {
    const n = makeNotif(1, false, {
      type: "task_assigned",
      payload_json: JSON.stringify({
        task_id: 42,
        task_title: "Fix bug",
        assignee_id: 1,
      }),
    });
    expect(notifRoute(n)).toBe("/tasks/42");
  });

  it("task_assigned without task_id falls back to /tasks", () => {
    const n = makeNotif(1, false, {
      type: "task_assigned",
      payload_json: JSON.stringify({ task_title: "Fix bug" }),
    });
    expect(notifRoute(n)).toBe("/tasks");
  });

  it("blocker_resolved with task_id deep-links to /tasks/:id", () => {
    const n = makeNotif(1, false, {
      type: "blocker_resolved",
      payload_json: JSON.stringify({ task_id: 7, task_title: "Ship feature" }),
    });
    expect(notifRoute(n)).toBe("/tasks/7");
  });

  it("blocker_resolved without task_id falls back to /tasks", () => {
    const n = makeNotif(1, false, {
      type: "blocker_resolved",
      payload_json: JSON.stringify({}),
    });
    expect(notifRoute(n)).toBe("/tasks");
  });

  it("session_failed with session_id deep-links to /command?session=...", () => {
    const n = makeNotif(1, false, {
      type: "session_failed",
      payload_json: JSON.stringify({
        session_id: "abc12345-dead-beef",
        reason: "error",
      }),
    });
    expect(notifRoute(n)).toBe("/command?session=abc12345-dead-beef");
  });

  it("session_failed with URL-special chars in session_id encodes them", () => {
    const n = makeNotif(1, false, {
      type: "session_failed",
      payload_json: JSON.stringify({ session_id: "abc 123&x=1" }),
    });
    expect(notifRoute(n)).toBe("/command?session=abc%20123%26x%3D1");
  });

  it("session_failed without session_id falls back to /command", () => {
    const n = makeNotif(1, false, {
      type: "session_failed",
      payload_json: JSON.stringify({ reason: "error" }),
    });
    expect(notifRoute(n)).toBe("/command");
  });

  it("session_info with session_id deep-links to /command?session=...", () => {
    const n = makeNotif(1, false, {
      type: "session_info",
      payload_json: JSON.stringify({
        session_id: "xyz99",
        reason: "unknown_reason",
      }),
    });
    expect(notifRoute(n)).toBe("/command?session=xyz99");
  });

  it("session_info without session_id falls back to /command", () => {
    const n = makeNotif(1, false, {
      type: "session_info",
      payload_json: null,
    });
    expect(notifRoute(n)).toBe("/command");
  });

  it("cost_threshold (no usable item id) routes to /command", () => {
    const n = makeNotif(1, false, {
      type: "cost_threshold",
      payload_json: JSON.stringify({
        daily_cost_usd: 12.5,
        threshold_usd: 10.0,
      }),
    });
    expect(notifRoute(n)).toBe("/command");
  });

  it("budget_threshold routes to /budgets", () => {
    const n = makeNotif(1, false, {
      type: "budget_threshold",
      payload_json: JSON.stringify({
        budget_id: 3,
        threshold: 80,
        spent_usd: 8.0,
        limit_usd: 10.0,
        period: "monthly",
      }),
    });
    expect(notifRoute(n)).toBe("/budgets");
  });

  it("inbox_new with inbox_id deep-links to /inbox?focus=:id", () => {
    const n = makeNotif(1, false, {
      type: "inbox_new",
      payload_json: JSON.stringify({ inbox_id: 99, title: "New item" }),
    });
    expect(notifRoute(n)).toBe("/inbox?focus=99");
  });

  it("inbox_new without inbox_id falls back to /inbox", () => {
    const n = makeNotif(1, false, {
      type: "inbox_new",
      payload_json: null,
    });
    expect(notifRoute(n)).toBe("/inbox");
  });

  it("unknown type falls back to /", () => {
    const n = makeNotif(1, false, {
      type: "unknown_future_type",
      payload_json: JSON.stringify({ foo: "bar" }),
    });
    expect(notifRoute(n)).toBe("/");
  });

  it("malformed payload_json falls back to /", () => {
    const n = makeNotif(1, false, {
      type: "task_assigned",
      payload_json: "not valid json {{{",
    });
    expect(notifRoute(n)).toBe("/");
  });

  it("null payload_json uses empty payload safely", () => {
    const n = makeNotif(1, false, {
      type: "task_assigned",
      payload_json: null,
    });
    expect(notifRoute(n)).toBe("/tasks");
  });
});

// ─── NotificationBell component tests ────────────────────────────────────────

describe("NotificationBell", () => {
  it("shows no badge when all notifications are read", () => {
    mockUseNotifications.mockReturnValue({
      data: [makeNotif(1, true)],
    });
    render(<NotificationBell />, { wrapper });
    const badge = document.querySelector("[class*='badge']");
    expect(badge).toBeNull();
  });

  it("shows badge with count when notifications are unread", () => {
    mockUseNotifications.mockReturnValue({
      data: [makeNotif(1, false), makeNotif(2, false), makeNotif(3, false)],
    });
    render(<NotificationBell />, { wrapper });
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("shows 9+ when more than 9 unread", () => {
    mockUseNotifications.mockReturnValue({
      data: Array.from({ length: 15 }, (_, i) => makeNotif(i + 1, false)),
    });
    render(<NotificationBell />, { wrapper });
    expect(screen.getByText("9+")).toBeTruthy();
  });

  it("toggles dropdown visibility on bell click", () => {
    mockUseNotifications.mockReturnValue({
      data: [makeNotif(1, false)],
    });
    render(<NotificationBell />, { wrapper });

    const bell = screen.getByRole("button", {
      name: "Notifications (1 unread)",
    });

    // Closed initially
    expect(document.querySelector("[role='dialog']")).toBeNull();

    // Open
    fireEvent.click(bell);
    expect(document.querySelector("[role='dialog']")).toBeTruthy();

    // Close
    fireEvent.click(bell);
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });
});
