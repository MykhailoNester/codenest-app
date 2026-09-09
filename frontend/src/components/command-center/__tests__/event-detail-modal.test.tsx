// Coverage for the "body not stored" affordance (#159).
//
// From the sidecar trim on, a tool event's payload_json carries only the
// provenance fields and a per-tool allowlisted tool_input slice — never
// tool_response, never a Bash/file body. The modal's renderers were already
// null-safe against a missing anchor key (they fall back to
// GenericJsonRenderer), so this is an affordance that explains a trimmed
// row reads as policy, not a crash-avoidance test.

import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EventDetailModal, type EventLike } from "../event-detail-modal";

afterEach(() => {
  cleanup();
});

function makeEvent(overrides: Partial<EventLike> = {}): EventLike {
  return {
    id: 1,
    session_id: "session-1",
    event_type: "PostToolUse",
    tool_name: "Bash",
    summary: "Bash done",
    payload_json: null,
    created_at: "2026-07-31T10:00:00Z",
    ...overrides,
  };
}

describe("EventDetailModal", () => {
  it("shows the body-not-stored note for a trimmed PostToolUse", () => {
    const ev = makeEvent({
      payload_json: JSON.stringify({
        session_id: "session-1",
        cwd: "/tmp/proj",
        tool_name: "Bash",
        tool_use_id: "toolu_1",
        truncated: true,
      }),
      summary: "Bash done",
    });

    render(<EventDetailModal event={ev} onClose={() => {}} />);

    expect(screen.getByText(/body not stored/i)).toBeTruthy();
    expect(screen.getByText("Bash done")).toBeTruthy();
  });

  it("does not show the note for a legacy event that still has a body", () => {
    const ev = makeEvent({
      payload_json: JSON.stringify({
        tool_input: { command: "ls -la" },
        tool_response: { stdout: "a\nb\n", stderr: "" },
      }),
    });

    render(<EventDetailModal event={ev} onClose={() => {}} />);

    expect(screen.queryByText(/body not stored/i)).toBeNull();
    expect(screen.getByText("ls -la")).toBeTruthy();
  });

  it("shows the note for a trimmed PreToolUse with an empty tool_input", () => {
    const ev = makeEvent({
      event_type: "PreToolUse",
      tool_name: "Edit",
      payload_json: JSON.stringify({ tool_input: {} }),
    });

    render(<EventDetailModal event={ev} onClose={() => {}} />);

    expect(screen.getByText(/body not stored/i)).toBeTruthy();
  });

  it("keeps the Task tool_input visible instead of the note", () => {
    const ev = makeEvent({
      event_type: "PreToolUse",
      tool_name: "Task",
      payload_json: JSON.stringify({
        tool_input: {
          subagent_type: "planner-agent",
          name: "Plan the release",
          description: "Work out the rollout order",
        },
      }),
    });

    render(<EventDetailModal event={ev} onClose={() => {}} />);

    expect(screen.queryByText(/body not stored/i)).toBeNull();
    expect(screen.getByText(/subagent_type/)).toBeTruthy();
  });

  it("a trimmed UserPromptSubmit falls back to the no-prompt hint under its summary strip", () => {
    const ev = makeEvent({
      event_type: "UserPromptSubmit",
      tool_name: null,
      payload_json:
        '{"session_id":"s1","hook_event_name":"UserPromptSubmit","truncated":true}',
      summary: "refactor the trim",
    });

    render(<EventDetailModal event={ev} onClose={() => {}} />);

    expect(screen.getByText("(no prompt text)")).toBeTruthy();
    expect(screen.getByText("refactor the trim")).toBeTruthy();
    expect(screen.queryByText(/body not stored/i)).toBeNull();
  });

  it("still renders the prompt for a legacy UserPromptSubmit that has one", () => {
    const ev = makeEvent({
      event_type: "UserPromptSubmit",
      tool_name: null,
      payload_json: '{"prompt": "hello"}',
      summary: "hello (legacy row)",
    });

    render(<EventDetailModal event={ev} onClose={() => {}} />);

    expect(screen.getByText("hello")).toBeTruthy();
  });
});
