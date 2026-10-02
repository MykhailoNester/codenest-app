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
  mockUseTaskSubtasks,
  mockUseTaskComments,
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
  mockUseTaskSubtasks: vi.fn(),
  mockUseTaskComments: vi.fn(),
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
  useTaskSubtasks: (...args: unknown[]) => mockUseTaskSubtasks(...args),
  useTaskComments: (...args: unknown[]) => mockUseTaskComments(...args),
  useSessionReplay: (...args: unknown[]) => mockUseSessionReplay(...args),
  useProfiles: (...args: unknown[]) => mockUseProfiles(...args),
  updateTask: (...args: unknown[]) => mockUpdateTask(...args),
  changeTaskStatus: (...args: unknown[]) => mockChangeTaskStatus(...args),
  deleteTask: (...args: unknown[]) => mockDeleteTask(...args),
  addTaskBlocker: (...args: unknown[]) => mockAddTaskBlocker(...args),
  removeTaskBlocker: (...args: unknown[]) => mockRemoveTaskBlocker(...args),
  addTaskLabel: (...args: unknown[]) => mockAddTaskLabel(...args),
  removeTaskLabel: (...args: unknown[]) => mockRemoveTaskLabel(...args),
  createSubtask: vi.fn(),
  updateSubtask: vi.fn(),
  deleteSubtask: vi.fn(),
  createComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mockToastError, success: mockToastSuccess },
}));

