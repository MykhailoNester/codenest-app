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
import { agentStopTask } from "../../../lib/ipc";
import type { AgentFrame, AgentFrameKind } from "../../../lib/ipc";

// `useGitPaneStatus` registers a poller that reaches for Tauri; without the
// shell it resolves to no status, which is the branch these tests want (the git
// cell is covered by the shell-pane HUD's own tests). `agentStopTask` is this
// file's own mock: it is the function the orchestration panel's Stop button
// calls, and a factory mock throws on *access* of a missing named export, not
// only on a call — so it must be present even in a test that never clicks Stop.
vi.mock("../../../lib/ipc", () => ({
  isTauriAvailable: (): boolean => false,
  getGitPaneStatus: async (): Promise<null> => null,
  agentStopTask: vi.fn(async (): Promise<void> => undefined),
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

// --- Orchestration (Workflow-tool) fixtures, transcribed from the plan's
// wire evidence — same discipline as `taskState`/`withTask` above. ---

function orchestrationTaskStartedFrame(
  taskId: string,
  extra: Record<string, unknown> = {},
): AgentFrame {
  return frame("system", {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: "toolu_wf_1",
    description: "Two-phase probe",
    task_type: "local_workflow",
    workflow_name: "wire-probe",
    ...extra,
  });
}

function orchestrationProgressFrame(
  taskId: string,
  extra: Record<string, unknown> = {},
): AgentFrame {
  return frame("system", { type: "system", subtype: "task_progress", task_id: taskId, ...extra });
}

function orchestrationTerminalFrame(taskId: string, status: string): AgentFrame {
  return frame("system", { type: "system", subtype: "task_notification", task_id: taskId, status });
}

afterEach(() => {
  cleanup();
  // Additive: only the timer tests below mock the clock, but resetting is
  // always safe and keeps a future timer test from leaking into the next file.
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("AgentSessionHud", () => {
  it("shows only the status cell before the first turn reports anything", () => {
    render(<AgentSessionHud state={emptyConversation()} cwd={undefined} paneId="p1" />);

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
    render(<AgentSessionHud state={liveState()} cwd={undefined} paneId="p1" />);

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
    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);

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
    const live = render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    const liveStrip = screen.getByTestId("agent-session-hud");
    expect(liveStrip.querySelector('[data-cell="tool"]')?.textContent).toContain("Bash");
    expect(liveStrip.querySelector('[data-cell="thinking"]')).not.toBeNull();
    live.unmount();

    // Exited: the process is gone, so neither claim may survive.
    const dead = applyFrame(state, frame("exit", { exit_code: 0 }), 4_000);
    render(<AgentSessionHud state={dead} cwd={undefined} paneId="p1" />);
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
    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="perm"]')
        ?.textContent,
    ).toContain("1 awaiting approval");
  });

  it("names the sub-agent and its elapsed time while a Task is in flight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = taskState("planner-agent", "Plan the migration", 1_000_000 - 12_000);

    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    const cell = screen
      .getByTestId("agent-session-hud")
      .querySelector('[data-cell="subagent"]');
    expect(cell?.textContent).toContain("planner-agent");
    expect(cell?.textContent).toContain("12s");
  });

  it("a live Task owns the sub-agent cell and not the tool cell", () => {
    const state = taskState("planner-agent", "d", 1_000);

    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
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

    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
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

    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    const cell = screen
      .getByTestId("agent-session-hud")
      .querySelector('[data-cell="subagent"]');
    expect(cell?.textContent).toContain("2 sub-agents");
    // Timed from the oldest (toolu_a), not the newest.
    expect(cell?.textContent).toContain("20s");
  });

  it("the sub-agent cell disappears when the sub-agent completes", () => {
    let state = taskState("planner-agent", "d", 1_000);
    const { rerender } = render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="subagent"]'),
    ).not.toBeNull();

    state = applyFrame(state, taskResultFrame("toolu_sub", false), 2_000);
    rerender(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="subagent"]'),
    ).toBeNull();
    expect(screen.queryByTestId("agent-subagent-detail")).toBeNull();
  });

  it("the sub-agent cell disappears when it errors", () => {
    let state = taskState("planner-agent", "d", 1_000);
    const { rerender } = render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);

    state = applyFrame(state, taskResultFrame("toolu_sub", true), 2_000);
    rerender(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="subagent"]'),
    ).toBeNull();
    expect(screen.queryByTestId("agent-subagent-detail")).toBeNull();
  });

  it("renders no sub-agent cell on an exited session", () => {
    let state = taskState("planner-agent", "d", 1_000);
    state = applyFrame(state, frame("exit", { exit_code: 0 }), 4_000);

    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="subagent"]'),
    ).toBeNull();
  });

  it("renders no sub-agent cell and no detail panel when nothing is delegated", () => {
    render(<AgentSessionHud state={liveState()} cwd={undefined} paneId="p1" />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="subagent"]'),
    ).toBeNull();
    expect(screen.queryByTestId("agent-subagent-detail")).toBeNull();
  });

  it("clicking the cell expands the sub-agent detail and clicking again collapses it", () => {
    const state = taskState("planner-agent", "Plan the migration", 1_000);
    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);

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
    const { rerender } = render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);

    const button = screen
      .getByTestId("agent-session-hud")
      .querySelector('[data-cell="subagent"] button') as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    // The oldest call (toolu_a, the expanded one) finishes; toolu_b runs on.
    state = applyFrame(state, taskResultFrame("toolu_a", false), 3_000);
    rerender(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);

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

    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
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

  it("renders no orchestration cell and no panel when nothing is orchestrating", () => {
    render(<AgentSessionHud state={liveState()} cwd={undefined} paneId="p1" />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="orchestration"]'),
    ).toBeNull();
    expect(screen.queryByTestId("agent-orchestration-detail")).toBeNull();
  });

  it("names the orchestration and its phase and agent counts while it runs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000_000 - 5_000);
    state = applyFrame(
      state,
      orchestrationProgressFrame("wf1", {
        workflow_progress: [
          { type: "workflow_phase", index: 1, title: "Alpha" },
          { type: "workflow_phase", index: 2, title: "Beta" },
          { type: "workflow_agent", index: 1, label: "red", phaseIndex: 1, state: "done" },
          { type: "workflow_agent", index: 2, label: "blue", phaseIndex: 1, state: "start" },
        ],
      }),
      1_000_000 - 4_000,
    );

    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    const cell = screen
      .getByTestId("agent-session-hud")
      .querySelector('[data-cell="orchestration"]');
    expect(cell?.textContent).toContain("wire-probe");
    expect(cell?.textContent).toContain("2 phases");
    expect(cell?.textContent).toContain("1/2 agents");
    expect(cell?.textContent).toContain("5s");
  });

  it("omits the phase clause for a run that declared no phases", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = applyFrame(
      state,
      orchestrationProgressFrame("wf1", {
        workflow_progress: [{ type: "workflow_agent", index: 1, label: "red", state: "start" }],
      }),
      1_500,
    );

    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    const cell = screen
      .getByTestId("agent-session-hud")
      .querySelector('[data-cell="orchestration"]');
    expect(cell?.textContent).not.toContain("phase");
    expect(cell?.textContent).toContain("0/1 agents");
  });

  it("the orchestration cell disappears when the run completes", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    const { rerender } = render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="orchestration"]'),
    ).not.toBeNull();

    state = applyFrame(state, orchestrationTerminalFrame("wf1", "completed"), 2_000);
    rerender(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="orchestration"]'),
    ).toBeNull();
    expect(screen.queryByTestId("agent-orchestration-detail")).toBeNull();
  });

  it("renders no orchestration cell on an exited session", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = applyFrame(state, frame("exit", { exit_code: 0 }), 2_000);

    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="orchestration"]'),
    ).toBeNull();
  });

  it("clicking the cell expands the phase tree and clicking again collapses it", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = applyFrame(
      state,
      orchestrationProgressFrame("wf1", {
        usage: { total_tokens: 4_096 },
        workflow_progress: [
          { type: "workflow_phase", index: 1, title: "Alpha" },
          { type: "workflow_agent", index: 1, label: "red", phaseIndex: 1, state: "start" },
        ],
      }),
      1_500,
    );

    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    const button = screen
      .getByTestId("agent-session-hud")
      .querySelector('[data-cell="orchestration"] button') as HTMLButtonElement;
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const detail = screen.getByTestId("agent-orchestration-detail");
    expect(detail.textContent).toContain("wire-probe");
    expect(detail.textContent).toContain("1 phase");
    expect(detail.textContent).toContain("0/1 agents");
    expect(detail.textContent).toContain("4k");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("agent-orchestration-detail")).toBeNull();
  });

  it("the expanded panel lists each phase with one status-pilled row per agent", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = applyFrame(
      state,
      orchestrationProgressFrame("wf1", {
        workflow_progress: [
          { type: "workflow_phase", index: 1, title: "Alpha" },
          { type: "workflow_agent", index: 1, label: "red", phaseIndex: 1, state: "start" },
          { type: "workflow_agent", index: 2, label: "blue", phaseIndex: 1, state: "done" },
        ],
      }),
      1_500,
    );

    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    fireEvent.click(
      screen
        .getByTestId("agent-session-hud")
        .querySelector('[data-cell="orchestration"] button') as HTMLButtonElement,
    );

    const detail = screen.getByTestId("agent-orchestration-detail");
    // Scoped to the exact `.detailAgent` row class — `[class*="detailAgent_"]`
    // (trailing underscore) does not also match the sibling `.detailAgentLabel`
    // class the CSS-module hasher produces (same idiom as
    // `context-picker.test.tsx`'s `[class*='pickerRowTitle']`).
    const rows = detail.querySelectorAll('[class*="detailAgent_"]');
    expect(rows).toHaveLength(2);

    const runningPill = rows[0]?.querySelector(".d3-status");
    expect(runningPill?.className).toContain("d3-status--active");
    expect(runningPill?.querySelector(".d3-status__pulse")).not.toBeNull();

    const donePill = rows[1]?.querySelector(".d3-status");
    expect(donePill?.className).toContain("d3-status--active");
    expect(donePill?.querySelector(".d3-status__pulse")).toBeNull();
  });

  it("an errored agent renders the amber pill and its error text", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = applyFrame(
      state,
      orchestrationProgressFrame("wf1", {
        workflow_progress: [
          { type: "workflow_agent", index: 1, label: "red", state: "error", error: "boom" },
        ],
      }),
      1_500,
    );

    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    fireEvent.click(
      screen
        .getByTestId("agent-session-hud")
        .querySelector('[data-cell="orchestration"] button') as HTMLButtonElement,
    );

    const detail = screen.getByTestId("agent-orchestration-detail");
    const row = detail.querySelector('[class*="detailAgent_"]');
    const pill = row?.querySelector(".d3-status");
    expect(pill?.className).toContain("d3-status--idle");
    expect(row?.textContent).toContain("boom");
  });

  it("Stop calls agentStopTask with the pane id and the run's task_id, then disables itself", () => {
    const state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);

    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    fireEvent.click(
      screen
        .getByTestId("agent-session-hud")
        .querySelector('[data-cell="orchestration"] button') as HTMLButtonElement,
    );

    const stopButton = screen.getByText("Stop") as HTMLButtonElement;
    fireEvent.click(stopButton);

    expect(agentStopTask).toHaveBeenCalledWith("p1", "wf1");
    expect(agentStopTask).toHaveBeenCalledTimes(1);
    expect(stopButton.disabled).toBe(true);

    // A second click on the now-disabled button must not fire again.
    fireEvent.click(stopButton);
    expect(agentStopTask).toHaveBeenCalledTimes(1);

    // No optimistic status change (D9): the panel still reads the wire's own
    // "running" state, not a locally-guessed "stopped".
    expect(screen.getByTestId("agent-orchestration-detail").textContent).toContain("running");
  });

  it("the expansion resets itself when the expanded run ends", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = applyFrame(state, orchestrationTaskStartedFrame("wf2"), 2_000);
    const { rerender } = render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);

    const button = screen
      .getByTestId("agent-session-hud")
      .querySelector('[data-cell="orchestration"] button') as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    // The primary (oldest, wf1) run finishes; wf2 runs on.
    state = applyFrame(state, orchestrationTerminalFrame("wf1", "completed"), 3_000);
    rerender(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);

    expect(screen.queryByTestId("agent-orchestration-detail")).toBeNull();
    const strip = screen.getByTestId("agent-session-hud");
    const newButton = strip.querySelector('[data-cell="orchestration"] button');
    expect(newButton?.getAttribute("aria-expanded")).toBe("false");
  });

  it("a live Task and a live orchestration render as two separate cells", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = applyFrame(
      state,
      frame("tool_use", {
        message: {
          content: [
            { type: "tool_use", id: "toolu_task", name: "Task", input: { subagent_type: "planner" } },
          ],
        },
      }),
      1_500,
    );

    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    const strip = screen.getByTestId("agent-session-hud");
    expect(strip.querySelector('[data-cell="subagent"]')).not.toBeNull();
    expect(strip.querySelector('[data-cell="orchestration"]')).not.toBeNull();
  });

  it("the orchestration elapsed value ticks while the run is live", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000_000 - 1_000);

    render(<AgentSessionHud state={state} cwd={undefined} paneId="p1" />);
    const before = screen
      .getByTestId("agent-session-hud")
      .querySelector('[data-cell="orchestration"]')?.textContent;

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    const after = screen
      .getByTestId("agent-session-hud")
      .querySelector('[data-cell="orchestration"]')?.textContent;
    expect(after).not.toBe(before);
  });
});
