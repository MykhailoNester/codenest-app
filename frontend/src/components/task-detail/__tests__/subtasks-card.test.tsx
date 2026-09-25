import { describe, it, expect, vi, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SubtasksCard, type SubtasksCardProps } from "../subtasks-card";
import type { Subtask } from "../../../lib/api";

afterEach(cleanup);

function makeSubtask(overrides: Partial<Subtask> = {}): Subtask {
  return {
    id: 1,
    task_id: 9,
    title: "Write the migration",
    done: false,
    sort_order: 0,
    created_at: "2026-08-11 13:34:21",
    ...overrides,
  };
}

function renderCard(overrides: Partial<SubtasksCardProps> = {}) {
  const props: SubtasksCardProps = {
    subtasks: [],
    isLoading: false,
    isError: false,
    onRetry: vi.fn(),
    onAdd: vi.fn(),
    onRename: vi.fn(),
    onToggle: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<SubtasksCard {...props} />) };
}

describe("SubtasksCard", () => {
  it("renders no count chip and no progress bar with zero subtasks", () => {
    renderCard();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(document.querySelector(".td-count")).toBeNull();
    expect(screen.getByText("No subtasks yet.")).toBeTruthy();
  });

  it("count chip and progress bar agree with the list", () => {
    renderCard({
      subtasks: [
        makeSubtask({ id: 1, done: true }),
        makeSubtask({ id: 2, title: "Wire the card", done: false }),
      ],
    });
    expect(document.querySelector(".td-count")?.textContent).toBe("1/2");
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    expect(bar.getAttribute("aria-valuemax")).toBe("2");
  });

  it("toggling is optimistic and reverts visibly when the write fails", async () => {
    const onToggle = vi.fn().mockRejectedValue(new Error("nope"));
    renderCard({ subtasks: [makeSubtask()], onToggle });

    const box = screen.getByRole("checkbox") as HTMLInputElement;
    fireEvent.click(box);
    expect(onToggle).toHaveBeenCalledWith(1, true);
    await waitFor(() => expect(box.checked).toBe(false));
    expect(document.querySelector(".td-count")?.textContent).toBe("0/1");
  });

  it("adds a subtask on submit and clears the draft", () => {
    const onAdd = vi.fn();
    renderCard({ onAdd });

    const input = screen.getByLabelText("Add a subtask") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  ship it  " } });
    fireEvent.submit(input.closest("form")!);

    expect(onAdd).toHaveBeenCalledWith("ship it");
    expect(input.value).toBe("");
  });

  it("renames on Enter and deletes on the row control", () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    renderCard({ subtasks: [makeSubtask()], onRename, onDelete });

    fireEvent.click(screen.getByText("Write the migration"));
    const editor = screen.getByLabelText("Rename Write the migration");
    fireEvent.change(editor, { target: { value: "Write migration 020" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith(1, "Write migration 020");

    fireEvent.click(screen.getByLabelText("Delete Write the migration"));
    expect(onDelete).toHaveBeenCalledWith(1);
  });
});
