import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NotificationBell } from "../notification-bell";
import { notifRoute } from "../../lib/notification-route";
import * as api from "../../lib/api";
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

// `afterEach(cleanup)` is mandatory: `frontend/vite.config.ts` does not set
// `globals: true`, so Testing Library's auto-cleanup never registers and two
// bells from two tests end up in the same document.
afterEach(() => {
  cleanup();
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
    // Was `[class*='badge']`, the CSS-module class. #283 replaced the blue
    // rounded pill with Deck's `.dk-tag`; the assertion is the same one.
    const badge = document.querySelector(".dk-tag");
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

  // ─── #283: the Deck conversion ────────────────────────────────────────────

  function openBell(data: Notification[]): void {
    mockUseNotifications.mockReturnValue({ data });
    render(<NotificationBell />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
  }

  it("portals the popover inside a `.deck` scope so the tokens resolve", () => {
    openBell([makeNotif(1, false)]);
    const dialog = document.querySelector("[role='dialog']");
    expect(dialog).toBeTruthy();
    expect(dialog!.closest(".deck")).toBeTruthy();
  });

  it("draws the popover on Deck, not on a CSS module", () => {
    openBell([makeNotif(1, false)]);
    const dialog = document.querySelector("[role='dialog']")!;
    expect(dialog.className).toContain("dk-modal");
    expect(document.querySelector("[role='grid']")).toBeTruthy();
    // The old module hashed every class as `notification-bell_<name>__<hash>`.
    expect(document.querySelector("[class*='notification-bell']")).toBeNull();
  });

  it("gives an unread row the same `?` glyph Needs You gives it, and a read row `·`", () => {
    openBell([makeNotif(1, false), makeNotif(2, true)]);
    const glyphs = Array.from(
      document.querySelectorAll("[role='row'] .dk-s"),
    ).map((g) => g.getAttribute("data-s"));
    expect(glyphs).toEqual(["wait", "idle"]);
  });

  it("marks an unread title bold on `.sub` and leaves a read one plain", () => {
    openBell([makeNotif(1, false), makeNotif(2, true)]);
    expect(screen.getByText("Item 1").tagName).toBe("B");
    expect(screen.getByText("Item 1").className).toBe("sub");
    expect(screen.getByText("Item 2").tagName).toBe("SPAN");
  });

  it("names the notification type as a word instead of a per-type icon chip", () => {
    openBell([makeNotif(1, false, { type: "session_failed" })]);
    expect(screen.getByText("session failed")).toBeTruthy();
  });

  it("falls back to the raw type, de-underscored, for a type it does not know", () => {
    openBell([makeNotif(1, false, { type: "some_future_type" })]);
    expect(screen.getByText("some future type")).toBeTruthy();
  });

  it("marks one row read from its own button", () => {
    openBell([makeNotif(7, false)]);
    fireEvent.click(screen.getByRole("button", { name: "mark read" }));
    expect(api.markNotificationRead).toHaveBeenCalledWith(7);
    expect(api.markAllNotificationsRead).not.toHaveBeenCalled();
  });

  it("marks one row read when the row itself is activated", () => {
    openBell([makeNotif(9, false)]);
    fireEvent.click(document.querySelector("[role='row'].dk-line")!);
    expect(api.markNotificationRead).toHaveBeenCalledWith(9);
  });

  it("offers neither mark-read affordance on a row that is already read", () => {
    openBell([makeNotif(3, true)]);
    expect(screen.queryByRole("button", { name: "mark read" })).toBeNull();
    fireEvent.click(document.querySelector("[role='row'].dk-line")!);
    expect(api.markNotificationRead).not.toHaveBeenCalled();
  });

  it("shows `mark all read` only while something is unread", () => {
    openBell([makeNotif(1, false)]);
    const markAll = screen.getByRole("button", { name: "mark all read" });
    fireEvent.click(markAll);
    expect(api.markAllNotificationsRead).toHaveBeenCalled();
  });

  it("hides `mark all read` when everything is read", () => {
    openBell([makeNotif(1, true)]);
    expect(screen.queryByRole("button", { name: "mark all read" })).toBeNull();
  });

  it("keeps the relative timestamp on every row", () => {
    openBell([makeNotif(1, false)]);
    // Three gridcells: the state glyph, the subject, the timestamp.
    const cells = document.querySelectorAll("[role='row'].dk-line [role='gridcell']");
    expect(cells.length).toBe(3);
    expect(cells[2]!.className).toBe("r");
    expect(cells[2]!.textContent).toBeTruthy();
  });

  it("expands a body on click and collapses it again, without marking it read", () => {
    openBell([makeNotif(1, false, { body: "the long story" })]);
    const body = screen.getByText("the long story");
    expect(body.getAttribute("style")).toContain("line-clamp");
    fireEvent.click(body);
    expect(screen.getByText("the long story").getAttribute("style")).toContain(
      "pre-wrap",
    );
    expect(api.markNotificationRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("the long story"));
    expect(screen.getByText("the long story").getAttribute("style")).toContain(
      "line-clamp",
    );
  });

  it("renders the empty state when there is nothing at all", () => {
    openBell([]);
    expect(screen.getByText("No notifications")).toBeTruthy();
    expect(document.querySelector("[role='grid']")).toBeNull();
  });

  it("caps the list at 50 rows", () => {
    openBell(Array.from({ length: 60 }, (_, i) => makeNotif(i + 1, false)));
    expect(document.querySelectorAll("[role='row'].dk-line").length).toBe(50);
  });
});
