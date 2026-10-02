/**
 * Needs You (epic #153 / #162, extended by #265).
 *
 * The page's value is entirely in what it claims, so these pin the claims
 * rather than the layout:
 *
 *   * **The empty state is the common case and must be honest.** It names the
 *     30-second re-check — the only freshness guarantee P1 has — and it must
 *     not promise a tray notification, which the S2 mockup's copy does and
 *     which P1 does not build. A screen whose worth is that you can trust its
 *     silence cannot overstate how that silence reaches you.
 *   * **Row actions are Inspect and one jump, never Allow / Deny.**
 *     Answering a `PermissionRequest` from here puts a human on a hook's
 *     critical path; that shape is P2's, behind a pre-authorise rule.
 *   * **Severity grouping and order.** Blocking, then stalled, then queued —
 *     the design's reading order, and the order the sidecar sorts by.
 *   * **#265: every row's jump actually arrives.** The pane path is the one no
 *     test can fully prove (it ends in a Tauri window), so what is pinned here
 *     is each of its three outcomes — the pane is in a tab, the pane is live
 *     elsewhere, the pane is gone — and that the third one falls back to the
 *     session's record instead of raising an empty window.
 *
 * Which rule produces which action is pinned in
 * `lib/__tests__/attention-action.test.ts` — that is a pure function. This file
 * is about the wiring.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AttentionPage } from "../attention";
import type { AttentionItem, AttentionQueue } from "../../lib/api";
import type { ReactNode } from "react";

const {
  mockUseAttention,
  mockNavigate,
  mockListLivePanes,
  mockOpenTerminalsWindow,
  mockEmitFocusPane,
  mockSetActiveTab,
  mockSetFocusedLeaf,
  mockHydrate,
  storeTabs,
} = vi.hoisted(() => ({
  mockUseAttention: vi.fn(),
  mockNavigate: vi.fn(),
  mockListLivePanes: vi.fn(() => Promise.resolve([] as string[])),
  mockOpenTerminalsWindow: vi.fn(() => Promise.resolve()),
  mockEmitFocusPane: vi.fn((paneId: string) => Promise.resolve(paneId)),
  mockSetActiveTab: vi.fn(),
  mockSetFocusedLeaf: vi.fn(),
  mockHydrate: vi.fn(() => Promise.resolve()),
  storeTabs: { value: [] as unknown[] },
}));

vi.mock("../../lib/api", () => ({
  useAttention: (...args: unknown[]) => mockUseAttention(...args),
}));

vi.mock("../../lib/ipc", () => ({
  listLivePanes: () => mockListLivePanes(),
  openTerminalsWindow: () => mockOpenTerminalsWindow(),
  emitFocusPaneToTerminals: (paneId: string) => mockEmitFocusPane(paneId),
}));

vi.mock("../../stores/terminal-store", () => ({
  useTerminalStore: {
    getState: () => ({
      hydrateFromStorage: mockHydrate,
      tabs: storeTabs.value,
      setActiveTab: mockSetActiveTab,
      setFocusedLeaf: mockSetFocusedLeaf,
    }),
  },
}));

// The launch composer pulls in the agent catalog, the projects query and the
// Tauri shell. The page's contract is only that it opens one, seeded from the
// right source — the composer's own behaviour has its own 800-line suite.
vi.mock("../../components/launch/attention-launch-dialog", () => ({
  AttentionLaunchDialog: ({
    source,
    projectId,
  }: {
    source: { kind: string; id: number } | null;
    projectId: number | null;
  }) => (
    <div data-testid="launch-dialog">
      {source ? `${source.kind}:${source.id}` : `project:${projectId}`}
    </div>
  ),
}));

// Stubbed for the same reason the old Shell was: this file tests the queue,
// not the chrome. `actions` is rendered so the state tabs stay reachable.
vi.mock("../../components/deck/deck-shell", () => ({
  DeckShell: ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
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

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <AttentionPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  storeTabs.value = [];
  mockListLivePanes.mockImplementation(() => Promise.resolve([] as string[]));
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
    const { container } = renderPage();
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
    expect(screen.getByText(/^inspect$/i)).toBeTruthy();
    expect(screen.getByText(/^jump to pane$/i)).toBeTruthy();
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
    expect(screen.queryByText(/^jump to pane$/i)).toBeNull();
  });

  it("hides Jump to pane when the pane belongs to a session that ended", () => {
    // #265. `pane_id` is joined live from `agent_sessions` and outlives the
    // session, so the column alone was never enough to offer the button.
    mockUseAttention.mockReturnValue({
      data: queue([item({ pane_id: "pane-7", session_status: "ended" })]),
      isLoading: false,
    });
    renderPage();
    expect(screen.queryByText(/^jump to pane$/i)).toBeNull();
    fireEvent.click(screen.getByText(/^open session$/i));
    expect(mockNavigate).toHaveBeenCalledWith("/sessions/s1");
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
    fireEvent.click(screen.getByText(/^inspect$/i));
    expect(mockNavigate).toHaveBeenCalledWith("/tasks/42");
  });

  it("opens a launch seeded from the ticket when nothing is running", () => {
    // #265's "start one, with the right agent, project and model already
    // chosen" — the seed endpoint resolves all three from the ticket, so the
    // page's whole job is to hand it the right source.
    mockUseAttention.mockReturnValue({
      data: queue([
        item({ kind: "task_blocked", severity: "queued", task_id: 42, session_id: null }),
      ]),
      isLoading: false,
    });
    renderPage();
    expect(screen.queryByTestId("launch-dialog")).toBeNull();
    fireEvent.click(screen.getByText(/^start session$/i));
    expect(screen.getByTestId("launch-dialog").textContent).toBe("task:42");
  });

  it("renders an em dash, never a dead button, when a row points nowhere", () => {
    // The app's standing rule for an unmeasurable value, applied to an action
    // that does not exist.
    mockUseAttention.mockReturnValue({
      data: queue([
        item({
          kind: "session_stalled",
          session_id: null,
          project_id: null,
          project_name: null,
          pane_id: null,
          session_status: null,
        }),
      ]),
      isLoading: false,
    });
    const { container } = renderPage();
    expect(container.querySelectorAll("button.dk-btn").length).toBe(0);
    const dash = container.querySelector(".dk-actions .note");
    expect(dash?.textContent).toBe("—");
    // ...and it says what is missing rather than just going quiet.
    expect(dash?.getAttribute("title")).toMatch(/session|ticket|project/i);
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
    const { container } = renderPage();
    const heads = Array.from(container.querySelectorAll("h2")).map((h) =>
      (h.textContent ?? "").trim(),
    );
    expect(heads[0]).toMatch(/^blocking/i);
    expect(heads[1]).toMatch(/^stalled/i);
    expect(heads[2]).toMatch(/^queued/i);
  });

  it("shows the seen count only once a condition has recurred", () => {
    // One row seen 40 times is the whole point of the dedup index; a row seen
    // once saying "seen 1×" would be noise on every item on the page.
    mockUseAttention.mockReturnValue({
      data: queue([item({ seen_count: 40 })]),
      isLoading: false,
    });
    const { container } = renderPage();
    expect(container.textContent).toContain("seen 40×");
    cleanup();

    mockUseAttention.mockReturnValue({
      data: queue([item({ seen_count: 1 })]),
      isLoading: false,
    });
    const second = renderPage();
    expect(second.container.textContent).not.toContain("seen 1×");
  });
});

describe("Needs You — jump to pane", () => {
  const live = () =>
    item({ pane_id: "pane-7", session_id: "s1", session_status: "active" });

  it("hydrates the store and focuses the leaf when a tab owns the pane", async () => {
    // A session from a previous app run is not in the store until the Sessions
    // page has mounted once, so the hydrate is load-bearing. Order matters
    // too: `setActiveTab` focuses the tab's first leaf, so the specific pane
    // has to be focused after it.
    storeTabs.value = [
      { id: "tab-1", layout: { type: "leaf", terminalId: "pane-7" } },
    ];
    mockUseAttention.mockReturnValue({ data: queue([live()]), isLoading: false });
    renderPage();
    fireEvent.click(screen.getByText(/^jump to pane$/i));

    expect(mockNavigate).toHaveBeenCalledWith("/terminal");
    await waitFor(() => expect(mockSetFocusedLeaf).toHaveBeenCalledWith("pane-7"));
    expect(mockHydrate).toHaveBeenCalled();
    expect(mockSetActiveTab).toHaveBeenCalledWith("tab-1");
    expect(mockOpenTerminalsWindow).not.toHaveBeenCalled();
  });

  it("raises the detached window when the pane is live but unowned", async () => {
    // The detached terminals window has its own store in its own JS context;
    // `focus-pane` is the only way in.
    mockListLivePanes.mockImplementation(() => Promise.resolve(["pane-7"]));
    mockUseAttention.mockReturnValue({ data: queue([live()]), isLoading: false });
    renderPage();
    fireEvent.click(screen.getByText(/^jump to pane$/i));

    await waitFor(() => expect(mockEmitFocusPane).toHaveBeenCalledWith("pane-7"));
    expect(mockOpenTerminalsWindow).toHaveBeenCalled();
    expect(mockSetFocusedLeaf).not.toHaveBeenCalled();
  });

  it("falls back to the session's record when the pane is gone", async () => {
    // This was the silent failure: no tab owned it, so the page raised the
    // detached window and emitted at a pane that no longer existed. The shell
    // is the only authority on whether a pane is alive, so it decides.
    mockListLivePanes.mockImplementation(() => Promise.resolve(["pane-other"]));
    mockUseAttention.mockReturnValue({ data: queue([live()]), isLoading: false });
    renderPage();
    fireEvent.click(screen.getByText(/^jump to pane$/i));

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith("/sessions/s1"),
    );
    expect(mockOpenTerminalsWindow).not.toHaveBeenCalled();
    expect(mockEmitFocusPane).not.toHaveBeenCalled();
  });
});

describe("Needs You — state tabs", () => {
  it("asks the sidecar for the selected state", () => {
    mockUseAttention.mockReturnValue({ data: queue([]), isLoading: false });
    renderPage();
    expect(mockUseAttention).toHaveBeenLastCalledWith("open");

    fireEvent.click(screen.getByText(/^muted$/i));
    expect(mockUseAttention).toHaveBeenLastCalledWith("muted");
    expect(screen.getByText("No muted items")).toBeTruthy();
  });
});
