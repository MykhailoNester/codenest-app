// Zone B of the native agent pane. Most of this file's fixtures and cases are
// relocated verbatim from `agent-session-hud.test.tsx` (see the plan's case
// disposition table): the live-tool, sub-agent and orchestration cells moved
// here as the Tools/Agents/Workflows groups, along with the one Stop button
// in the app that ends a `Workflow` run without killing the whole session.
//
// #21 replaced the Agents/Workflows group *bodies* — a single "primary
// entity" detail panel — with one row per delegation/run/phase-agent, so most
// of this file's cases now read those rows (`dock-agent-row(s)`,
// `dock-workflow-row(s)`, `dock-workflow-agent-row`) instead of the old
// `agent-subagent-detail` / `agent-orchestration-detail` panels, which no
// longer exist. The `dock()` helper below supplies the dock's required
// `selectedView`/`onSelectView` pair so every case doesn't have to.
//
// Three cases changed on purpose rather than moving unchanged: "the Agents/
// Workflows group disappears when its call/run completes [/ on an exited
// session]" becomes "…stays listed…" — the ticket's whole point is that a
// finished entity keeps its row. "The group stays open and re-targets the
// next live call/run" becomes "…and both stay listed…" for the same reason.

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { AgentActivityDock } from "../agent-activity-dock";
import {
  applyFrame,
  emptyConversation,
  type ConversationState,
} from "../../../lib/agent-conversation";
import { MAIN_VIEW, viewKey, type AgentViewId } from "../../../lib/agent-views";
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

const noop = (): void => undefined;

/** Wraps `<AgentActivityDock/>` with the required `selectedView`/
 *  `onSelectView` pair, plus the four keyboard-cursor props #22 added — every
 *  case renders through this rather than the component directly, so the
 *  dock's now-mandatory props don't have to be repeated at every call site.
 *  Defaults match "no cursor, no pending focus request, nobody listening" —
 *  the common case for every test that isn't specifically exercising #22. */
