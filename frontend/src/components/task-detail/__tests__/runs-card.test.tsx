import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentRun } from "../../../lib/api";
import { RunsCard } from "../runs-card";

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    row_kind: "run",
    id: 1,
    session_id: null,
    provider_id: null,
    project_id: null,
    pane_id: null,
    model: null,
    prompt_preview: null,
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
    project_name: null,
    session_status: null,
    session_current_tool: null,
    session_tokens_in: null,
    session_tokens_out: null,
    session_cost_usd: null,
    session_initial_prompt: null,
    session_total_tool_calls: null,
    schedule_id: null,
    schedule_name: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("RunsCard", () => {
  it("renders one .td-run per run, newest-first order preserved", () => {
    // The component never re-sorts — it renders exactly the order it is
    // handed, so "newest first" is the caller's (the page's query) job.
    // Distinct `prompt_preview` values, not the formatted timestamp (which
    // is locale/timezone-dependent), are what this test tracks.
    const runs = [
      run({ id: 3, prompt_preview: "third-newest" }),
      run({ id: 2, prompt_preview: "second" }),
      run({ id: 1, prompt_preview: "first-oldest" }),
    ];
    const { container } = render(
      <RunsCard
        runs={runs}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        activeSessionId={null}
        onReplay={vi.fn()}
      />,
    );
    const rows = container.querySelectorAll(".td-run");
    expect(rows.length).toBe(3);
    expect(rows[0]?.textContent).toContain("third-newest");
    expect(rows[1]?.textContent).toContain("second");
    expect(rows[2]?.textContent).toContain("first-oldest");
  });

  it("the aggregate equals the sum of the rows shown", () => {
    const runs = [
      run({ id: 1, session_cost_usd: 0.1, session_total_tool_calls: 3 }),
      run({ id: 2, session_cost_usd: 0.2, session_total_tool_calls: 0 }),
      run({ id: 3, session_cost_usd: null, session_total_tool_calls: null }),
    ];
    const { container } = render(
      <RunsCard
        runs={runs}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        activeSessionId={null}
        onReplay={vi.fn()}
      />,
    );
    const aggregate = container.querySelector(".td-card__head .td-dim");
    expect(aggregate?.textContent).toBe("3 sessions · $0.30 · 3 calls");
  });

  it("empty state is the literal copy", () => {
    const { container } = render(
      <RunsCard
        runs={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        activeSessionId={null}
        onReplay={vi.fn()}
      />,
    );
    screen.getByText("No agent has run on this task yet.");
    expect(container.querySelector(".td-runs")).toBeNull();
  });

  it("loading and error states", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <RunsCard
        runs={[]}
        isLoading={true}
        isError={false}
        onRetry={onRetry}
        activeSessionId={null}
        onReplay={vi.fn()}
      />,
    );
    screen.getByText("Loading runs…");

    rerender(
      <RunsCard
        runs={[]}
        isLoading={false}
        isError={true}
        onRetry={onRetry}
        activeSessionId={null}
        onReplay={vi.fn()}
      />,
    );
    screen.getByText("Could not load agent runs.");
    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('a running run renders "running" and no duration number', () => {
    const { container } = render(
      <RunsCard
        runs={[run({ ended_at: null, status: "running" })]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        activeSessionId={null}
        onReplay={vi.fn()}
      />,
    );
    const meta = container.querySelector(".td-run__meta");
    expect(meta?.textContent).toMatch(/running/);
    expect(meta?.textContent).not.toMatch(/\d+m|\d+s/);
  });

  it("identity is the provider, never a member", () => {
    render(
      <RunsCard
        runs={[
          run({
            provider_display_name: "Claude Code",
            provider_name: "claude-code",
            profile: "work",
          }),
        ]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        activeSessionId={null}
        onReplay={vi.fn()}
      />,
    );
    screen.getByText("Claude Code");
    expect(screen.queryByText("work")).toBeNull();
  });

  it("a run with no provider row renders the dashed avatar with no initials", () => {
    const { container } = render(
      <RunsCard
        runs={[
          run({ provider_name: null, provider_display_name: null }),
        ]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        activeSessionId={null}
        onReplay={vi.fn()}
      />,
    );
    const dashed = container.querySelector(".td-av--none");
    expect(dashed).not.toBeNull();
    expect(dashed?.textContent).toBe("");
  });

  it("a run with no session_id offers no Replay", () => {
    render(
      <RunsCard
        runs={[run({ session_id: null })]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        activeSessionId={null}
        onReplay={vi.fn()}
      />,
    );
    expect(screen.queryByText("Replay")).toBeNull();
  });

  it("clicking Replay calls onReplay with the session id", () => {
    const onReplay = vi.fn();
    render(
      <RunsCard
        runs={[run({ session_id: "sess-42" })]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        activeSessionId={null}
        onReplay={onReplay}
      />,
    );
    fireEvent.click(screen.getByText("Replay"));
    expect(onReplay).toHaveBeenCalledWith("sess-42");
  });

  it("the active run's Replay button is aria-pressed", () => {
    render(
      <RunsCard
        runs={[run({ session_id: "sess-42" })]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        activeSessionId="sess-42"
        onReplay={vi.fn()}
      />,
    );
    expect(screen.getByText("Replay").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("a null cost renders no cost cell; a 0 cost renders $0.00", () => {
    const { container: withoutCost } = render(
      <RunsCard
        runs={[run({ session_cost_usd: null })]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        activeSessionId={null}
        onReplay={vi.fn()}
      />,
    );
    expect(withoutCost.querySelector(".td-run__cost")).toBeNull();
    cleanup();

    const { container: withZeroCost } = render(
      <RunsCard
        runs={[run({ session_cost_usd: 0 })]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        activeSessionId={null}
        onReplay={vi.fn()}
      />,
    );
    expect(withZeroCost.querySelector(".td-run__cost")?.textContent).toBe(
      "$0.00",
    );
  });
});
