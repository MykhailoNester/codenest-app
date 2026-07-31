// The agent pane's status strip renders from stream-json frames rather than
// from the sidecar's hook-derived HUD rows, so its honesty contract has to be
// pinned here: every cell shows a fact the wire reported, and a fact the wire
// has not reported yet produces no cell at all — never a zero, a dash, or a
// percentage against an invented denominator.

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AgentSessionHud } from "../agent-session-hud";
import {
  applyFrame,
  emptyConversation,
  type ConversationState,
} from "../../../lib/agent-conversation";
import type { AgentFrame, AgentFrameKind } from "../../../lib/ipc";

// `useGitPaneStatus` registers a poller that reaches for Tauri; without the
// shell it resolves to no status, which is the branch these tests want (the git
// cell is covered by the shell-pane HUD's own tests).
vi.mock("../../../lib/ipc", () => ({
  isTauriAvailable: (): boolean => false,
  getGitPaneStatus: async (): Promise<null> => null,
}));

function frame(kind: AgentFrameKind, raw: unknown): AgentFrame {
  return { pane_id: "p1", session_id: "s1", kind, raw };
}

/** A session that has initialised and completed one turn. */
function liveState(): ConversationState {
  let state = applyFrame(emptyConversation(), frame("init", { model: "claude-opus-5" }), 1_000);
  state = applyFrame(
    state,
    frame("result", {
      is_error: false,
      total_cost_usd: 0.25,
      duration_ms: 1200,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 1_990,
        cache_read_input_tokens: 8_000,
        output_tokens: 40,
      },
      modelUsage: { "claude-opus-5": { contextWindow: 200_000 } },
    }),
    2_000,
  );
  return state;
}

afterEach(() => {
  cleanup();
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

  it("omits the percentage when the frame named no context window", () => {
    const state = applyFrame(
      liveState(),
      frame("result", { usage: { input_tokens: 500 }, modelUsage: {} }),
      3_000,
    );
    render(<AgentSessionHud state={state} cwd={undefined} />);

    const strip = screen.getByTestId("agent-session-hud");
    expect(strip.querySelector('[data-cell="ctx"]')).toBeNull();
    expect(strip.querySelector('[data-cell="tokens"]')?.textContent).not.toContain("%");
  });

  it("never claims a tool is running or thinking on an exited session", () => {
    let state = applyFrame(
      liveState(),
      frame("tool_use", {
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
        },
      }),
      3_000,
    );
    state = applyFrame(state, frame("system", { subtype: "thinking_tokens", estimated_tokens: 40 }), 3_100);

    // Live: both cells present — the tool call has no result yet.
    const live = render(<AgentSessionHud state={state} cwd={undefined} />);
    const liveStrip = screen.getByTestId("agent-session-hud");
    expect(liveStrip.querySelector('[data-cell="tool"]')?.textContent).toContain("Bash");
    expect(liveStrip.querySelector('[data-cell="thinking"]')).not.toBeNull();
    live.unmount();

    // Exited: the process is gone, so neither claim may survive.
    const dead = applyFrame(state, frame("exit", { exit_code: 0 }), 4_000);
    render(<AgentSessionHud state={dead} cwd={undefined} />);
    const deadStrip = screen.getByTestId("agent-session-hud");
    expect(deadStrip.querySelector('[data-cell="tool"]')).toBeNull();
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
});
