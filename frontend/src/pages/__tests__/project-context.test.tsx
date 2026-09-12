import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ProjectContextPage } from "../project-context";
import type { ProjectContextReport } from "../../lib/api";

const { mockUseProjectContext } = vi.hoisted(() => ({
  mockUseProjectContext: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  useProjectContext: () => mockUseProjectContext(),
}));

vi.mock("../../components/layout/shell", () => ({
  Shell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function report(over: Partial<ProjectContextReport> = {}) {
  return {
    project: {
      id: 3,
      name: "codenest",
      status: "active",
      path: "/Users/test/work/codenest",
      root_path: "/Users/test/work/codenest",
      provider_name: null,
      profile_name: null,
    },
    roots: [
      {
        id: 1,
        path: "/Users/test/work",
        label: null,
        source: "manual",
        enabled: true,
      },
    ],
    sessions: [
      {
        session_id: "aaaaaaaa-1111",
        profile: "default",
        status: "ended",
        started_at: "2026-09-12T10:00:00",
        ended_at: "2026-09-12T11:00:00",
        cwd: "/Users/test/work/other",
        session_project_name: "other",
        attributed_by: "span",
        spans: 2,
        seconds_here: 900,
        open_span: false,
        first_here_at: "2026-09-12T10:05:00",
        last_here_at: "2026-09-12T10:20:00",
        directories: ["/Users/test/work/codenest"],
        estimated_cost_usd: 0.75,
        lane_b_session_cost_usd: null,
      },
      {
        session_id: "bbbbbbbb-2222",
        profile: "default",
        status: "ended",
        started_at: "2026-09-11T09:00:00",
        ended_at: "2026-09-11T09:30:00",
        cwd: "/Users/test/work/codenest",
        session_project_name: "codenest",
        attributed_by: "session",
        spans: 0,
        seconds_here: null,
        open_span: false,
        first_here_at: "2026-09-11T09:00:00",
        last_here_at: "2026-09-11T09:30:00",
        directories: ["/Users/test/work/codenest"],
        estimated_cost_usd: null,
        lane_b_session_cost_usd: null,
      },
    ],
    sessions_truncated: false,
    cost: {
      lane: "A",
      estimate_usd: 0.75,
      estimate_tokens_in: 1200,
      estimate_tokens_out: 340,
      estimated_sessions: 1,
      lane_b_sessions: 0,
      lane_b_whole_session_usd: null,
    },
    agents_ran: [
      { name: "code-reviewer", runs: 3, last_run_at: "2026-09-12T10:15:00" },
    ],
    skills_ran: [],
    configured: {
      agents: [],
      skills: [
        {
          name: "dataviz",
          enabled: true,
          verify_status: "ok",
          link_path: "/Users/test/work/codenest/.claude/skills/dataviz",
        },
      ],
      commands: [],
      mcp_servers: [],
      launch_presets: [],
    },
    attention: [],
    ...over,
  } as unknown as ProjectContextReport;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/3/context"]}>
      <Routes>
        <Route
          path="/projects/:projectId/context"
          element={<ProjectContextPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function show(over: Partial<ProjectContextReport> = {}) {
  mockUseProjectContext.mockReturnValue({
    data: report(over),
    isPending: false,
    isError: false,
  });
  renderPage();
}

describe("the project context map", () => {
  it("labels the per-project cost as the hook-lane estimate, not a vendor price", () => {
    show();
    expect(screen.getAllByText("$0.7500").length).toBe(2);
    expect(document.body.textContent).toContain("Lane A estimate");
    expect(document.body.textContent).toContain("not a billed amount");
  });

  it("shows an unexported vendor figure as not observed rather than zero", () => {
    show();
    expect(document.body.textContent).toContain("That is silence, not zero");
    expect(screen.getAllByText("not observed").length).toBeGreaterThan(0);
  });

  it("separates a session placed here by a span from one placed by its session row", () => {
    show();
    expect(screen.getByText("span")).toBeTruthy();
    expect(screen.getByText("session")).toBeTruthy();
    expect(document.body.textContent).toContain("session opened in other");
    expect(document.body.textContent).toContain("never changed directory");
  });

  it("says a skill was never observed running rather than showing an empty table", () => {
    show();
    expect(document.body.textContent).toContain(
      "No skill invocation has been observed in this repo",
    );
    expect(screen.getByText("code-reviewer")).toBeTruthy();
  });

  it("explains a repo that sits under no root", () => {
    show({ roots: [] });
    expect(document.body.textContent).toContain("No root parents this repo");
  });
});
