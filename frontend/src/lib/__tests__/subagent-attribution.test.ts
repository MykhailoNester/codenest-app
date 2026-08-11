// Attribution of sub-agent frames to the `Task`/`Agent` tool block that
// spawned them, via the wire's `parent_tool_use_id`. Fixtures are built from
// the captured sequence in
// `plans/agent-pane-subagent-and-todo-rendering.md:440-478` (a single
// delegation reading a file and running a sleeping bash command), not
// hand-invented shapes. Split out of `agent-conversation.test.ts` — a new
// file rather than more cases in that 1500-line file, matching the split
// that already put grouping in its own file.

import { describe, it, expect } from "vitest";
import {
  applyFrame,
  childToolCount,
  delegationElapsedMs,
  emptyConversation,
  frameParentToolUseId,
  type ConvToolBlock,
  type ConvTurn,
} from "../agent-conversation";
import type { AgentFrame, AgentFrameKind } from "../ipc";

function frame(kind: AgentFrameKind, raw: unknown, sessionId = "s1"): AgentFrame {
  return { pane_id: "pane-1", session_id: sessionId, kind, raw };
}

/** An unparented `Agent`/`Task` `tool_use` — the delegating call itself. */
function agentToolUseFrame(id: string, name = "Agent"): AgentFrame {
  return frame("tool_use", {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id,
          name,
          input: {
            description: "inspect seed",
            prompt: "Read the file seed.txt … report just the number of lines.",
            subagent_type: "general-purpose",
            run_in_background: false,
          },
        },
      ],
    },
  });
}

