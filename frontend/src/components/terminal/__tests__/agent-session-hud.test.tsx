// The agent pane's status strip renders from stream-json frames rather than
// from the sidecar's hook-derived HUD rows, so its honesty contract has to be
// pinned here: every cell shows a fact the wire reported, and a fact the wire
// has not reported yet produces no cell at all — never a zero, a dash, or a
// percentage against an invented denominator.

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentSessionHud } from "../agent-session-hud";
import {
  applyFrame,
  emptyConversation,
  type ConversationState,
} from "../../../lib/agent-conversation";
import type { AgentFrame, AgentFrameKind } from "../../../lib/ipc";

// `useGitPaneStatus` registers a poller that reaches for Tauri; without the
// shell it resolves to no status, which is the branch these tests want (the git
// cell is covered by the shell-pane HUD's own tests).
vi.mock("../../../lib/ipc", () => ({
  isTauriAvailable: (): boolean => false,
  getGitPaneStatus: async (): Promise<null> => null,
}));

function frame(kind: AgentFrameKind, raw: unknown): AgentFrame {
  return { pane_id: "p1", session_id: "s1", kind, raw };
}

/** A session that has initialised and completed one turn. */
function liveState(): ConversationState {
  let state = applyFrame(emptyConversation(), frame("init", { model: "claude-opus-5" }), 1_000);
  state = applyFrame(
    state,
    frame("result", {
      is_error: false,
      total_cost_usd: 0.25,
      duration_ms: 1200,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 1_990,
        cache_read_input_tokens: 8_000,
        output_tokens: 40,
      },
      modelUsage: { "claude-opus-5": { contextWindow: 200_000 } },
    }),
    2_000,
  );
  return state;
}

/** Applies a `Task`/`Agent` tool_use frame to `state`, at wire time `startedAt`. */
function withTask(
  state: ConversationState,
  id: string,
  input: Record<string, unknown>,
  startedAt: number,
  toolName = "Task",
): ConversationState {
  return applyFrame(
    state,
    frame("tool_use", {
      message: { content: [{ type: "tool_use", id, name: toolName, input }] },
    }),
    startedAt,
  );
}

/** `liveState()` plus a single in-flight sub-agent call, `toolu_sub`. */
function taskState(
  subagentType: string | null,
  description: string | null,
  startedAt: number,
  toolName = "Task",
): ConversationState {
  const input: Record<string, unknown> = {};
  if (subagentType !== null) input.subagent_type = subagentType;
  if (description !== null) input.description = description;
  return withTask(liveState(), "toolu_sub", input, startedAt, toolName);
}

function taskResultFrame(toolUseId: string, isError = false): AgentFrame {
  return frame("tool_result", {
    message: {
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "done", is_error: isError }],
    },
  });
}

afterEach(() => {
  cleanup();
  // Additive: only the timer tests below mock the clock, but resetting is
  // always safe and keeps a future timer test from leaking into the next file.
  vi.useRealTimers();
});

