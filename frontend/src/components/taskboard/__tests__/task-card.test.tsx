import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TaskCard, type TaskCardProps } from "../task-card";
import type { ChipOption, TaskBoardVocab } from "../types";
import type { Task } from "../../../lib/api";

// The card mounts <LaunchFromSourceButton>, which unconditionally calls
// useLaunchSeed (a bare useQuery) — stubbing it means the card needs no
// QueryClientProvider at all, since every other input is a plain prop.
vi.mock("../../launch/launch-from-source-button", () => ({
  LaunchFromSourceButton: () => null,
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 7,
    title: "Fix the flaky test",
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

function makeVocab(overrides: Partial<TaskBoardVocab> = {}): TaskBoardVocab {
  return {
    priorityColors: { high: "#ef4444", medium: "#f59e0b", low: "#22c55e" },
    priorityLabels: { high: "High", medium: "Medium", low: "Low" },
    statusLabels: { todo: "To do", done: "Done" },
    priorityRank: { high: 0, medium: 1, low: 2 },
    priorityCount: 3,
    ...overrides,
  };
}

const STATUS_OPTIONS: ChipOption[] = [
  { value: "todo", label: "To do" },
  { value: "done", label: "Done" },
];
const PRIORITY_OPTIONS: ChipOption[] = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];
const ASSIGNEE_OPTIONS: ChipOption[] = [{ value: "", label: "— Unassigned" }];

function baseProps(overrides: Partial<TaskCardProps> = {}): TaskCardProps {
  return {
    task: makeTask(),
    vocab: makeVocab(),
    statusOptions: STATUS_OPTIONS,
    priorityOptions: PRIORITY_OPTIONS,
    assigneeOptions: ASSIGNEE_OPTIONS,
    labelOptions: [],
    isLive: false,
    onNavigate: vi.fn(),
    onStatus: vi.fn(),
    onPriority: vi.fn(),
    onAssignee: vi.fn(),
    onToggleLabel: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("TaskCard", () => {
  it("renders one chip per label from task.labels", () => {
    const task = makeTask({
      labels: [
        { id: 1, slug: "bug", label: "Bug", color: "#ef4444", sort_order: 10 },
        { id: 2, slug: "docs", label: "Docs", color: "#38bdf8", sort_order: 20 },
      ],
    });
    render(<TaskCard {...baseProps({ task })} />);
    screen.getByText("Bug");
    screen.getByText("Docs");
  });

  it("renders no label chips when labels is undefined", () => {
    const task = makeTask();
    delete (task as { labels?: unknown }).labels;
    const { container } = render(<TaskCard {...baseProps({ task })} />);
    expect(container.querySelectorAll(".tb-label").length).toBe(0);
  });

  it("shows the live dot only when isLive", () => {
    const { container, rerender } = render(
      <TaskCard {...baseProps({ isLive: false })} />,
    );
    expect(container.querySelector(".tb-card__live")).toBeNull();
    rerender(<TaskCard {...baseProps({ isLive: true })} />);
    expect(container.querySelector(".tb-card__live")).not.toBeNull();
  });

  it("omits the effort badge when effort is null", () => {
    const { container, rerender } = render(
      <TaskCard {...baseProps({ task: makeTask({ effort: null }) })} />,
    );
    expect(container.querySelector(".tb-effort")).toBeNull();
    rerender(
      <TaskCard {...baseProps({ task: makeTask({ effort: "small" }) })} />,
    );
    expect(container.querySelector(".tb-effort")).not.toBeNull();
  });

  it("marks a done card", () => {
    const { container, rerender } = render(
      <TaskCard {...baseProps({ task: makeTask({ status: "done" }) })} />,
    );
    expect(container.querySelector(".tb-card--done")).not.toBeNull();
    rerender(
      <TaskCard {...baseProps({ task: makeTask({ status: "todo" }) })} />,
    );
    expect(container.querySelector(".tb-card--done")).toBeNull();
  });

  it("derives the priority glyph from rank, not slug", () => {
    const vocab = makeVocab({
      priorityRank: { urgent: 0, high: 1, low: 2 },
      priorityCount: 3,
    });
    const { container, rerender } = render(
      <TaskCard
        {...baseProps({ task: makeTask({ priority: "urgent" }), vocab })}
      />,
    );
    expect(container.querySelector(".tb-card__prio")?.textContent).toBe("▲");

    rerender(
      <TaskCard
        {...baseProps({ task: makeTask({ priority: "low" }), vocab })}
      />,
    );
    expect(container.querySelector(".tb-card__prio")?.textContent).toBe("▼");

    rerender(
      <TaskCard
        {...baseProps({ task: makeTask({ priority: "high" }), vocab })}
      />,
    );
    expect(container.querySelector(".tb-card__prio")?.textContent).toBe("▬");

    rerender(
      <TaskCard
        {...baseProps({ task: makeTask({ priority: "unknown" }), vocab })}
      />,
    );
    expect(container.querySelector(".tb-card__prio")?.textContent).toBe("●");

    rerender(
      <TaskCard
        {...baseProps({
          task: makeTask({ priority: "solo" }),
          vocab: makeVocab({ priorityRank: { solo: 0 }, priorityCount: 1 }),
        })}
      />,
    );
    expect(container.querySelector(".tb-card__prio")?.textContent).toBe("▬");
  });

  it("toggling a label chip calls onToggleLabel with the id and the next state", () => {
    const onToggleLabel = vi.fn();
    const task = makeTask({
      labels: [{ id: 1, slug: "bug", label: "Bug", color: "#ef4444", sort_order: 10 }],
    });
    render(
      <TaskCard
        {...baseProps({
          task,
          labelOptions: [
            { id: 1, label: "Bug", color: "#ef4444" },
            { id: 2, label: "Docs", color: "#38bdf8" },
          ],
          onToggleLabel,
        })}
      />,
    );
    fireEvent.click(screen.getByLabelText("Labels: 1 selected"));
    const options = screen.getAllByRole("option");
    const bugOption = options.find((o) => o.textContent?.includes("Bug"));
    const docsOption = options.find((o) => o.textContent?.includes("Docs"));
    fireEvent.click(bugOption!);
    expect(onToggleLabel).toHaveBeenCalledWith(7, 1, false);
    fireEvent.click(docsOption!);
    expect(onToggleLabel).toHaveBeenCalledWith(7, 2, true);
  });

  it("renders 'No labels' when the vocabulary is empty", () => {
    render(<TaskCard {...baseProps({ labelOptions: [] })} />);
    fireEvent.click(screen.getByLabelText("Add labels"));
    screen.getByText(/No labels/);
  });

  describe("dates", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-08T12:00:00.000Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("done shows completed_date", () => {
      const task = makeTask({ status: "done", completed_date: "2026-08-05" });
      const { container } = render(<TaskCard {...baseProps({ task })} />);
      const date = container.querySelector(".tb-date");
      expect(date?.textContent).toBe("2026-08-05");
      expect(date?.getAttribute("title")).toBe("Completed 2026-08-05");
    });

    it("else shows started_date", () => {
      const task = makeTask({ started_date: "2026-08-01" });
      const { container } = render(<TaskCard {...baseProps({ task })} />);
      const date = container.querySelector(".tb-date");
      expect(date?.textContent).toBe("2026-08-01");
      expect(date?.getAttribute("title")).toBe("Started 2026-08-01");
    });

    it("else falls back to created_at, normalised to UTC", () => {
      const task = makeTask({ created_at: "2026-08-08T11:59:00" });
      const { container } = render(<TaskCard {...baseProps({ task })} />);
      const date = container.querySelector(".tb-date");
      expect(date?.textContent).toBe("1m ago");
      expect(date?.getAttribute("title")).toBe("Created 2026-08-08T11:59:00");
    });
  });

  it("an unassigned task renders the dashed avatar", () => {
    const { container } = render(<TaskCard {...baseProps()} />);
    const avatar = container.querySelector(".tb-avatar--none");
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute("title")).toBe("Unassigned");
  });
});
