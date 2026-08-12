// Pure selectors behind the activity dock's Tools group and its "does the
// dock have anything to show at all" gate. No jsdom, no React — these read
// `ConversationState` directly, same discipline as `conversation-grouping.test.ts`.

import { describe, it, expect } from "vitest";
import {
  dockAgentRows,
  dockHasContent,
  dockNavRows,
  dockWorkflowRows,
  liveToolRun,
  nextDockNavKey,
  toolRunStartedAt,
} from "../agent-dock";
import {
  applyFrame,
  emptyConversation,
  type ConversationState,
  type ConvBlock,
  type ConvToolBlock,
  type ConvTurn,
  type OrchestrationAgent,
  type OrchestrationRun,
} from "../agent-conversation";
import type { AgentFrame, AgentFrameKind } from "../ipc";

// Same fixture idiom as `conversation-grouping.test.ts:16-29` — cast rather
// than fully typed, since a test block only ever sets the fields a given
// case cares about.
function tool(over: Partial<ConvToolBlock> = {}): ConvToolBlock {
  return {
    type: "tool",
    id: over.id ?? `t${Math.round((over.startedAt ?? 0) * 1000)}`,
    name: "Bash",
    argSummary: "ls -la",
    diffstat: null,
    output: null,
    startedAt: 0,
    endedAt: 100,
    isError: false,
    childTurns: [],
    ...over,
  } as ConvToolBlock;
}

function turn(blocks: ConvBlock[], over: Partial<ConvTurn> = {}): ConvTurn {
  return {
    id: over.id ?? "turn",
    role: "assistant",
    at: 0,
    blocks,
    ...over,
  };
}

function state(turns: ConvTurn[], over: Partial<ConversationState> = {}): ConversationState {
  return { ...emptyConversation(), status: "running", startedAt: 500, turns, ...over };
}

function frame(kind: AgentFrameKind, raw: unknown): AgentFrame {
  return { pane_id: "p1", session_id: "s1", kind, raw };
}

// Same idiom, for the Workflows-group fixtures below — a plain object cast
// through `Partial<...>` overrides, same as `tool()`/`turn()` above.
function agent(over: Partial<OrchestrationAgent> = {}): OrchestrationAgent {
  return {
    index: 1,
    label: "red",
    phaseIndex: null,
    phaseTitle: null,
    agentType: null,
    model: null,
    state: "start",
    tokens: null,
    toolCalls: null,
    durationMs: null,
    error: null,
    cached: false,
    promptPreview: null,
    resultPreview: null,
    ...over,
  };
}

function run(over: Partial<OrchestrationRun> = {}): OrchestrationRun {
  return {
    taskId: "wf1",
    toolUseId: null,
    name: "wire-probe",
    description: null,
    status: "running",
    activity: null,
    totalTokens: null,
    startedAt: 1_000,
    endedAt: null,
    phases: [],
    agents: [],
    ...over,
  };
}