function dock(
  state: ConversationState,
  over: {
    selectedView?: AgentViewId;
    onSelectView?: (id: AgentViewId) => void;
    highlightedKey?: string | null;
    focusRequest?: { key: string; token: number } | null;
    onHighlightChange?: (key: string | null, opts?: { focus?: boolean }) => void;
    onReturnFocus?: () => void;
  } = {},
): ReactElement {
  return (
    <AgentActivityDock
      state={state}
      cwd={undefined}
      paneId="p1"
      selectedView={over.selectedView ?? MAIN_VIEW}
      onSelectView={over.onSelectView ?? noop}
      highlightedKey={over.highlightedKey ?? null}
      focusRequest={over.focusRequest ?? null}
      onHighlightChange={over.onHighlightChange ?? noop}
      onReturnFocus={over.onReturnFocus ?? noop}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("AgentActivityDock — presence and the metrics line", () => {
  it("renders nothing at all for a fresh session", () => {
    render(dock(emptyConversation()));
    expect(screen.queryByTestId("agent-activity-dock")).toBeNull();
    expect(screen.queryByTestId("agent-session-hud")).toBeNull();
  });

  it("renders the metrics line once init reports a start", () => {
    render(dock(liveState()));
    const dockEl = screen.getByTestId("agent-activity-dock");
    const strip = screen.getByTestId("agent-session-hud");
    expect(dockEl.contains(strip)).toBe(true);
    expect(strip.querySelector('[data-cell="elapsed"]')).not.toBeNull();
  });
});

describe("AgentActivityDock — Tools group", () => {
  it("states the grouped run and its live headline call", () => {
    let state = liveState();
    state = applyFrame(state, toolUseFrame("t1", { command: "ls" }), 3_000);
    state = applyFrame(state, toolUseFrame("t2", { command: "pwd" }), 3_100);
    state = applyFrame(state, toolUseFrame("t3", { file_path: "a.ts" }, "Read"), 3_200);

    render(dock(state));
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

    render(dock(state));
    expect(screen.queryByTestId("dock-group-tools")).toBeNull();
  });

  it("the Tools elapsed ticks while a call is in flight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = applyFrame(liveState(), toolUseFrame("t1", { command: "ls" }), 1_000_000 - 1_000);

    render(dock(state));
    const before = screen.getByTestId("dock-group-tools").textContent;

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    const after = screen.getByTestId("dock-group-tools").textContent;
    expect(after).not.toBe(before);
  });

  it("renders no Tools group on an exited session", () => {
    let state = applyFrame(liveState(), toolUseFrame("t1", { command: "ls" }), 3_000);
    const live = render(dock(state));
    expect(screen.getByTestId("dock-group-tools")).not.toBeNull();
    live.unmount();

    state = applyFrame(state, frame("exit", { exit_code: 0 }), 4_000);
    render(dock(state));
    expect(screen.queryByTestId("dock-group-tools")).toBeNull();
  });
});

describe("AgentActivityDock — Agents group", () => {
  it("names the sub-agent and its elapsed time while a Task is in flight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = taskState("planner-agent", "Plan the migration", 1_000_000 - 12_000);

    render(dock(state));
    const group = screen.getByTestId("dock-group-agents");
    expect(group.textContent).toContain("planner-agent");
    expect(group.textContent).toContain("12s");
  });

  it("a live Task owns the Agents group and not the Tools group", () => {
    const state = taskState("planner-agent", "d", 1_000);

    render(dock(state));
    expect(screen.queryByTestId("dock-group-tools")).toBeNull();
    expect(screen.queryByTestId("dock-group-agents")).not.toBeNull();
  });

  it("a Bash alongside a Task renders both groups", () => {
    let state = taskState("planner-agent", "d", 1_000);
    state = applyFrame(state, toolUseFrame("toolu_bash", { command: "ls" }), 1_500);

    render(dock(state));
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

    render(dock(state));
    const group = screen.getByTestId("dock-group-agents");
    expect(group.textContent).toContain("2 sub-agents");
    // Timed from the oldest (toolu_a), not the newest.
    expect(group.textContent).toContain("20s");
  });

  it("a completed sub-agent stays listed, marked done", () => {
    let state = taskState("planner-agent", "d", 1_000);
    const { rerender } = render(dock(state));
    expect(screen.getByTestId("dock-group-agents")).not.toBeNull();

    state = applyFrame(state, toolResultFrame("toolu_sub", false), 2_000);
    rerender(dock(state));
    // The group and its row survive completion — the opposite of the old
    // "disappears when the sub-agent completes" behaviour this case pinned.
    expect(screen.getByTestId("dock-group-agents")).not.toBeNull();

    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );
    const row = screen.getByTestId("dock-agent-row");
    expect(row.querySelector('[class*="dotDone"]')).not.toBeNull();
    expect(row.textContent).toContain("1.0s");
    expect(row.textContent).not.toContain("running");
  });

  it("a failed sub-agent stays listed with a failed dot", () => {
    let state = taskState("planner-agent", "d", 1_000);
    const { rerender } = render(dock(state));

    state = applyFrame(state, toolResultFrame("toolu_sub", true), 2_000);
    rerender(dock(state));
    expect(screen.getByTestId("dock-group-agents")).not.toBeNull();

    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );
    const row = screen.getByTestId("dock-agent-row");
    expect(row.querySelector('[class*="dotFailed"]')).not.toBeNull();
  });

  it("an exited session still lists its delegations and calls none of them running", () => {
    let state = taskState("planner-agent", "d", 1_000);
    state = applyFrame(state, frame("exit", { exit_code: 0 }), 4_000);

    render(dock(state));
    const group = screen.getByTestId("dock-group-agents");
    expect(group).not.toBeNull();

    fireEvent.click(group.querySelector("button") as HTMLButtonElement);
    const row = screen.getByTestId("dock-agent-row");
    // The wire never reported this call's end (the process died first), so
    // the row reads "ended", never "running" and never "done".
    expect(row.querySelector('[class*="dotEnded"]')).not.toBeNull();
    expect(row.textContent).not.toContain("running");
  });

  it("renders no Agents group and no detail panel when nothing is delegated", () => {
    render(dock(liveState()));
    expect(screen.queryByTestId("dock-group-agents")).toBeNull();
    expect(screen.queryByTestId("agent-subagent-detail")).toBeNull();
  });

  it("clicking the header expands the sub-agent detail and clicking again collapses it", () => {
    const state = taskState("planner-agent", "Plan the migration", 1_000);
    render(dock(state));

    const button = screen
      .getByTestId("dock-group-agents")
      .querySelector("button") as HTMLButtonElement;
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const rows = screen.getByTestId("dock-agent-rows");
    expect(rows.textContent).toContain("planner-agent");
    expect(rows.textContent).toContain("Plan the migration");
    expect(rows.textContent).toContain("running");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("dock-agent-rows")).toBeNull();
  });

  it("the group stays open and both calls stay listed when the older one ends", () => {
    let state = withTask(liveState(), "toolu_a", { subagent_type: "planner", description: "p" }, 1_000);
    state = withTask(state, "toolu_b", { subagent_type: "coder", description: "c" }, 2_000);
    const { rerender } = render(dock(state));

    const button = screen
      .getByTestId("dock-group-agents")
      .querySelector("button") as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    // The oldest call (toolu_a) finishes; toolu_b runs on.
    state = applyFrame(state, toolResultFrame("toolu_a", false), 3_000);
    rerender(dock(state));

    // The group stays open (D5) rather than deriving itself closed…
    const newButton = screen.getByTestId("dock-group-agents").querySelector("button");
    expect(newButton?.getAttribute("aria-expanded")).toBe("true");
    // …and its body still names both calls, not just the survivor.
    const rows = screen.getByTestId("dock-agent-rows");
    expect(rows.textContent).toContain("planner");
    expect(rows.textContent).toContain("coder");
  });

  it("the elapsed value ticks while a sub-agent runs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = taskState("planner-agent", "d", 1_000_000 - 1_000);

    render(dock(state));
    const before = screen.getByTestId("dock-group-agents").textContent;

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    const after = screen.getByTestId("dock-group-agents").textContent;
    expect(after).not.toBe(before);
  });
});

