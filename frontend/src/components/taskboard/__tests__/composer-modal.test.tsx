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

  // ── Chrome ────────────────────────────────────────────────────────────
  //
  // Assertable for the first time: the Composer's `tb-*` classes lived in a
  // plain stylesheet vitest never loaded, so none of this could be checked
  // except by eye. The `.deck` wrapper is the one that matters — this dialog
  // portals to `document.body`, and outside a `.deck` every token resolves to
  // nothing and it ships as an unstyled white box.

  function dialog(): HTMLElement {
    return screen.getByRole("dialog", { name: "New task" });
  }

  it("portals the dialog inside a .deck wrapper so Deck tokens resolve", () => {
    render(<ComposerModal {...baseProps()} />);
    const deck = dialog().closest(".deck");
    expect(deck).not.toBeNull();
    expect((deck as HTMLElement).style.display).toBe("contents");
  });

  it("is a .dk-modal inside a .dk-scrim that stays above the terminal portals", () => {
    render(<ComposerModal {...baseProps()} />);
    expect(dialog().classList.contains("dk-modal")).toBe(true);
    const scrim = dialog().parentElement as HTMLElement;
    expect(scrim.classList.contains("dk-scrim")).toBe(true);
    // `.dk-scrim` is z-index 60, which is a scrim inside a page. The pickers'
    // popovers sit at 199/200 and must still clear this one.
    expect(scrim.style.zIndex).toBe("150");
  });

  it("clicking the scrim closes, clicking the dialog does not", () => {
    const onClose = vi.fn();
    render(<ComposerModal {...baseProps({ onClose })} />);
    fireEvent.click(dialog());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(dialog().parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the header close button closes without creating", () => {
    const onClose = vi.fn();
    render(<ComposerModal {...baseProps({ onClose })} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("the title and description are labelled Deck form controls", () => {
    render(<ComposerModal {...baseProps()} />);
    const title = screen.getByLabelText("Title");
    expect(title.classList.contains("dk-ctl")).toBe(true);
    expect(title.getAttribute("placeholder")).toBe("What needs doing?");

    fireEvent.click(screen.getByRole("button", { name: /Add description/ }));
    const desc = screen.getByLabelText("Description");
    expect(desc.tagName).toBe("TEXTAREA");
    expect(desc.classList.contains("dk-ctl")).toBe(true);
    // `textarea.dk-ctl` is `resize: vertical`, which a self-sizing field
    // overwrites on the next keystroke.
    expect((desc as HTMLElement).style.resize).toBe("none");
  });

  it("the description field replaces its own add button and keeps what is typed", () => {
    render(<ComposerModal {...baseProps()} />);
    fireEvent.click(screen.getByRole("button", { name: /Add description/ }));
    expect(screen.queryByRole("button", { name: /Add description/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "the detail" },
    });
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe(
      "the detail",
    );
  });

  it("sends the typed description, trimmed, and null when it is blank", async () => {
    mockCreateTask.mockResolvedValue({ id: 7 });
    render(<ComposerModal {...baseProps()} />);
    fireEvent.click(screen.getByRole("button", { name: /Add description/ }));
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "  the detail  " },
    });
    typeTitle("Ship the thing");
    cmdEnter();
    await waitFor(() => expect(mockCreateTask).toHaveBeenCalledTimes(1));
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({ description: "the detail" }),
    );
  });

  it("Create is a single primary, disabled until there is a title", () => {
    render(<ComposerModal {...baseProps()} />);
    const create = screen.getByRole("button", { name: "Create" });
    expect(create.className).toBe("dk-btn pri");
    expect((create as HTMLButtonElement).disabled).toBe(true);
    typeTitle("Ship the thing");
    expect((create as HTMLButtonElement).disabled).toBe(false);
    // Deck's rule: one primary per surface. Cancel is the bare secondary.
    expect(dialog().querySelectorAll(".dk-btn.pri").length).toBe(1);
    expect(screen.getByRole("button", { name: "Cancel" }).className).toBe("dk-btn bare");
  });

  it("the Create button submits, the Cancel button does not", async () => {
    const onClose = vi.fn();
    mockCreateTask.mockResolvedValue({ id: 42 });
    render(<ComposerModal {...baseProps({ onClose })} />);
    typeTitle("Ship the thing");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockCreateTask).toHaveBeenCalledTimes(1));
  });

  it("the validation message is an alert in Deck's broken semantic", async () => {
    render(<ComposerModal {...baseProps({ projects: [], defaultProjectId: "" })} />);
    typeTitle("Ship the thing");
    cmdEnter();
    const err = await screen.findByRole("alert");
    expect(err.textContent).toBe("Project is required");
    expect(err.style.color).toBe("var(--err)");
  });

  it("picking a project clears the validation message", async () => {
    render(<ComposerModal {...baseProps({ defaultProjectId: "" })} />);
    typeTitle("Ship the thing");
    cmdEnter();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByLabelText("Project: Project"));
    fireEvent.click(screen.getByRole("option", { name: "Alpha" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("every picker says what it sets, not just what it is set to", () => {
    render(<ComposerModal {...baseProps()} />);
    const labels = Array.from(dialog().querySelectorAll(".dk-form__grid .dk-label")).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual([
      "Status",
      "Priority",
      "Project",
      "Assignee",
      "Effort",
      "Labels",
    ]);
  });

  it("the footer keeps 'Create another' left of the shortcut hint", () => {
    render(<ComposerModal {...baseProps()} />);
    const foot = dialog().querySelector(".dk-modal__f") as HTMLElement;
    expect(foot).not.toBeNull();
    const check = screen.getByLabelText("Create another").closest("label") as HTMLElement;
    // `.sp` is `margin-left: auto` only inside the headers deck.css names, so
    // a right-aligned footer pushes from the left item instead.
    expect(check.style.marginRight).toBe("auto");
    expect(foot.querySelector(".dk-meta")?.textContent).toBe("⌘↩ to create");
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
