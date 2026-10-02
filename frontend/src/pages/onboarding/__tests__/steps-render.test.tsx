/**
 * The informational steps (01, 04, 07) carry no validation of their own, so
 * what has to hold is narrower but still invisible in review: each one renders,
 * registers a commit that resolves so Continue is never wedged, and shows the
 * numbers the summary claims to show.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const api = {
  workspace: { data: undefined as { root_path: string } | undefined },
  projects: { data: [] as Record<string, unknown>[] },
  hookStatus: { data: { connected: false } as { connected: boolean } },
  providers: { data: [] as { display_name: string }[] },
  orgAgents: { data: [] as { id: number; name: string }[] },
};

vi.mock("../../../lib/api", () => ({
  useWorkspace: () => api.workspace,
  useWorkspaceProjects: () => api.projects,
  useHookStatus: () => api.hookStatus,
  useProviders: () => api.providers,
  useOrgAgents: () => api.orgAgents,
}));

vi.mock("../../../components/project-agents-panel", () => ({
  ProjectAgents: ({ projectId }: { projectId: number }) => (
    <div>agents-panel:{projectId}</div>
  ),
  ProjectSkills: ({ projectId }: { projectId: number }) => (
    <div>skills-panel:{projectId}</div>
  ),
}));

const { WelcomeStep } = await import("../welcome-step");
const { DoneStep } = await import("../done-step");
const { AgentsReviewStep } = await import("../agents-review-step");

function capture(): { fn: () => Promise<void> } {
  return { fn: async () => undefined };
}

beforeEach(() => {
  api.workspace = { data: undefined };
  api.projects = { data: [] };
  api.hookStatus = { data: { connected: false } };
  api.providers = { data: [] };
  api.orgAgents = { data: [] };
});

afterEach(() => {
  cleanup();
});

describe("WelcomeStep", () => {
  it("registers a commit that resolves, so Continue is never wedged", async () => {
    const ref = capture();
    render(<WelcomeStep registerCommit={(f) => (ref.fn = f)} />);
    await expect(ref.fn()).resolves.toBeUndefined();
  });

  it("explains both session modes", () => {
    render(<WelcomeStep registerCommit={() => undefined} />);
    expect(screen.getByText(/Workspace session/)).toBeTruthy();
    expect(screen.getByText(/Project session/)).toBeTruthy();
    expect(screen.getByText(/read-only sources/)).toBeTruthy();
  });
});

describe("DoneStep", () => {
  it("registers a commit that resolves", async () => {
    const ref = capture();
    render(<DoneStep registerCommit={(f) => (ref.fn = f)} />);
    await expect(ref.fn()).resolves.toBeUndefined();
  });

  it("summarises an empty workspace without claiming anything was set up", () => {
    render(<DoneStep registerCommit={() => undefined} />);
    expect(screen.getByText("No provider")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("Projects imported")).toBeTruthy();
  });

  it("counts projects, promoted agents and the provider", () => {
    api.projects = {
      data: [
        { id: 1, name: "alpha", enabled_count: 2, agent_count: 5 },
        { id: 2, name: "beta", enabled_count: 1, agent_count: 3 },
      ],
    };
    api.providers = { data: [{ display_name: "Anthropic" }] };
    api.hookStatus = { data: { connected: true } };
    render(<DoneStep registerCommit={() => undefined} />);

    expect(screen.getByText("2")).toBeTruthy(); // projects imported
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy(); // 2 + 1 promoted
    expect(screen.getByText("/ 8")).toBeTruthy(); // 5 + 3 detected
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("pluralises the provider count", () => {
    api.providers = {
      data: [{ display_name: "Anthropic" }, { display_name: "Alt" }],
    };
    render(<DoneStep registerCommit={() => undefined} />);
    expect(screen.getByText("2 providers")).toBeTruthy();
  });
});

describe("AgentsReviewStep", () => {
  it("registers a commit that resolves — promotions are saved inline", async () => {
    const ref = capture();
    render(<AgentsReviewStep registerCommit={(f) => (ref.fn = f)} />);
    await expect(ref.fn()).resolves.toBeUndefined();
  });

  it("tells the user to import first when no project has been imported", () => {
    render(<AgentsReviewStep registerCommit={() => undefined} />);
    expect(screen.getByText(/Import projects first \(Step 02\)/)).toBeTruthy();
  });

  it("renders the agents and skills panel per imported project", () => {
    api.projects = {
      data: [
        { id: 7, name: "alpha", enabled_count: 1, agent_count: 4 },
        { id: 9, name: "beta", enabled_count: 0, agent_count: 2 },
      ],
    };
    render(<AgentsReviewStep registerCommit={() => undefined} />);
    expect(screen.getByText("agents-panel:7")).toBeTruthy();
    expect(screen.getByText("skills-panel:7")).toBeTruthy();
    expect(screen.getByText("agents-panel:9")).toBeTruthy();
    expect(screen.getByText("1/4 agents in workspace")).toBeTruthy();
    expect(screen.getByText("0/2 agents in workspace")).toBeTruthy();
  });

  it("lists org agents as already workspace-wide", () => {
    api.orgAgents = {
      data: [
        { id: 1, name: "atlas-recruiter" },
        { id: 2, name: "orion-ops" },
      ],
    };
    render(<AgentsReviewStep registerCommit={() => undefined} />);
    expect(screen.getByText("atlas-recruiter")).toBeTruthy();
    expect(screen.getByText("orion-ops")).toBeTruthy();
    expect(screen.getAllByText("shared · workspace")).toHaveLength(2);
  });
});