describe("AgentActivityDock — Agents group rows", () => {
  it("five parallel sub-agents of the same type render five individually identifiable rows", () => {
    let state = liveState();
    const descriptions = ["Scan A", "Scan B", "Scan C", "Scan D", "Scan E"];
    descriptions.forEach((description, i) => {
      state = withTask(
        state,
        `toolu_${i}`,
        { subagent_type: "general-purpose", description },
        1_000 + i,
      );
    });

    render(dock(state));
    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );

    expect(screen.getAllByTestId("dock-agent-row")).toHaveLength(5);
    const rowsText = screen.getByTestId("dock-agent-rows").textContent ?? "";
    for (const description of descriptions) {
      expect(rowsText).toContain(description);
    }
  });

  it("a running row reads the word running; a finished row reads its exact duration", () => {
    let state = withTask(liveState(), "toolu_a", { subagent_type: "planner", description: "p" }, 1_000);
    state = applyFrame(state, toolResultFrame("toolu_a", false), 3_000);
    state = withTask(state, "toolu_b", { subagent_type: "coder", description: "c" }, 4_000);

    render(dock(state));
    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );

    const rows = screen.getAllByTestId("dock-agent-row");
    expect(rows[0]?.textContent).toContain("2.0s");
    expect(rows[0]?.textContent).not.toContain("running");
    expect(rows[1]?.textContent).toContain("running");
  });

  it("row order does not change when a running agent finishes", () => {
    let state = withTask(liveState(), "toolu_a", { subagent_type: "planner", description: "p" }, 1_000);
    state = withTask(state, "toolu_b", { subagent_type: "coder", description: "c" }, 2_000);
    const { rerender } = render(dock(state));
    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );

    const before = screen
      .getAllByTestId("dock-agent-row")
      .map((row) => row.getAttribute("data-view-key"));

    state = applyFrame(state, toolResultFrame("toolu_a", false), 3_000);
    rerender(dock(state));

    const after = screen
      .getAllByTestId("dock-agent-row")
      .map((row) => row.getAttribute("data-view-key"));
    expect(after).toEqual(before);
  });

  it("clicking an agent row asks the pane to show that sub-agent", () => {
    const state = taskState("planner-agent", "d", 1_000);
    const onSelectView = vi.fn();
    render(dock(state, { onSelectView }));
    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );

    fireEvent.click(
      screen.getByTestId("dock-agent-row").querySelector("button") as HTMLButtonElement,
    );
    expect(onSelectView).toHaveBeenCalledTimes(1);
    expect(onSelectView).toHaveBeenCalledWith({ kind: "subagent", id: "toolu_sub" });
  });
});

