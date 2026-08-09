import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { BoardColumn, type BoardColumnProps } from "../board-column";
import type { TaskCardProps } from "../task-card";
import type { BoardColumnDef, TaskBoardVocab } from "../types";
import type { Task } from "../../../lib/api";

vi.mock("../../launch/launch-from-source-button", () => ({
  LaunchFromSourceButton: () => null,
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "A task",
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

const VOCAB: TaskBoardVocab = {
  priorityColors: {},
  priorityLabels: {},
  statusLabels: {},
  priorityRank: {},
  priorityCount: 0,
};

const CARD_PROPS: Omit<TaskCardProps, "task" | "isLive"> = {
  vocab: VOCAB,
  statusOptions: [{ value: "todo", label: "To do" }],
  priorityOptions: [{ value: "medium", label: "Medium" }],
  assigneeOptions: [{ value: "", label: "— Unassigned" }],
  labelOptions: [],
  onNavigate: vi.fn(),
  onStatus: vi.fn(),
  onPriority: vi.fn(),
  onAssignee: vi.fn(),
  onToggleLabel: vi.fn(),
};

const COL: BoardColumnDef = { id: "todo", label: "To do", color: "#60a5fa" };

function baseProps(overrides: Partial<BoardColumnProps> = {}): BoardColumnProps {
  return {
    col: COL,
    tasks: [],
    wipLimit: null,
    filtersActive: false,
    onSetWipLimit: vi.fn(),
    card: CARD_PROPS,
    liveTaskIds: new Set(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("BoardColumn", () => {
  it("renders no count/limit text when no limit is configured", () => {
    const { container } = render(<BoardColumn {...baseProps()} />);
    const wip = container.querySelector(".tb-col__wip");
    expect(wip?.textContent).toBe("WIP");
  });

  it("warns at the limit and flags over the limit", () => {
    const three = [makeTask({ id: 1 }), makeTask({ id: 2 }), makeTask({ id: 3 })];
    const { container, rerender } = render(
      <BoardColumn {...baseProps({ tasks: three, wipLimit: 3 })} />,
    );
    expect(container.querySelector(".tb-col__wip--warn")).not.toBeNull();
    expect(container.querySelector(".tb-col__wip--over")).toBeNull();
    expect(container.querySelector(".tb-col--over")).toBeNull();

    const four = [...three, makeTask({ id: 4 })];
    rerender(<BoardColumn {...baseProps({ tasks: four, wipLimit: 3 })} />);
    expect(container.querySelector(".tb-col__wip--over")).not.toBeNull();
    expect(container.querySelector(".tb-col--over")).not.toBeNull();
  });

  it("mutes the WIP badge while filters are active", () => {
    const four = [
      makeTask({ id: 1 }),
      makeTask({ id: 2 }),
      makeTask({ id: 3 }),
      makeTask({ id: 4 }),
    ];
    const { container } = render(
      <BoardColumn
        {...baseProps({ tasks: four, wipLimit: 3, filtersActive: true })}
      />,
    );
    expect(container.querySelector(".tb-col__wip--muted")).not.toBeNull();
    expect(container.querySelector(".tb-col__wip--warn")).toBeNull();
    expect(container.querySelector(".tb-col__wip--over")).toBeNull();
    expect(container.querySelector(".tb-col--over")).toBeNull();
  });

  it("setting a limit calls onSetWipLimit with an integer", () => {
    const onSetWipLimit = vi.fn();
    const { container, getByRole } = render(
      <BoardColumn {...baseProps({ onSetWipLimit })} />,
    );
    fireEvent.click(container.querySelector(".tb-col__wip")!);
    const input = document.querySelector(".tb-wip-form__input")!;
    fireEvent.change(input, { target: { value: "3.7" } });
    fireEvent.click(getByRole("button", { name: "Set limit" }));
    expect(onSetWipLimit).toHaveBeenCalledWith("todo", 3);
  });

  it("does not call onSetWipLimit for 0 or a negative number", () => {
    const onSetWipLimit = vi.fn();
    const { container, getByRole } = render(
      <BoardColumn {...baseProps({ onSetWipLimit })} />,
    );
    fireEvent.click(container.querySelector(".tb-col__wip")!);
    const input = document.querySelector(".tb-wip-form__input")!;
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(getByRole("button", { name: "Set limit" }));
    fireEvent.change(input, { target: { value: "-1" } });
    fireEvent.click(getByRole("button", { name: "Set limit" }));
    expect(onSetWipLimit).not.toHaveBeenCalled();
  });

  it("'No limit' calls onSetWipLimit with null", () => {
    const onSetWipLimit = vi.fn();
    const { container, getByRole } = render(
      <BoardColumn {...baseProps({ wipLimit: 3, onSetWipLimit })} />,
    );
    fireEvent.click(container.querySelector(".tb-col__wip")!);
    fireEvent.click(getByRole("button", { name: "No limit" }));
    expect(onSetWipLimit).toHaveBeenCalledWith("todo", null);
  });

  it("renders the empty state with zero tasks", () => {
    const { container } = render(<BoardColumn {...baseProps({ tasks: [] })} />);
    expect(container.querySelector(".tb-col__empty")).not.toBeNull();
  });

  it("passes isLive only for ids in liveTaskIds", () => {
    const tasks = [makeTask({ id: 1 }), makeTask({ id: 2 })];
    const { container } = render(
      <BoardColumn
        {...baseProps({ tasks, liveTaskIds: new Set([2]) })}
      />,
    );
    expect(container.querySelectorAll(".tb-card__live").length).toBe(1);
  });
});
