/**
 * Agents page — the list is the catalog, and what is *not* linked says so.
 *
 * The regression these pin: three projects each shipping a `code-reviewer` used
 * to render three rows all called "Code reviewer" under Shared, of which the
 * workspace linked one. The page now renders the catalog, so a row is a file
 * `.claude/` really links, under the token the CLI really resolves.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TeamPage } from "../team";
import type {
  ConfiguredAgentsResult,
  InvocableItem,
  InvocablesCatalog,
  ShadowedInvocable,
  WorkspaceHealthData,
} from "../../lib/api";
import type { ReactNode } from "react";

const {
  mockUseInvocables,
  mockUseConfiguredAgents,
  mockUseWorkspaceHealth,
  mockUseAgentRuns,
  mockRegenerate,
} = vi.hoisted(() => ({
  mockUseInvocables: vi.fn(),
  mockUseConfiguredAgents: vi.fn(),
  mockUseWorkspaceHealth: vi.fn(),
  mockUseAgentRuns: vi.fn(),
  mockRegenerate: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  useInvocables: (...args: unknown[]) => mockUseInvocables(...args),
  useConfiguredAgents: () => mockUseConfiguredAgents(),
  useWorkspaceHealth: () => mockUseWorkspaceHealth(),
  useAgentRuns: (...args: unknown[]) => mockUseAgentRuns(...args),
  useRegenerateWorkspace: () => ({
    mutate: mockRegenerate,
    isPending: false,
  }),
}));

vi.mock("../../components/layout/shell", () => ({
  Shell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function agent(overrides: Partial<InvocableItem> = {}): InvocableItem {
  return {
    kind: "project",
    name: "code-reviewer",
    alias: "code-reviewer",
    invoke_token: "@agent-code-reviewer",
    display_name: null,
    description: "Reviews the current branch.",
    model: null,
    project_id: 1,
    project_name: "codenest-app",
    canonical_path: "/p/.claude/agents/code-reviewer.md",
    link_path: "/ws/.claude/agents/code-reviewer.md",
    verify_status: "ok",
    shared: true,
    materialized: false,
    ...overrides,
  };
}

function aliased(project: string, projectId: number): InvocableItem {
  return agent({
    name: `${project}--code-reviewer`,
    alias: `${project}:code-reviewer`,
    invoke_token: `@agent-${project}--code-reviewer`,
    project_id: projectId,
    project_name: project,
    materialized: true,
  });
}

function catalog(overrides: Partial<InvocablesCatalog> = {}): InvocablesCatalog {
  return {
    scope: "workspace",
    cwd: null,
    project_id: null,
    project_name: null,
    agents: [],
    skills: [],
    commands: [],
    shadowed: [],
    ...overrides,
  };
}

const NO_PROJECTS: ConfiguredAgentsResult = {
  shared: [],
  shared_skills: [],
  by_project: [],
};

const HEALTHY: WorkspaceHealthData = {
  issues: [],
  issue_count: 0,
  agent_name_conflicts: [],
  conflict_count: 0,
};

function conflict(
  overrides: Partial<ShadowedInvocable> = {},
): ShadowedInvocable {
  return {
    name: "code-reviewer",
    kind: "project_agent",
    project: "miragold",
    canonical_path: "/m/.claude/agents/code-reviewer.md",
    shadowed_by: "codenest-app",
    shadowed_by_kind: "project_agent",
    row_id: 77,
    ...overrides,
  };
}

function setup(opts: {
  catalog?: InvocablesCatalog;
  configured?: ConfiguredAgentsResult;
  health?: WorkspaceHealthData;
}): void {
  mockUseInvocables.mockReturnValue({
    data: opts.catalog ?? catalog(),
    isLoading: false,
    isError: false,
  });
  mockUseConfiguredAgents.mockReturnValue({
    data: opts.configured ?? NO_PROJECTS,
    isLoading: false,
    isError: false,
  });
  mockUseWorkspaceHealth.mockReturnValue({ data: opts.health ?? HEALTHY });
  mockUseAgentRuns.mockReturnValue({ data: [] });

  render(
    <MemoryRouter>
      <TeamPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Agents page — workspace list", () => {
  it("renders one row per invocable, with the alias and the resolved token", () => {
    setup({
      catalog: catalog({
        agents: [
          aliased("codenest-app", 1),
          aliased("miragold", 2),
          aliased("networa", 3),
        ],
      }),
    });

    // Three claimants to one name, three distinct rows — not three "Code reviewer".
    expect(screen.getByText("codenest-app:code-reviewer")).toBeTruthy();
    expect(screen.getByText("miragold:code-reviewer")).toBeTruthy();
    expect(screen.getByText("networa:code-reviewer")).toBeTruthy();
    expect(screen.queryByText("Code reviewer")).toBeNull();

    // The token is the truth: what `.claude/` links each one under.
    expect(screen.getByText("@agent-codenest-app--code-reviewer")).toBeTruthy();
    expect(screen.getByText("@agent-networa--code-reviewer")).toBeTruthy();

    // Origin is on the row, once per claimant.
    expect(screen.getAllByText("miragold").length).toBe(1);
  });

  it("shows skills and commands alongside agents", () => {
    setup({
      catalog: catalog({
        agents: [agent()],
        skills: [
          agent({
            kind: "builtin",
            name: "projects",
            alias: "projects",
            invoke_token: "/projects",
            project_id: null,
            project_name: null,
          }),
        ],
        commands: [
          agent({
            name: "ship",
            alias: "codenest-app:ship",
            invoke_token: "/ship",
          }),
        ],
      }),
    });

    expect(screen.getByText("Agents")).toBeTruthy();
    expect(screen.getByText("Skills")).toBeTruthy();
    expect(screen.getByText("Commands")).toBeTruthy();
    expect(screen.getByText("/projects")).toBeTruthy();
    expect(screen.getByText("built-in")).toBeTruthy();
    expect(screen.getByText("/ship")).toBeTruthy();
  });

  it("marks a linked entry whose target has moved as broken", () => {
    setup({
      catalog: catalog({
        agents: [agent({ verify_status: "missing_target" })],
      }),
    });

    expect(screen.getByText("missing_target")).toBeTruthy();
  });

  it("marks a materialized entry as a copy", () => {
    setup({ catalog: catalog({ agents: [aliased("codenest-app", 1)] }) });
    expect(screen.getByText("copy")).toBeTruthy();
  });
});

describe("Agents page — name conflicts", () => {
  it("says so when an agent could not be linked, and can regenerate", () => {
    setup({
      catalog: catalog({ agents: [agent()] }),
      health: {
        ...HEALTHY,
        agent_name_conflicts: [conflict()],
        conflict_count: 1,
      },
    });

    expect(
      screen.getByText("1 agent is not linked into the workspace"),
    ).toBeTruthy();

    const btn = screen.getByRole("button", { name: "Regenerate links" });
    fireEvent.click(btn);
    expect(mockRegenerate).toHaveBeenCalledTimes(1);
  });

  it("renders no warning chrome when nothing conflicts", () => {
    setup({ catalog: catalog({ agents: [agent()] }) });

    expect(screen.queryByRole("button", { name: "Regenerate links" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not call a conflicting project agent shared", () => {
    setup({
      catalog: catalog({ agents: [agent()] }),
      configured: {
        shared: [],
        shared_skills: [],
        by_project: [
          {
            project_id: 2,
            project_name: "miragold",
            agents: [
              {
                id: 77,
                name: "code-reviewer",
                display_name: null,
                description: null,
                model: null,
                verify_status: "ok",
                kind: "project",
                // enabled=1 in the DB — asked to be shared, and still dropped.
                is_shared: true,
              },
            ],
            skills: [],
          },
        ],
      },
      health: {
        ...HEALTHY,
        agent_name_conflicts: [conflict({ row_id: 77 })],
        conflict_count: 1,
      },
    });

    expect(screen.getByText("not linked")).toBeTruthy();
    expect(screen.queryByText("shared")).toBeNull();
  });
});
