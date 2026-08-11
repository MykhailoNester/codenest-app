// Pure selectors behind the activity dock's Tools group and its "does the
// dock have anything to show at all" gate. No jsdom, no React — these read
// `ConversationState` directly, same discipline as `conversation-grouping.test.ts`.

import { describe, it, expect } from "vitest";
import { dockHasContent, liveToolRun, toolRunStartedAt } from "../agent-dock";
import {
  applyFrame,
  emptyConversation,
  type ConversationState,
  type ConvBlock,
  type ConvToolBlock,
  type ConvTurn,
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
