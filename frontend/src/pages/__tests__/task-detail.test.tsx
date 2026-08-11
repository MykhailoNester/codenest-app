import type { ReactNode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TaskDetailPage } from "../task-detail";
import type {
  ActivityEntry,
  AgentRun,
  LookupsOut,
  Project,
  Task,
  Taxonomy,
  TeamMember,
} from "../../lib/api";

const {
  mockUseTask,
  mockUseTeamMembers,
  mockUseProjects,
  mockUseTasks,
  mockUseLookups,
  mockUseTaxonomy,
  mockUseTaskActivity,
  mockUseTaskRuns,
  mockUseSessionReplay,
  mockUseProfiles,
  mockUpdateTask,
  mockChangeTaskStatus,
  mockDeleteTask,
  mockAddTaskBlocker,
  mockRemoveTaskBlocker,
  mockAddTaskLabel,
  mockRemoveTaskLabel,
  mockToastError,
  mockToastSuccess,
} = vi.hoisted(() => ({
  mockUseTask: vi.fn(),
  mockUseTeamMembers: vi.fn(),
  mockUseProjects: vi.fn(),
  mockUseTasks: vi.fn(),
  mockUseLookups: vi.fn(),
  mockUseTaxonomy: vi.fn(),
  mockUseTaskActivity: vi.fn(),
  mockUseTaskRuns: vi.fn(),
  mockUseSessionReplay: vi.fn(),
  mockUseProfiles: vi.fn(),
  mockUpdateTask: vi.fn(),
  mockChangeTaskStatus: vi.fn(),
  mockDeleteTask: vi.fn(),
  mockAddTaskBlocker: vi.fn(),
  mockRemoveTaskBlocker: vi.fn(),
  mockAddTaskLabel: vi.fn(),
  mockRemoveTaskLabel: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  useTask: (...args: unknown[]) => mockUseTask(...args),
  useTeamMembers: () => mockUseTeamMembers(),
  useProjects: () => mockUseProjects(),
  useTasks: (...args: unknown[]) => mockUseTasks(...args),
  useLookups: () => mockUseLookups(),
  useTaxonomy: (...args: unknown[]) => mockUseTaxonomy(...args),
  useTaskActivity: (...args: unknown[]) => mockUseTaskActivity(...args),
  useTaskRuns: (...args: unknown[]) => mockUseTaskRuns(...args),
  useSessionReplay: (...args: unknown[]) => mockUseSessionReplay(...args),
  useProfiles: (...args: unknown[]) => mockUseProfiles(...args),
  updateTask: (...args: unknown[]) => mockUpdateTask(...args),
  changeTaskStatus: (...args: unknown[]) => mockChangeTaskStatus(...args),
  deleteTask: (...args: unknown[]) => mockDeleteTask(...args),
  addTaskBlocker: (...args: unknown[]) => mockAddTaskBlocker(...args),
  removeTaskBlocker: (...args: unknown[]) => mockRemoveTaskBlocker(...args),
  addTaskLabel: (...args: unknown[]) => mockAddTaskLabel(...args),
  removeTaskLabel: (...args: unknown[]) => mockRemoveTaskLabel(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: mockToastError, success: mockToastSuccess },
}));

