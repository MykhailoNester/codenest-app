import { describe, it, expect } from "vitest";
import {
  activeOrchestrations,
  activeSubagents,
  applyFrame,
  appendUserTurn,
  emptyConversation,
  formatDuration,
  isSubagentTool,
  orchestrationBadgeLabel,
  orchestrationCounts,
  orchestrationPhaseTree,
  previewUserMessageLine,
  splitInlineCode,
  toolArgSummary,
  toolDiffstat,
  buildUserMessageText,
  permissionInputSummary,
  type ConversationState,
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

  // The four fixtures below are the literal lines CLI 2.1.220 answered when
  // each `set_permission_mode` request was round-tripped through a child
  // spawned with `build_agent_argv`'s flags.

  it("init reports the mode the session booted with", () => {
    const state = applyFrame(
      emptyConversation(),
      frame("init", {
        type: "system",
        subtype: "init",
        cwd: "/tmp",
        session_id: "s1",
        tools: [],
        model: "claude-opus-5",
        permissionMode: "dontAsk",
        slash_commands: [],
      }),
      0,
    );
    expect(state.permissionMode).toBe("dontAsk");
  });

  it("a set_permission_mode success adopts the mode the CLI applied", () => {
    const state = applyFrame(
      emptyConversation(),
      frame("control", {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "codenest-0",
          response: { mode: "acceptEdits" },
        },
      }),
      0,
    );
    expect(state.permissionMode).toBe("acceptEdits");
    expect(state.permissionModeError).toBeNull();
  });

  it("requesting `manual` adopts the `default` the CLI aliases it to", () => {
    // Not cosmetic: the composer's select has one option for the pair, so
    // adopting the echo verbatim is what keeps it from showing "no selection".
    const state = applyFrame(
      emptyConversation(),
      frame("control", {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "codenest-1",
          response: { mode: "default" },
        },
      }),
      0,
    );
    expect(state.permissionMode).toBe("default");
  });

  it("a refused mode is recorded verbatim and does not move the applied mode", () => {
    let state = applyFrame(
      emptyConversation(),
      frame("control", {
        type: "control_response",
        response: { subtype: "success", request_id: "c0", response: { mode: "plan" } },
      }),
      0,
    );
    state = applyFrame(
      state,
      frame("control", {
        type: "control_response",
        response: {
          subtype: "error",
          request_id: "codenest-2",
          error:
            "Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions",
        },
      }),
      0,
    );
    expect(state.permissionMode).toBe("plan");
    expect(state.permissionModeError).toContain("bypassPermissions");
  });

  it("a control error that is not about the mode is left to the breadcrumb", () => {
    // One frame kind answers interrupt, set_model and set_permission_mode, and
    // the responses are not correlated back to their request — so a set_model
    // failure must not be blamed on the mode switcher.
    const state = applyFrame(
      emptyConversation(),
      frame("control", {
        type: "control_response",
        response: {
          subtype: "error",
          request_id: "codenest-3",
          error: "set_model: model must be a string",
        },
      }),
      0,
    );
    expect(state.permissionModeError).toBeNull();
  });

  it("a fresh init clears a previous session's refusal", () => {
    let state = applyFrame(
      emptyConversation(),
      frame("control", {
        type: "control_response",
        response: { subtype: "error", request_id: "c0", error: "Cannot set permission mode: …" },
      }),
      0,
    );
    state = applyFrame(
      state,
      frame("init", { type: "system", subtype: "init", permissionMode: "default" }),
      0,
    );
    expect(state.permissionModeError).toBeNull();
    expect(state.permissionMode).toBe("default");
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

  it("an assistant frame records the context its own API call sent", () => {
    // Field names and nesting copied from a real CLI 2.1.220 `assistant` line.
    const state = applyFrame(
      { ...emptyConversation(), model: "claude-sonnet-5" },
      frame("assistant", {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 7404,
            cache_read_input_tokens: 19082,
            output_tokens: 94,
          },
        },
      }),
      0,
    );
    // Context is fresh input plus both cache halves — the whole prompt that
    // one call sent, which is how the CLI itself counts it.
    expect(state.usage).toEqual({
      contextTokens: 10 + 7404 + 19082,
      outputTokens: 94,
    });
  });

  it("result contributes the context window and leaves live context alone (#39)", () => {
    const assistant = applyFrame(
      { ...emptyConversation(), model: "claude-sonnet-5" },
      frame("assistant", {
        message: { content: [], usage: { input_tokens: 40, cache_read_input_tokens: 60 } },
      }),
      0,
    );
    const state = applyFrame(
      assistant,
      frame("result", {
        subtype: "success",
        is_error: false,
        duration_ms: 2162,
        total_cost_usd: 0.0171962,
        // The session lifetime aggregate — deliberately ignored for context.
        usage: {
          input_tokens: 300,
          cache_creation_input_tokens: 900_000,
          cache_read_input_tokens: 1_500_000,
          output_tokens: 94,
        },
        modelUsage: {
          "claude-sonnet-5": { contextWindow: 1000000, maxOutputTokens: 64000 },
        },
      }),
      0,
    );
    expect(state.contextWindow).toBe(1000000);
    expect(state.usage).toEqual({ contextTokens: 100, outputTokens: null });
    // Cost still comes off the result frame, where the session total belongs.
    expect(state.lastResult?.costUsd).toBe(0.0171962);
  });

  it("context stays inside the window across many turns (#39)", () => {
    // The regression: every turn re-reads the whole cache, so summing the
    // result frame's three input fields climbs past the window within a
    // handful of turns — the strip that reported `2181k/1000k`. Reading the
    // per-call assistant usage instead cannot exceed the window.
    let state: ConversationState = { ...emptyConversation(), model: "m" };
    let lifetimeRead = 0;
    for (let turn = 1; turn <= 20; turn += 1) {
      const perCallContext = 40_000 + turn * 1_000;
      lifetimeRead += perCallContext;
      state = applyFrame(
        state,
        frame("assistant", {
          message: {
            content: [{ type: "text", text: `turn ${turn}` }],
            usage: { input_tokens: 1_000, cache_read_input_tokens: perCallContext - 1_000 },
          },
        }),
        0,
      );
      state = applyFrame(
        state,
        frame("result", {
          usage: { input_tokens: turn, cache_read_input_tokens: lifetimeRead },
          modelUsage: { m: { contextWindow: 200_000 } },
        }),
        0,
      );
    }
    // The old reducer would have reported the aggregate, which by now exceeds
    // the window; the live figure is one call's prompt.
    expect(lifetimeRead).toBeGreaterThan(200_000);
    expect(state.usage?.contextTokens).toBe(60_000);
    expect(state.contextWindow).toBe(200_000);
  });

  it("result with no matching modelUsage entry reports tokens with no window", () => {
    // The strip must then show tokens and omit the percentage rather than
    // inventing a denominator.
    const state = applyFrame(
      { ...emptyConversation(), model: "claude-opus-5" },
      frame("result", {
        usage: { input_tokens: 5, cache_read_input_tokens: 100 },
        modelUsage: {
          "claude-sonnet-5": { contextWindow: 1000000 },
          "claude-haiku-4-5": { contextWindow: 200000 },
        },
      }),
      0,
    );
    expect(state.contextWindow).toBeNull();
    expect(state.usage).toBeNull();
  });

  it("frames that name no figures keep the previous ones", () => {
    const seeded = applyFrame(
      applyFrame(
        { ...emptyConversation(), model: "m" },
        frame("assistant", { message: { content: [], usage: { input_tokens: 7 } } }),
        0,
      ),
      frame("result", { usage: { input_tokens: 7 }, modelUsage: { m: { contextWindow: 1000 } } }),
      0,
    );
    // A later assistant message with no usage, then a result naming no window.
    const after = applyFrame(
      applyFrame(seeded, frame("assistant", { message: { content: [] } }), 0),
      frame("result", { is_error: false }),
      0,
    );
    expect(after.usage).toEqual(seeded.usage);
    expect(after.contextWindow).toBe(1000);
  });

  it("a sub-agent's usage never reaches the pane's own context figure (#39)", () => {
    // The delegating call first, so the child frame has a parent block to land
    // in and is genuinely folded into the child stream rather than dropped.
    const delegated = applyFrame(
      { ...emptyConversation(), model: "m" },
      frame("tool_use", {
        message: {
          content: [
            { type: "tool_use", id: "toolu_child", name: "Agent", input: { prompt: "go" } },
          ],
          usage: { input_tokens: 500 },
        },
      }),
      0,
    );
    const withChild = applyFrame(
      delegated,
      frame("assistant", {
        parent_tool_use_id: "toolu_child",
        message: { content: [{ type: "text", text: "sub" }], usage: { input_tokens: 90_000 } },
      }),
      0,
    );
    expect(withChild.turns).not.toEqual(delegated.turns); // the child did land
    expect(withChild.usage).toEqual({ contextTokens: 500, outputTokens: null });
  });

  it("init stamps startedAt so elapsed counts the session, not the mount", () => {
    const state = applyFrame(emptyConversation(), frame("init", { model: "m" }), 1234);
    expect(state.startedAt).toBe(1234);
    // A restart re-inits the same pane and restarts the clock.
    const restarted = applyFrame(state, frame("init", { model: "m" }), 9999);
    expect(restarted.startedAt).toBe(9999);
  });

  // #40 — the metrics line showed `idle … 10m 14s` and climbing, because the
  // elapsed cell measured `startedAt` (the session's age). These pin the turn
  // clock that replaced it: it runs only while a turn does, and what it freezes
  // on is that turn's own duration.
  it("the turn clock starts when a turn does and freezes on the result's duration (#40)", () => {
    const sent = appendUserTurn(emptyConversation(), "run the tests", 10_000);
    expect(sent.turnStartedAt).toBe(10_000);
    expect(sent.lastTurnDurationMs).toBeNull();

    // The CLI's own duration wins over anything this side could measure.
    const done = applyFrame(sent, frame("result", { duration_ms: 2_300 }), 42_000);
    expect(done.status).toBe("idle");
    expect(done.turnStartedAt).toBeNull();
    expect(done.lastTurnDurationMs).toBe(2_300);
  });

  it("a turn the CLI opened itself starts the clock too, and queued input does not restart it", () => {
    const requesting = applyFrame(
      emptyConversation(),
      frame("system", { subtype: "status", status: "requesting" }),
      3_000,
    );
    expect(requesting.turnStartedAt).toBe(3_000);

    // Typing again mid-turn belongs to the turn already in flight.
    const queued = appendUserTurn(requesting, "and lint", 8_000);
    expect(queued.turnStartedAt).toBe(3_000);
  });

  it("a result with no duration_ms falls back to the wall time this side measured", () => {
    const sent = appendUserTurn(emptyConversation(), "hi", 1_000);
    const done = applyFrame(sent, frame("result", { is_error: false }), 4_500);
    expect(done.lastTurnDurationMs).toBe(3_500);
  });

  it("a session killed mid-turn freezes on how long that turn did run", () => {
    // No `result` frame ever arrives for an interrupted session, so the exit is
    // the only place left to stop the clock.
    const sent = appendUserTurn(emptyConversation(), "hi", 1_000);
    const dead = applyFrame(sent, frame("exit", { exit_code: 143 }), 6_000);
    expect(dead.status).toBe("exited");
    expect(dead.turnStartedAt).toBeNull();
    expect(dead.lastTurnDurationMs).toBe(5_000);

    // An exit between turns leaves the last completed turn's figure alone.
    const idle = applyFrame(
      appendUserTurn(emptyConversation(), "hi", 1_000),
      frame("result", { duration_ms: 900 }),
      2_000,
    );
    expect(applyFrame(idle, frame("exit", { exit_code: 0 }), 9_000).lastTurnDurationMs).toBe(900);
  });

  it("a restart clears the dead session's turn clock", () => {
    const done = applyFrame(
      appendUserTurn(emptyConversation(), "hi", 1_000),
      frame("result", { duration_ms: 900 }),
      2_000,
    );
    const restarted = applyFrame(done, frame("init", { model: "m" }), 9_999);
    expect(restarted.lastTurnDurationMs).toBeNull();
    expect(restarted.turnStartedAt).toBeNull();
  });

  it("a thinking_tokens system frame sets thinking and its token estimate", () => {
    // Captured shape: {"type":"system","subtype":"thinking_tokens","estimated_tokens":112}
    const state = applyFrame(
      emptyConversation(),
      frame("system", { subtype: "thinking_tokens", estimated_tokens: 112 }),
      0,
    );
    expect(state.thinking).toBe(true);
    expect(state.thinkingTokens).toBe(112);

    // A result frame ends the turn and clears it.
    const done = applyFrame(state, frame("result", { is_error: false }), 0);
    expect(done.thinking).toBe(false);
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

  /**
   * The CLI emits `system/permission_denied` for a tool call it refused *without*
   * asking — a deny rule, the auto-mode classifier, or `dontAsk` mode, which the
   * CLI documents as "Don't prompt for permissions, deny if not pre-approved".
   * Dropping the frame is what made a `dontAsk` session look broken rather than
   * strict: no dialog, no log line, and the only trace was the model narrating
   * "Bash is denied in this mode" a turn later.
   */
  it("a permission_denied system frame renders the refusal", () => {
    const seeded = applyFrame(
      emptyConversation(),
      frame("assistant", {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Checking." }] },
        session_id: "s1",
      }),
      1000,
    );
    const state = applyFrame(
      seeded,
      frame("system", {
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: "toolu_1",
        decision_reason_type: "mode",
        message: "Permission to use Bash has been denied.",
        session_id: "s1",
      }),
      2000,
    );
    const blocks = state.turns.at(-1)?.blocks ?? [];
    const denial = blocks.find((b) => b.type === "error");
    expect(denial).toBeDefined();
    if (denial?.type !== "error") throw new Error("expected an error block");
    expect(denial.text).toContain("Bash");
    expect(denial.text).toContain("denied without asking");
    expect(denial.text).toContain("Permission to use Bash has been denied.");
  });

  it("permission_denied names the pane's mode when that is what refused it", () => {
    const state = applyFrame(
      emptyConversation(),
      frame("system", {
        type: "system",
        subtype: "permission_denied",
        tool_name: "Write",
        tool_use_id: "toolu_2",
        decision_reason_type: "mode",
        message: "denied",
        session_id: "s1",
      }),
      1000,
    );
    const block = state.turns[0]?.blocks[0];
    if (block?.type !== "error") throw new Error("expected an error block");
    expect(block.text).toContain("permission mode");
  });

  it("an unrelated system subtype still changes nothing", () => {
    const before = emptyConversation();
    const after = applyFrame(
      before,
      frame("system", { type: "system", subtype: "hook_started", session_id: "s1" }),
      1000,
    );
    expect(after).toEqual(before);
  });

  it("permissionInputSummary picks the field that identifies the call", () => {
    expect(permissionInputSummary("Bash", { command: "git push" })).toBe("$ git push");
    expect(permissionInputSummary("Write", { file_path: "/tmp/a", content: "x" })).toBe(
      "/tmp/a",
    );
    expect(permissionInputSummary("WebFetch", { url: "https://example.com" })).toBe(
      "https://example.com",
    );
    // An MCP tool's input shape is arbitrary — compact JSON is still honest.
    expect(permissionInputSummary("mcp__x__y", { anything: 1 })).toBe('{"anything":1}');
    expect(permissionInputSummary("Bash", {})).toBeNull();
    expect(permissionInputSummary("Bash", undefined)).toBeNull();
  });
});

