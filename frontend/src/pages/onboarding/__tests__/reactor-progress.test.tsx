/**
 * The setup rail is the only progress feedback the flow has, and onboarding
 * runs once on a fresh DB — nobody will catch a regression here by eye. So its
 * contracts are asserted directly: which step reads as current, which steps can
 * be jumped back to, and what the gauge says.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { ReactorProgress, type ReactorStep } from "../reactor-progress";

const STEPS: ReactorStep[] = [
  { code: "01", title: "Welcome" },
  { code: "02", title: "Import projects" },
  { code: "03", title: "AI provider" },
  { code: "04", title: "Budgets", optional: true },
];

afterEach(() => {
  cleanup();
});

function rowFor(title: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(title, "i") });
}

describe("ReactorProgress", () => {
  it("renders one row per step, in order", () => {
    render(<ReactorProgress steps={STEPS} current={0} maxReached={0} />);
    const rows = screen.getAllByRole("button");
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.textContent)).toEqual([
      "01 Welcome",
      "02 Import projects",
      "03 AI provider",
      "04 Budgetsopt",
    ]);
  });

  it("marks only the current step with aria-current", () => {
    render(<ReactorProgress steps={STEPS} current={2} maxReached={2} />);
    expect(rowFor("AI provider").getAttribute("aria-current")).toBe("step");
    expect(rowFor("Welcome").hasAttribute("aria-current")).toBe(false);
    expect(rowFor("Budgets").hasAttribute("aria-current")).toBe(false);
  });

  it("labels each step's state as text, not colour alone", () => {
    render(<ReactorProgress steps={STEPS} current={1} maxReached={1} />);
    // Steps before the current one are done, the current one is current,
    // everything after is pending.
    expect(screen.getAllByLabelText("done")).toHaveLength(1);
    expect(screen.getAllByLabelText("current step")).toHaveLength(1);
    expect(screen.getAllByLabelText("pending")).toHaveLength(2);
  });

  it("reports progress as a percentage of the steps completed", () => {
    const { rerender } = render(
      <ReactorProgress steps={STEPS} current={0} maxReached={0} />,
    );
    const bar = screen.getByRole("progressbar", { name: "Setup progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getByText(/0% · 01 \/ 04/)).toBeTruthy();

    rerender(<ReactorProgress steps={STEPS} current={3} maxReached={3} />);
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByText(/100% · 04 \/ 04/)).toBeTruthy();
  });

  it("enables only the steps already reached, and calls onSelect with the index", () => {
    const onSelect = vi.fn();
    // The user got as far as step 03 and then went back to 02.
    render(
      <ReactorProgress
        steps={STEPS}
        current={1}
        maxReached={2}
        onSelect={onSelect}
      />,
    );
    expect((rowFor("Welcome") as HTMLButtonElement).disabled).toBe(false);
    expect((rowFor("AI provider") as HTMLButtonElement).disabled).toBe(false);
    // Never reached — must stay unreachable, so the flow cannot be skipped.
    expect((rowFor("Budgets") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(rowFor("Welcome"));
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it("disables every row when no onSelect is given", () => {
    render(<ReactorProgress steps={STEPS} current={3} maxReached={3} />);
    for (const row of screen.getAllByRole("button")) {
      expect((row as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("tags an optional step and leaves the required ones untagged", () => {
    render(<ReactorProgress steps={STEPS} current={0} maxReached={0} />);
    expect(rowFor("Budgets").textContent).toContain("opt");
    expect(rowFor("Welcome").textContent).not.toContain("opt");
  });
});