describe("AgentSessionHud", () => {
  it("shows only the status cell before the first turn reports anything", () => {
    render(<AgentSessionHud state={emptyConversation()} cwd={undefined} />);

    const strip = screen.getByTestId("agent-session-hud");
    expect(strip.textContent).toContain("starting");
    // No usage, no cost, no init yet — so no ctx, tokens, cost or elapsed cell.
    expect(strip.querySelector('[data-cell="ctx"]')).toBeNull();
    expect(strip.querySelector('[data-cell="tokens"]')).toBeNull();
    expect(strip.querySelector('[data-cell="cost"]')).toBeNull();
    expect(strip.querySelector('[data-cell="elapsed"]')).toBeNull();
    // A session that has not started yet is dimmed, like a shell pane with no
    // session bound.
    expect(strip.dataset.dimmed).toBe("true");
  });

  it("renders context, tokens, cost and elapsed once a result frame reports them", () => {
    render(<AgentSessionHud state={liveState()} cwd={undefined} />);

    const strip = screen.getByTestId("agent-session-hud");
    expect(strip.dataset.dimmed).toBe("false");
    // 10 + 1990 + 8000 = 10k of a 200k window = 5%.
    expect(strip.querySelector('[data-cell="ctx"]')?.textContent).toContain("5%");
    expect(strip.querySelector('[data-cell="tokens"]')?.textContent).toBe("10k/200k");
    expect(strip.querySelector('[data-cell="cost"]')?.textContent).toContain("0.25");
    expect(strip.querySelector('[data-cell="elapsed"]')).not.toBeNull();
  });

  it("omits the percentage when the frame named no context window", () => {
    const state = applyFrame(
      liveState(),
      frame("result", { usage: { input_tokens: 500 }, modelUsage: {} }),
      3_000,
    );
    render(<AgentSessionHud state={state} cwd={undefined} />);

    const strip = screen.getByTestId("agent-session-hud");
    expect(strip.querySelector('[data-cell="ctx"]')).toBeNull();
    expect(strip.querySelector('[data-cell="tokens"]')?.textContent).not.toContain("%");
  });

  it("never claims a tool is running or thinking on an exited session", () => {
    let state = applyFrame(
      liveState(),
      frame("tool_use", {
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
        },
      }),
      3_000,
    );
    state = applyFrame(state, frame("system", { subtype: "thinking_tokens", estimated_tokens: 40 }), 3_100);

    // Live: both cells present — the tool call has no result yet.
    const live = render(<AgentSessionHud state={state} cwd={undefined} />);
    const liveStrip = screen.getByTestId("agent-session-hud");
    expect(liveStrip.querySelector('[data-cell="tool"]')?.textContent).toContain("Bash");
    expect(liveStrip.querySelector('[data-cell="thinking"]')).not.toBeNull();
    live.unmount();

    // Exited: the process is gone, so neither claim may survive.
    const dead = applyFrame(state, frame("exit", { exit_code: 0 }), 4_000);
    render(<AgentSessionHud state={dead} cwd={undefined} />);
    const deadStrip = screen.getByTestId("agent-session-hud");
    expect(deadStrip.querySelector('[data-cell="tool"]')).toBeNull();
    expect(deadStrip.querySelector('[data-cell="thinking"]')).toBeNull();
    expect(deadStrip.dataset.dimmed).toBe("true");
  });

  it("surfaces a pending permission count", () => {
    const state = applyFrame(
      liveState(),
      frame("permission", {
        request_id: "req_1",
        request: { tool_name: "Bash", input: { command: "rm -rf /" } },
      }),
      3_000,
    );
    render(<AgentSessionHud state={state} cwd={undefined} />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="perm"]')
        ?.textContent,
    ).toContain("1 awaiting approval");
  });

  it("names the sub-agent and its elapsed time while a Task is in flight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = taskState("planner-agent", "Plan the migration", 1_000_000 - 12_000);

    render(<AgentSessionHud state={state} cwd={undefined} />);
    const cell = screen
      .getByTestId("agent-session-hud")
      .querySelector('[data-cell="subagent"]');
    expect(cell?.textContent).toContain("planner-agent");
    expect(cell?.textContent).toContain("12s");
  });

  it("a live Task owns the sub-agent cell and not the tool cell", () => {
    const state = taskState("planner-agent", "d", 1_000);

    render(<AgentSessionHud state={state} cwd={undefined} />);
    const strip = screen.getByTestId("agent-session-hud");
    expect(strip.querySelector('[data-cell="tool"]')).toBeNull();
    expect(strip.querySelector('[data-cell="subagent"]')).not.toBeNull();
  });

  it("a Bash alongside a Task renders both cells", () => {
    let state = taskState("planner-agent", "d", 1_000);
    state = applyFrame(
      state,
      frame("tool_use", {
        message: {
          content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "ls" } }],
        },
      }),
      1_500,
    );

    render(<AgentSessionHud state={state} cwd={undefined} />);
    const strip = screen.getByTestId("agent-session-hud");
    expect(strip.querySelector('[data-cell="tool"]')?.textContent).toContain("Bash");
    expect(strip.querySelector('[data-cell="subagent"]')).not.toBeNull();
  });

  it("counts concurrent sub-agents and times from the oldest", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let state = withTask(
      liveState(),
      "toolu_a",
      { subagent_type: "planner", description: "p" },
      1_000_000 - 20_000,
    );
    state = withTask(
      state,
      "toolu_b",
      { subagent_type: "coder", description: "c" },
      1_000_000 - 5_000,
    );

    render(<AgentSessionHud state={state} cwd={undefined} />);
    const cell = screen
      .getByTestId("agent-session-hud")
      .querySelector('[data-cell="subagent"]');
    expect(cell?.textContent).toContain("2 sub-agents");
    // Timed from the oldest (toolu_a), not the newest.
    expect(cell?.textContent).toContain("20s");
  });

  it("the sub-agent cell disappears when the sub-agent completes", () => {
    let state = taskState("planner-agent", "d", 1_000);
    const { rerender } = render(<AgentSessionHud state={state} cwd={undefined} />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="subagent"]'),
    ).not.toBeNull();

    state = applyFrame(state, taskResultFrame("toolu_sub", false), 2_000);
    rerender(<AgentSessionHud state={state} cwd={undefined} />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="subagent"]'),
    ).toBeNull();
    expect(screen.queryByTestId("agent-subagent-detail")).toBeNull();
  });

  it("the sub-agent cell disappears when it errors", () => {
    let state = taskState("planner-agent", "d", 1_000);
    const { rerender } = render(<AgentSessionHud state={state} cwd={undefined} />);

    state = applyFrame(state, taskResultFrame("toolu_sub", true), 2_000);
    rerender(<AgentSessionHud state={state} cwd={undefined} />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="subagent"]'),
    ).toBeNull();
    expect(screen.queryByTestId("agent-subagent-detail")).toBeNull();
  });

  it("renders no sub-agent cell on an exited session", () => {
    let state = taskState("planner-agent", "d", 1_000);
    state = applyFrame(state, frame("exit", { exit_code: 0 }), 4_000);

    render(<AgentSessionHud state={state} cwd={undefined} />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="subagent"]'),
    ).toBeNull();
  });

  it("renders no sub-agent cell and no detail panel when nothing is delegated", () => {
    render(<AgentSessionHud state={liveState()} cwd={undefined} />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="subagent"]'),
    ).toBeNull();
    expect(screen.queryByTestId("agent-subagent-detail")).toBeNull();
  });

  it("clicking the cell expands the sub-agent detail and clicking again collapses it", () => {
    const state = taskState("planner-agent", "Plan the migration", 1_000);
    render(<AgentSessionHud state={state} cwd={undefined} />);

    const button = screen
      .getByTestId("agent-session-hud")
      .querySelector('[data-cell="subagent"] button') as HTMLButtonElement;
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const detail = screen.getByTestId("agent-subagent-detail");
    expect(detail.textContent).toContain("planner-agent");
    expect(detail.textContent).toContain("Plan the migration");
    expect(detail.textContent).toContain("running");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("agent-subagent-detail")).toBeNull();
  });

  it("the expansion resets itself when the expanded call ends", () => {
    let state = withTask(
      liveState(),
      "toolu_a",
      { subagent_type: "planner", description: "p" },
      1_000,
    );
    state = withTask(
      state,
      "toolu_b",
      { subagent_type: "coder", description: "c" },
      2_000,
    );
    const { rerender } = render(<AgentSessionHud state={state} cwd={undefined} />);

    const button = screen
      .getByTestId("agent-session-hud")
      .querySelector('[data-cell="subagent"] button') as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    // The oldest call (toolu_a, the expanded one) finishes; toolu_b runs on.
    state = applyFrame(state, taskResultFrame("toolu_a", false), 3_000);
    rerender(<AgentSessionHud state={state} cwd={undefined} />);

    expect(screen.queryByTestId("agent-subagent-detail")).toBeNull();
    const strip = screen.getByTestId("agent-session-hud");
    const newButton = strip.querySelector('[data-cell="subagent"] button');
    expect(newButton?.getAttribute("aria-expanded")).toBe("false");
    expect(strip.querySelector('[data-cell="subagent"]')?.textContent).toContain("coder");
  });

  it("the elapsed value ticks while a sub-agent runs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = taskState("planner-agent", "d", 1_000_000 - 1_000);

    render(<AgentSessionHud state={state} cwd={undefined} />);
    const before = screen
      .getByTestId("agent-session-hud")
      .querySelector('[data-cell="subagent"]')?.textContent;

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    const after = screen
      .getByTestId("agent-session-hud")
      .querySelector('[data-cell="subagent"]')?.textContent;
    expect(after).not.toBe(before);
  });
});