// The wire's tool_use.input for a Task/Agent call carries {description, prompt,
// subagent_type} — the same object the hook side calls tool_input
// (app/routers/agents.py:189-191).
function taskToolUseFrame(
  id: string,
  input: Record<string, unknown>,
  name = "Task",
): AgentFrame {
  return frame("tool_use", {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  });
}

function toolResultFrame(toolUseId: string, isError = false): AgentFrame {
  return frame("tool_result", {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: toolUseId, content: "done", is_error: isError },
      ],
    },
  });
}

describe("sub-agent activity", () => {
  it("a Task in flight is reported with its subagent_type and description", () => {
    const state = applyFrame(
      emptyConversation(),
      taskToolUseFrame("toolu_task_1", {
        description: "Review the auth module",
        prompt: "Read every file under src/auth and summarise it.",
        subagent_type: "reviewer",
      }),
      5_000,
    );

    const active = activeSubagents(state);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      id: "toolu_task_1",
      toolName: "Task",
      subagentType: "reviewer",
      description: "Review the auth module",
      startedAt: 5_000,
    });
  });

  it("a tool_result clears the sub-agent from the active list", () => {
    let state = applyFrame(
      emptyConversation(),
      taskToolUseFrame("toolu_task_2", { description: "d", subagent_type: "planner" }),
      1_000,
    );
    expect(activeSubagents(state)).toHaveLength(1);

    state = applyFrame(state, toolResultFrame("toolu_task_2", false), 2_000);
    expect(activeSubagents(state)).toHaveLength(0);
  });

  it("an is_error tool_result clears it too", () => {
    let state = applyFrame(
      emptyConversation(),
      taskToolUseFrame("toolu_task_3", { description: "d", subagent_type: "planner" }),
      1_000,
    );
    state = applyFrame(state, toolResultFrame("toolu_task_3", true), 2_000);
    expect(activeSubagents(state)).toHaveLength(0);
  });

  it("an Agent-named call counts as a sub-agent", () => {
    const state = applyFrame(
      emptyConversation(),
      taskToolUseFrame("toolu_agent_1", { description: "d", subagent_type: "explorer" }, "Agent"),
      1_000,
    );
    expect(isSubagentTool("Agent")).toBe(true);
    expect(activeSubagents(state)).toHaveLength(1);
    expect(activeSubagents(state)[0]?.toolName).toBe("Agent");
  });

  it("a Task with no subagent_type reports null, not a placeholder", () => {
    const state = applyFrame(
      emptyConversation(),
      taskToolUseFrame("toolu_task_4", { description: "" }),
      1_000,
    );
    const active = activeSubagents(state);
    expect(active[0]?.subagentType).toBeNull();
    // An empty-string description is not a description either.
    expect(active[0]?.description).toBeNull();
  });

  it("a Bash call is never reported as a sub-agent", () => {
    const state = applyFrame(
      emptyConversation(),
      frame("tool_use", {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "ls" } }],
        },
      }),
      1_000,
    );
    expect(activeSubagents(state)).toHaveLength(0);
  });

  it("an empty conversation reports none", () => {
    expect(activeSubagents(emptyConversation())).toEqual([]);
  });

  it("concurrent sub-agents are reported oldest first", () => {
    let state = applyFrame(
      emptyConversation(),
      taskToolUseFrame("toolu_t1", { description: "first", subagent_type: "planner" }),
      1_000,
    );
    state = applyFrame(
      state,
      taskToolUseFrame("toolu_t2", { description: "second", subagent_type: "coder" }),
      2_000,
    );

    const active = activeSubagents(state);
    expect(active.map((s) => s.id)).toEqual(["toolu_t1", "toolu_t2"]);
  });

  it("an exited session reports no active sub-agents even with an unresolved Task", () => {
    let state = applyFrame(
      emptyConversation(),
      taskToolUseFrame("toolu_task_5", { description: "d", subagent_type: "planner" }),
      1_000,
    );
    state = applyFrame(state, frame("exit", { exit_code: 0 }), 2_000);
    expect(activeSubagents(state)).toEqual([]);
  });
});

