import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TasksPage } from "../tasks";
import type { LookupsOut, Project, Task, TeamMember, Taxonomy } from "../../lib/api";
import type { ReactNode } from "react";

const {
  mockUseTasks,
  mockUseProjects,
  mockUseTeamMembers,
  mockUseLookups,
  mockUseTaxonomy,
  mockUseAgentRuns,
  mockChangeTaskStatus,
  mockUpdateTask,
  mockSetBoardWipLimit,
  mockAddTaskLabel,
  mockRemoveTaskLabel,
  mockCreateTask,
  mockSetTaskLabels,
  mockToastError,
} = vi.hoisted(() => ({
  mockUseTasks: vi.fn(),
  mockUseProjects: vi.fn(),
  mockUseTeamMembers: vi.fn(),
  mockUseLookups: vi.fn(),
  mockUseTaxonomy: vi.fn(),
  mockUseAgentRuns: vi.fn(),
  mockChangeTaskStatus: vi.fn(),
  mockUpdateTask: vi.fn(),
  mockSetBoardWipLimit: vi.fn(),
  mockAddTaskLabel: vi.fn(),
  mockRemoveTaskLabel: vi.fn(),
  mockCreateTask: vi.fn(),
  mockSetTaskLabels: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  useTasks: (...args: unknown[]) => mockUseTasks(...args),
  useProjects: () => mockUseProjects(),
  useTeamMembers: () => mockUseTeamMembers(),
  useLookups: () => mockUseLookups(),
  useTaxonomy: (...args: unknown[]) => mockUseTaxonomy(...args),
  useAgentRuns: (...args: unknown[]) => mockUseAgentRuns(...args),
  changeTaskStatus: (...args: unknown[]) => mockChangeTaskStatus(...args),
  updateTask: (...args: unknown[]) => mockUpdateTask(...args),
  setBoardWipLimit: (...args: unknown[]) => mockSetBoardWipLimit(...args),
  addTaskLabel: (...args: unknown[]) => mockAddTaskLabel(...args),
  removeTaskLabel: (...args: unknown[]) => mockRemoveTaskLabel(...args),
  createTask: (...args: unknown[]) => mockCreateTask(...args),
  setTaskLabels: (...args: unknown[]) => mockSetTaskLabels(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: mockToastError, success: vi.fn() },
}));

vi.mock("../../components/deck/deck-shell", () => ({
  DeckShell: ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
    <div>
      <div>{actions}</div>
      {children}
    </div>
  ),
}));

vi.mock("../../components/launch/launch-from-source-button", () => ({
  LaunchFromSourceButton: () => null,
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "Task One",
    description: null,
    status: "todo",
    priority: "medium",
    effort: null,
    assignee_id: null,
    assignee_name: null,
    project_id: 1,
    project_name: "Alpha",
    started_date: null,
    completed_date: null,
    created_at: "2026-08-08T00:00:00",
    updated_at: "2026-08-08T00:00:00",
    ...overrides,
  };
}

const PROJECTS: Project[] = [
  {
    id: 1,
    name: "Alpha",
    description: null,
    tech_stack: null,
    status: "active",
    path: null,
    root_path: null,
    is_workspace: 0,
    is_active: 1,
    default_provider_id: null,
    profile_id: null,
    created_at: "2026-01-01T00:00:00",
  },
];

const MEMBERS: TeamMember[] = [
  {
    id: 1,
    name: "Ada",
    role: "eng",
    type: "human",
    subtype: null,
    department: null,
    status: "active",
    agent_file: null,
    joined_date: null,
    notes: null,
  },
];

const LABEL_TAXONOMY: Taxonomy[] = [
  {
    id: 7,
    kind: "task_label",
    slug: "bug",
    display_name: "Bug",
    sort_order: 10,
    color: "#ef4444",
    is_default: false,
    is_active: true,
  },
];

// Deliberately different labels than FALLBACK_TASK_STATUSES, so a test
// asserting on these strings proves the columns came from the taxonomy
// mock, not the client-side fallback.
const CUSTOM_STATUSES: LookupsOut["workflow_task_statuses"] = [
  { slug: "backlog", label: "Icebox", color: "#111111", sort_order: 10 },
  { slug: "todo", label: "Ready", color: "#222222", sort_order: 20 },
  { slug: "in-progress", label: "Doing", color: "#333333", sort_order: 30 },
  { slug: "blocked", label: "Stuck", color: "#444444", sort_order: 40 },
  { slug: "done", label: "Shipped", color: "#555555", sort_order: 50 },
];

const PRIORITIES: LookupsOut["workflow_task_priorities"] = [
  { slug: "high", label: "High", color: "#ef4444", sort_order: 10 },
  { slug: "medium", label: "Medium", color: "#f59e0b", sort_order: 20 },
  { slug: "low", label: "Low", color: "#22c55e", sort_order: 30 },
];

function makeLookups(overrides: Partial<LookupsOut> = {}): LookupsOut {
  return {
    statuses: ["backlog", "todo", "in-progress", "blocked", "done"],
    status_colors: {
      backlog: "#111111",
      todo: "#222222",
      "in-progress": "#333333",
      blocked: "#444444",
      done: "#555555",
    },
    workflow_task_statuses: CUSTOM_STATUSES,
    workflow_task_priorities: PRIORITIES,
    workflow_inbox_statuses: [],
    document_categories: [],
    document_category_colors: {},
    board_wip_limits: {},
    profiles: [],
    wizard_completed: true,
    enabled_features: {},
    user_display_name: "Operator",
    user_role: "Owner",
    ...overrides,
  };
}

function setupMocks(
  opts: {
    tasks?: Task[];
    lookups?: LookupsOut | undefined;
  } = {},
): void {
  mockUseTasks.mockReturnValue({ data: opts.tasks ?? [makeTask()] });
  mockUseProjects.mockReturnValue({ data: PROJECTS });
  mockUseTeamMembers.mockReturnValue({ data: MEMBERS });
  mockUseLookups.mockReturnValue({
    data: "lookups" in opts ? opts.lookups : makeLookups(),
  });
  mockUseTaxonomy.mockReturnValue({ data: LABEL_TAXONOMY });
  mockUseAgentRuns.mockReturnValue({ data: [] });
}

function renderPage(
  initialEntries: string[] = ["/tasks"],
  qc: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <TasksPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});