describe("AgentActivityDock — Workflows group", () => {
  it("renders no Workflows group and no panel when nothing is orchestrating", () => {
    render(dock(liveState()));
    expect(screen.queryByTestId("dock-group-workflows")).toBeNull();
    expect(screen.queryByTestId("dock-workflow-rows")).toBeNull();
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

    render(dock(state));
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

    render(dock(state));
    const group = screen.getByTestId("dock-group-workflows");
    expect(group.textContent).not.toContain("phase");
    expect(group.textContent).toContain("0/1 agents");
  });

  it("a completed run stays listed and stops offering Stop", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    const { rerender } = render(dock(state));
    expect(screen.getByTestId("dock-group-workflows")).not.toBeNull();

    state = applyFrame(state, orchestrationTerminalFrame("wf1", "completed"), 2_000);
    rerender(dock(state));
    // The group and its row survive completion — the opposite of the old
    // "disappears when the run completes" behaviour this case pinned.
    expect(screen.getByTestId("dock-group-workflows")).not.toBeNull();

    fireEvent.click(
      screen.getByTestId("dock-group-workflows").querySelector("button") as HTMLButtonElement,
    );
    expect(screen.getByTestId("dock-workflow-rows")).not.toBeNull();
    expect(screen.queryByText("Stop")).toBeNull();
  });

  it("an exited session still lists its runs and calls none of them running", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = applyFrame(state, frame("exit", { exit_code: 0 }), 2_000);

    render(dock(state));
    const group = screen.getByTestId("dock-group-workflows");
    expect(group).not.toBeNull();

    fireEvent.click(group.querySelector("button") as HTMLButtonElement);
    const row = screen.getByTestId("dock-workflow-row");
    expect(row.querySelector('[class*="dotEnded"]')).not.toBeNull();
    expect(screen.queryByText("Stop")).toBeNull();
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

    render(dock(state));
    const button = screen
      .getByTestId("dock-group-workflows")
      .querySelector("button") as HTMLButtonElement;
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const rows = screen.getByTestId("dock-workflow-rows");
    expect(rows.textContent).toContain("wire-probe");
    expect(rows.textContent).toContain("1 phase");
    expect(rows.textContent).toContain("0/1 agents");
    expect(rows.textContent).toContain("4k");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("dock-workflow-rows")).toBeNull();
  });

  it("the expanded panel lists each phase with one dot-marked row per agent", () => {
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

    render(dock(state));
    fireEvent.click(
      screen.getByTestId("dock-group-workflows").querySelector("button") as HTMLButtonElement,
    );

    const rows = screen.getAllByTestId("dock-workflow-agent-row");
    expect(rows).toHaveLength(2);

    expect(rows[0]?.querySelector('[class*="dotRunning"]')).not.toBeNull();
    expect(rows[0]?.querySelector(".d3-status__pulse")).not.toBeNull();

    expect(rows[1]?.querySelector('[class*="dotDone"]')).not.toBeNull();
    expect(rows[1]?.querySelector(".d3-status__pulse")).toBeNull();
  });

  it("an errored workflow agent renders a warn dot and its error text", () => {
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

    render(dock(state));
    fireEvent.click(
      screen.getByTestId("dock-group-workflows").querySelector("button") as HTMLButtonElement,
    );

    const row = screen.getByTestId("dock-workflow-agent-row");
    expect(row.querySelector('[class*="dotWarn"]')).not.toBeNull();
    expect(row.textContent).toContain("boom");
  });

  it("Stop calls agentStopTask with the pane id and the run's task_id, then disables itself", () => {
    const state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);

    render(dock(state));
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

    // No optimistic status change: the row still reads the wire's own live
    // state — the literal word "running" — not a locally-guessed "stopped".
    expect(screen.getByTestId("dock-workflow-rows").textContent).toContain("running");
  });

  it("the group stays open and both runs stay listed when the older one ends", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = applyFrame(
      state,
      orchestrationTaskStartedFrame("wf2", { workflow_name: "wire-probe-2" }),
      2_000,
    );
    const { rerender } = render(dock(state));

    const button = screen
      .getByTestId("dock-group-workflows")
      .querySelector("button") as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    // The older (wf1) run finishes; wf2 runs on.
    state = applyFrame(state, orchestrationTerminalFrame("wf1", "completed"), 3_000);
    rerender(dock(state));

    // The group stays open (D5) rather than deriving itself closed, and its
    // body still names both runs, not just the survivor.
    const newButton = screen.getByTestId("dock-group-workflows").querySelector("button");
    expect(newButton?.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("dock-workflow-rows").textContent).toContain("wire-probe-2");
    expect(screen.getAllByTestId("dock-workflow-row")).toHaveLength(2);
  });

  it("a live Task and a live orchestration render as two separate groups", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = applyFrame(
      state,
      toolUseFrame("toolu_task", { subagent_type: "planner" }, "Task"),
      1_500,
    );

    render(dock(state));
    expect(screen.getByTestId("dock-group-agents")).not.toBeNull();
    expect(screen.getByTestId("dock-group-workflows")).not.toBeNull();
  });

  it("the elapsed value ticks while the run is live", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000_000 - 1_000);

    render(dock(state));
    const before = screen.getByTestId("dock-group-workflows").textContent;

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    const after = screen.getByTestId("dock-group-workflows").textContent;
    expect(after).not.toBe(before);
  });
});

describe("AgentActivityDock — Workflows group rows", () => {
  it("a phase agent row is announced but is not focusable or selectable", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = applyFrame(
      state,
      orchestrationProgressFrame("wf1", {
        workflow_progress: [{ type: "workflow_agent", index: 1, label: "red", state: "start" }],
      }),
      1_500,
    );

    render(dock(state));
    fireEvent.click(
      screen.getByTestId("dock-group-workflows").querySelector("button") as HTMLButtonElement,
    );

    const row = screen.getByTestId("dock-workflow-agent-row");
    expect(row.querySelector("button")).toBeNull();
    const option = row.querySelector('[role="option"]');
    expect(option).not.toBeNull();
    expect(option?.getAttribute("aria-disabled")).toBe("true");
    expect(option?.hasAttribute("tabindex")).toBe(false);
  });

  it("a run row offers Stop only while it is running", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    const { rerender } = render(dock(state));
    fireEvent.click(
      screen.getByTestId("dock-group-workflows").querySelector("button") as HTMLButtonElement,
    );
    expect(screen.queryByText("Stop")).not.toBeNull();

    state = applyFrame(state, orchestrationTerminalFrame("wf1", "completed"), 2_000);
    rerender(dock(state));
    expect(screen.queryByText("Stop")).toBeNull();
  });

  it("clicking a workflow row asks the pane to show that run", () => {
    const state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    const onSelectView = vi.fn();
    render(dock(state, { onSelectView }));
    fireEvent.click(
      screen.getByTestId("dock-group-workflows").querySelector("button") as HTMLButtonElement,
    );

    fireEvent.click(
      screen.getByTestId("dock-workflow-row").querySelector("button") as HTMLButtonElement,
    );
    expect(onSelectView).toHaveBeenCalledTimes(1);
    expect(onSelectView).toHaveBeenCalledWith({ kind: "workflow", taskId: "wf1" });
  });
});

