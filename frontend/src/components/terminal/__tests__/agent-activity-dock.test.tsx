// Zone B of the native agent pane. Most of this file's fixtures and cases are
// relocated verbatim from `agent-session-hud.test.tsx` (see the plan's case
// disposition table): the live-tool, sub-agent and orchestration cells moved
// here as the Tools/Agents/Workflows groups, along with the one Stop button
// in the app that ends a `Workflow` run without killing the whole session.
//
// Two cases changed on purpose rather than moving unchanged (D5): "the
// expansion resets itself when the expanded call/run ends" becomes "the group
// stays open and re-targets the next live call/run" — per-pane collapse state
// that survives re-render cannot also derive itself closed per-entity, and the
// ticket asks for the former.

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentActivityDock } from "../agent-activity-dock";
import {
  applyFrame,
  emptyConversation,
  type ConversationState,
} from "../../../lib/agent-conversation";
import { agentStopTask } from "../../../lib/ipc";
import type { AgentFrame, AgentFrameKind } from "../../../lib/ipc";

// Same mock shape as the (now trimmed) hud test's, plus `agentStopTask` —
// the Workflows group's Stop button calls it, and a factory mock throws on
// *access* of a missing named export, not only on a call, so it must be
// present even in a test that never clicks Stop.
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

/** A `tool_use` frame for one call — a plain `Bash`/`Read` unless overridden. */
function toolUseFrame(
  id: string,
  input: Record<string, unknown>,
  name = "Bash",
): AgentFrame {
  return frame("tool_use", {
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
}

/** The matching `tool_result` for a call started with `toolUseFrame`/`withTask`. */
function toolResultFrame(toolUseId: string, isError = false): AgentFrame {
  return frame("tool_result", {
    message: {
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "done", is_error: isError }],
    },
  });
}

/** Applies a `Task`/`Agent` tool_use frame to `state`, at wire time `startedAt`. */
function withTask(
  state: ConversationState,
  id: string,
  input: Record<string, unknown>,
  startedAt: number,
  toolName = "Task",
): ConversationState {
  return applyFrame(state, toolUseFrame(id, input, toolName), startedAt);
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
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("AgentActivityDock — presence and the metrics line", () => {
  it("renders nothing at all for a fresh session", () => {
    render(<AgentActivityDock state={emptyConversation()} cwd={undefined} paneId="p1" />);
    expect(screen.queryByTestId("agent-activity-dock")).toBeNull();
    expect(screen.queryByTestId("agent-session-hud")).toBeNull();
  });

  it("renders the metrics line once init reports a start", () => {
    render(<AgentActivityDock state={liveState()} cwd={undefined} paneId="p1" />);
    const dock = screen.getByTestId("agent-activity-dock");
    const strip = screen.getByTestId("agent-session-hud");
    expect(dock.contains(strip)).toBe(true);
    expect(strip.querySelector('[data-cell="elapsed"]')).not.toBeNull();
  });
});

describe("AgentActivityDock — Tools group", () => {
  it("states the grouped run and its live headline call", () => {
    let state = liveState();
    state = applyFrame(state, toolUseFrame("t1", { command: "ls" }), 3_000);
    state = applyFrame(state, toolUseFrame("t2", { command: "pwd" }), 3_100);
    state = applyFrame(state, toolUseFrame("t3", { file_path: "a.ts" }, "Read"), 3_200);

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    const group = screen.getByTestId("dock-group-tools");
    expect(group.textContent).toContain("Running 2 commands, reading 1 file");
    // Pins the reuse of `toolRunHeadline` — a second summariser would name a
    // different call or word the row differently and fail here.
    const toolRun = screen.getByTestId("dock-tool-run");
    expect(toolRun.textContent).toContain("Bash");
    expect(toolRun.textContent).toContain("ls");
  });

  it("renders no Tools group when nothing is in flight", () => {
    let state = liveState();
    state = applyFrame(state, toolUseFrame("t1", { command: "ls" }), 3_000);
    state = applyFrame(state, toolUseFrame("t2", { file_path: "a.ts" }, "Read"), 3_100);
    state = applyFrame(state, toolResultFrame("t1"), 3_200);
    state = applyFrame(state, toolResultFrame("t2"), 3_300);

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    expect(screen.queryByTestId("dock-group-tools")).toBeNull();
  });

  it("the Tools elapsed ticks while a call is in flight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = applyFrame(liveState(), toolUseFrame("t1", { command: "ls" }), 1_000_000 - 1_000);

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    const before = screen.getByTestId("dock-group-tools").textContent;

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    const after = screen.getByTestId("dock-group-tools").textContent;
    expect(after).not.toBe(before);
  });

  it("renders no Tools group on an exited session", () => {
    let state = applyFrame(liveState(), toolUseFrame("t1", { command: "ls" }), 3_000);
    const live = render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    expect(screen.getByTestId("dock-group-tools")).not.toBeNull();
    live.unmount();

    state = applyFrame(state, frame("exit", { exit_code: 0 }), 4_000);
    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    expect(screen.queryByTestId("dock-group-tools")).toBeNull();
  });
});

