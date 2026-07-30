import { describe, it, expect } from "vitest";
import {
  applyFrame,
  appendUserTurn,
  emptyConversation,
  formatDuration,
  previewUserMessageLine,
  splitInlineCode,
  toolArgSummary,
  toolDiffstat,
  type ConvToolBlock,
} from "../agent-conversation";
import type { AgentFrame, AgentFrameKind } from "../ipc";

// Fixtures below are transcribed verbatim from the plan's Wire verification
// section (captured against CLI 2.1.220), not hand-invented shapes.

function frame(kind: AgentFrameKind, raw: unknown, sessionId = "s1"): AgentFrame {
  return { pane_id: "pane-1", session_id: sessionId, kind, raw };
}

describe("agent-conversation reducer", () => {
  it("an assistant frame appends one turn whose text round-trips inline code", () => {
    const f = frame("assistant", {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Reading `use-terminal-shortcuts.ts` now." }],
      },
      session_id: "s1",
    });
    const state = applyFrame(emptyConversation(), f, 1000);
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.role).toBe("assistant");
    const block = state.turns[0]?.blocks[0];
    expect(block?.type).toBe("text");
    if (block?.type !== "text") throw new Error("expected a text block");
    expect(splitInlineCode(block.text)).toEqual([
      { code: false, text: "Reading " },
      { code: true, text: "use-terminal-shortcuts.ts" },
      { code: false, text: " now." },
    ]);
  });

  it("an assistant frame whose only block is thinking appends no text block and no empty turn", () => {
    const f = frame("assistant", {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "", signature: "abc" }],
      },
    });
    const state = applyFrame(emptyConversation(), f, 1000);
    expect(state.turns).toHaveLength(0);
  });

  it("a tool_use Edit frame produces a tool block with argSummary and diffstat", () => {
    const f = frame("tool_use", {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Edit",
            input: {
              file_path: "use-terminal-shortcuts.ts",
              old_string: "a\nb",
              new_string: "a\nb\nc\nd",
            },
          },
        ],
      },
    });
    const state = applyFrame(emptyConversation(), f, 1000);
    const block = state.turns[0]?.blocks[0];
    expect(block?.type).toBe("tool");
    if (block?.type !== "tool") throw new Error("expected a tool block");
    expect(block.name).toBe("Edit");
    expect(block.argSummary).toBe("use-terminal-shortcuts.ts");
    expect(block.diffstat).toEqual({ added: 4, removed: 2 });
    expect(block.endedAt).toBeNull();
  });

  it("a Bash tool_use frame produces diffstat === null — no fake chip", () => {
    const f = frame("tool_use", {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_2",
            name: "Bash",
            input: { command: "pnpm vitest run use-terminal-shortcuts" },
          },
        ],
      },
    });
    const state = applyFrame(emptyConversation(), f, 1000);
    const block = state.turns[0]?.blocks[0] as ConvToolBlock;
    expect(block.argSummary).toBe("pnpm vitest run use-terminal-shortcuts");
    expect(block.diffstat).toBeNull();
  });

  it("a tool_result with string content fills output/endedAt/duration on the matching block", () => {
    const started = applyFrame(
      emptyConversation(),
      frame("tool_use", {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "ls" } }],
        },
      }),
      1000,
    );
    const finished = applyFrame(
      started,
      frame("tool_result", {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_3", content: "a.ts\nb.ts" }],
        },
      }),
      1340,
    );
    const block = finished.turns[0]?.blocks[0] as ConvToolBlock;
    expect(block.output).toBe("a.ts\nb.ts");
    expect(block.endedAt).toBe(1340);
    expect(formatDuration((block.endedAt ?? 0) - block.startedAt)).toBe("340ms");
  });

  it("a tool_result with array content flattens over text blocks", () => {
    const started = applyFrame(
      emptyConversation(),
      frame("tool_use", {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_4", name: "Read", input: { file_path: "x.ts" } }],
        },
      }),
      0,
    );
    const finished = applyFrame(
      started,
      frame("tool_result", {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_4",
              content: [{ type: "text", text: "line one" }, { type: "text", text: " line two" }],
            },
          ],
        },
      }),
      50,
    );
    const block = finished.turns[0]?.blocks[0] as ConvToolBlock;
    expect(block.output).toBe("line one line two");
  });

  it("a tool_result with an unmatched tool_use_id is ignored without throwing", () => {
    const state = emptyConversation();
    const result = applyFrame(
      state,
      frame("tool_result", {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "does-not-exist", content: "x" }],
        },
      }),
      0,
    );
    expect(result).toBe(state);
  });

  it("a 5000-char tool_result output is capped at 4000", () => {
    const started = applyFrame(
      emptyConversation(),
      frame("tool_use", {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_5", name: "Read", input: { file_path: "big.ts" } }],
        },
      }),
      0,
    );
    const finished = applyFrame(
      started,
      frame("tool_result", {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_5", content: "x".repeat(5000) }],
        },
      }),
      0,
    );
    const block = finished.turns[0]?.blocks[0] as ConvToolBlock;
    expect(block.output).toHaveLength(4000);
  });

  it("the captured can_use_tool frame yields a PermissionRequest with a sessionKey from the first rule", () => {
    const raw = {
      type: "control_request",
      request_id: "d501ec82-dd10-4a3c-b2b1-e1c913b3e597",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        display_name: "Bash",
        input: {
          command: 'curl -s https://example.com/nope --max-time 2 ; echo "exit code: $?"',
          description: "Fetch URL with curl and report exit code",
        },
        description: "Fetch URL with curl and report exit code",
        permission_suggestions: [
          {
            type: "addRules",
            rules: [
              { toolName: "Bash", ruleContent: "curl -s https://example.com/nope --max-time 2" },
              { toolName: "Bash", ruleContent: 'echo "exit code: $?"' },
            ],
            behavior: "allow",
            destination: "localSettings",
          },
        ],
        decision_reason_type: "subcommandResults",
        tool_use_id: "toolu_01AQY9sSrdBGy26KKiQKUF45",
      },
    };
    const state = applyFrame(emptyConversation(), frame("permission", raw), 0);
    expect(state.permissions).toHaveLength(1);
    const req = state.permissions[0];
    expect(req?.requestId).toBe("d501ec82-dd10-4a3c-b2b1-e1c913b3e597");
    expect(req?.toolName).toBe("Bash");
    expect(req?.input).toEqual(raw.request.input);
    expect(req?.sessionKey).toBe("Bash curl -s https://example.com/nope --max-time 2");
  });

  it("a permission request with no suggestions falls back to 'toolName *'", () => {
    const raw = {
      type: "control_request",
      request_id: "req_x",
      request: { subtype: "can_use_tool", tool_name: "Read" },
    };
    const state = applyFrame(emptyConversation(), frame("permission", raw), 0);
    expect(state.permissions[0]?.sessionKey).toBe("Read *");
  });

  it("two permission frames queue FIFO", () => {
    let state = emptyConversation();
    state = applyFrame(
      state,
      frame("permission", {
        request_id: "req_1",
        request: { subtype: "can_use_tool", tool_name: "Bash" },
      }),
      0,
    );
    state = applyFrame(
      state,
      frame("permission", {
        request_id: "req_2",
        request: { subtype: "can_use_tool", tool_name: "Read" },
      }),
      0,
    );
    expect(state.permissions.map((p) => p.requestId)).toEqual(["req_1", "req_2"]);
  });

  it("result sets status idle and lastResult, surfacing is_error rather than swallowing it", () => {
    const state = applyFrame(
      emptyConversation(),
      frame("result", {
        subtype: "success",
        is_error: true,
        duration_ms: 2300,
        total_cost_usd: 0.01,
        result: "Invalid API key",
      }),
      0,
    );
    expect(state.status).toBe("idle");
    expect(state.lastResult).toEqual({ costUsd: 0.01, durationMs: 2300, isError: true });
  });

  it("system status requesting sets running; other subtypes are inert", () => {
    const running = applyFrame(
      emptyConversation(),
      frame("system", { subtype: "status", status: "requesting" }),
      0,
    );
    expect(running.status).toBe("running");

    const before = emptyConversation();
    const after = applyFrame(before, frame("system", { subtype: "hook_started" }), 0);
    expect(after.status).toBe(before.status);
  });

  it("delta frames: text_delta appends, thinking_delta sets thinking without text, input_json_delta is a no-op", () => {
    let state = emptyConversation();
    state = applyFrame(
      state,
      frame("delta", { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } }),
      0,
    );
    expect(state.streaming).toBe(true);
    expect(state.streamText).toBe("Hel");

    state = applyFrame(
      state,
      frame("delta", {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "", estimated_tokens: 12 } },
      }),
      0,
    );
    expect(state.thinking).toBe(true);
    expect(state.thinkingTokens).toBe(12);
    expect(state.streamText).toBe("Hel"); // no text appended by a thinking delta

    const beforeJsonDelta = state;
    state = applyFrame(
      state,
      frame("delta", {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"a\":" } },
      }),
      0,
    );
    expect(state).toBe(beforeJsonDelta);

    // A following assistant frame replaces the buffer rather than doubling it.
    state = applyFrame(
      state,
      frame("assistant", {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Hello there" }] },
      }),
      10,
    );
    expect(state.streamText).toBe("");
    expect(state.streaming).toBe(false);
    const block = state.turns[0]?.blocks[0];
    expect(block?.type === "text" ? block.text : null).toBe("Hello there");
  });

  it("stderr and error frames become error blocks — never dropped", () => {
    let state = applyFrame(emptyConversation(), frame("stderr", { source: "stderr", text: "boom" }), 0);
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.blocks[0]).toEqual({ type: "error", text: "boom", source: "stderr" });

    state = applyFrame(
      state,
      frame("error", { source: "stdout", text: "not json", error: "EOF while parsing" }),
      0,
    );
    expect(state.turns[0]?.blocks).toHaveLength(2);
    expect(state.turns[0]?.blocks[1]).toEqual({ type: "error", text: "not json", source: "stdout" });
  });

  it("exit sets status exited and exitCode", () => {
    const state = applyFrame(emptyConversation(), frame("exit", { exit_code: 1 }), 0);
    expect(state.status).toBe("exited");
    expect(state.exitCode).toBe(1);
  });

  it("kind unknown with raw null returns the same state object", () => {
    const state = emptyConversation();
    const result = applyFrame(state, frame("unknown", null), 0);
    expect(result).toBe(state);
  });

  it("kind control returns the same state object", () => {
    const state = emptyConversation();
    const result = applyFrame(
      state,
      frame("control", { type: "control_response", response: { subtype: "success" } }),
      0,
    );
    expect(result).toBe(state);
  });

  it("appendUserTurn appends an optimistic user turn and marks the conversation running", () => {
    const state = appendUserTurn(emptyConversation(), "hello", 5);
    expect(state.status).toBe("running");
    expect(state.turns[0]).toEqual({
      id: "user-0-5",
      role: "user",
      at: 5,
      blocks: [{ type: "text", text: "hello" }],
    });
  });

  it("a user frame carrying the same text as the last user turn is dropped (dedup)", () => {
    const withUser = appendUserTurn(emptyConversation(), "run the tests", 0);
    const deduped = applyFrame(
      withUser,
      frame("user", {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "run the tests" }] },
      }),
      10,
    );
    expect(deduped).toBe(withUser);
  });

  it("a user frame carrying different text is appended", () => {
    const withUser = appendUserTurn(emptyConversation(), "run the tests", 0);
    const appended = applyFrame(
      withUser,
      frame("user", {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "something else" }] },
      }),
      10,
    );
    expect(appended.turns).toHaveLength(2);
  });

  it("previewUserMessageLine('hi') equals the literal encode_user_message writes", () => {
    expect(previewUserMessageLine("hi")).toBe(
      '{"message":{"content":[{"text":"hi","type":"text"}],"role":"user"},"type":"user"}',
    );
  });

  it("toolArgSummary falls back to the first string value for an unrecognised tool", () => {
    expect(toolArgSummary("WebFetch", { url: "https://example.com", prompt: "summarize" })).toBe(
      "https://example.com",
    );
    expect(toolArgSummary("WebFetch", { count: 3 })).toBe("");
  });

  it("toolDiffstat sums MultiEdit across edits[]", () => {
    expect(
      toolDiffstat("MultiEdit", {
        edits: [
          { old_string: "a", new_string: "a\nb" },
          { old_string: "x\ny", new_string: "z" },
        ],
      }),
    ).toEqual({ added: 3, removed: 3 });
  });
});
