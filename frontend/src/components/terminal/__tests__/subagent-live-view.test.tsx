// The drill-in view's own stream (#23) — the ticket's core claim, checked
// end to end: a sub-agent's (and an orchestration's) `childTurns` render
// through the exact same block renderers the main transcript uses, live,
// with the returned result pinned last and no invented placeholder text.
// Fixtures built from `applyFrame`, the same idiom `delegation-card.test.tsx`
// and `subagent-attribution.test.ts` use — not hand-shaped `ConvTurn`/
// `ConvBlock` literals, so a fixture here is only ever a real wire shape.

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentViewPanel } from "../agent-view-panel";
import {
  applyFrame,
  emptyConversation,
  summarizeToolRun,
  type ConvToolBlock,
  type OrchestrationRun,
} from "../../../lib/agent-conversation";
import type { AgentFrame, AgentFrameKind } from "../../../lib/ipc";

afterEach(() => {
  cleanup();
});

function noop(): void {
  /* onOpenSubagent stub */
}

function frame(kind: AgentFrameKind, raw: unknown): AgentFrame {
  return { pane_id: "pane-1", session_id: "s1", kind, raw };
}

function agentToolUseFrame(
  id: string,
  description: string,
  subagentType: string,
): AgentFrame {
  return frame("tool_use", {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id,
          name: "Agent",
          input: { description, subagent_type: subagentType, prompt: "do the work" },
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

function toolResultFrame(toolUseId: string, content = "done", isError = false): AgentFrame {
  return frame("tool_result", {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
  });
}

/** A delegation with its own spawning prompt, an assistant line and three
 *  tool calls under way — exactly `delegation-card.test.tsx`'s own fixture,
 *  plus the assistant line this ticket needs to prove the stream renders
 *  prose too, not just tool rows. */
function delegationBlock(id = "toolu_agent"): ConvToolBlock {
  let state = applyFrame(
    emptyConversation(),
    agentToolUseFrame(id, "Review the auth module", "reviewer"),
    1_000,
  );
  state = applyFrame(
    state,
    parentedUserTextFrame(id, "Read every file under src/auth and summarise it."),
    1_100,
  );
  state = applyFrame(state, parentedAssistantTextFrame(id, "Reading the files now."), 1_150);
  state = applyFrame(
    state,
    parentedToolUseFrame(id, "toolu_1", "Read", { file_path: "src/auth/user.py" }),
    1_200,
  );
  state = applyFrame(
    state,
    parentedToolUseFrame(id, "toolu_2", "Grep", { pattern: "TODO" }),
    1_300,
  );
  state = applyFrame(state, parentedToolUseFrame(id, "toolu_3", "Bash", { command: "pytest" }), 1_400);
  return state.turns[0]?.blocks[0] as ConvToolBlock;
}

/** The three tool calls `delegationBlock` put under way, in transcript order —
 *  read back off the block itself rather than re-declared, so a test can
 *  never disagree with what the fixture actually produced. */
function toolBlocksOf(block: ConvToolBlock): ConvToolBlock[] {
  return block.childTurns
    .flatMap((t) => t.blocks)
    .filter((b): b is ConvToolBlock => b.type === "tool");
}

function orchestrationRun(over: Partial<OrchestrationRun> = {}): OrchestrationRun {
  return {
    taskId: "wf1",
    toolUseId: "toolu_workflow",
    name: "review-changes",
    description: "Review across dimensions",
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

describe("SubagentView's own stream", () => {
  it("renders the sub-agent's own assistant text and grouped tool rows while it runs", () => {
    const block = delegationBlock();
    render(
      <AgentViewPanel kind="subagent" block={block} sessionExited={false} onOpenSubagent={noop} />,
    );

    expect(screen.getByTestId("subagent-stream")).toBeTruthy();
    expect(screen.getByText("Reading the files now.")).toBeTruthy();
    // Grouped through the exact same code path the transcript uses, not a
    // lookalike: the collapsed run's summary line is `summarizeToolRun`'s own
    // output for these three calls.
    expect(screen.getByText(summarizeToolRun(toolBlocksOf(block)))).toBeTruthy();
  });

  it("a child stream's tool run expands into its individual rows", () => {
    const block = delegationBlock();
    render(
      <AgentViewPanel kind="subagent" block={block} sessionExited={false} onOpenSubagent={noop} />,
    );

    // Buried inside the collapsed run — Grep is not the headline (Read is,
    // as the first still-open call), so this is the row expanding proves.
    expect(screen.queryByText("TODO")).toBeNull();

    const summary = screen.getByRole("button", { expanded: false });
    fireEvent.click(summary);

    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("TODO")).toBeTruthy();
  });

  it("the delegated prompt is labelled Prompt, never You", () => {
    const block = delegationBlock();
    render(
      <AgentViewPanel kind="subagent" block={block} sessionExited={false} onOpenSubagent={noop} />,
    );

    expect(screen.queryByText("You")).toBeNull();
    expect(screen.getByText("Prompt")).toBeTruthy();
  });

  it("the returned result renders last, after the stream", () => {
    let state = applyFrame(
      emptyConversation(),
      agentToolUseFrame("toolu_agent", "Review the auth module", "reviewer"),
      1_000,
    );
    state = applyFrame(state, parentedAssistantTextFrame("toolu_agent", "Looking now."), 1_100);
    state = applyFrame(state, toolResultFrame("toolu_agent", "All good."), 2_000);
    const block = state.turns[0]?.blocks[0] as ConvToolBlock;

    render(
      <AgentViewPanel kind="subagent" block={block} sessionExited={false} onOpenSubagent={noop} />,
    );

    const stream = screen.getByTestId("subagent-stream");
    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(
      stream.compareDocumentPosition(pre as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("an agent that returned nothing says so, and invents nothing", () => {
    let state = applyFrame(
      emptyConversation(),
      agentToolUseFrame("toolu_agent", "Task", "planner"),
      1_000,
    );
    state = applyFrame(state, toolResultFrame("toolu_agent", ""), 2_000);
    const block = state.turns[0]?.blocks[0] as ConvToolBlock;

    render(
      <AgentViewPanel kind="subagent" block={block} sessionExited={false} onOpenSubagent={noop} />,
    );

    expect(screen.getByText("Reported nothing back.")).toBeTruthy();
    expect(document.querySelector("pre")).toBeNull();
    expect(screen.queryByTestId("subagent-stream")).toBeNull();
  });

  it("a running agent with an empty stream still says it is working", () => {
    const state = applyFrame(
      emptyConversation(),
      agentToolUseFrame("toolu_agent", "Task", "planner"),
      1_000,
    );
    const block = state.turns[0]?.blocks[0] as ConvToolBlock;

    render(
      <AgentViewPanel kind="subagent" block={block} sessionExited={false} onOpenSubagent={noop} />,
    );

    expect(screen.getByText("Still working — nothing reported back yet.")).toBeTruthy();
    expect(screen.queryByTestId("subagent-stream")).toBeNull();
    expect(document.querySelector("pre")).toBeNull();
  });

  it("a session that died mid-call does not claim the agent returned nothing", () => {
    const state = applyFrame(
      emptyConversation(),
      agentToolUseFrame("toolu_agent", "Task", "planner"),
      1_000,
    );
    const block = state.turns[0]?.blocks[0] as ConvToolBlock;

    render(<AgentViewPanel kind="subagent" block={block} sessionExited onOpenSubagent={noop} />);

    expect(screen.getByText("Session ended before this sub-agent reported back.")).toBeTruthy();
    expect(screen.queryByText("Reported nothing back.")).toBeNull();
    expect(screen.queryByText("Still working — nothing reported back yet.")).toBeNull();
  });

  it("a nested delegation renders a card that opens the nested agent", () => {
    let state = applyFrame(
      emptyConversation(),
      agentToolUseFrame("toolu_outer", "Review", "reviewer"),
      1_000,
    );
    state = applyFrame(
      state,
      parentedToolUseFrame("toolu_outer", "toolu_inner", "Agent", {
        description: "Check the nested module",
        subagent_type: "checker",
      }),
      1_100,
    );
    const block = state.turns[0]?.blocks[0] as ConvToolBlock;

    const onOpenSubagent = vi.fn();
    render(
      <AgentViewPanel
        kind="subagent"
        block={block}
        sessionExited={false}
        onOpenSubagent={onOpenSubagent}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /checker/i }));

    expect(onOpenSubagent).toHaveBeenCalledWith("toolu_inner");
  });
});

describe("WorkflowView's own stream", () => {
  it("renders the run's own stream, and nothing when it has none", () => {
    const streamed = applyFrame(
      emptyConversation(),
      frame("assistant", {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Kicking off phase one." }] },
      }),
      1_000,
    );

    render(
      <AgentViewPanel
        kind="workflow"
        run={orchestrationRun()}
        childTurns={streamed.turns}
        sessionExited={false}
        onOpenSubagent={noop}
      />,
    );
    expect(screen.getByTestId("workflow-stream")).toBeTruthy();
    expect(screen.getByText("Kicking off phase one.")).toBeTruthy();
    cleanup();

    render(
      <AgentViewPanel
        kind="workflow"
        run={orchestrationRun()}
        childTurns={[]}
        sessionExited={false}
        onOpenSubagent={noop}
      />,
    );
    expect(screen.queryByTestId("workflow-stream")).toBeNull();
  });
});
