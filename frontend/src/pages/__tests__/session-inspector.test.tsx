import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionInspectorPage } from "../session-inspector";
import type { SessionInspectorReport } from "../../lib/api";

const { mockUseSessionInspector } = vi.hoisted(() => ({
  mockUseSessionInspector: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  useSessionInspector: () => mockUseSessionInspector(),
}));

vi.mock("../../components/layout/shell", () => ({
  Shell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function report(over: Partial<SessionInspectorReport> = {}) {
  return {
    session: {
      session_id: "s1",
      profile: "default",
      status: "ended",
      project_name: "codenest",
      cwd: "/Users/test/codenest",
      started_at: "2026-09-12T10:00:00",
      ended_at: "2026-09-12T10:30:00",
      total_tool_calls: 12,
    },
    lanes: [
      { lane: "A", label: "Hooks", observed: true, evidence: "40 hook events", fields_won: 3 },
      {
        lane: "B",
        label: "OTLP telemetry",
        observed: false,
        evidence: "nothing exported — telemetry is opt-in and off for this session",
        fields_won: 0,
      },
      {
        lane: "C",
        label: "Transcript scan",
        observed: false,
        evidence: "transcript not scanned (file gone, or scan not run)",
        fields_won: 0,
      },
    ],
    fields: [
      {
        field: "cost_usd",
        group: "money",
        value: 4.25,
        state: "claimed",
        winning_lane: "B",
        lanes_allowed: ["B", "C", "A"],
        claims: [
          { lane: "A", value_text: "1.1", claimed_at: "2026-09-12 10:29:00" },
          { lane: "B", value_text: "4.25", claimed_at: "2026-09-12 10:41:00" },
        ],
      },
      {
        field: "context_tokens",
        group: "money",
        value: 0,
        state: "unobserved",
        winning_lane: null,
        lanes_allowed: ["B", "C", "A"],
        claims: [],
      },
    ],
    spans: [],
    attention: [],
    operations: [],
    events: [],
    event_counts: [],
    events_truncated: false,
    ...over,
  } as unknown as SessionInspectorReport;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/sessions/s1"]}>
      <Routes>
        <Route path="/sessions/:sessionId" element={<SessionInspectorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("the session inspector", () => {
  it("names the lane that owns a figure and what the other lane had said", () => {
    mockUseSessionInspector.mockReturnValue({
      data: report(),
      isPending: false,
      isError: false,
    });
    renderPage();

    expect(screen.getByText("$4.2500")).toBeTruthy();
    expect(screen.getByText("said 1.1")).toBeTruthy();
    expect(screen.getByText("said 4.25")).toBeTruthy();
  });

  it("shows an unmeasured field as unobserved rather than as zero", () => {
    mockUseSessionInspector.mockReturnValue({
      data: report(),
      isPending: false,
      isError: false,
    });
    renderPage();
    expect(screen.getByText("not observed")).toBeTruthy();
  });

  it("explains a missing telemetry lane instead of showing an empty table", () => {
    mockUseSessionInspector.mockReturnValue({
      data: report(),
      isPending: false,
      isError: false,
    });
    renderPage();
    expect(document.body.textContent).toContain("nothing is broken");
    expect(document.body.textContent).toContain("opt-in");
  });

  it("attributes a session that never changed directory to its one project", () => {
    mockUseSessionInspector.mockReturnValue({
      data: report(),
      isPending: false,
      isError: false,
    });
    renderPage();
    expect(document.body.textContent).toContain(
      "No directory change was ever observed",
    );
  });
});
