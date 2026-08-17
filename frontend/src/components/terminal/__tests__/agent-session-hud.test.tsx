// The agent pane's status strip renders from stream-json frames rather than
// from the sidecar's hook-derived HUD rows, so its honesty contract has to be
// pinned here: every cell shows a fact the wire reported, and a fact the wire
// has not reported yet produces no cell at all — never a zero, a dash, or a
// percentage against an invented denominator.
//
// This file now covers only the metrics line: the live-tool, sub-agent and
// orchestration cells (and their Stop button) moved to the dock that renders
// this strip as its first child — see `__tests__/agent-activity-dock.test.tsx`.
// `agentStopTask` is that button's mock now, not this file's; only
// `isTauriAvailable`/`getGitPaneStatus` are mocked here.

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { AgentSessionHud } from "../agent-session-hud";
import {
  appendUserTurn,
  applyFrame,
  emptyConversation,
  type ConversationState,
} from "../../../lib/agent-conversation";
import type { AgentFrame, AgentFrameKind } from "../../../lib/ipc";

vi.mock("../../../lib/ipc", () => ({
  isTauriAvailable: (): boolean => false,
  getGitPaneStatus: async (): Promise<null> => null,
}));

function frame(kind: AgentFrameKind, raw: unknown): AgentFrame {
  return { pane_id: "p1", session_id: "s1", kind, raw };
}

/** A session that has initialised and completed one turn. Context comes off
 *  the assistant message and the window off the result frame (#39). */
function liveState(): ConversationState {
  let state = applyFrame(emptyConversation(), frame("init", { model: "claude-opus-5" }), 1_000);
  state = applyFrame(
    state,
    frame("assistant", {
      message: {
        content: [{ type: "text", text: "done" }],
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 1_990,
          cache_read_input_tokens: 8_000,
          output_tokens: 40,
        },
      },
    }),
    1_500,
  );
  state = applyFrame(
    state,
    frame("result", {
      is_error: false,
      total_cost_usd: 0.25,
      duration_ms: 1200,
      usage: { input_tokens: 10, cache_read_input_tokens: 8_000, output_tokens: 40 },
      modelUsage: { "claude-opus-5": { contextWindow: 200_000 } },
    }),
    2_000,
  );
  return state;
}

