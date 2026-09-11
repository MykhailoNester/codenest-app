/**
 * Needs You (epic #153 / #162).
 *
 * The page's value is entirely in what it claims, so these pin the claims
 * rather than the layout:
 *
 *   * **The empty state is the common case and must be honest.** It names the
 *     30-second re-check — the only freshness guarantee P1 has — and it must
 *     not promise a tray notification, which the S2 mockup's copy does and
 *     which P1 does not build. A screen whose worth is that you can trust its
 *     silence cannot overstate how that silence reaches you.
 *   * **Row actions are Inspect and Jump to pane, never Allow / Deny.**
 *     Answering a `PermissionRequest` from here puts a human on a hook's
 *     critical path; that shape is P2's, behind a pre-authorise rule.
 *   * **Severity grouping and order.** Blocking, then stalled, then queued —
 *     the design's reading order, and the order the sidecar sorts by.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AttentionPage } from "../attention";
import type { AttentionItem, AttentionQueue } from "../../lib/api";
import type { ReactNode } from "react";

const { mockUseAttention, mockNavigate } = vi.hoisted(() => ({
  mockUseAttention: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  useAttention: (...args: unknown[]) => mockUseAttention(...args),
}));

vi.mock("../../components/layout/shell", () => ({
  Shell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => mockNavigate };
});

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 1,
    kind: "session_stalled",
    severity: "stalled",
    state: "open",
    dedup_key: "session_stalled:s1",
    seen_count: 1,
    title: "Session idle 42m with unfinished work",
    detail: "codenest-app · last tool Edit",
    session_id: "s1",
    project_id: 2,
    task_id: null,
    schedule_id: null,
    payload_json: null,
    first_seen_at: "2026-09-10 11:00:00",
    last_seen_at: "2026-09-10 12:00:00",
    resolved_at: null,
    resolution: null,
    muted_until: null,
    pane_id: null,
    session_status: "active",
    project_name: "codenest-app",
    ...overrides,
  };
}

function queue(items: AttentionItem[]): AttentionQueue {
  return {
    items,
    counts: {
      blocking: items.filter((i) => i.severity === "blocking").length,
      stalled: items.filter((i) => i.severity === "stalled").length,
      queued: items.filter((i) => i.severity === "queued").length,
      open: items.length,
      muted: 0,
      resolved_today: 0,
      resolved_today_avg_seconds: null,
    },
  };
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <AttentionPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Needs You — empty state", () => {
  it("names the 30-second re-check", () => {
    mockUseAttention.mockReturnValue({ data: queue([]), isLoading: false });
    renderPage();
    expect(screen.getByText(/Nothing is waiting on you/)).toBeTruthy();
    expect(screen.getByText(/re-checks every 30 seconds/)).toBeTruthy();
  });

  it("does not promise a tray notification", () => {
    // The S2 mockup's copy says "You'll get a tray notification the moment
    // that changes." P1 builds no tray, so that sentence would be a lie on
    // the one screen that cannot afford one.
    mockUseAttention.mockReturnValue({ data: queue([]), isLoading: false });
    const { container } = render(
      <MemoryRouter>
        <AttentionPage />
      </MemoryRouter>,
    );
    expect(container.textContent).not.toMatch(/tray/i);
    expect(container.textContent).not.toMatch(/notif/i);
  });
});

describe("Needs You — rows", () => {
  it("offers Inspect and Jump to pane, and never Allow / Deny", () => {
    mockUseAttention.mockReturnValue({
      data: queue([item({ pane_id: "pane-7" })]),
      isLoading: false,
    });
    renderPage();
    expect(screen.getByText("Inspect")).toBeTruthy();
    expect(screen.getByText("Jump to pane")).toBeTruthy();
    expect(screen.queryByText(/Allow/)).toBeNull();
    expect(screen.queryByText(/Deny/)).toBeNull();
  });

  it("hides Jump to pane when the item has no pane", () => {
    // A session recorded before panes existed, or one whose pane is gone. A
    // button that cannot do its job is worse than no button.
    mockUseAttention.mockReturnValue({
      data: queue([item({ pane_id: null })]),
      isLoading: false,
    });
    renderPage();
    expect(screen.queryByText("Jump to pane")).toBeNull();
  });

  it("routes Inspect to the subject's own page", () => {
    mockUseAttention.mockReturnValue({
      data: queue([
        item({
          id: 9,
          kind: "task_blocked",
          severity: "queued",
          task_id: 42,
          title: "Task blocked: ship the thing",
          session_id: null,
        }),
      ]),
      isLoading: false,
    });
    renderPage();
    fireEvent.click(screen.getByText("Inspect"));
    expect(mockNavigate).toHaveBeenCalledWith("/tasks/42");
  });

  it("groups by severity in the design's reading order", () => {
    mockUseAttention.mockReturnValue({
      data: queue([
        item({ id: 1, severity: "blocking", title: "blocking row" }),
        item({ id: 2, severity: "stalled", title: "stalled row" }),
        item({ id: 3, severity: "queued", title: "queued row" }),
      ]),
      isLoading: false,
    });
    const { container } = render(
      <MemoryRouter>
        <AttentionPage />
      </MemoryRouter>,
    );
    const heads = Array.from(container.querySelectorAll("h2")).map((h) =>
      (h.textContent ?? "").trim(),
    );
    expect(heads[0]).toMatch(/^Blocking/);
    expect(heads[1]).toMatch(/^Stalled/);
    expect(heads[2]).toMatch(/^Queued/);
  });

  it("shows the seen count only once a condition has recurred", () => {
    // One row seen 40 times is the whole point of the dedup index; a row seen
    // once saying "seen 1×" would be noise on every item on the page.
    mockUseAttention.mockReturnValue({
      data: queue([item({ seen_count: 40 })]),
      isLoading: false,
    });
    const { container } = render(
      <MemoryRouter>
        <AttentionPage />
      </MemoryRouter>,
    );
    expect(container.textContent).toContain("seen 40×");
    cleanup();

    mockUseAttention.mockReturnValue({
      data: queue([item({ seen_count: 1 })]),
      isLoading: false,
    });
    const second = render(
      <MemoryRouter>
        <AttentionPage />
      </MemoryRouter>,
    );
    expect(second.container.textContent).not.toContain("seen 1×");
  });
});

describe("Needs You — state tabs", () => {
  it("asks the sidecar for the selected state", () => {
    mockUseAttention.mockReturnValue({ data: queue([]), isLoading: false });
    renderPage();
    expect(mockUseAttention).toHaveBeenLastCalledWith("open");

    fireEvent.click(screen.getByText("Muted"));
    expect(mockUseAttention).toHaveBeenLastCalledWith("muted");
    expect(screen.getByText("No muted items")).toBeTruthy();
  });
});