describe("AgentActivityDock — Agents group", () => {
  it("names the sub-agent and its elapsed time while a Task is in flight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = taskState("planner-agent", "Plan the migration", 1_000_000 - 12_000);

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    const group = screen.getByTestId("dock-group-agents");
    expect(group.textContent).toContain("planner-agent");
    expect(group.textContent).toContain("12s");
  });

  it("a live Task owns the Agents group and not the Tools group", () => {
    const state = taskState("planner-agent", "d", 1_000);

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    expect(screen.queryByTestId("dock-group-tools")).toBeNull();
    expect(screen.queryByTestId("dock-group-agents")).not.toBeNull();
  });

  it("a Bash alongside a Task renders both groups", () => {
    let state = taskState("planner-agent", "d", 1_000);
    state = applyFrame(state, toolUseFrame("toolu_bash", { command: "ls" }), 1_500);

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    expect(screen.getByTestId("dock-group-tools")).not.toBeNull();
    expect(screen.getByTestId("dock-group-agents")).not.toBeNull();
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

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    const group = screen.getByTestId("dock-group-agents");
    expect(group.textContent).toContain("2 sub-agents");
    // Timed from the oldest (toolu_a), not the newest.
    expect(group.textContent).toContain("20s");
  });

  it("the Agents group disappears when the sub-agent completes", () => {
    let state = taskState("planner-agent", "d", 1_000);
    const { rerender } = render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    expect(screen.getByTestId("dock-group-agents")).not.toBeNull();

    state = applyFrame(state, toolResultFrame("toolu_sub", false), 2_000);
    rerender(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    expect(screen.queryByTestId("dock-group-agents")).toBeNull();
    expect(screen.queryByTestId("agent-subagent-detail")).toBeNull();
  });

  it("the Agents group disappears when the sub-agent errors", () => {
    let state = taskState("planner-agent", "d", 1_000);
    const { rerender } = render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);

    state = applyFrame(state, toolResultFrame("toolu_sub", true), 2_000);
    rerender(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    expect(screen.queryByTestId("dock-group-agents")).toBeNull();
    expect(screen.queryByTestId("agent-subagent-detail")).toBeNull();
  });

  it("renders no Agents group on an exited session", () => {
    let state = taskState("planner-agent", "d", 1_000);
    state = applyFrame(state, frame("exit", { exit_code: 0 }), 4_000);

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    expect(screen.queryByTestId("dock-group-agents")).toBeNull();
  });

  it("renders no Agents group and no detail panel when nothing is delegated", () => {
    render(<AgentActivityDock state={liveState()} cwd={undefined} paneId="p1" />);
    expect(screen.queryByTestId("dock-group-agents")).toBeNull();
    expect(screen.queryByTestId("agent-subagent-detail")).toBeNull();
  });

  it("clicking the header expands the sub-agent detail and clicking again collapses it", () => {
    const state = taskState("planner-agent", "Plan the migration", 1_000);
    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);

    const button = screen
      .getByTestId("dock-group-agents")
      .querySelector("button") as HTMLButtonElement;
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

  it("the group stays open and re-targets the next live call when the expanded one ends", () => {
    let state = withTask(liveState(), "toolu_a", { subagent_type: "planner", description: "p" }, 1_000);
    state = withTask(state, "toolu_b", { subagent_type: "coder", description: "c" }, 2_000);
    const { rerender } = render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);

    const button = screen
      .getByTestId("dock-group-agents")
      .querySelector("button") as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    // The oldest call (toolu_a, the one showing) finishes; toolu_b runs on.
    state = applyFrame(state, toolResultFrame("toolu_a", false), 3_000);
    rerender(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);

    // The group stays open (D5) rather than deriving itself closed…
    const newButton = screen.getByTestId("dock-group-agents").querySelector("button");
    expect(newButton?.getAttribute("aria-expanded")).toBe("true");
    // …and its body now names the surviving call, not the dead one.
    const detail = screen.getByTestId("agent-subagent-detail");
    expect(detail.textContent).toContain("coder");
  });

  it("the elapsed value ticks while a sub-agent runs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = taskState("planner-agent", "d", 1_000_000 - 1_000);

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    const before = screen.getByTestId("dock-group-agents").textContent;

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    const after = screen.getByTestId("dock-group-agents").textContent;
    expect(after).not.toBe(before);
  });
});