describe("liveToolRun", () => {
  it("returns the whole consecutive run that contains the in-flight call", () => {
    const blocks = [
      tool({ id: "a", name: "Bash" }),
      tool({ id: "b", name: "Read" }),
      tool({ id: "c", name: "Bash", endedAt: null }),
    ];
    // `summarizeToolRun` counts the whole run, not just the live call — this
    // is what makes that true.
    expect(liveToolRun(state([turn(blocks)])).map((b) => b.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("returns a lone in-flight call as a one-element run", () => {
    // Pins the `kind: "block"` branch: `groupTurnBlocks` gives a single tool
    // call its own row rather than a `toolRun` group of one.
    const s = state([turn([tool({ id: "solo", endedAt: null })])]);
    expect(liveToolRun(s).map((b) => b.id)).toEqual(["solo"]);
  });

  it("is empty when every call has ended", () => {
    const s = state([turn([tool({ id: "a" }), tool({ id: "b" })])]);
    expect(liveToolRun(s)).toEqual([]);
  });

  it("never returns a Task/Agent delegation — the Agents group owns it", () => {
    const s = state([turn([tool({ id: "t", name: "Task", endedAt: null })])]);
    expect(liveToolRun(s)).toEqual([]);
  });

  it("prefers the newest run when two turns each have one open", () => {
    const s = state([
      turn([tool({ id: "old", endedAt: null })], { id: "turn-1" }),
      turn([tool({ id: "new", endedAt: null })], { id: "turn-2" }),
    ]);
    expect(liveToolRun(s).map((b) => b.id)).toEqual(["new"]);
  });

  it("is empty on an exited session", () => {
    const s = state([turn([tool({ id: "a", endedAt: null })])], { status: "exited" });
    expect(liveToolRun(s)).toEqual([]);
  });
});

describe("toolRunStartedAt", () => {
  it("is the earliest start in the run, not the headline's", () => {
    const blocks = [
      tool({ id: "a", startedAt: 500 }),
      tool({ id: "b", startedAt: 100, endedAt: null }),
    ];
    // `toolRunHeadline` would name "b" (the only one still open) — this is a
    // different question, and its answer is unaffected by which call is live.
    expect(toolRunStartedAt(blocks)).toBe(100);
  });

  it("is null for an empty run", () => {
    expect(toolRunStartedAt([])).toBeNull();
  });
});

describe("dockHasContent", () => {
  it("is false for a fresh conversation", () => {
    expect(dockHasContent(emptyConversation())).toBe(false);
  });

  it("is true once init reported a start", () => {
    const s = applyFrame(emptyConversation(), frame("init", { model: "claude-opus-5" }), 1_000);
    expect(dockHasContent(s)).toBe(true);
  });

  it("is true for a pending permission before init", () => {
    const s = applyFrame(
      emptyConversation(),
      frame("permission", {
        request_id: "req_1",
        request: { tool_name: "Bash", input: { command: "rm -rf /" } },
      }),
      1_000,
    );
    expect(dockHasContent(s)).toBe(true);
  });

  it("is true while a tool run is live", () => {
    const s = state([turn([tool({ id: "a", endedAt: null })])]);
    expect(dockHasContent(s)).toBe(true);
  });

  // Not a branch to test but an absence to note: `dockHasContent` takes no
  // git argument at all (D7). The git branch is ambient context available
  // from the moment the pane mounts — including it in this disjunction would
  // make "renders nothing for an idle fresh session" unreachable in any repo
  // that has one, so the property under test elsewhere in this suite (a
  // fresh conversation is content-less) already covers this by construction.
});

describe("dockAgentRows", () => {
  it("lists finished delegations alongside running ones, oldest first", () => {
    const blocks = [
      tool({ id: "a", name: "Task", startedAt: 0, endedAt: 100, isError: false }),
      tool({ id: "b", name: "Task", startedAt: 200, endedAt: 300, isError: true }),
      tool({ id: "c", name: "Task", startedAt: 400, endedAt: null }),
    ];
    const rows = dockAgentRows(state([turn(blocks)]));
    expect(rows.map((r) => r.view)).toEqual([
      { kind: "subagent", id: "a" },
      { kind: "subagent", id: "b" },
      { kind: "subagent", id: "c" },
    ]);
    expect(rows.map((r) => r.status)).toEqual(["done", "failed", "running"]);
  });

  it("carries the agent name and the task description as two separate fields", () => {
    // The ticket's actual defect: two rows of one type are told apart by the
    // description field, never by inventing a second label.
    const block = tool({
      id: "a",
      name: "Task",
      input: { subagent_type: "general-purpose", description: "Scan temperature for Kyiv" },
    });
    const [row] = dockAgentRows(state([turn([block])]));
    expect(row?.label).toBe("general-purpose");
    expect(row?.description).toBe("Scan temperature for Kyiv");
  });

  it("falls back to the tool name when subagent_type is absent, never a placeholder", () => {
    const block = tool({ id: "a", name: "Task", input: {} });
    const [row] = dockAgentRows(state([turn([block])]));
    expect(row?.label).toBe("Task");
  });

  it("reports an exact elapsed only once both ends are known", () => {
    const open = tool({ id: "a", name: "Task", startedAt: 1_000, endedAt: null });
    const ended = tool({ id: "b", name: "Task", startedAt: 1_000, endedAt: 1_500 });
    const rows = dockAgentRows(state([turn([open, ended])]));
    expect(rows[0]?.elapsedMs).toBeNull();
    expect(rows[0]?.running).toBe(true);
    expect(rows[1]?.elapsedMs).toBe(500);
    expect(rows[1]?.running).toBe(false);
  });

  it("a call still open on an exited session is 'ended', never 'running' or 'done'", () => {
    const block = tool({ id: "a", name: "Task", endedAt: null });
    const s = state([turn([block])], { status: "exited" });
    const [row] = dockAgentRows(s);
    expect(row?.status).toBe("ended");
    expect(row?.running).toBe(false);
  });

  it("counts the sub-agent's own tool calls", () => {
    const block = tool({
      id: "a",
      name: "Task",
      childTurns: [turn([tool({ id: "child1" }), tool({ id: "child2" })])],
    });
    const [row] = dockAgentRows(state([turn([block])]));
    expect(row?.toolCount).toBe(2);
  });
});

describe("dockWorkflowRows", () => {
  it("lists terminal runs, not just live ones", () => {
    const s = state([], {
      orchestrations: [run({ taskId: "a", status: "completed" }), run({ taskId: "b", status: "running" })],
    });
    const rows = dockWorkflowRows(s);
    expect(rows.map((r) => r.taskId)).toEqual(["a", "b"]);
  });

  it("nests the phase tree and each phase's agents", () => {
    const r = run({
      phases: [
        { index: 1, title: "Alpha" },
        { index: 2, title: "Beta" },
      ],
      agents: [
        agent({ index: 1, label: "red", phaseIndex: 1 }),
        agent({ index: 2, label: "blue", phaseIndex: 1 }),
        agent({ index: 3, label: "green", phaseIndex: 2 }),
      ],
    });
    const [row] = dockWorkflowRows(state([], { orchestrations: [r] }));
    expect(row?.phases.map((p) => p.title)).toEqual(["Alpha", "Beta"]);
    expect(row?.phases[0]?.agents.map((a) => a.label)).toEqual(["red", "blue"]);
    expect(row?.phases[1]?.agents.map((a) => a.label)).toEqual(["green"]);
  });

  it("degrades the counts label honestly", () => {
    const phaseless = run({ phases: [], agents: [agent({ index: 1 })] });
    const [row] = dockWorkflowRows(state([], { orchestrations: [phaseless] }));
    expect(row?.counts).not.toContain("phase");
    expect(row?.counts).not.toContain("%");

    const agentless = run({ phases: [{ index: 1, title: "Alpha" }], agents: [] });
    const [row2] = dockWorkflowRows(state([], { orchestrations: [agentless] }));
    expect(row2?.counts).not.toContain("0/0");
    expect(row2?.counts).not.toContain("%");
  });

  it("a run the wire still calls running is 'ended' on an exited session", () => {
    const s = state([], { status: "exited", orchestrations: [run({ status: "running" })] });
    const [row] = dockWorkflowRows(s);
    expect(row?.status).toBe("ended");
    expect(row?.running).toBe(false);
  });

  it("an errored workflow agent is warn, not failed", () => {
    const r = run({ agents: [agent({ index: 1, state: "error", error: "boom" })] });
    const [row] = dockWorkflowRows(state([], { orchestrations: [r] }));
    const [phase] = row?.phases ?? [];
    expect(phase?.agents[0]?.status).toBe("warn");
  });
});

describe("dockNavRows", () => {
  it("lists every agent row then every workflow run row, and no phase agents", () => {
    const blocks = [
      tool({ id: "a", name: "Task", startedAt: 0 }),
      tool({ id: "b", name: "Task", startedAt: 100, endedAt: null }),
    ];
    const r = run({
      taskId: "wf1",
      agents: [agent({ index: 1, label: "red", phaseIndex: 1 })],
      phases: [{ index: 1, title: "Alpha" }],
    });
    const s = state([turn(blocks)], { orchestrations: [r] });

    const rows = dockNavRows(s);
    expect(rows.map((row) => row.key)).toEqual([
      "sub:a",
      "sub:b",
      "wf:wf1",
    ]);
    expect(rows.map((row) => row.group)).toEqual(["agents", "agents", "workflows"]);
    // The phase agent ("red") carries no `AgentViewId` (it is `view: null` in
    // the dock) and can never be a cursor target.
    expect(rows.some((row) => row.label === "red")).toBe(false);
  });

  it("is empty for a session with no delegations", () => {
    expect(dockNavRows(state([]))).toEqual([]);
  });
});

describe("nextDockNavKey", () => {
  const rows = [
    { key: "a", view: { kind: "subagent", id: "a" } as const, label: "a", group: "agents" as const },
    { key: "b", view: { kind: "subagent", id: "b" } as const, label: "b", group: "agents" as const },
    { key: "c", view: { kind: "workflow", taskId: "c" } as const, label: "c", group: "workflows" as const },
  ];

  it("clamps at both ends instead of wrapping", () => {
    expect(nextDockNavKey(rows, "c", 1)).toBe("c");
    expect(nextDockNavKey(rows, "a", -1)).toBe("a");
  });

  it("enters at the first row going down and the last going up when there is no cursor", () => {
    expect(nextDockNavKey(rows, null, 1)).toBe("a");
    expect(nextDockNavKey(rows, null, -1)).toBe("c");
  });

  it("treats a key that names no row as no cursor", () => {
    // The `/clear`-then-`Ctrl+↓` path: the previously-highlighted row aged
    // out, so the next move must not throw and must not return the stale key.
    expect(() => nextDockNavKey(rows, "gone", 1)).not.toThrow();
    expect(nextDockNavKey(rows, "gone", 1)).toBe("a");
    expect(nextDockNavKey(rows, "gone", -1)).toBe("c");
  });

  it("returns null for an empty list", () => {
    expect(nextDockNavKey([], null, 1)).toBeNull();
    expect(nextDockNavKey([], "a", 1)).toBeNull();
  });

  it("moves one row forward and backward from a live cursor", () => {
    expect(nextDockNavKey(rows, "a", 1)).toBe("b");
    expect(nextDockNavKey(rows, "b", -1)).toBe("a");
    // Moving off the last Agents row into the Workflows group — deliberate,
    // not a wrap: `dockNavRows` returns one flat list across both groups.
    expect(nextDockNavKey(rows, "b", 1)).toBe("c");
  });
});
