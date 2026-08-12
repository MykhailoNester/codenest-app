// The pane's view router: what the picker offers, and what happens when the
// thing it is pointing at disappears.

import { describe, it, expect } from "vitest";
import { emptyConversation, type ConversationState, type ConvTurn } from "../agent-conversation";
import {
  findSubagent,
  findToolBlock,
  listAgentViews,
  MAIN_VIEW,
  parseViewKey,
  resolveView,
  sameView,
  subagentLabel,
  viewKey,
} from "../agent-views";

function subagentBlock(over: Record<string, unknown> = {}) {
  return {
    type: "tool" as const,
    id: "call-1",
    name: "Task",
    argSummary: "Review the composer",
    input: { subagent_type: "code-reviewer", description: "Review the composer" },
    diffstat: null,
    output: null,
    startedAt: 1_000,
    endedAt: 2_000,
    isError: false,
    // Required, not cosmetic: this fixture is inferred, not typed as
    // `ConvToolBlock` (some callers cast it past the type), and the
    // recursive walk below reads `block.childTurns` on every tool block it
    // visits. Fixture completeness, not a behaviour change — every real
    // block has this field (`agent-conversation.ts:58-78`). Typed explicitly
    // as `ConvTurn[]` rather than left to infer `never[]` — an untyped empty
    // array there makes `withSubagent`'s `as ConversationState["turns"]`
    // cast below fail with "neither type sufficiently overlaps with the
    // other" (`never[]` cannot compare against a real `ConvTurn[]`).
    childTurns: [] as ConvTurn[],
    ...over,
  };
}

function run(over: Record<string, unknown> = {}) {
  return {
    taskId: "wf1",
    toolUseId: null,
    name: "review-changes",
    description: "Review across dimensions",
    status: "running" as const,
    activity: null,
    totalTokens: null,
    startedAt: 5_000,
    endedAt: null,
    phases: [{ index: 1, title: "Review" }],
    agents: [],
    ...over,
  };
}

function state(over: Partial<ConversationState> = {}): ConversationState {
  return { ...emptyConversation(), status: "running", startedAt: 500, ...over };
}

function withSubagent(block: ReturnType<typeof subagentBlock>): ConversationState {
  return state({
    turns: [{ role: "assistant", blocks: [block] }] as ConversationState["turns"],
  });
}

/** One child-stream turn, the shape `withChildStream` builds — for a nested
 *  delegation fixture's `childTurns`. */
function childTurn(blocks: ReturnType<typeof subagentBlock>[]) {
  return { id: "child-turn", role: "assistant" as const, at: 1_500, blocks };
}

describe("viewKey / parseViewKey", () => {
  it("round-trips every view kind", () => {
    for (const id of [
      MAIN_VIEW,
      { kind: "subagent" as const, id: "call-1" },
      { kind: "workflow" as const, taskId: "wf1" },
    ]) {
      expect(parseViewKey(viewKey(id))).toEqual(id);
    }
  });

  it("degrades an unrecognised key to the transcript rather than throwing", () => {
    // The picker is chrome; a stale key must not be able to take the pane down.
    expect(parseViewKey("nonsense")).toEqual(MAIN_VIEW);
    expect(parseViewKey("")).toEqual(MAIN_VIEW);
  });

  it("survives an id containing the separator", () => {
    const id = { kind: "subagent" as const, id: "a:b:c" };
    expect(parseViewKey(viewKey(id))).toEqual(id);
  });

  it("sameView compares by identity, not reference", () => {
    expect(sameView({ kind: "workflow", taskId: "x" }, { kind: "workflow", taskId: "x" })).toBe(
      true,
    );
    expect(sameView(MAIN_VIEW, { kind: "workflow", taskId: "x" })).toBe(false);
  });
});