/** A DeckGroup heading is chevron + label + count spans; the label is the second. */
function groupLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll("h2")].map((h) => {
    const spans = h.querySelectorAll("span");
    return (spans[1]?.textContent ?? "").trim();
  });
}

describe("TasksPage — work board", () => {
  it("N opens the composer", () => {
    setupMocks();
    renderPage();
    fireEvent.keyDown(window, { key: "n" });
    screen.getByPlaceholderText("What needs doing?");
  });

  // The filter row is selects now, so the nearest real text input is the
  // composer's own. The guard being tested is the same one: N must not act
  // while focus is in a field.
  it("N typed into a text input does not reopen the composer", () => {
    setupMocks();
    renderPage();
    fireEvent.keyDown(window, { key: "n" });
    const title = screen.getByPlaceholderText("What needs doing?");
    fireEvent.keyDown(title, { key: "n" });
    expect(screen.getAllByPlaceholderText("What needs doing?")).toHaveLength(1);
  });

  it("Cmd+N does not open the composer", () => {
    setupMocks();
    renderPage();
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    expect(screen.queryByPlaceholderText("What needs doing?")).toBeNull();
  });

  // #292 replaced the kanban with status groups on one list. One group per
  // active status, in the taxonomy's order — the same contract the columns had.
  it("renders one group per active task status, using its label", () => {
    setupMocks({
      tasks: ["backlog", "todo", "in-progress", "blocked", "done"].map((status, i) =>
        makeTask({ id: i + 1, status }),
      ),
    });
    const { container } = renderPage();
    expect(groupLabels(container)).toEqual(["icebox", "ready", "doing", "stuck", "shipped"]);
  });

  it("falls back to five groups when lookups have not resolved", () => {
    setupMocks({
      lookups: undefined,
      tasks: ["backlog", "todo", "in-progress", "blocked", "done"].map((status, i) =>
        makeTask({ id: i + 1, status }),
      ),
    });
    const { container } = renderPage();
    expect(groupLabels(container)).toEqual(["idea", "to do", "in progress", "blocked", "done"]);
  });

  // A status deactivated while tasks still carry it must not make those tasks
  // vanish from the board — they fall into the first group, as they did into
  // the first column.
  it("buckets a task whose status is not a group into the first group", () => {
    setupMocks({ tasks: [makeTask({ id: 99, status: "no-such-status" })] });
    const { container } = renderPage();
    expect(screen.getByText("#99")).toBeTruthy();
    expect(groupLabels(container)[0]).toBe("icebox");
  });

  it("the label filter narrows the board client-side", () => {
    setupMocks({
      tasks: [
        makeTask({ id: 1, status: "todo" }),
        makeTask({
          id: 2,
          status: "todo",
          labels: [{ id: 7, slug: "bug", label: "Bug", color: "#ef4444", sort_order: 10 }],
        }),
        makeTask({ id: 3, status: "todo" }),
      ],
    });
    const { container } = renderPage(["/tasks?label=7"]);
    expect(container.querySelectorAll(".dk-line").length).toBe(1);
  });

  it("a failed status change surfaces a toast", async () => {
    setupMocks({ tasks: [makeTask({ id: 5, status: "todo" })] });
    mockChangeTaskStatus.mockRejectedValueOnce(new Error("boom"));
    renderPage();
    fireEvent.change(screen.getByLabelText("Status of task 5"), {
      target: { value: "in-progress" },
    });
    await waitFor(() => expect(mockChangeTaskStatus).toHaveBeenCalledWith(5, "in-progress"));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
  });


  // The kanban forbade selects because a card moved by dragging. A line cannot
  // be dragged, so the select is how a task moves — one per row, deliberately.
  it("gives each line an inline status select", () => {
    setupMocks({ tasks: [makeTask({ id: 5, status: "todo" })] });
    renderPage();
    const sel = screen.getByLabelText("Status of task 5") as HTMLSelectElement;
    expect(sel.tagName).toBe("SELECT");
    expect(sel.value).toBe("todo");
  });

});