vi.mock("../../components/layout/shell", () => ({
  Shell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// `LaunchFromSourceButton` calls `useLaunchSeed` unconditionally
// (`tasks-board.test.tsx` mocks it for the same reason).
vi.mock("../../components/launch/launch-from-source-button", () => ({
  LaunchFromSourceButton: () => null,
}));

// `AgentMarkdown` is rendered for real (it is already covered by its own
// test); its `openExternalUrl` import is mocked so nothing reaches Tauri.
vi.mock("../../lib/ipc", () => ({
  openExternalUrl: vi.fn(),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "Original title",
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
    blockers: [],
    labels: [],
    ...overrides,
  };
}

const MEMBERS: TeamMember[] = [
  {
    id: 1,
    name: "Ada",
    role: "Engineer",
    type: "human",
    subtype: null,
    department: null,
    status: "active",
    agent_file: null,
    joined_date: null,
    notes: null,
  },
];

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

const STATUS_VOCAB: LookupsOut["workflow_task_statuses"] = [
  { slug: "todo", label: "To do", color: "#60a5fa", sort_order: 20 },
  {
    slug: "in-progress",
    label: "In progress",
    color: "#f59e0b",
    sort_order: 30,
  },
];

const PRIORITY_VOCAB: LookupsOut["workflow_task_priorities"] = [
  { slug: "high", label: "High", color: "#ef4444", sort_order: 10 },
  { slug: "medium", label: "Medium", color: "#f59e0b", sort_order: 20 },
  { slug: "low", label: "Low", color: "#22c55e", sort_order: 30 },
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

function makeLookups(overrides: Partial<LookupsOut> = {}): LookupsOut {
  return {
    statuses: ["todo", "in-progress"],
    status_colors: { todo: "#60a5fa", "in-progress": "#f59e0b" },
    workflow_task_statuses: STATUS_VOCAB,
    workflow_task_priorities: PRIORITY_VOCAB,
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
    task?: Task;
    tasks?: Task[];
    lookups?: LookupsOut;
    members?: TeamMember[];
    projects?: Project[];
    labelTaxonomy?: Taxonomy[];
    activity?: ActivityEntry[];
    runs?: AgentRun[];
  } = {},
): Task {
  const task = opts.task ?? makeTask();
  mockUseTask.mockReturnValue({
    data: task,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  mockUseTeamMembers.mockReturnValue({ data: opts.members ?? MEMBERS });
  mockUseProjects.mockReturnValue({ data: opts.projects ?? PROJECTS });
  mockUseTasks.mockReturnValue({ data: opts.tasks ?? [task] });
  mockUseLookups.mockReturnValue({ data: opts.lookups ?? makeLookups() });
  mockUseTaxonomy.mockReturnValue({
    data: opts.labelTaxonomy ?? LABEL_TAXONOMY,
  });
  mockUseTaskActivity.mockReturnValue({
    data: opts.activity ?? [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mockUseTaskRuns.mockReturnValue({
    data: opts.runs ?? [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mockUseSessionReplay.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  });
  mockUseProfiles.mockReturnValue({ data: [] });
  return task;
}

function renderPage(
  qc: QueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/tasks/1"]}>
        <Routes>
          <Route path="/tasks/:id" element={<TaskDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TaskDetailPage", () => {
  it("Enter commits the inline title edit", () => {
    setupMocks();
    const { container } = renderPage();
    fireEvent.click(screen.getByText("Original title"));
    const textarea = container.querySelector(
      ".td-title--edit",
    ) as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    fireEvent.change(textarea, { target: { value: "New title" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(mockUpdateTask).toHaveBeenCalledTimes(1);
    expect(mockUpdateTask).toHaveBeenCalledWith(1, { title: "New title" });
    expect(container.querySelector(".td-title--edit")).toBeNull();
  });

  it("blur commits the inline title edit", () => {
    setupMocks();
    const { container } = renderPage();
    fireEvent.click(screen.getByText("Original title"));
    const textarea = container.querySelector(
      ".td-title--edit",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Blurred title" } });
    fireEvent.blur(textarea);
    expect(mockUpdateTask).toHaveBeenCalledWith(1, { title: "Blurred title" });
  });

  it("Escape cancels the inline title edit", () => {
    setupMocks();
    const { container } = renderPage();
    fireEvent.click(screen.getByText("Original title"));
    const textarea = container.querySelector(
      ".td-title--edit",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Changed" } });
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(mockUpdateTask).not.toHaveBeenCalled();
    screen.getByText("Original title");
  });

  it("a blank title is not committed", () => {
    setupMocks();
    const { container } = renderPage();
    fireEvent.click(screen.getByText("Original title"));
    const textarea = container.querySelector(
      ".td-title--edit",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it("choosing a status writes through the status endpoint", () => {
    setupMocks();
    renderPage();
    fireEvent.click(screen.getByLabelText("Status: To do"));
    fireEvent.click(screen.getByRole("option", { name: "In progress" }));
    expect(mockChangeTaskStatus).toHaveBeenCalledWith(1, "in-progress");
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it("choosing an effort never sends a value the CHECK rejects", () => {
    setupMocks();
    renderPage();
    const openEffort = () =>
      fireEvent.click(screen.getByLabelText("Effort: —"));

    openEffort();
    fireEvent.click(screen.getByRole("option", { name: /None/ }));
    openEffort();
    fireEvent.click(screen.getByRole("option", { name: /Small/ }));
    openEffort();
    fireEvent.click(screen.getByRole("option", { name: /Medium/ }));
    openEffort();
    fireEvent.click(screen.getByRole("option", { name: /Large/ }));

    expect(mockUpdateTask.mock.calls.map((c) => c[1])).toEqual([
      { effort: null },
      { effort: "small" },
      { effort: "medium" },
      { effort: "large" },
    ]);
  });

  it("adding a label calls the label endpoint and keeps the menu open", () => {
    setupMocks();
    renderPage();
    fireEvent.click(screen.getByLabelText("Add label"));
    fireEvent.click(screen.getByRole("option", { name: "Bug" }));
    expect(mockAddTaskLabel).toHaveBeenCalledWith(1, 7);
    // Multi-select: the item is still there, the popover did not close.
    expect(screen.queryByRole("option", { name: "Bug" })).not.toBeNull();
  });

  it("clicking an already-assigned label calls the remove endpoint", () => {
    setupMocks({
      task: makeTask({
        labels: [
          {
            id: 7,
            slug: "bug",
            label: "Bug",
            color: "#ef4444",
            sort_order: 10,
          },
        ],
      }),
    });
    renderPage();
    fireEvent.click(screen.getByLabelText("Add label"));
    fireEvent.click(screen.getByRole("option", { name: "Bug" }));
    expect(mockRemoveTaskLabel).toHaveBeenCalledWith(1, 7);
  });

  it("the Saved indicator appears only after the write's refetch settles", async () => {
    setupMocks();
    const { container } = renderPage();

    let resolveUpdate: (() => void) | undefined;
    mockUpdateTask.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpdate = () => resolve({ ok: true });
        }),
    );

    fireEvent.click(screen.getByText("Original title"));
    const textarea = container.querySelector(
      ".td-title--edit",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "New title" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // "Saving…" (`.td-saved.td-dim`) is expected while the write is
    // in-flight; "✓ Saved" (`.td-saved` without `.td-dim`) is the assertion
    // that must wait for the write AND its refetch to settle.
    expect(screen.queryByText("✓ Saved")).toBeNull();

    resolveUpdate?.();
    await waitFor(() => screen.getByText("✓ Saved"));
  });

  it("a rejected write shows a toast and never shows Saved", async () => {
    setupMocks();
    mockUpdateTask.mockRejectedValueOnce(new Error("boom"));
    const { container } = renderPage();

    fireEvent.click(screen.getByText("Original title"));
    const textarea = container.querySelector(
      ".td-title--edit",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "New title" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(container.querySelector(".td-saved")).toBeNull();
  });

  it("blockers still add and remove", () => {
    setupMocks({
      task: makeTask({
        blockers: [
          {
            id: 10,
            blocking_task_id: 5,
            blocking_title: "Fix bug",
            blocking_status: "todo",
          },
        ],
      }),
      tasks: [
        makeTask({ id: 1 }),
        makeTask({ id: 2, title: "Other task" }),
        makeTask({ id: 5, title: "Fix bug" }),
      ],
    });
    renderPage();

    fireEvent.click(screen.getByText("+ Add"));
    fireEvent.click(screen.getByRole("option", { name: "#2 Other task" }));
    expect(mockAddTaskBlocker).toHaveBeenCalledWith(1, 2);

    fireEvent.click(screen.getByText("Remove"));
    expect(mockRemoveTaskBlocker).toHaveBeenCalledWith(1, 10);
  });

  it("an unassigned task renders the dashed avatar", () => {
    setupMocks();
    const { container } = renderPage();
    expect(container.querySelectorAll(".td-av--none").length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText("Unassigned").length).toBeGreaterThan(0);
  });

  it("a task with no effort and no labels renders those rows empty", () => {
    setupMocks();
    const { container } = renderPage();
    screen.getByLabelText("Effort: —");
    const labelsRow = container.querySelector(".td-labels");
    expect(labelsRow).not.toBeNull();
    expect(labelsRow?.querySelectorAll(".td-label").length).toBe(0);
    expect(labelsRow?.querySelector(".td-label--add")).not.toBeNull();
  });

  it("no select survives on the page", () => {
    setupMocks();
    const { container } = renderPage();
    expect(container.querySelector("select")).toBeNull();
  });

  it("a 404 renders the not-found state", () => {
    mockUseTask.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 404, message: "not found" },
      refetch: vi.fn(),
    });
    mockUseTeamMembers.mockReturnValue({ data: MEMBERS });
    mockUseProjects.mockReturnValue({ data: PROJECTS });
    mockUseTasks.mockReturnValue({ data: [] });
    mockUseLookups.mockReturnValue({ data: makeLookups() });
    mockUseTaxonomy.mockReturnValue({ data: LABEL_TAXONOMY });
    mockUseTaskActivity.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    mockUseTaskRuns.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    mockUseSessionReplay.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    });
    mockUseProfiles.mockReturnValue({ data: [] });

    renderPage();

    screen.getByText("Task #1 no longer exists.");
    expect(screen.queryByText(/Loading task/)).toBeNull();
  });

  it("the activity card is mounted in the document column", () => {
    setupMocks({
      activity: [
        {
          id: 1,
          entity_type: "task",
          entity_id: 1,
          action: "created",
          old_value: null,
          new_value: "Original title",
          actor: "system",
          created_at: "2026-08-08 00:00:00",
        },
        {
          id: 2,
          entity_type: "task",
          entity_id: 1,
          action: "status_changed",
          old_value: "todo",
          new_value: "in-progress",
          actor: "system",
          created_at: "2026-08-08 01:00:00",
        },
      ],
    });
    const { container } = renderPage();
    const doc = container.querySelector(".td-doc");
    expect(doc).not.toBeNull();
    const feed = doc?.querySelector(".td-feed");
    expect(feed).not.toBeNull();
    expect(feed?.querySelectorAll("li").length).toBe(2);
  });

  it("the runs card is mounted in the document column", () => {
    const runs: AgentRun[] = [
      {
        row_kind: "run",
        id: 101,
        session_id: "sess-101",
        provider_id: 1,
        project_id: 1,
        pane_id: "pane-1",
        model: "claude-opus",
        prompt_preview: "Investigate the flaky test",
        status: "ended",
        source_kind: "task",
        source_id: 1,
        started_at: "2026-08-11T16:00:00+00:00",
        ended_at: "2026-08-11T16:05:00+00:00",
        profile: "work",
        target: "embedded",
        provider_name: "claude-code",
        provider_display_name: "Claude Code",
        provider_color: "#d97757",
        project_name: "Alpha",
        session_status: "ended",
        session_current_tool: null,
        session_tokens_in: 100,
        session_tokens_out: 50,
        session_cost_usd: 0.42,
        session_initial_prompt: null,
        session_total_tool_calls: 12,
        schedule_id: null,
        schedule_name: null,
      },
      {
        row_kind: "run",
        id: 102,
        session_id: null,
        provider_id: null,
        project_id: 1,
        pane_id: null,
        model: null,
        prompt_preview: null,
        status: "running",
        source_kind: "task",
        source_id: 1,
        started_at: "2026-08-11T16:10:00+00:00",
        ended_at: null,
        profile: null,
        target: null,
        provider_name: null,
        provider_display_name: null,
        provider_color: null,
        project_name: "Alpha",
        session_status: null,
        session_current_tool: null,
        session_tokens_in: null,
        session_tokens_out: null,
        session_cost_usd: null,
        session_initial_prompt: null,
        session_total_tool_calls: null,
        schedule_id: null,
        schedule_name: null,
      },
    ];
    setupMocks({ runs });
    const { container } = renderPage();
    const doc = container.querySelector(".td-doc");
    expect(doc).not.toBeNull();
    const runsList = doc?.querySelector(".td-runs");
    expect(runsList).not.toBeNull();
    expect(runsList?.querySelectorAll(".td-run").length).toBe(2);
  });

  it("Replay mounts the existing replay panel", () => {
    const runs: AgentRun[] = [
      {
        row_kind: "run",
        id: 201,
        session_id: "sess-201",
        provider_id: 1,
        project_id: 1,
        pane_id: "pane-2",
        model: "claude-opus",
        prompt_preview: "Ship the runs card",
        status: "ended",
        source_kind: "task",
        source_id: 1,
        started_at: "2026-08-11T16:00:00+00:00",
        ended_at: "2026-08-11T16:05:00+00:00",
        profile: "work",
        target: "embedded",
        provider_name: "claude-code",
        provider_display_name: "Claude Code",
        provider_color: "#d97757",
        project_name: "Alpha",
        session_status: "ended",
        session_current_tool: null,
        session_tokens_in: 100,
        session_tokens_out: 50,
        session_cost_usd: 0.42,
        session_initial_prompt: null,
        session_total_tool_calls: 12,
        schedule_id: null,
        schedule_name: null,
      },
    ];
    setupMocks({ runs });
    mockUseSessionReplay.mockReturnValue({
      data: {
        session: {
          id: 1,
          session_id: "sess-201",
          profile: "work",
          status: "ended",
          cwd: "/repo",
          project_id: 1,
          provider_id: 1,
          model: "claude-opus",
          tokens_in: 100,
          tokens_out: 50,
          cost_usd: 0.42,
          project_name: "Alpha",
          initial_prompt: "Ship the runs card",
          current_tool: null,
          total_tool_calls: 12,
          started_at: "2026-08-11T16:00:00+00:00",
          ended_at: "2026-08-11T16:05:00+00:00",
          last_event_at: null,
        },
        events: [],
      },
      isLoading: false,
      isError: false,
    });

    const { container } = renderPage();
    expect(container.querySelector(".d3-replay")).toBeNull();

    fireEvent.click(screen.getByText("Replay"));
    const doc = container.querySelector(".td-doc");
    expect(doc?.querySelector(".d3-replay")).not.toBeNull();
  });

  it("status badge colour comes from the taxonomy", () => {
    setupMocks({
      lookups: makeLookups({
        workflow_task_statuses: [
          { slug: "todo", label: "To do", color: "#123456", sort_order: 20 },
          {
            slug: "in-progress",
            label: "In progress",
            color: "#f59e0b",
            sort_order: 30,
          },
        ],
      }),
    });
    const { container } = renderPage();
    const badge = container.querySelector(".td-badge") as HTMLElement;
    expect(badge.style.getPropertyValue("--c")).toBe("#123456");
  });
});
