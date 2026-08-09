import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FilterBar, type FilterBarProps, type FilterKey } from "../filter-bar";
import type { ChipOption } from "../types";

const PROJECT_OPTIONS: ChipOption[] = [
  { value: "", label: "Any project" },
  { value: "1", label: "Alpha" },
];
const PRIORITY_OPTIONS: ChipOption[] = [
  { value: "", label: "Any priority" },
  { value: "high", label: "High" },
];
const ASSIGNEE_OPTIONS: ChipOption[] = [
  { value: "", label: "Any assignee" },
  { value: "9", label: "Ada" },
];
const LABEL_OPTIONS: ChipOption[] = [
  { value: "", label: "Any label" },
  { value: "3", label: "Bug" },
];

function baseProps(overrides: Partial<FilterBarProps> = {}): FilterBarProps {
  return {
    values: {
      project_id: "",
      priority: "",
      assignee_id: "",
      label: "",
      status: "",
    },
    projectOptions: PROJECT_OPTIONS,
    priorityOptions: PRIORITY_OPTIONS,
    assigneeOptions: ASSIGNEE_OPTIONS,
    labelOptions: LABEL_OPTIONS,
    onSet: vi.fn(),
    onClearAll: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("FilterBar", () => {
  it("renders one removable chip per active filter and none when all are empty", () => {
    const { container, rerender } = render(<FilterBar {...baseProps()} />);
    expect(container.querySelectorAll(".tb-filter").length).toBe(0);

    rerender(
      <FilterBar
        {...baseProps({
          values: {
            project_id: "1",
            priority: "high",
            assignee_id: "",
            label: "",
            status: "",
          },
        })}
      />,
    );
    expect(container.querySelectorAll(".tb-filter").length).toBe(2);
  });

  it("the count badge counts only active filters, is absent at zero, and excludes sort", () => {
    const { container, rerender } = render(<FilterBar {...baseProps()} />);
    expect(container.querySelector(".tb-filter-count")).toBeNull();

    rerender(
      <FilterBar
        {...baseProps({
          values: {
            project_id: "1",
            priority: "",
            assignee_id: "",
            label: "",
            status: "",
          },
          sort: { value: "priority", options: [{ value: "priority", label: "Priority" }] },
          onSetSort: vi.fn(),
        })}
      />,
    );
    expect(container.querySelector(".tb-filter-count")?.textContent).toBe("1");
  });

  it("removing a chip clears exactly that one key", () => {
    const onSet = vi.fn();
    render(
      <FilterBar
        {...baseProps({
          values: {
            project_id: "1",
            priority: "high",
            assignee_id: "",
            label: "",
            status: "",
          },
          onSet,
        })}
      />,
    );
    const removeButtons = screen.getAllByRole("button", { name: /Remove .* filter/ });
    const priorityRemove = removeButtons.find((b) =>
      b.getAttribute("aria-label")?.includes("Priority"),
    )!;
    priorityRemove.click();
    expect(onSet).toHaveBeenCalledTimes(1);
    expect(onSet).toHaveBeenCalledWith("priority" satisfies FilterKey, "");
  });

  it("'Clear all' calls onClearAll once", () => {
    const onClearAll = vi.fn();
    render(
      <FilterBar
        {...baseProps({
          values: {
            project_id: "1",
            priority: "",
            assignee_id: "",
            label: "",
            status: "",
          },
          onClearAll,
        })}
      />,
    );
    screen.getByRole("button", { name: "Clear all" }).click();
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it("omits the status picker when statusOptions is absent", () => {
    render(<FilterBar {...baseProps()} />);
    expect(screen.queryByLabelText("Status: Any status")).toBeNull();
  });
});
