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

// Same reasoning as the permission dialog's own affordance block: this is a
// consent surface, so which button is primary and which is destructive is
// behaviour, not decoration. Assertable since the Deck conversion (#283) put
// the tone in an inline style — vitest stubs CSS modules, so the old classes
// resolved to nothing in a test.
describe("AgentQuestionDialog consent affordances", () => {
  function dialog(): HTMLElement {
    const el = document.querySelector("[data-question-dialog]");
    if (el === null) throw new Error("no question dialog rendered");
    return el as HTMLElement;
  }

  it("Answer is the one primary action and Deny the one destructive one", () => {
    renderConv(stateWith(askRequest(restoreInput)));
    const primaries = Array.from(dialog().querySelectorAll("button.pri"));
    const dangers = Array.from(dialog().querySelectorAll("button.danger"));
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.textContent).toMatch(/^Answer\b/);
    expect(dangers).toHaveLength(1);
    expect(dangers[0]!.textContent).toMatch(/^Deny\b/);
  });

  it("keeps Deny away from Answer — the two are not adjacent", () => {
    renderConv(stateWith(askRequest(restoreInput)));
    const deny = screen.getByRole("button", { name: /^Deny/ });
    expect(deny.previousElementSibling?.tagName).not.toBe("BUTTON");
  });

  it("leaves the options as radios, never as buttons that could read as submitting", () => {
    renderConv(stateWith(askRequest(restoreInput)));
    const options = dialog().querySelectorAll('[role="radiogroup"] button');
    expect(options).toHaveLength(0);
    expect(screen.getAllByRole("radio").length).toBeGreaterThan(0);
  });

  it("wears the live tone, not the permission ask's warn one", () => {
    renderConv(stateWith(askRequest(restoreInput)));
    expect(dialog().style.borderColor).toBe("var(--run)");
    expect(dialog().style.borderColor).not.toBe("var(--warn)");
  });
});