// Fixtures below are transcribed verbatim (or, where the plan's transcription
// was abridged with "…", filled in with plausible sibling values) from the
// plan's "Wire evidence" section — three live captures against CLI 2.1.226 of
// a `Workflow`-tool run (run 1: "Two-phase probe", task_id "wt8nboga7").

/** `system/task_started` for a `Workflow`-tool run — finding 2's payload. */
function taskStartedFrame(taskId: string, extra: Record<string, unknown> = {}): AgentFrame {
  return frame("system", {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: "toolu_01As1tHX8yBzfjZ8DS1Sdpyp",
    description: "Two-phase probe",
    task_type: "local_workflow",
    workflow_name: "wire-probe",
    ...extra,
  });
}

/** `system/task_progress` for a `Workflow`-tool run. */
function taskProgressFrame(taskId: string, extra: Record<string, unknown> = {}): AgentFrame {
  return frame("system", {
    type: "system",
    subtype: "task_progress",
    task_id: taskId,
    ...extra,
  });
}

/** Finding 3's 5.723s snapshot: two declared phases, two agents in Alpha,
 *  both `"start"`. */
const SNAPSHOT_5_723 = [
  { type: "workflow_phase", index: 1, title: "Alpha" },
  { type: "workflow_phase", index: 2, title: "Beta" },
  {
    type: "workflow_agent",
    index: 1,
    label: "red",
    phaseIndex: 1,
    phaseTitle: "Alpha",
    agentId: "aa1c769ec1197b484",
    model: "claude-opus-5[1m]",
    state: "start",
    startedAt: 1_786_255_097_666,
    queuedAt: 1_786_255_097_665,
    attempt: 1,
    promptPreview: "Reply with exactly the word RED…",
    lastProgressAt: 1_786_255_097_666,
  },
  {
    type: "workflow_agent",
    index: 2,
    label: "blue",
    phaseIndex: 1,
    phaseTitle: "Alpha",
    model: "claude-opus-5[1m]",
    state: "start",
    startedAt: 1_786_255_097_680,
    queuedAt: 1_786_255_097_665,
    attempt: 1,
    lastProgressAt: 1_786_255_097_680,
  },
];

