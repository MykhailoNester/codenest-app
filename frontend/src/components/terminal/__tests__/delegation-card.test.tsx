// The delegation card that replaces the machine-written prompt a `Task`/
// `Agent` call used to dump into the main transcript as a `YOU` turn — this
// is the user-visible statement of the bug the reducer-level
// `subagent-attribution.test.ts` fixes underneath.

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentConversation } from "../agent-conversation";
import {
  applyFrame,
  emptyConversation,
  formatDuration,
  type ConversationState,
} from "../../../lib/agent-conversation";
import type { AgentFrame, AgentFrameKind } from "../../../lib/ipc";

afterEach(() => {
  cleanup();
});

function noop(): void {
  /* conversation callback stub */
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

function parentedToolUseFrame(parentId: string, id: string, name: string): AgentFrame {
  return frame("tool_use", {
    type: "assistant",
    parent_tool_use_id: parentId,
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
  });
}

function parentedUserTextFrame(parentId: string, text: string): AgentFrame {
  return frame("user", {
    type: "user",
    parent_tool_use_id: parentId,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function toolResultFrame(toolUseId: string): AgentFrame {
  return frame("tool_result", {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok", is_error: false }],
    },
  });
}

/** A delegation with its own spawning prompt and three tool calls already
 *  under way — exactly the shape that used to leak into the main transcript. */
function delegationState(): ConversationState {
  let state = applyFrame(
    emptyConversation(),
    agentToolUseFrame("toolu_agent", "Review the auth module", "reviewer"),
    1_000,
  );
  state = applyFrame(
    state,
    parentedUserTextFrame(
      "toolu_agent",
      "Read every file under src/auth and summarise it.",
    ),
    1_100,
  );
  state = applyFrame(state, parentedToolUseFrame("toolu_agent", "toolu_1", "Read"), 1_200);
  state = applyFrame(state, parentedToolUseFrame("toolu_agent", "toolu_2", "Grep"), 1_300);
  state = applyFrame(state, parentedToolUseFrame("toolu_agent", "toolu_3", "Bash"), 1_400);
  return state;
}

function renderConversation(
  state: ConversationState,
  onOpenSubagent: (id: string) => void = noop,
): ReturnType<typeof render> {
  return render(
    <AgentConversation
      state={state}
      isFocusedPane
      onAllowPermission={noop}
      onAllowPermissionSession={noop}
      onDenyPermission={noop}
      onOpenSubagent={onOpenSubagent}
    />,
  );
}

describe("DelegationCard", () => {
  it("the transcript renders one delegation card per Task/Agent call", () => {
    renderConversation(delegationState());

    expect(screen.getByText(/reviewer/)).toBeTruthy();
    expect(screen.getByText("Review the auth module")).toBeTruthy();
    expect(screen.getByText(/3 tools/)).toBeTruthy();
  });

  it("clicking the card opens that sub-agent's view", () => {
    const onOpenSubagent = vi.fn();
    renderConversation(delegationState(), onOpenSubagent);

    fireEvent.click(screen.getByRole("button", { name: /reviewer/i }));

    expect(onOpenSubagent).toHaveBeenCalledTimes(1);
    expect(onOpenSubagent).toHaveBeenCalledWith("toolu_agent");
  });

  it("a delegated prompt is never rendered as a YOU turn", () => {
    renderConversation(delegationState());

    expect(screen.queryByText(/Read every file under src\/auth/)).toBeNull();
    expect(screen.queryByText("You")).toBeNull();
  });

  it("an ended delegation shows its exact duration; a live one says running", () => {
    let ended = applyFrame(
      emptyConversation(),
      agentToolUseFrame("toolu_done", "Task A", "planner"),
      1_000,
    );
    ended = applyFrame(ended, toolResultFrame("toolu_done"), 4_500);
    renderConversation(ended);
    expect(screen.getByText(new RegExp(formatDuration(3_500).replace(".", "\\.")))).toBeTruthy();
    cleanup();

    const live = applyFrame(
      emptyConversation(),
      agentToolUseFrame("toolu_live", "Task B", "planner"),
      1_000,
    );
    renderConversation(live);
    expect(screen.getByText(/running/)).toBeTruthy();
  });

  it("a delegation with no tools yet shows no tool clause", () => {
    const state = applyFrame(
      emptyConversation(),
      agentToolUseFrame("toolu_agent", "Task", "planner"),
      1_000,
    );
    renderConversation(state);

    expect(screen.queryByText(/tools/)).toBeNull();
  });
});