describe("listAgentViews", () => {
  it("always offers the main agent first, even with nothing delegated", () => {
    const views = listAgentViews(state());
    expect(views).toHaveLength(1);
    expect(views[0]?.id).toEqual(MAIN_VIEW);
  });

  it("includes finished sub-agents, not just in-flight ones", () => {
    // The most useful moment to read a sub-agent's result is right after it
    // ends, so unlike `activeSubagents` this list keeps the finished ones.
    const views = listAgentViews(withSubagent(subagentBlock({ endedAt: 2_000 })));
    expect(views.map((v) => v.label)).toEqual(["Main agent", "code-reviewer"]);
  });

  it("gives a finished sub-agent its exact duration", () => {
    const done = listAgentViews(withSubagent(subagentBlock({ endedAt: 2_000 })));
    expect(done[1]?.elapsedMs).toBe(1_000);
    expect(done[1]?.running).toBe(false);
  });

  it("reports no duration for a running sub-agent, only that it is running", () => {
    // A number measured against a render-time clock is stale the instant it
    // paints; callers render "running" instead.
    const live = listAgentViews(withSubagent(subagentBlock({ endedAt: null })));
    expect(live[1]?.elapsedMs).toBeNull();
    expect(live[1]?.running).toBe(true);
  });

  it("never calls a sub-agent live on an exited session", () => {
    const s = state({
      status: "exited",
      turns: [
        { role: "assistant", blocks: [subagentBlock({ endedAt: null })] },
      ] as ConversationState["turns"],
    });
    expect(listAgentViews(s)[1]?.running).toBe(false);
  });

  it("reports no elapsed for the main agent — the wire never says when a session ended", () => {
    expect(listAgentViews(state({ status: "exited" }))[0]?.elapsedMs).toBeNull();
    expect(listAgentViews(state())[0]?.elapsedMs).toBeNull();
  });

  it("lists orchestrations with a phase and agent tally", () => {
    const s = state({ orchestrations: [run()] } as Partial<ConversationState>);
    const views = listAgentViews(s);
    expect(views[1]?.label).toBe("review-changes");
    expect(views[1]?.detail).toContain("1 phases");
    // Still running, so no exact duration yet.
    expect(views[1]?.elapsedMs).toBeNull();
    const finished = listAgentViews(
      state({ orchestrations: [run({ endedAt: 6_000 })] } as Partial<ConversationState>),
    );
    expect(finished[1]?.elapsedMs).toBe(1_000);
  });

  it("orders sub-agents and workflows by start time, not by running state", () => {
    // A list that reshuffles as things finish is one no habit can form around.
    const s = state({
      turns: [
        { role: "assistant", blocks: [subagentBlock({ id: "late", startedAt: 8_000 })] },
      ] as ConversationState["turns"],
      orchestrations: [run({ startedAt: 6_000 })],
    } as Partial<ConversationState>);
    const views = listAgentViews(s);
    expect(views.map((v) => v.id.kind)).toEqual(["main", "workflow", "subagent"]);
  });

  it("falls back to the tool name when the call declared no sub-agent type", () => {
    expect(subagentLabel(subagentBlock({ input: {} }) as never)).toBe("Task");
  });

  it("lists a nested delegation, so its card has a view to open", () => {
    // A depth-2 delegation: the top-level `Agent` call's own `childTurns`
    // hold a second `Agent` call. Without the recursion the picker's
    // `<select>` would hold a `value` with no matching `<option>` and render
    // blank the moment a nested card were clicked.
    const nestedId = "nested-1";
    const outer = subagentBlock({
      childTurns: [
        childTurn([subagentBlock({ id: nestedId, startedAt: 1_500, endedAt: null })]),
      ],
    });
    const s = withSubagent(outer);

    const views = listAgentViews(s);
    expect(views.map((v) => v.id)).toEqual([
      MAIN_VIEW,
      { kind: "subagent", id: "call-1" },
      { kind: "subagent", id: nestedId },
    ]);
    expect(findSubagent(s, nestedId)).not.toBeNull();
    expect(resolveView(s, { kind: "subagent", id: nestedId })).toEqual({
      kind: "subagent",
      id: nestedId,
    });
  });
});

describe("resolveView", () => {
  it("keeps a selection whose target is still there", () => {
    const s = withSubagent(subagentBlock());
    const sel = { kind: "subagent" as const, id: "call-1" };
    expect(resolveView(s, sel)).toEqual(sel);
  });

  it("falls back to the transcript when the sub-agent has gone — the /clear case", () => {
    expect(resolveView(state(), { kind: "subagent", id: "call-1" })).toEqual(MAIN_VIEW);
  });

  it("falls back when the orchestration has gone", () => {
    expect(resolveView(state(), { kind: "workflow", taskId: "wf1" })).toEqual(MAIN_VIEW);
  });

  it("leaves main alone", () => {
    expect(resolveView(state(), MAIN_VIEW)).toEqual(MAIN_VIEW);
  });
});

describe("findToolBlock", () => {
  it("finds a non-delegation block at any depth", () => {
    // `Workflow` is deliberately not a `Task`/`Agent` name — `subagentBlocks`
    // would never surface it, but the workflow view needs the block itself
    // for its own `childTurns`.
    const workflowBlock = subagentBlock({ id: "toolu_workflow", name: "Workflow" });
    const outer = subagentBlock({ childTurns: [childTurn([workflowBlock])] });
    const s = withSubagent(outer);

    expect(findToolBlock(s, "toolu_workflow")).toEqual(workflowBlock);
    expect(findToolBlock(s, "does-not-exist")).toBeNull();
  });
});
