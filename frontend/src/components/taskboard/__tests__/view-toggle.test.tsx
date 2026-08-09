import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ViewToggle } from "../view-toggle";

afterEach(() => {
  cleanup();
});

describe("ViewToggle", () => {
  it("marks the active mode with aria-selected and tb-seg__btn--on", () => {
    render(<ViewToggle mode="board" onChange={vi.fn()} />);
    const board = screen.getByRole("tab", { name: "Board" });
    const list = screen.getByRole("tab", { name: "List" });
    expect(board.getAttribute("aria-selected")).toBe("true");
    expect(board.className).toContain("tb-seg__btn--on");
    expect(list.getAttribute("aria-selected")).toBe("false");
    expect(list.className).not.toContain("tb-seg__btn--on");
  });

  it("clicking the inactive mode calls onChange once with it", () => {
    const onChange = vi.fn();
    render(<ViewToggle mode="board" onChange={onChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("list");
  });

  it("clicking the active mode still calls onChange", () => {
    const onChange = vi.fn();
    render(<ViewToggle mode="board" onChange={onChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("board");
  });
});