describe("AgentActivityDock — Workflows group", () => {
  it("renders no Workflows group and no panel when nothing is orchestrating", () => {
    render(<AgentActivityDock state={liveState()} cwd={undefined} paneId="p1" />);
    expect(screen.queryByTestId("dock-group-workflows")).toBeNull();
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

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    const group = screen.getByTestId("dock-group-workflows");
    expect(group.textContent).toContain("wire-probe");
    expect(group.textContent).toContain("2 phases");
    expect(group.textContent).toContain("1/2 agents");
    expect(group.textContent).toContain("5s");
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

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    const group = screen.getByTestId("dock-group-workflows");
    expect(group.textContent).not.toContain("phase");
    expect(group.textContent).toContain("0/1 agents");
  });

  it("the Workflows group disappears when the run completes", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    const { rerender } = render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    expect(screen.getByTestId("dock-group-workflows")).not.toBeNull();

    state = applyFrame(state, orchestrationTerminalFrame("wf1", "completed"), 2_000);
    rerender(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    expect(screen.queryByTestId("dock-group-workflows")).toBeNull();
    expect(screen.queryByTestId("agent-orchestration-detail")).toBeNull();
  });

  it("renders no Workflows group on an exited session", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = applyFrame(state, frame("exit", { exit_code: 0 }), 2_000);

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    expect(screen.queryByTestId("dock-group-workflows")).toBeNull();
  });

  it("clicking the header expands the phase tree and clicking again collapses it", () => {
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

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    const button = screen
      .getByTestId("dock-group-workflows")
      .querySelector("button") as HTMLButtonElement;
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

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    fireEvent.click(
      screen.getByTestId("dock-group-workflows").querySelector("button") as HTMLButtonElement,
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

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    fireEvent.click(
      screen.getByTestId("dock-group-workflows").querySelector("button") as HTMLButtonElement,
    );

    const detail = screen.getByTestId("agent-orchestration-detail");
    const row = detail.querySelector('[class*="detailAgent_"]');
    const pill = row?.querySelector(".d3-status");
    expect(pill?.className).toContain("d3-status--idle");
    expect(row?.textContent).toContain("boom");
  });

  it("Stop calls agentStopTask with the pane id and the run's task_id, then disables itself", () => {
    const state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    fireEvent.click(
      screen.getByTestId("dock-group-workflows").querySelector("button") as HTMLButtonElement,
    );

    const stopButton = screen.getByText("Stop") as HTMLButtonElement;
    fireEvent.click(stopButton);

    expect(agentStopTask).toHaveBeenCalledWith("p1", "wf1");
    expect(agentStopTask).toHaveBeenCalledTimes(1);
    expect(stopButton.disabled).toBe(true);

    // A second click on the now-disabled button must not fire again.
    fireEvent.click(stopButton);
    expect(agentStopTask).toHaveBeenCalledTimes(1);

    // No optimistic status change: the panel still reads the wire's own
    // "running" state, not a locally-guessed "stopped".
    expect(screen.getByTestId("agent-orchestration-detail").textContent).toContain("running");
  });

  it("the group stays open and re-targets the next live run when the expanded one ends", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = applyFrame(state, orchestrationTaskStartedFrame("wf2"), 2_000);
    const { rerender } = render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);

    const button = screen
      .getByTestId("dock-group-workflows")
      .querySelector("button") as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    // The primary (oldest, wf1) run finishes; wf2 runs on.
    state = applyFrame(state, orchestrationTerminalFrame("wf1", "completed"), 3_000);
    rerender(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);

    // The group stays open (D5) rather than deriving itself closed, and its
    // body now names the surviving run, not the dead one.
    const newButton = screen.getByTestId("dock-group-workflows").querySelector("button");
    expect(newButton?.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("agent-orchestration-detail")).not.toBeNull();
  });

  it("a live Task and a live orchestration render as two separate groups", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = applyFrame(
      state,
      toolUseFrame("toolu_task", { subagent_type: "planner" }, "Task"),
      1_500,
    );

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    expect(screen.getByTestId("dock-group-agents")).not.toBeNull();
    expect(screen.getByTestId("dock-group-workflows")).not.toBeNull();
  });

  it("the elapsed value ticks while the run is live", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000_000 - 1_000);

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    const before = screen.getByTestId("dock-group-workflows").textContent;

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    const after = screen.getByTestId("dock-group-workflows").textContent;
    expect(after).not.toBe(before);
  });
});