afterEach(() => {
  cleanup();
  // Additive: only the timer tests below mock the clock, but resetting is
  // always safe and keeps a future timer test from leaking into the next file.
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("AgentSessionHud", () => {
  it("shows only the status cell before the first turn reports anything", () => {
    render(<AgentSessionHud state={emptyConversation()} cwd={undefined} />);

    const strip = screen.getByTestId("agent-session-hud");
    expect(strip.textContent).toContain("starting");
    // No usage, no cost, no init yet — so no ctx, tokens, cost or elapsed cell.
    expect(strip.querySelector('[data-cell="ctx"]')).toBeNull();
    expect(strip.querySelector('[data-cell="tokens"]')).toBeNull();
    expect(strip.querySelector('[data-cell="cost"]')).toBeNull();
    expect(strip.querySelector('[data-cell="elapsed"]')).toBeNull();
    // A session that has not started yet is dimmed, like a shell pane with no
    // session bound.
    expect(strip.dataset.dimmed).toBe("true");
  });

  it("renders context, tokens, cost and elapsed once a result frame reports them", () => {
    render(<AgentSessionHud state={liveState()} cwd={undefined} />);

    const strip = screen.getByTestId("agent-session-hud");
    expect(strip.dataset.dimmed).toBe("false");
    // 10 + 1990 + 8000 = 10k of a 200k window = 5%.
    expect(strip.querySelector('[data-cell="ctx"]')?.textContent).toContain("5%");
    expect(strip.querySelector('[data-cell="tokens"]')?.textContent).toBe("10k/200k");
    expect(strip.querySelector('[data-cell="cost"]')?.textContent).toContain("0.25");
    expect(strip.querySelector('[data-cell="elapsed"]')).not.toBeNull();
  });

  it("omits the percentage when no frame has named a context window", () => {
    // Tokens are a fact from the first assistant message; the window is not
    // known until a `result` names one for the running model.
    const state = applyFrame(
      applyFrame(emptyConversation(), frame("init", { model: "claude-opus-5" }), 1_000),
      frame("assistant", { message: { content: [], usage: { input_tokens: 500 } } }),
      3_000,
    );
    render(<AgentSessionHud state={state} cwd={undefined} />);

    const strip = screen.getByTestId("agent-session-hud");
    expect(strip.querySelector('[data-cell="ctx"]')).toBeNull();
    expect(strip.querySelector('[data-cell="tokens"]')?.textContent).not.toContain("%");
  });

  it("the ctx cell cannot exceed the window once many turns have run (#39)", () => {
    // The bug: the result frame's lifetime aggregate divided by a per-call
    // window rendered `2181k/1000k`, clamped to a full bar at 100%.
    let state = liveState();
    let lifetime = 0;
    for (let turn = 0; turn < 30; turn += 1) {
      lifetime += 50_000;
      state = applyFrame(
        state,
        frame("assistant", {
          message: { content: [], usage: { input_tokens: 500, cache_read_input_tokens: 49_500 } },
        }),
        4_000 + turn,
      );
      state = applyFrame(
        state,
        frame("result", {
          usage: { input_tokens: 500, cache_read_input_tokens: lifetime },
          modelUsage: { "claude-opus-5": { contextWindow: 200_000 } },
        }),
        4_000 + turn,
      );
    }
    render(<AgentSessionHud state={state} cwd={undefined} />);

    const strip = screen.getByTestId("agent-session-hud");
    expect(strip.querySelector('[data-cell="tokens"]')?.textContent).toBe("50k/200k");
    expect(strip.querySelector('[data-cell="ctx"]')?.textContent).toContain("25%");
  });

  it("never claims the model is thinking on an exited session", () => {
    let state = applyFrame(
      liveState(),
      frame("system", { subtype: "thinking_tokens", estimated_tokens: 40 }),
      3_100,
    );

    // Live: the thinking cell is present.
    const live = render(<AgentSessionHud state={state} cwd={undefined} />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="thinking"]'),
    ).not.toBeNull();
    live.unmount();

    // Exited: the process is gone, so the claim may not survive.
    state = applyFrame(state, frame("exit", { exit_code: 0 }), 4_000);
    render(<AgentSessionHud state={state} cwd={undefined} />);
    const deadStrip = screen.getByTestId("agent-session-hud");
    expect(deadStrip.querySelector('[data-cell="thinking"]')).toBeNull();
    expect(deadStrip.dataset.dimmed).toBe("true");
  });

  it("surfaces a pending permission count", () => {
    const state = applyFrame(
      liveState(),
      frame("permission", {
        request_id: "req_1",
        request: { tool_name: "Bash", input: { command: "rm -rf /" } },
      }),
      3_000,
    );
    render(<AgentSessionHud state={state} cwd={undefined} />);
    expect(
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="perm"]')
        ?.textContent,
    ).toContain("1 awaiting approval");
  });

  it("the elapsed cell ticks while a turn is in flight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let state = applyFrame(
      emptyConversation(),
      frame("init", { model: "claude-opus-5" }),
      1_000_000 - 600_000,
    );
    // The turn started a second ago; the session started ten minutes ago, and
    // the cell must be reporting the former (#40).
    state = appendUserTurn(state, "run the tests", 1_000_000 - 1_000);

    render(<AgentSessionHud state={state} cwd={undefined} />);
    const strip = (): string | undefined =>
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="elapsed"]')
        ?.textContent ?? undefined;
    expect(strip()).toBe("1s");

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(strip()).toBe("3s");
  });

  it("the elapsed cell holds still on an idle pane, showing the last turn's duration (#40)", () => {
    // The bug: this cell counted the session's age, so a pane sitting idle read
    // `10m 14s` and kept climbing — a timer beside `idle` measuring nothing.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let state = applyFrame(
      emptyConversation(),
      frame("init", { model: "claude-opus-5" }),
      1_000_000 - 600_000,
    );
    state = appendUserTurn(state, "run the tests", 1_000_000 - 90_000);
    state = applyFrame(state, frame("result", { duration_ms: 42_000 }), 1_000_000 - 48_000);

    render(<AgentSessionHud state={state} cwd={undefined} />);
    const strip = (): string | undefined =>
      screen.getByTestId("agent-session-hud").querySelector('[data-cell="elapsed"]')
        ?.textContent ?? undefined;
    expect(strip()).toBe("42s");

    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(strip()).toBe("42s");
  });

  it("shows no elapsed cell on an idle pane that has run nothing yet", () => {
    // Honesty contract: before a first turn completes there is no duration to
    // report, and `0s` would be a value no frame ever sent.
    const state = applyFrame(emptyConversation(), frame("init", { model: "claude-opus-5" }), 1_000);
    render(<AgentSessionHud state={state} cwd={undefined} />);
    const strip = screen.getByTestId("agent-session-hud");
    expect(strip.textContent).toContain("idle");
    expect(strip.querySelector('[data-cell="elapsed"]')).toBeNull();
  });
});