/** Finding 3's 7.287s snapshot: agent 1 ("red") promoted to `"done"`. */
const SNAPSHOT_7_287 = [
  SNAPSHOT_5_723[0],
  SNAPSHOT_5_723[1],
  {
    ...SNAPSHOT_5_723[2],
    state: "done",
    tokens: 10_304,
    toolCalls: 0,
    durationMs: 1_594,
    resultPreview: "RED",
  },
  SNAPSHOT_5_723[3],
];

/** Finding 3's 7.411s snapshot: a third agent ("green") starts in phase 2. */
const SNAPSHOT_7_411 = [
  ...SNAPSHOT_7_287,
  { type: "workflow_agent", index: 3, label: "green", phaseIndex: 2, phaseTitle: "Beta", state: "start" },
];

describe("orchestration runs", () => {
  it("a local_workflow task_started opens a running orchestration keyed by task_id", () => {
    const state = applyFrame(emptyConversation(), taskStartedFrame("wt8nboga7"), 5_669);

    const runs = activeOrchestrations(state);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      taskId: "wt8nboga7",
      toolUseId: "toolu_01As1tHX8yBzfjZ8DS1Sdpyp",
      name: "wire-probe",
      description: "Two-phase probe",
      status: "running",
      startedAt: 5_669,
    });
  });

  it("a local_agent or local_bash task_started opens no orchestration", () => {
    for (const taskType of ["local_agent", "local_bash"]) {
      const state = applyFrame(
        emptyConversation(),
        frame("system", {
          type: "system",
          subtype: "task_started",
          task_id: "t1",
          task_type: taskType,
        }),
        1_000,
      );
      expect(activeOrchestrations(state)).toEqual([]);
    }
  });

  it("a task_started with no task_type opens no orchestration", () => {
    const state = applyFrame(
      emptyConversation(),
      frame("system", { type: "system", subtype: "task_started", task_id: "t1" }),
      1_000,
    );
    expect(activeOrchestrations(state)).toEqual([]);
  });

  it("a workflow_progress snapshot replaces the phase and agent lists", () => {
    let state = applyFrame(emptyConversation(), taskStartedFrame("wt8nboga7"), 5_669);
    state = applyFrame(
      state,
      taskProgressFrame("wt8nboga7", { workflow_progress: SNAPSHOT_5_723 }),
      5_723,
    );

    let run = activeOrchestrations(state)[0];
    expect(run?.agents).toHaveLength(2);
    expect(run?.agents.find((a) => a.index === 1)).toMatchObject({ label: "red", state: "start" });

    state = applyFrame(
      state,
      taskProgressFrame("wt8nboga7", { workflow_progress: SNAPSHOT_7_287 }),
      7_287,
    );
    run = activeOrchestrations(state)[0];
    // Replaced wholesale, not accumulated: still exactly two agents, no
    // duplicate index-1 entry.
    expect(run?.agents).toHaveLength(2);
    expect(run?.agents.filter((a) => a.index === 1)).toHaveLength(1);
    expect(run?.agents.find((a) => a.index === 1)).toMatchObject({
      state: "done",
      tokens: 10_304,
      toolCalls: 0,
      durationMs: 1_594,
      resultPreview: "RED",
    });
  });

  it("a task_progress with no workflow_progress keeps the previous snapshot", () => {
    let state = applyFrame(emptyConversation(), taskStartedFrame("wt8nboga7"), 5_669);
    state = applyFrame(
      state,
      taskProgressFrame("wt8nboga7", {
        description: "Alpha: blue",
        usage: { total_tokens: 0 },
        workflow_progress: SNAPSHOT_5_723,
      }),
      5_723,
    );
    const agentsBefore = activeOrchestrations(state)[0]?.agents;

    // The 7.219s frame (finding 3): a throttled batch with no state change
    // carries no `workflow_progress` key at all.
    state = applyFrame(
      state,
      taskProgressFrame("wt8nboga7", {
        description: "Alpha: blue (still running)",
        usage: { total_tokens: 512 },
      }),
      7_219,
    );

    const run = activeOrchestrations(state)[0];
    expect(run?.agents).toEqual(agentsBefore);
    expect(run?.activity).toBe("Alpha: blue (still running)");
    expect(run?.totalTokens).toBe(512);
  });

  it("a task_progress for an unknown task_id is inert", () => {
    const state = applyFrame(emptyConversation(), taskStartedFrame("wt8nboga7"), 5_669);
    const after = applyFrame(
      state,
      taskProgressFrame("some-other-task", { description: "local_bash progress" }),
      6_000,
    );
    expect(after).toBe(state);
  });

  it("task_updated patch statuses map completed/failed/killed to completed/failed/stopped", () => {
    const cases = [
      ["completed", "completed"],
      ["failed", "failed"],
      ["killed", "stopped"],
    ] as const;
    for (const [wireStatus, expected] of cases) {
      let state = applyFrame(emptyConversation(), taskStartedFrame("t1"), 1_000);
      state = applyFrame(
        state,
        frame("system", {
          type: "system",
          subtype: "task_updated",
          task_id: "t1",
          patch: { status: wireStatus, end_time: 2_000 },
        }),
        2_000,
      );
      expect(state.orchestrations[0]?.status).toBe(expected);
    }
  });

  it("task_updated end_time sets endedAt, and a non-numeric end_time falls back to now", () => {
    let state = applyFrame(emptyConversation(), taskStartedFrame("t1"), 1_000);
    state = applyFrame(
      state,
      frame("system", {
        type: "system",
        subtype: "task_updated",
        task_id: "t1",
        patch: { status: "completed", end_time: 1_786_255_180_371 },
      }),
      9_000,
    );
    expect(state.orchestrations[0]?.endedAt).toBe(1_786_255_180_371);

    let state2 = applyFrame(emptyConversation(), taskStartedFrame("t2"), 1_000);
    state2 = applyFrame(
      state2,
      frame("system", {
        type: "system",
        subtype: "task_updated",
        task_id: "t2",
        patch: { status: "completed", end_time: "not-a-number" },
      }),
      9_000,
    );
    expect(state2.orchestrations[0]?.endedAt).toBe(9_000);
  });

  it("a task_notification after a task_updated does not reopen or re-stamp the run", () => {
    let state = applyFrame(emptyConversation(), taskStartedFrame("wek0ucptg"), 1_000);
    state = applyFrame(
      state,
      frame("system", {
        type: "system",
        subtype: "task_updated",
        task_id: "wek0ucptg",
        patch: { status: "killed", end_time: 1_786_255_282_149 },
      }),
      10_399,
    );
    state = applyFrame(
      state,
      frame("system", {
        type: "system",
        subtype: "task_notification",
        task_id: "wek0ucptg",
        status: "stopped",
        summary: "Slow one-phase probe",
      }),
      10_399,
    );
    const run = state.orchestrations[0];
    expect(run?.status).toBe("stopped");
    expect(run?.endedAt).toBe(1_786_255_282_149);
  });

  it("a terminal run is retained in state but excluded from activeOrchestrations", () => {
    let state = applyFrame(emptyConversation(), taskStartedFrame("t1"), 1_000);
    state = applyFrame(
      state,
      frame("system", {
        type: "system",
        subtype: "task_updated",
        task_id: "t1",
        patch: { status: "completed", end_time: 2_000 },
      }),
      2_000,
    );
    expect(state.orchestrations).toHaveLength(1);
    expect(activeOrchestrations(state)).toEqual([]);
  });

  it("activeOrchestrations returns [] on an exited session", () => {
    let state = applyFrame(emptyConversation(), taskStartedFrame("t1"), 1_000);
    state = applyFrame(state, frame("exit", { exit_code: 0 }), 2_000);
    expect(activeOrchestrations(state)).toEqual([]);
  });

  it("activeOrchestrations still lists a run while the session status is idle", () => {
    // Finding 5: `result success` arrives mid-run, well before the run's own
    // terminal frames — the pane goes `idle` for most of an orchestration.
    let state = applyFrame(emptyConversation(), frame("init", { model: "claude-opus-5" }), 0);
    state = applyFrame(state, taskStartedFrame("wt8nboga7"), 5_669);
    state = applyFrame(state, frame("result", { is_error: false }), 8_176);

    expect(state.status).toBe("idle");
    expect(activeOrchestrations(state)).toHaveLength(1);
  });

  it("a second init frame mid-run keeps the orchestration", () => {
    let state = applyFrame(emptyConversation(), taskStartedFrame("wt8nboga7"), 5_669);
    // Finding 5: a fresh `system/init` frame arrives after the turn returns,
    // while the orchestration is still (or was still) running.
    state = applyFrame(state, frame("init", { model: "claude-opus-5" }), 10_484);
    expect(activeOrchestrations(state)).toHaveLength(1);
  });

  it("orchestrationPhaseTree groups agents under their declared phase titles", () => {
    let state = applyFrame(emptyConversation(), taskStartedFrame("wt8nboga7"), 5_669);
    state = applyFrame(
      state,
      taskProgressFrame("wt8nboga7", { workflow_progress: SNAPSHOT_7_411 }),
      7_411,
    );
    const run = activeOrchestrations(state)[0];
    const tree = run ? orchestrationPhaseTree(run) : [];

    expect(tree.map((g) => g.title)).toEqual(["Alpha", "Beta"]);
    expect(tree[0]?.agents.map((a) => a.label)).toEqual(["red", "blue"]);
    expect(tree[1]?.agents.map((a) => a.label)).toEqual(["green"]);
  });

  it('orchestrationPhaseTree titles an unnamed phase index "Phase N"', () => {
    let state = applyFrame(emptyConversation(), taskStartedFrame("t1"), 1_000);
    state = applyFrame(
      state,
      taskProgressFrame("t1", {
        workflow_progress: [
          { type: "workflow_agent", index: 1, label: "red", phaseIndex: 3, state: "start" },
        ],
      }),
      2_000,
    );
    const run = activeOrchestrations(state)[0];
    const tree = run ? orchestrationPhaseTree(run) : [];
    expect(tree).toHaveLength(1);
    expect(tree[0]?.title).toBe("Phase 3");
  });

  it("orchestrationPhaseTree returns one unphased group when no agent carries a phaseIndex", () => {
    let state = applyFrame(emptyConversation(), taskStartedFrame("t1"), 1_000);
    state = applyFrame(
      state,
      taskProgressFrame("t1", {
        workflow_progress: [
          { type: "workflow_agent", index: 1, label: "red", state: "start" },
          { type: "workflow_agent", index: 2, label: "blue", state: "start" },
        ],
      }),
      2_000,
    );
    const run = activeOrchestrations(state)[0];
    const tree = run ? orchestrationPhaseTree(run) : [];
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ phaseIndex: null, title: "agents" });
    expect(tree[0]?.agents).toHaveLength(2);
  });

  it("orchestrationPhaseTree keeps declared phase titles when no agent has started yet", () => {
    // A `task_started` batch can seed `workflow_phase` entries before any
    // agent's own `start` state lands (D4/finding-3: any batch containing a
    // state change always attaches `workflow_progress`, but a phase-seed
    // batch need not contain an agent state change at all). `run.agents` is
    // `[]` here, so the early-return guard must not collapse the declared
    // phases into a single synthetic "agents" group.
    let state = applyFrame(emptyConversation(), taskStartedFrame("t1"), 1_000);
    state = applyFrame(
      state,
      taskProgressFrame("t1", {
        workflow_progress: [
          { type: "workflow_phase", index: 1, title: "Alpha" },
          { type: "workflow_phase", index: 2, title: "Beta" },
        ],
      }),
      2_000,
    );
    const run = activeOrchestrations(state)[0];
    expect(run?.agents).toEqual([]);
    const tree = run ? orchestrationPhaseTree(run) : [];
    expect(tree.map((g) => g.title)).toEqual(["Alpha", "Beta"]);
    expect(tree[0]).toMatchObject({ phaseIndex: 1, agents: [] });
    expect(tree[1]).toMatchObject({ phaseIndex: 2, agents: [] });
  });

  it("orchestrationPhaseTree keeps a declared phase with no agents yet", () => {
    let state = applyFrame(emptyConversation(), taskStartedFrame("t1"), 1_000);
    state = applyFrame(
      state,
      taskProgressFrame("t1", {
        workflow_progress: [
          { type: "workflow_phase", index: 1, title: "Alpha" },
          { type: "workflow_phase", index: 2, title: "Beta" },
          { type: "workflow_agent", index: 1, label: "red", phaseIndex: 1, state: "start" },
        ],
      }),
      2_000,
    );
    const run = activeOrchestrations(state)[0];
    const tree = run ? orchestrationPhaseTree(run) : [];
    expect(tree).toHaveLength(2);
    expect(tree[1]).toMatchObject({ phaseIndex: 2, title: "Beta" });
    expect(tree[1]?.agents).toEqual([]);
  });

  it("orchestrationCounts counts an errored agent as done and reports the declared phase count", () => {
    let state = applyFrame(emptyConversation(), taskStartedFrame("t1"), 1_000);
    state = applyFrame(
      state,
      taskProgressFrame("t1", {
        workflow_progress: [
          { type: "workflow_phase", index: 1, title: "Alpha" },
          { type: "workflow_agent", index: 1, label: "red", phaseIndex: 1, state: "done" },
          {
            type: "workflow_agent",
            index: 2,
            label: "blue",
            phaseIndex: 1,
            state: "error",
            error: "skipped by user",
          },
          { type: "workflow_agent", index: 3, label: "green", phaseIndex: 1, state: "start" },
        ],
      }),
      2_000,
    );
    const run = activeOrchestrations(state)[0];
    const counts = run
      ? orchestrationCounts(run)
      : { phases: 0, agentsDone: 0, agentsTotal: 0 };
    // M (agentsDone) counts the errored agent too, so it can reach K without
    // stalling; K (agentsTotal) is every agent seen so far.
    expect(counts).toEqual({ phases: 1, agentsDone: 2, agentsTotal: 3 });
  });

  it("orchestrationCounts reports 0 phases for a phase-less run", () => {
    const state = applyFrame(emptyConversation(), taskStartedFrame("t1"), 1_000);
    const run = activeOrchestrations(state)[0];
    const counts = run ? orchestrationCounts(run) : null;
    expect(counts).toEqual({ phases: 0, agentsDone: 0, agentsTotal: 0 });
  });

  it("a workflow_log element in workflow_progress is ignored", () => {
    let state = applyFrame(emptyConversation(), taskStartedFrame("t1"), 1_000);
    state = applyFrame(
      state,
      taskProgressFrame("t1", {
        workflow_progress: [
          { type: "workflow_log", index: 1, message: "starting" },
          { type: "workflow_agent", index: 1, label: "red", state: "start" },
        ],
      }),
      2_000,
    );
    const run = activeOrchestrations(state)[0];
    expect(run?.agents).toHaveLength(1);
    expect(run?.phases).toHaveLength(0);
  });

  it("a malformed workflow_progress leaves the run intact", () => {
    let state = applyFrame(emptyConversation(), taskStartedFrame("t1"), 1_000);
    state = applyFrame(
      state,
      taskProgressFrame("t1", { workflow_progress: SNAPSHOT_5_723 }),
      2_000,
    );
    const before = activeOrchestrations(state)[0];

    // Not an array at all: exactly like an absent key (D4) — the previous
    // snapshot survives untouched.
    const notArray = applyFrame(
      state,
      taskProgressFrame("t1", { workflow_progress: "nope" }),
      3_000,
    );
    expect(activeOrchestrations(notArray)[0]?.agents).toEqual(before?.agents);
    expect(activeOrchestrations(notArray)[0]?.phases).toEqual(before?.phases);

    // An array whose elements are not records: each fails to parse, so the
    // snapshot replaces with an empty phase/agent list rather than throwing.
    const notRecords = applyFrame(
      state,
      taskProgressFrame("t1", { workflow_progress: [42, "x", null] }),
      3_000,
    );
    expect(activeOrchestrations(notRecords)[0]?.agents).toEqual([]);
    expect(activeOrchestrations(notRecords)[0]?.phases).toEqual([]);

    // A `workflow_agent` with an unrecognised `state` string degrades to the
    // documented default ("start") rather than propagating garbage.
    const unknownState = applyFrame(
      state,
      taskProgressFrame("t1", {
        workflow_progress: [
          { type: "workflow_agent", index: 1, label: "red", state: "bogus" },
        ],
      }),
      3_000,
    );
    expect(activeOrchestrations(unknownState)[0]?.agents[0]?.state).toBe("start");
  });

  it('orchestrationBadgeLabel returns "" for none, "M/K agents" for one, "N orchestrations" for several', () => {
    expect(orchestrationBadgeLabel(emptyConversation())).toBe("");

    let state = applyFrame(emptyConversation(), taskStartedFrame("t1"), 1_000);
    state = applyFrame(
      state,
      taskProgressFrame("t1", {
        workflow_progress: [
          { type: "workflow_agent", index: 1, label: "red", state: "done" },
          { type: "workflow_agent", index: 2, label: "blue", state: "start" },
        ],
      }),
      2_000,
    );
    expect(orchestrationBadgeLabel(state)).toBe("1/2 agents");

    state = applyFrame(state, taskStartedFrame("t2"), 3_000);
    expect(orchestrationBadgeLabel(state)).toBe("2 orchestrations");
  });
});