describe("AgentActivityDock — collapse state and layout", () => {
  it("each group collapses independently and the state survives a re-render", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = applyFrame(state, toolUseFrame("t1", { command: "ls" }), 1_500);

    const { rerender } = render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);

    const toolsButton = screen
      .getByTestId("dock-group-tools")
      .querySelector("button") as HTMLButtonElement;
    fireEvent.click(toolsButton); // Tools defaults open (D9) — this collapses it.
    expect(toolsButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("dock-tool-run")).toBeNull();

    // Workflows defaults collapsed and is untouched by the Tools click.
    const workflowsButton = screen
      .getByTestId("dock-group-workflows")
      .querySelector("button");
    expect(workflowsButton?.getAttribute("aria-expanded")).toBe("false");

    // A fresh state object (same content, new reference) — the collapse flags
    // are component state, not something re-derived from `state` on the fly.
    const freshState: ConversationState = { ...state };
    rerender(<AgentActivityDock state={freshState} cwd={undefined} paneId="p1" />);

    const toolsButtonAfter = screen
      .getByTestId("dock-group-tools")
      .querySelector("button");
    expect(toolsButtonAfter?.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("dock-tool-run")).toBeNull();
    const workflowsButtonAfter = screen
      .getByTestId("dock-group-workflows")
      .querySelector("button");
    expect(workflowsButtonAfter?.getAttribute("aria-expanded")).toBe("false");
  });

  it("collapse state survives a phase with nothing to report", () => {
    let state = liveState();
    state = applyFrame(state, toolUseFrame("t1", { command: "ls" }), 1_500);
    const { rerender } = render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);

    const toolsButton = screen
      .getByTestId("dock-group-tools")
      .querySelector("button") as HTMLButtonElement;
    fireEvent.click(toolsButton);
    expect(toolsButton.getAttribute("aria-expanded")).toBe("false");

    // The call resolves — no Tools group at all for this render, but the
    // dock itself stays mounted (the metrics line still has something to
    // show), so the collapse flag is not reset by a remount.
    const resolved = applyFrame(state, toolResultFrame("t1", false), 2_000);
    rerender(<AgentActivityDock state={resolved} cwd={undefined} paneId="p1" />);
    expect(screen.queryByTestId("dock-group-tools")).toBeNull();

    // A new live run starts — the group reappears still collapsed.
    const again = applyFrame(resolved, toolUseFrame("t2", { command: "pwd" }), 3_000);
    rerender(<AgentActivityDock state={again} cwd={undefined} paneId="p1" />);
    const toolsButtonAgain = screen
      .getByTestId("dock-group-tools")
      .querySelector("button");
    expect(toolsButtonAgain?.getAttribute("aria-expanded")).toBe("false");
  });

  it("a busy dock keeps its group stack in one internally-scrolling box", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = withTask(state, "toolu_sub", { subagent_type: "planner", description: "d" }, 1_500);
    state = applyFrame(state, toolUseFrame("t1", { command: "ls" }), 2_000);

    render(<AgentActivityDock state={state} cwd={undefined} paneId="p1" />);
    const toolsGroup = screen.getByTestId("dock-group-tools");
    const agentsGroup = screen.getByTestId("dock-group-agents");
    const workflowsGroup = screen.getByTestId("dock-group-workflows");
    const strip = screen.getByTestId("agent-session-hud");
    const dock = screen.getByTestId("agent-activity-dock");

    const container = toolsGroup.parentElement;
    expect(container).not.toBeNull();
    expect(container).toBe(agentsGroup.parentElement);
    expect(container).toBe(workflowsGroup.parentElement);
    // The scroll box is its own element, distinct from the dock root and never
    // an ancestor of the metrics strip — the strip must stay pinned even while
    // the group stack scrolls.
    expect(container).not.toBe(dock);
    expect(container?.contains(strip)).toBe(false);
  });
});