// Stubbed for the same reason the old Shell was: this file tests the record,
// not the chrome. `actions` is rendered so the bar's buttons stay reachable.
vi.mock("../../components/deck/deck-shell", () => ({
  DeckShell: ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
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
  mockUseTaskSubtasks.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mockUseTaskComments.mockReturnValue({
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
      ".dk-title__edit",
    ) as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    fireEvent.change(textarea, { target: { value: "New title" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(mockUpdateTask).toHaveBeenCalledTimes(1);
    expect(mockUpdateTask).toHaveBeenCalledWith(1, { title: "New title" });
    expect(container.querySelector(".dk-title__edit")).toBeNull();
  });

  it("blur commits the inline title edit", () => {
    setupMocks();
    const { container } = renderPage();
    fireEvent.click(screen.getByText("Original title"));
    const textarea = container.querySelector(
      ".dk-title__edit",
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
      ".dk-title__edit",
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
      ".dk-title__edit",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it("choosing a status writes through the status endpoint", () => {
    setupMocks();
    renderPage();
    const select = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(select.value).toBe("todo");
    fireEvent.change(select, { target: { value: "in-progress" } });
    expect(mockChangeTaskStatus).toHaveBeenCalledWith(1, "in-progress");
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it("choosing an effort never sends a value the CHECK rejects", () => {
    setupMocks();
    renderPage();
    const select = screen.getByLabelText("Effort") as HTMLSelectElement;

    // Every option the control offers, in turn — the point of the test is
    // that the set is closed, so it drives the real option list rather than
    // a list repeated here.
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["", "small", "medium", "large"]);
    for (const value of values) {
      fireEvent.change(select, { target: { value } });
    }

    expect(mockUpdateTask.mock.calls.map((c) => c[1])).toEqual([
      { effort: null },
      { effort: "small" },
      { effort: "medium" },
      { effort: "large" },
    ]);
  });

  it("adding a label calls the label endpoint and the control stays usable", () => {
    setupMocks();
    renderPage();
    const select = screen.getByLabelText("Add label") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "7" } });
    expect(mockAddTaskLabel).toHaveBeenCalledWith(1, 7);
    // Multi-valued: the control resets to its placeholder and the next label
    // can be added without reopening anything.
    expect(select.value).toBe("");
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
    // An assigned label is a chip, and the chip is its own remove control.
    fireEvent.click(screen.getByLabelText("Remove label Bug"));
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
      ".dk-title__edit",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "New title" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // "saving…" is expected while the write is in-flight; "✓ saved" is the
    // assertion that must wait for the write AND its refetch to settle.
    expect(screen.queryByText(/✓ saved/i)).toBeNull();

    resolveUpdate?.();
    await waitFor(() => screen.getByText(/✓ saved/i));
  });

  it("a rejected write shows a toast and never shows Saved", async () => {
    setupMocks();
    mockUpdateTask.mockRejectedValueOnce(new Error("boom"));
    const { container } = renderPage();

    fireEvent.click(screen.getByText("Original title"));
    const textarea = container.querySelector(
      ".dk-title__edit",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "New title" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(screen.queryByText(/✓ saved/i)).toBeNull();
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

    const add = screen.getByLabelText("Add blocker") as HTMLSelectElement;
    expect(screen.getByRole("option", { name: "#2 Other task" })).not.toBeNull();
    fireEvent.change(add, { target: { value: "2" } });
    expect(mockAddTaskBlocker).toHaveBeenCalledWith(1, 2);

    fireEvent.click(screen.getByText(/^remove$/i));
    expect(mockRemoveTaskBlocker).toHaveBeenCalledWith(1, 10);
  });

  // #298 dropped the avatar with the rest of the card chrome; "no assignee"
  // now has to read as text in both places it appears.
  it("an unassigned task says so in the quickmeta and in the picker", () => {
    setupMocks();
    renderPage();
    const select = screen.getByLabelText("Assignee") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getAllByText(/unassigned/i).length).toBeGreaterThan(1);
  });

  it("a task with no effort and no labels renders those rows empty", () => {
    setupMocks();
    renderPage();
    expect((screen.getByLabelText("Effort") as HTMLSelectElement).value).toBe(
      "",
    );
    const add = screen.getByLabelText("Add label");
    const labelsRow = add.closest(".dk-kv");
    expect(labelsRow).not.toBeNull();
    expect(labelsRow?.querySelectorAll(".dk-tag").length).toBe(0);
  });

  // #298 reversed this: the old design banned every <select> in favour of
  // custom popovers. Deck has no popover primitive, so the six property
  // pickers are native selects — the same control the Work board's line
  // carries. The contract this now pins is that each field has exactly one,
  // accessibly named.
  it("every property picker is a native, named select", () => {
    setupMocks();
    const { container } = renderPage();
    expect(container.querySelectorAll("select").length).toBe(7);
    for (const name of [
      "Status",
      "Priority",
      "Assignee",
      "Effort",
      "Project",
      "Add label",
      "Add blocker",
    ]) {
      expect(screen.getByLabelText(name).tagName).toBe("SELECT");
    }
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
    mockUseTaskSubtasks.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    mockUseTaskComments.mockReturnValue({
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
    const doc = container.querySelector(".dk-detail__doc");
    expect(doc).not.toBeNull();
    const feed = doc?.querySelector(".dk-list");
    expect(feed).not.toBeNull();
    expect(feed?.querySelectorAll(".dk-line").length).toBe(2);
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
    const doc = container.querySelector(".dk-detail__doc");
    expect(doc).not.toBeNull();
    const runsList = doc?.querySelector('[aria-label="Agent runs"]');
    expect(runsList).not.toBeNull();
    expect(runsList?.querySelectorAll(".dk-line").length).toBe(2);
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

    fireEvent.click(screen.getByText(/^replay$/i));
    const doc = container.querySelector(".dk-detail__doc");
    expect(doc?.querySelector(".d3-replay")).not.toBeNull();
  });

  // Deck carries status on the state glyph, not as a per-status hex from the
  // taxonomy — the same decision #292 made for the board's `status_colors`.
  // The contract is now "the badge names the status", not "it is this colour".
  it("the status badge reflects the task's status", () => {
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
    // #298 removed the duplicate identity bar — the shell crumb carries the
    // status label now, and the chrome is stubbed here. The properties select
    // is the rendered control that actually reflects it.
    renderPage();
    const sel = screen.getByLabelText(/status/i) as HTMLSelectElement;
    expect(sel.value).toBe("todo");
  });
});