describe("AgentActivityDock — selection", () => {
  it("the row matching the current selection is marked", () => {
    let state = withTask(liveState(), "toolu_a", { subagent_type: "planner", description: "p" }, 1_000);
    state = withTask(state, "toolu_b", { subagent_type: "coder", description: "c" }, 2_000);

    render(dock(state, { selectedView: { kind: "subagent", id: "toolu_a" } }));
    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );

    const rows = screen.getAllByTestId("dock-agent-row");
    // Changed, not regressed (#22): the row became a `role="option"`, where
    // `aria-selected` is the conformant expression of "this is the chosen
    // one" — `aria-current` is the navigation-landmark idiom and would be a
    // second, non-conformant channel for the same fact (plan D13). The
    // behaviour under test — which row is marked as the current selection —
    // is identical to before.
    expect(rows[0]?.querySelector("button")?.getAttribute("aria-selected")).toBe("true");
    expect(rows[1]?.querySelector("button")?.getAttribute("aria-selected")).toBe("false");
  });
});

describe("AgentActivityDock — collapse state and layout", () => {
  it("each group collapses independently and the state survives a re-render", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = applyFrame(state, toolUseFrame("t1", { command: "ls" }), 1_500);

    const { rerender } = render(dock(state));

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
    rerender(dock(freshState));

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
    const { rerender } = render(dock(state));

    const toolsButton = screen
      .getByTestId("dock-group-tools")
      .querySelector("button") as HTMLButtonElement;
    fireEvent.click(toolsButton);
    expect(toolsButton.getAttribute("aria-expanded")).toBe("false");

    // The call resolves — no Tools group at all for this render, but the
    // dock itself stays mounted (the metrics line still has something to
    // show), so the collapse flag is not reset by a remount.
    const resolved = applyFrame(state, toolResultFrame("t1", false), 2_000);
    rerender(dock(resolved));
    expect(screen.queryByTestId("dock-group-tools")).toBeNull();

    // A new live run starts — the group reappears still collapsed.
    const again = applyFrame(resolved, toolUseFrame("t2", { command: "pwd" }), 3_000);
    rerender(dock(again));
    const toolsButtonAgain = screen
      .getByTestId("dock-group-tools")
      .querySelector("button");
    expect(toolsButtonAgain?.getAttribute("aria-expanded")).toBe("false");
  });

  it("a busy dock keeps its group stack in one internally-scrolling box", () => {
    let state = applyFrame(liveState(), orchestrationTaskStartedFrame("wf1"), 1_000);
    state = withTask(state, "toolu_sub", { subagent_type: "planner", description: "d" }, 1_500);
    state = applyFrame(state, toolUseFrame("t1", { command: "ls" }), 2_000);

    render(dock(state));
    const toolsGroup = screen.getByTestId("dock-group-tools");
    const agentsGroup = screen.getByTestId("dock-group-agents");
    const workflowsGroup = screen.getByTestId("dock-group-workflows");
    const strip = screen.getByTestId("agent-session-hud");
    const dockEl = screen.getByTestId("agent-activity-dock");

    const container = toolsGroup.parentElement;
    expect(container).not.toBeNull();
    expect(container).toBe(agentsGroup.parentElement);
    expect(container).toBe(workflowsGroup.parentElement);
    // The scroll box is its own element, distinct from the dock root and never
    // an ancestor of the metrics strip — the strip must stay pinned even while
    // the group stack scrolls.
    expect(container).not.toBe(dockEl);
    expect(container?.contains(strip)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Keyboard navigation over the dock rows (#22) — the cursor, its focus
// requests, and the ARIA that describes both. `dock()`'s new defaults (no
// cursor, no pending focus request) mean every case above this line is
// unaffected; these cases exercise the four new props directly.
// ---------------------------------------------------------------------------

describe("AgentActivityDock — keyboard navigation (#22)", () => {
  it("the rows are a listbox of options that announce name and status", () => {
    let state = taskState("planner", "d", 1_000);
    state = applyFrame(state, orchestrationTaskStartedFrame("wf1"), 1_500);
    state = applyFrame(
      state,
      orchestrationProgressFrame("wf1", {
        workflow_progress: [
          { type: "workflow_phase", index: 1, title: "Alpha" },
          { type: "workflow_agent", index: 1, label: "red", phaseIndex: 1, state: "start" },
        ],
      }),
      1_600,
    );

    render(dock(state));
    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );
    fireEvent.click(
      screen.getByTestId("dock-group-workflows").querySelector("button") as HTMLButtonElement,
    );

    const agentRows = screen.getByTestId("dock-agent-rows");
    expect(agentRows.getAttribute("role")).toBe("listbox");
    expect(agentRows.getAttribute("aria-label")).toBe("Sub-agents");
    const workflowRows = screen.getByTestId("dock-workflow-rows");
    expect(workflowRows.getAttribute("role")).toBe("listbox");
    expect(workflowRows.getAttribute("aria-label")).toBe("Workflow runs");

    const agentOption = screen.getByTestId("dock-agent-row").querySelector('[role="option"]');
    expect(agentOption?.getAttribute("aria-label")).toBe("planner — running");

    const phase = screen.getByText("Alpha").closest('[role="group"]');
    expect(phase?.getAttribute("aria-label")).toBe("Alpha");

    // The running run row carries the Stop button, so its own wrapper is a
    // `role="group"` — never a bare `role="presentation"`, which would make
    // the Stop button a non-conformant direct child of the listbox.
    expect(screen.getByTestId("dock-workflow-row").getAttribute("role")).toBe("group");
  });

  it("the highlighted row and the selected row are two different states", () => {
    let state = withTask(liveState(), "toolu_a", { subagent_type: "planner", description: "p" }, 1_000);
    state = withTask(state, "toolu_b", { subagent_type: "coder", description: "c" }, 2_000);

    render(
      dock(state, {
        selectedView: { kind: "subagent", id: "toolu_a" },
        highlightedKey: viewKey({ kind: "subagent", id: "toolu_b" }),
      }),
    );
    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );

    const rows = screen.getAllByTestId("dock-agent-row");
    const a = rows[0]?.querySelector("button");
    const b = rows[1]?.querySelector("button");
    expect(a?.getAttribute("aria-selected")).toBe("true");
    expect(a?.hasAttribute("data-highlighted")).toBe(false);
    expect(b?.getAttribute("aria-selected")).toBe("false");
    expect(b?.getAttribute("data-highlighted")).toBe("true");
  });

  it("exactly one row is a Tab stop, and it is the highlighted one", () => {
    let state = withTask(liveState(), "toolu_a", { subagent_type: "planner", description: "p" }, 1_000);
    state = withTask(state, "toolu_b", { subagent_type: "coder", description: "c" }, 2_000);
    state = applyFrame(state, orchestrationTaskStartedFrame("wf1"), 3_000);

    render(dock(state, { highlightedKey: viewKey({ kind: "subagent", id: "toolu_b" }) }));
    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );
    fireEvent.click(
      screen.getByTestId("dock-group-workflows").querySelector("button") as HTMLButtonElement,
    );

    const options = [
      ...screen.getAllByTestId("dock-agent-row"),
      ...screen.getAllByTestId("dock-workflow-row"),
    ].map((row) => row.querySelector("button") as HTMLButtonElement);

    const tabStops = options.filter((el) => el.getAttribute("tabindex") === "0");
    expect(tabStops).toHaveLength(1);
    expect(tabStops[0]?.getAttribute("data-highlighted")).toBe("true");
  });

  it("with no cursor the tab stop falls back to the selected row, then to the first row", () => {
    let state = withTask(liveState(), "toolu_a", { subagent_type: "planner", description: "p" }, 1_000);
    state = withTask(state, "toolu_b", { subagent_type: "coder", description: "c" }, 2_000);

    const { rerender } = render(
      dock(state, { selectedView: { kind: "subagent", id: "toolu_b" } }),
    );
    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );

    let rows = screen
      .getAllByTestId("dock-agent-row")
      .map((r) => r.querySelector("button") as HTMLButtonElement);
    expect(rows[1]?.getAttribute("tabindex")).toBe("0");
    expect(rows[0]?.getAttribute("tabindex")).toBe("-1");

    // No cursor and no selection override — `dock()`'s default `selectedView`
    // is `MAIN_VIEW`, which names no row, so the tab stop falls all the way
    // to the first row.
    rerender(dock(state));
    rows = screen
      .getAllByTestId("dock-agent-row")
      .map((r) => r.querySelector("button") as HTMLButtonElement);
    expect(rows[0]?.getAttribute("tabindex")).toBe("0");
    expect(rows[1]?.getAttribute("tabindex")).toBe("-1");
  });

  it("aria-activedescendant names the highlighted option only on the group that holds it", () => {
    let state = withTask(liveState(), "toolu_a", { subagent_type: "planner", description: "p" }, 1_000);
    state = applyFrame(state, orchestrationTaskStartedFrame("wf1"), 2_000);

    render(dock(state, { highlightedKey: viewKey({ kind: "subagent", id: "toolu_a" }) }));
    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );
    fireEvent.click(
      screen.getByTestId("dock-group-workflows").querySelector("button") as HTMLButtonElement,
    );

    const agentRows = screen.getByTestId("dock-agent-rows");
    const workflowRows = screen.getByTestId("dock-workflow-rows");
    const optionId = screen.getByTestId("dock-agent-row").querySelector("button")?.id;
    expect(optionId).toBeTruthy();
    expect(agentRows.getAttribute("aria-activedescendant")).toBe(optionId);
    expect(workflowRows.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("ArrowDown/ArrowUp on a row ask the pane to move the cursor with focus, and never select", () => {
    let state = withTask(liveState(), "toolu_a", { subagent_type: "planner", description: "p" }, 1_000);
    state = withTask(state, "toolu_b", { subagent_type: "coder", description: "c" }, 2_000);
    const onHighlightChange = vi.fn();
    const onSelectView = vi.fn();

    render(
      dock(state, {
        highlightedKey: viewKey({ kind: "subagent", id: "toolu_a" }),
        onHighlightChange,
        onSelectView,
      }),
    );
    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );

    const rowA = screen
      .getAllByTestId("dock-agent-row")[0]
      ?.querySelector("button") as HTMLButtonElement;
    fireEvent.keyDown(rowA, { key: "ArrowDown" });

    expect(onHighlightChange).toHaveBeenCalledWith(
      viewKey({ kind: "subagent", id: "toolu_b" }),
      { focus: true },
    );
    expect(onSelectView).not.toHaveBeenCalled();
  });

  it("a row click asks for a highlight but never for focus", () => {
    const state = taskState("planner", "d", 1_000);
    const onHighlightChange = vi.fn();
    const onSelectView = vi.fn();

    render(dock(state, { onHighlightChange, onSelectView }));
    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );
    fireEvent.click(
      screen.getByTestId("dock-agent-row").querySelector("button") as HTMLButtonElement,
    );

    expect(onSelectView).toHaveBeenCalledWith({ kind: "subagent", id: "toolu_sub" });
    expect(onHighlightChange).toHaveBeenCalledWith(
      viewKey({ kind: "subagent", id: "toolu_sub" }),
    );
    // Exactly one argument: this is the unit-level half of the "clicking must
    // not steal the caret" guarantee — a later refactor that starts passing
    // `{ focus: true }` from `onClick` turns this red even in jsdom, where a
    // click never moves focus by itself.
    expect(onHighlightChange.mock.calls[0]).toHaveLength(1);
  });

  it("a focus request whose row is not in the DOM hands focus back to the composer", () => {
    const state = taskState("planner", "d", 1_000);
    const onReturnFocus = vi.fn();

    expect(() =>
      render(dock(state, { focusRequest: { key: "sub:gone", token: 1 }, onReturnFocus })),
    ).not.toThrow();

    expect(onReturnFocus).toHaveBeenCalledTimes(1);
  });

  it("a highlighted row that disappears while it holds focus returns focus to the composer", () => {
    const key = viewKey({ kind: "subagent", id: "toolu_sub" });

    // Part 1: the row held focus. Removing it (the sub-agent ages out of the
    // transcript — same shape as a `/clear`) drops DOM focus to `<body>`, and
    // the custodian effect hands it back.
    const onReturnFocusA = vi.fn();
    const withRow = taskState("planner", "d", 1_000);
    const { rerender, unmount } = render(
      dock(withRow, { highlightedKey: key, onReturnFocus: onReturnFocusA }),
    );
    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );
    const option = screen.getByTestId("dock-agent-row").querySelector("button") as HTMLButtonElement;
    option.focus();
    expect(document.activeElement).toBe(option);

    // The session lives on (still `dockHasContent`) but the row itself is
    // gone — the Agents group disappears along with it.
    rerender(dock(liveState(), { highlightedKey: key, onReturnFocus: onReturnFocusA }));
    expect(onReturnFocusA).toHaveBeenCalledTimes(1);
    unmount();

    // Part 2: same transition, but focus was never on the row — parked on an
    // unrelated element instead. The `document.activeElement === document.body`
    // guard means the custodian must stay out of it.
    const onReturnFocusB = vi.fn();
    const { rerender: rerenderB } = render(
      dock(withRow, { highlightedKey: key, onReturnFocus: onReturnFocusB }),
    );
    const decoy = document.createElement("button");
    document.body.appendChild(decoy);
    decoy.focus();
    expect(document.activeElement).toBe(decoy);
    rerenderB(dock(liveState(), { highlightedKey: key, onReturnFocus: onReturnFocusB }));
    expect(onReturnFocusB).not.toHaveBeenCalled();
    decoy.remove();
  });

  it("Enter and ArrowRight open the row's view and hand focus back", () => {
    const state = taskState("planner", "d", 1_000);
    const onSelectView = vi.fn();
    const onReturnFocus = vi.fn();

    render(dock(state, { onSelectView, onReturnFocus }));
    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );
    const option = screen.getByTestId("dock-agent-row").querySelector("button") as HTMLButtonElement;

    fireEvent.keyDown(option, { key: "Enter" });
    expect(onSelectView).toHaveBeenCalledWith({ kind: "subagent", id: "toolu_sub" });
    expect(onReturnFocus).toHaveBeenCalledTimes(1);

    onSelectView.mockClear();
    onReturnFocus.mockClear();
    fireEvent.keyDown(option, { key: "ArrowRight" });
    expect(onSelectView).toHaveBeenCalledWith({ kind: "subagent", id: "toolu_sub" });
    expect(onReturnFocus).toHaveBeenCalledTimes(1);
  });

  it("Escape and ArrowLeft go back to the main transcript and hand focus back", () => {
    const state = taskState("planner", "d", 1_000);
    const onSelectView = vi.fn();
    const onReturnFocus = vi.fn();

    render(dock(state, { onSelectView, onReturnFocus }));
    fireEvent.click(
      screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement,
    );
    const option = screen.getByTestId("dock-agent-row").querySelector("button") as HTMLButtonElement;

    fireEvent.keyDown(option, { key: "Escape" });
    expect(onSelectView).toHaveBeenCalledWith(MAIN_VIEW);
    expect(onReturnFocus).toHaveBeenCalledTimes(1);

    onSelectView.mockClear();
    onReturnFocus.mockClear();
    fireEvent.keyDown(option, { key: "ArrowLeft" });
    expect(onSelectView).toHaveBeenCalledWith(MAIN_VIEW);
    expect(onReturnFocus).toHaveBeenCalledTimes(1);
  });

  it("a cursor inside a collapsed group forces that group open", () => {
    const state = taskState("planner", "d", 1_000);
    // `agents` defaults collapsed (`agent-activity-dock.tsx`) — no click here.
    render(dock(state, { highlightedKey: viewKey({ kind: "subagent", id: "toolu_sub" }) }));

    expect(
      screen.getByTestId("dock-group-agents").querySelector("button")?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByTestId("dock-agent-row")).not.toBeNull();
  });

  it("collapsing a group that holds the cursor clears it", () => {
    const state = taskState("planner", "d", 1_000);
    const onHighlightChange = vi.fn();
    const cursorKey = viewKey({ kind: "subagent", id: "toolu_sub" });

    // First, a genuine (non-cursor-forced) expand: the group's own collapse
    // flag flips to "open" with no cursor in play yet.
    const { rerender } = render(dock(state, { onHighlightChange }));
    const header = screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement;
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");

    // The cursor lands inside the now-genuinely-open group (e.g. Ctrl+↓).
    rerender(dock(state, { highlightedKey: cursorKey, onHighlightChange }));

    // Collapsing it now must clear the cursor first — otherwise D5's derived
    // expansion (`!collapsed[id] || cursorGroup === id`) would keep rendering
    // the group open despite the collapse flag flipping, and the click would
    // appear to do nothing.
    fireEvent.click(header);
    expect(onHighlightChange).toHaveBeenCalledWith(null);
    // No focus option — otherwise the click would pull the caret out of the
    // composer for a group-collapse, which is a pointer path (plan D5/D15).
    expect(onHighlightChange.mock.calls[0]).toHaveLength(1);
  });

  it("collapsing a group with the mouse while its cursor row holds real DOM focus hands focus back to the composer", () => {
    // Review round 1, F1: reaching the row via Ctrl+↓/arrow keys puts real
    // DOM focus on it; clicking the group's twisty next clears the cursor
    // and collapses the group in one commit, so `cursorLost` never edges
    // false→true and the custodian effect below never fires. Without the fix
    // in `toggle()`, the row's removal from the DOM would strand focus on
    // <body>.
    const state = taskState("planner", "d", 1_000);
    const onHighlightChange = vi.fn();
    const onReturnFocus = vi.fn();
    const cursorKey = viewKey({ kind: "subagent", id: "toolu_sub" });

    const { rerender } = render(dock(state, { onHighlightChange, onReturnFocus }));
    const header = screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement;
    fireEvent.click(header); // genuine, non-cursor-forced expand

    rerender(dock(state, { highlightedKey: cursorKey, onHighlightChange, onReturnFocus }));
    const option = screen.getByTestId("dock-agent-row").querySelector("button") as HTMLButtonElement;
    option.focus();
    expect(document.activeElement).toBe(option);

    fireEvent.click(header); // collapses the group the focused row lives in
    expect(onHighlightChange).toHaveBeenCalledWith(null);
    expect(onReturnFocus).toHaveBeenCalledTimes(1);
  });

  it("collapsing a group with the mouse while its cursor row does NOT hold DOM focus leaves focus alone", () => {
    // The mirror case: the cursor is inside the collapsing group, but DOM
    // focus is parked elsewhere (e.g. the composer). Collapsing must still
    // clear the cursor, but must not reach for focus it does not own.
    const state = taskState("planner", "d", 1_000);
    const onHighlightChange = vi.fn();
    const onReturnFocus = vi.fn();
    const cursorKey = viewKey({ kind: "subagent", id: "toolu_sub" });

    const { rerender } = render(dock(state, { onHighlightChange, onReturnFocus }));
    const header = screen.getByTestId("dock-group-agents").querySelector("button") as HTMLButtonElement;
    fireEvent.click(header); // genuine, non-cursor-forced expand

    rerender(dock(state, { highlightedKey: cursorKey, onHighlightChange, onReturnFocus }));
    const decoy = document.createElement("button");
    document.body.appendChild(decoy);
    decoy.focus();
    expect(document.activeElement).toBe(decoy);

    fireEvent.click(header);
    expect(onHighlightChange).toHaveBeenCalledWith(null);
    expect(onReturnFocus).not.toHaveBeenCalled();
    decoy.remove();
  });
});
