import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ComposerModal, type ComposerModalProps } from "../composer-modal";
import type { Project, TeamMember } from "../../../lib/api";

const { mockCreateTask, mockSetTaskLabels, mockToastError } = vi.hoisted(() => ({
  mockCreateTask: vi.fn(),
  mockSetTaskLabels: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("../../../lib/api", () => ({
  createTask: mockCreateTask,
  setTaskLabels: mockSetTaskLabels,
}));

vi.mock("sonner", () => ({
  toast: { error: mockToastError, success: vi.fn() },
}));

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
  {
    id: 2,
    name: "Claudia",
    role: "agent",
    type: "agent",
    subtype: null,
    department: null,
    status: "active",
    agent_file: null,
    joined_date: null,
    notes: null,
  },
];

function baseProps(overrides: Partial<ComposerModalProps> = {}): ComposerModalProps {
  return {
    projects: PROJECTS,
    members: MEMBERS,
    statusOptions: [{ value: "todo", label: "To do" }],
    priorityOptions: [{ value: "medium", label: "Medium" }],
    labelOptions: [
      { id: 1, label: "Bug", color: "#ef4444" },
      { id: 2, label: "Docs", color: "#38bdf8" },
    ],
    defaultProjectId: "1",
    defaultStatus: "todo",
    defaultPriority: "medium",
    onClose: vi.fn(),
    onCreated: vi.fn(),
    ...overrides,
  };
}

function typeTitle(text: string): void {
  fireEvent.change(screen.getByPlaceholderText("What needs doing?"), {
    target: { value: text },
  });
}

function cmdEnter(): void {
  fireEvent.keyDown(window, { key: "Enter", metaKey: true });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ComposerModal", () => {
  it("Cmd+Enter submits", async () => {
    mockCreateTask.mockResolvedValue({ id: 42 });
    render(<ComposerModal {...baseProps()} />);
    typeTitle("Ship the thing");
    cmdEnter();
    await waitFor(() => expect(mockCreateTask).toHaveBeenCalledTimes(1));
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Ship the thing", project_id: 1 }),
    );
  });

  it("Ctrl+Enter submits", async () => {
    mockCreateTask.mockResolvedValue({ id: 42 });
    render(<ComposerModal {...baseProps()} />);
    typeTitle("Ship the thing");
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(mockCreateTask).toHaveBeenCalledTimes(1));
  });

  it("does not submit an empty or whitespace-only title", async () => {
    render(<ComposerModal {...baseProps()} />);
    typeTitle("   ");
    cmdEnter();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("surfaces 'Project is required' and issues no request when there is no project", async () => {
    render(<ComposerModal {...baseProps({ projects: [], defaultProjectId: "" })} />);
    typeTitle("Ship the thing");
    cmdEnter();
    await waitFor(() => screen.getByText("Project is required"));
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("sends selected labels via setTaskLabels with the new task id", async () => {
    mockCreateTask.mockResolvedValue({ id: 42 });
    mockSetTaskLabels.mockResolvedValue([]);
    render(<ComposerModal {...baseProps()} />);
    fireEvent.click(screen.getByLabelText("Add labels"));
    fireEvent.click(screen.getByRole("option", { name: /Bug/ }));
    typeTitle("Ship the thing");
    cmdEnter();
    await waitFor(() => expect(mockCreateTask).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(mockSetTaskLabels).toHaveBeenCalledWith(42, [1]),
    );
  });

  it("does not call setTaskLabels when no label is selected", async () => {
    mockCreateTask.mockResolvedValue({ id: 42 });
    render(<ComposerModal {...baseProps()} />);
    typeTitle("Ship the thing");
    cmdEnter();
    await waitFor(() => expect(mockCreateTask).toHaveBeenCalledTimes(1));
    expect(mockSetTaskLabels).not.toHaveBeenCalled();
  });

  it("a failed setTaskLabels still counts as a created task", async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    mockCreateTask.mockResolvedValue({ id: 42 });
    mockSetTaskLabels.mockRejectedValue(new Error("nope"));
    render(<ComposerModal {...baseProps({ onCreated, onClose })} />);
    fireEvent.click(screen.getByLabelText("Add labels"));
    fireEvent.click(screen.getByRole("option", { name: /Bug/ }));
    typeTitle("Ship the thing");
    cmdEnter();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(mockToastError).toHaveBeenCalledWith(
      "Task created, but labels failed to save",
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("'Create another' keeps the modal open, clears the title and labels, keeps the project", async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    mockCreateTask.mockResolvedValue({ id: 42 });
    render(<ComposerModal {...baseProps({ onClose, onCreated })} />);
    fireEvent.click(screen.getByLabelText("Create another"));
    typeTitle("Ship the thing");
    cmdEnter();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(
      (screen.getByPlaceholderText("What needs doing?") as HTMLInputElement)
        .value,
    ).toBe("");
    // Project chip is unaffected by "Create another".
    screen.getByLabelText("Project: Alpha");
  });

  it("unchecked 'Create another' closes the modal", async () => {
    const onClose = vi.fn();
    mockCreateTask.mockResolvedValue({ id: 42 });
    render(<ComposerModal {...baseProps({ onClose })} />);
    typeTitle("Ship the thing");
    cmdEnter();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("Escape closes without creating", () => {
    const onClose = vi.fn();
    render(<ComposerModal {...baseProps({ onClose })} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("clearing effort sends null, not ''", async () => {
    mockCreateTask.mockResolvedValue({ id: 42 });
    render(<ComposerModal {...baseProps()} />);
    typeTitle("Ship the thing");
    cmdEnter();
    await waitFor(() => expect(mockCreateTask).toHaveBeenCalledTimes(1));
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({ effort: null }),
    );
  });

  it("does not double-submit while a create is in flight", async () => {
    let resolveCreate: (v: { id: number }) => void = () => {};
    mockCreateTask.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    render(<ComposerModal {...baseProps()} />);
    typeTitle("Ship the thing");
    cmdEnter();
    cmdEnter();
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    resolveCreate({ id: 1 });
    await waitFor(() => expect(mockCreateTask).toHaveBeenCalledTimes(1));
  });

  it("agent options carry the assignment hint", () => {
    render(<ComposerModal {...baseProps()} />);
    fireEvent.click(screen.getByLabelText("Assignee: — Unassigned"));
    const agentOption = screen.getByRole("option", { name: /Claudia/ });
    expect(agentOption.textContent).toContain(
      "Assigning does not start a session",
    );
    const humanOption = screen.getByRole("option", { name: /^Ada$/ });
    expect(humanOption.textContent).not.toContain(
      "Assigning does not start a session",
    );
  });

  it("registers exactly one keydown listener across re-renders", () => {
    const spy = vi.spyOn(window, "addEventListener");
    const { rerender } = render(<ComposerModal {...baseProps()} />);
    rerender(<ComposerModal {...baseProps()} />);
    rerender(<ComposerModal {...baseProps()} />);
    const keydownCalls = spy.mock.calls.filter(([type]) => type === "keydown");
    expect(keydownCalls.length).toBe(1);
    spy.mockRestore();
  });

  it("Escape inside a chip picker closes only the picker", () => {
    const onClose = vi.fn();
    render(<ComposerModal {...baseProps({ onClose })} />);
    typeTitle("Draft title");
    fireEvent.click(screen.getByLabelText("Status: To do"));
    expect(screen.queryAllByRole("option").length).toBeGreaterThan(0);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryAllByRole("option").length).toBe(0);
    expect(onClose).not.toHaveBeenCalled();
    expect(
      (screen.getByPlaceholderText("What needs doing?") as HTMLInputElement)
        .value,
    ).toBe("Draft title");
  });
});
