import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TaskCost } from "../../../lib/api";
import { CostCard } from "../cost-card";

function cost(overrides: Partial<TaskCost> = {}): TaskCost {
  return {
    task_id: 267,
    cost_usd: 12.5,
    tokens_in: 120_000,
    tokens_out: 4_300,
    session_count: 3,
    by_launch: 2,
    by_branch: 1,
    reason: null,
    sessions: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("CostCard", () => {
  it("shows an em dash, not a zero, when nothing is attributed", () => {
    render(
      <CostCard
        cost={cost({
          cost_usd: null,
          tokens_in: null,
          tokens_out: null,
          session_count: 0,
          by_launch: 0,
          by_branch: 0,
          reason: "no session has been attributed to this task",
        })}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
    // and it names what would make the number appear
    expect(screen.getByText(/feature\/267/)).toBeTruthy();
  });

  it("shows the total and how much of it rests on branch inference", () => {
    render(
      <CostCard
        cost={cost()}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("$12.50")).toBeTruthy();
    expect(screen.getByText(/120.0k in/)).toBeTruthy();
    expect(screen.getByText(/2 launched, 1 by branch/)).toBeTruthy();
  });

  it("hides the split when every session was launched from the task", () => {
    render(
      <CostCard
        cost={cost({ session_count: 2, by_launch: 2, by_branch: 0 })}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByText(/by branch/)).toBeNull();
  });

  it("offers a retry on error", () => {
    const onRetry = vi.fn();
    render(
      <CostCard
        cost={undefined}
        isLoading={false}
        isError={true}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