// A pill's *body* is the instruction. Sending only titles made every attachment
// decorative: a task titled "Get the weather in Lviv" whose description asked
// for the same day last year produced an answer about today.
describe("buildUserMessageText", () => {
  it("sends a task's description, not only its title", () => {
    const text = buildUserMessageText(
      [
        {
          kind: "task",
          taskId: 3,
          title: "Get the weather in Lviv",
          description: "What is the weather in the city same day last year.",
        },
      ],
      "go",
    );

    expect(text).toBe(
      "@task #3: Get the weather in Lviv\n" +
        "What is the weather in the city same day last year.\n\ngo",
    );
  });

  it("sends a template's body, which is the whole point of attaching one", () => {
    const text = buildUserMessageText(
      [{ kind: "template", slug: "review", title: "Review", body: "Check X then Y." }],
      "",
    );

    expect(text).toBe("@template: Review\nCheck X then Y.\n\n");
  });

  it("omits an absent or blank body rather than leaving a dangling line", () => {
    const text = buildUserMessageText(
      [{ kind: "task", taskId: 7, title: "Bare", description: null }],
      "go",
    );

    expect(text).toBe("@task #7: Bare\n\ngo");
  });

  it("separates multi-line blocks so one body cannot read as the next header", () => {
    const text = buildUserMessageText(
      [
        { kind: "task", taskId: 1, title: "One", description: "First body." },
        { kind: "task", taskId: 2, title: "Two", description: "Second body." },
      ],
      "go",
    );

    expect(text).toBe(
      "@task #1: One\nFirst body.\n\n@task #2: Two\nSecond body.\n\ngo",
    );
  });

  it("keeps a file pill a path — the agent reads the file itself", () => {
    const text = buildUserMessageText(
      [{ kind: "file", path: "/w/app/src/main.rs" }],
      "explain",
    );

    expect(text).toBe("@file: /w/app/src/main.rs\n\nexplain");
  });

  it("sends a bare draft when nothing is attached", () => {
    expect(buildUserMessageText([], "just this")).toBe("just this");
  });
});
