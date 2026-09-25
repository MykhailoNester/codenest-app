import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentConversation } from "../agent-conversation";
import {
  emptyConversation,
  parseAgentQuestions,
  type ConversationState,
  type PermissionRequest,
} from "../../../lib/agent-conversation";

const noop = (): void => {};

function askRequest(input: unknown, requestId = "req_1"): PermissionRequest {
  return {
    requestId,
    toolName: "AskUserQuestion",
    displayName: null,
    input,
    description: null,
    toolUseId: "toolu_1",
    decisionReason: null,
    decisionReasonType: null,
    blockedPath: null,
    sessionKey: "AskUserQuestion",
  };
}

const restoreInput = {
  questions: [
    {
      question: "Restore in prod?",
      header: "Restore",
      multiSelect: false,
      options: [
        { label: "Restore now", description: "Roll the snapshot back immediately" },
        { label: "Dry run first", description: "Print the plan, change nothing" },
        { label: "Cancel", description: "Leave prod alone" },
      ],
    },
  ],
};

function stateWith(...permissions: PermissionRequest[]): ConversationState {
  return { ...emptyConversation(), permissions };
}

function renderConv(
  state: ConversationState,
  onAnswerQuestion: (updatedInput: Record<string, unknown>) => void = noop,
): void {
  render(
    <AgentConversation
      state={state}
      isFocusedPane
      onAllowPermission={noop}
      onAllowPermissionSession={noop}
      onDenyPermission={noop}
      onAnswerQuestion={onAnswerQuestion}
      onOpenSubagent={noop}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("parseAgentQuestions", () => {
  it("returns null for every shape it does not recognise", () => {
    expect(parseAgentQuestions(undefined)).toBeNull();
    expect(parseAgentQuestions({})).toBeNull();
    expect(parseAgentQuestions({ questions: [] })).toBeNull();
    expect(parseAgentQuestions({ questions: "nope" })).toBeNull();
    expect(parseAgentQuestions({ questions: [{ question: "Q?" }] })).toBeNull();
    expect(parseAgentQuestions({ questions: [{ question: "Q?", options: [{}] }] })).toBeNull();
  });
});

describe("AgentQuestionDialog", () => {
  it("renders the offered options instead of the raw JSON input", () => {
    renderConv(stateWith(askRequest(restoreInput)));

    expect(screen.getByText("Restore now")).toBeTruthy();
    expect(screen.getByText("Dry run first")).toBeTruthy();
    expect(screen.getByText("Leave prod alone")).toBeTruthy();
    expect(screen.queryByText(/"multiSelect"/)).toBeNull();
  });

  it("answers with the selection keyed by the question text", async () => {
    const onAnswer = vi.fn();
    renderConv(stateWith(askRequest(restoreInput)), onAnswer);

    await userEvent.click(screen.getByText("Dry run first"));
    await userEvent.click(screen.getByRole("button", { name: /Answer/ }));

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0]?.[0]).toEqual({
      ...restoreInput,
      answers: { "Restore in prod?": "Dry run first" },
    });
  });

  it("carries both picks of a multiSelect question into one submit", async () => {
    const onAnswer = vi.fn();
    const input = {
      questions: [
        {
          question: "Which suites?",
          header: "Tests",
          multiSelect: true,
          options: [
            { label: "unit", description: "fast" },
            { label: "e2e", description: "slow" },
            { label: "lint", description: "static" },
          ],
        },
      ],
    };
    renderConv(stateWith(askRequest(input)), onAnswer);

    await userEvent.click(screen.getByText("unit"));
    await userEvent.click(screen.getByText("lint"));
    await userEvent.click(screen.getByRole("button", { name: /Answer/ }));

    expect(onAnswer.mock.calls[0]?.[0]).toEqual({
      ...input,
      answers: { "Which suites?": ["unit", "lint"] },
    });
  });

  it("sends the free text typed into Other, not a label", async () => {
    const onAnswer = vi.fn();
    renderConv(stateWith(askRequest(restoreInput)), onAnswer);

    await userEvent.click(screen.getByText("Other…"));
    await userEvent.type(
      screen.getByLabelText("Other answer for: Restore in prod?"),
      "restore to /Users/test/snapshots",
    );
    await userEvent.click(screen.getByRole("button", { name: /Answer/ }));

    expect(onAnswer.mock.calls[0]?.[0]).toEqual({
      ...restoreInput,
      answers: { "Restore in prod?": "restore to /Users/test/snapshots" },
    });
  });

  it("picks an option by its number key", async () => {
    const onAnswer = vi.fn();
    renderConv(stateWith(askRequest(restoreInput)), onAnswer);

    fireEvent.keyDown(window, { key: "1" });
    fireEvent.keyDown(window, { key: "Enter" });

    expect(onAnswer.mock.calls[0]?.[0]).toEqual({
      ...restoreInput,
      answers: { "Restore in prod?": "Restore now" },
    });
  });

  it("never offers Allow for this session, and keeps Deny", () => {
    renderConv(stateWith(askRequest(restoreInput)));

    expect(screen.queryByRole("button", { name: /Allow for this session/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Deny/ })).toBeTruthy();
  });

  it("falls back to the generic permission dialog on a malformed input", () => {
    renderConv(stateWith(askRequest({ questions: [] })));

    expect(screen.getByRole("button", { name: /Allow for this session/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Answer/ })).toBeNull();
  });

  it("shows the next queued ask with no selection carried over", async () => {
    const second = {
      questions: [
        {
          question: "Then what?",
          header: "Next",
          multiSelect: false,
          options: [{ label: "Deploy", description: "ship it" }],
        },
      ],
    };
    const { rerender } = render(
      <AgentConversation
        state={stateWith(askRequest(restoreInput), askRequest(second, "req_2"))}
        isFocusedPane
        onAllowPermission={noop}
        onAllowPermissionSession={noop}
        onDenyPermission={noop}
        onAnswerQuestion={noop}
        onOpenSubagent={noop}
      />,
    );

    await userEvent.click(screen.getByText("Restore now"));
    rerender(
      <AgentConversation
        state={stateWith(askRequest(second, "req_2"))}
        isFocusedPane
        onAllowPermission={noop}
        onAllowPermissionSession={noop}
        onDenyPermission={noop}
        onAnswerQuestion={noop}
        onOpenSubagent={noop}
      />,
    );

    expect(screen.getByText("Then what?")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Deploy/ }).getAttribute("checked")).toBeNull();
    expect((screen.getByRole("button", { name: /Answer/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