function parentedUserTextFrame(parentId: string, text: string): AgentFrame {
  return frame("user", {
    type: "user",
    parent_tool_use_id: parentId,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function parentedAssistantTextFrame(parentId: string, text: string): AgentFrame {
  return frame("assistant", {
    type: "assistant",
    parent_tool_use_id: parentId,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function parentedToolUseFrame(
  parentId: string,
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): AgentFrame {
  return frame("tool_use", {
    type: "assistant",
    parent_tool_use_id: parentId,
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
}

function parentedToolResultFrame(
  parentId: string,
  toolUseId: string,
  content = "done",
  isError = false,
): AgentFrame {
  return frame("tool_result", {
    type: "user",
    parent_tool_use_id: parentId,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
  });
}

/** The delegation's own, unparented `tool_result` — the Agent call's answer
 *  coming back to the main session. */
function toolResultFrame(toolUseId: string, content = "done", isError = false): AgentFrame {
  return frame("tool_result", {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
  });
}

describe("attributing parented frames to their delegating block", () => {
  it("a delegated prompt never becomes a top-level user turn", () => {
    const withAgent = applyFrame(emptyConversation(), agentToolUseFrame("toolu_agent"), 1000);
    const state = applyFrame(
      withAgent,
      parentedUserTextFrame(
        "toolu_agent",
        "Read the file seed.txt … report just the number of lines.",
      ),
      2000,
    );

    expect(state.turns.filter((t) => t.role === "user")).toHaveLength(0);
    const block = state.turns[0]?.blocks[0] as ConvToolBlock;
    expect(block.childTurns[0]?.blocks[0]).toEqual({
      type: "text",
      text: "Read the file seed.txt … report just the number of lines.",
    });
  });

  it("a sub-agent's assistant text and tool calls stay off the main transcript", () => {
    let state = applyFrame(emptyConversation(), agentToolUseFrame("toolu_agent"), 1000);
    state = applyFrame(state, parentedAssistantTextFrame("toolu_agent", "Reading now."), 2000);
    state = applyFrame(
      state,
      parentedToolUseFrame("toolu_agent", "toolu_read", "Read", { file_path: "seed.txt" }),
      3000,
    );

    // Still one assistant turn holding the Agent block — nothing new at the top.
    expect(state.turns).toHaveLength(1);
    const block = state.turns[0]?.blocks[0] as ConvToolBlock;
    expect(block.childTurns).toHaveLength(1);
    expect(block.childTurns[0]?.blocks[0]).toEqual({ type: "text", text: "Reading now." });
    expect(block.childTurns[0]?.blocks[1]?.type).toBe("tool");
  });

  it("a nested tool_result resolves the nested block, not the delegation card", () => {
    let state = applyFrame(emptyConversation(), agentToolUseFrame("toolu_agent"), 1000);
    state = applyFrame(
      state,
      parentedToolUseFrame("toolu_agent", "toolu_read", "Read", { file_path: "seed.txt" }),
      2000,
    );
    state = applyFrame(state, parentedToolResultFrame("toolu_agent", "toolu_read", "3\n"), 3000);

    const parentBlock = state.turns[0]?.blocks[0] as ConvToolBlock;
    expect(parentBlock.endedAt).toBeNull();
    const childBlock = parentBlock.childTurns[0]?.blocks[0] as ConvToolBlock;
    expect(childBlock.output).toBe("3\n");
    expect(childBlock.endedAt).toBe(3000);
  });

  it("the delegation's own tool_result ends the card", () => {
    let state = applyFrame(emptyConversation(), agentToolUseFrame("toolu_agent"), 1000);
    state = applyFrame(state, parentedAssistantTextFrame("toolu_agent", "Reading now."), 2000);
    state = applyFrame(state, toolResultFrame("toolu_agent", "3 lines"), 3000);

    const block = state.turns[0]?.blocks[0] as ConvToolBlock;
    expect(block.endedAt).toBe(3000);
    // The child stream built so far is untouched by the delegation's own result.
    expect(block.childTurns).toHaveLength(1);
  });

  it("a frame naming an unknown parent block is dropped, not appended", () => {
    const state = emptyConversation();
    const result = applyFrame(state, parentedUserTextFrame("toolu_unknown", "a prompt"), 1000);

    expect(result).toBe(state);
    expect(result.turns).toEqual([]);
  });

  it("a sub-agent's frames after the transcript is cleared are dropped", () => {
    const withAgent = applyFrame(emptyConversation(), agentToolUseFrame("toolu_agent"), 1000);
    // What `clearContext` (`agent-session-store.ts:112-138`) produces.
    const cleared = { ...withAgent, turns: [] };
    const result = applyFrame(cleared, parentedUserTextFrame("toolu_agent", "a prompt"), 2000);

    expect(result).toBe(cleared);
  });

  it("a sub-agent that itself delegates attributes to its own parent block", () => {
    let state = applyFrame(emptyConversation(), agentToolUseFrame("toolu_outer"), 1000);
    state = applyFrame(
      state,
      parentedToolUseFrame("toolu_outer", "toolu_inner", "Agent", { description: "nested" }),
      2000,
    );
    state = applyFrame(
      state,
      parentedAssistantTextFrame("toolu_inner", "Doing the nested work."),
      3000,
    );

    expect(state.turns).toHaveLength(1); // top-level turn count unchanged
    const outerBlock = state.turns[0]?.blocks[0] as ConvToolBlock;
    expect(outerBlock.childTurns).toHaveLength(1); // depth-1 child turn count unchanged
    const innerBlock = outerBlock.childTurns[0]?.blocks[0] as ConvToolBlock;
    expect(innerBlock.name).toBe("Agent");
    expect(innerBlock.childTurns[0]?.blocks[0]).toEqual({
      type: "text",
      text: "Doing the nested work.",
    });
  });

  it("a parented delta never reaches the main stream buffer", () => {
    const before = applyFrame(emptyConversation(), agentToolUseFrame("toolu_agent"), 1000);
    const after = applyFrame(
      before,
      frame("delta", {
        type: "stream_event",
        parent_tool_use_id: "toolu_agent",
        event: { delta: { type: "text_delta", text: "sub-agent tokens" } },
      }),
      2000,
    );

    expect(after.streamText).toBe("");
    expect(after).toBe(before);
  });

  it("a parented result never idles the pane", () => {
    const withAgent = applyFrame(emptyConversation(), agentToolUseFrame("toolu_agent"), 1000);
    const before = { ...withAgent, status: "running" as const };
    const after = applyFrame(
      before,
      frame("result", {
        type: "result",
        parent_tool_use_id: "toolu_agent",
        total_cost_usd: 0.01,
      }),
      2000,
    );

    expect(after.status).toBe("running");
    expect(after).toBe(before);
  });

  it("a permission request is never dropped, even carrying a parent id", () => {
    const withAgent = applyFrame(emptyConversation(), agentToolUseFrame("toolu_agent"), 1000);
    const state = applyFrame(
      withAgent,
      frame("permission", {
        type: "control_request",
        parent_tool_use_id: "toolu_agent",
        request_id: "req_1",
        request: { subtype: "can_use_tool", tool_name: "Bash" },
      }),
      2000,
    );

    expect(state.permissions).toHaveLength(1);
  });
});

describe("frameParentToolUseId", () => {
  it("reads null, absent and empty string as no parent", () => {
    expect(frameParentToolUseId({ parent_tool_use_id: null })).toBeNull();
    expect(frameParentToolUseId({})).toBeNull();
    expect(frameParentToolUseId({ parent_tool_use_id: "" })).toBeNull();
    expect(frameParentToolUseId(null)).toBeNull();
    expect(frameParentToolUseId({ parent_tool_use_id: "toolu_1" })).toBe("toolu_1");
  });
});

function toolBlock(over: Partial<ConvToolBlock> = {}): ConvToolBlock {
  return {
    type: "tool",
    id: "t1",
    name: "Agent",
    argSummary: "",
    input: null,
    diffstat: null,
    output: null,
    startedAt: 0,
    endedAt: null,
    isError: false,
    childTurns: [],
    ...over,
  };
}

function childTurn(blocks: ConvTurn["blocks"]): ConvTurn {
  return { id: "child-turn", role: "assistant", at: 0, blocks };
}

describe("childToolCount", () => {
  it("counts only the sub-agent's own calls, not a nested delegation's", () => {
    const nested = toolBlock({
      id: "nested",
      childTurns: [childTurn([toolBlock({ id: "deep" })])],
    });
    const block = toolBlock({
      childTurns: [childTurn([toolBlock({ id: "a" }), toolBlock({ id: "b" }), nested])],
    });
    expect(childToolCount(block)).toBe(3);
  });

  it("is 0 until the sub-agent has called anything", () => {
    expect(childToolCount(toolBlock())).toBe(0);
  });
});

describe("delegationElapsedMs", () => {
  it("is exact once ended, ignoring the injected clock", () => {
    const block = toolBlock({ startedAt: 1000, endedAt: 4500 });
    expect(delegationElapsedMs(block, 999_999)).toBe(3500);
  });

  it("is measured against the injected clock while live", () => {
    const block = toolBlock({ startedAt: 1000, endedAt: null });
    expect(delegationElapsedMs(block, 2500)).toBe(1500);
  });

  it("never goes negative", () => {
    const block = toolBlock({ startedAt: 5000, endedAt: null });
    expect(delegationElapsedMs(block, 1000)).toBe(0);
  });
});
