import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SessionHud } from "../session-hud";
import type { PaneHud } from "../../../lib/api";
import type { GitPaneStatus } from "../../../lib/ipc";

// `stores/session-hud-store` owns the SSE subscription, the hydration fetch
// and the git poller — none of that is under test here, and mocking the
// whole module (rather than its `lib/api`/`lib/ipc` dependencies) keeps this
// file from ever touching `fetch` or `invoke`.
const { hudBox, gitBox, startFeedSpy } = vi.hoisted(() => {
  return {
    hudBox: { current: null as PaneHud | null },
    gitBox: { current: null as GitPaneStatus | null },
    startFeedSpy: vi.fn(),
  };
});

vi.mock("../../../stores/session-hud-store", () => ({
  useSessionHud: () => hudBox.current,
  useGitPaneStatus: () => gitBox.current,
  startSessionHudFeed: () => startFeedSpy(),
}));

function fullHud(overrides: Partial<PaneHud> = {}): PaneHud {
  return {
    pane_id: "pane-1",
    session_id: "sess-1",
    status: "active",
    model: "claude-opus-4-8",
    context_tokens: 76_000,
    context_window: 200_000,
    cost_usd: 1.84,
    started_at: "2026-01-01T00:00:00",
    ended_at: null,
    current_tool: "Edit",
    current_tool_started_at: "2026-01-01T00:18:00",
    thinking: true,
    todo_done: 5,
    todo_total: 8,
    ...overrides,
  };
}

function gitStatus(overrides: Partial<GitPaneStatus> = {}): GitPaneStatus {
  return {
    branch: "develop",
    dirty: true,
    ahead: 2,
    ...overrides,
  };
}

describe("SessionHud", () => {
  beforeEach(() => {
    hudBox.current = null;
    gitBox.current = null;
    startFeedSpy.mockClear();
  });

  afterEach(() => {
    // Mandatory: `frontend/vite.config.ts` does not set `globals: true`, so
    // Testing Library's auto-cleanup never registers.
    cleanup();
    vi.useRealTimers();
  });

  it("renders nothing when there is no session and no git", () => {
    const { container } = render(
      <SessionHud paneId="pane-1" cwd="/repo" exited={false} />,
    );
    expect(container.firstChild).toBeNull();
    expect(startFeedSpy).toHaveBeenCalled();
  });

  it("renders only the git cell, dimmed, for a shell pane in a repo", () => {
    gitBox.current = gitStatus();
    render(<SessionHud paneId="pane-1" cwd="/repo" exited={false} />);

    const hud = screen.getByTestId("session-hud");
    expect(hud.dataset.dimmed).toBe("true");
    expect(hud.querySelector('[data-cell="git"]')).not.toBeNull();
    expect(hud.querySelector('[data-cell="model"]')).toBeNull();
    expect(hud.querySelector('[data-cell="cost"]')).toBeNull();
    expect(hud.querySelector('[data-cell="ctx"]')).toBeNull();
  });

  it("renders all nine cells for a full active session", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:18:04Z"));
    hudBox.current = fullHud();
    gitBox.current = gitStatus();
    render(<SessionHud paneId="pane-1" cwd="/repo" exited={false} />);

    const hud = screen.getByTestId("session-hud");
    expect(hud.dataset.dimmed).toBe("false");
    expect(hud.textContent).toContain("Opus 4.8");
    expect(hud.textContent).toContain("38%");
    expect(hud.textContent).toContain("76k/200k");
    expect(hud.textContent).toContain("$1.84");
    expect(hud.textContent).toContain("develop");
    expect(hud.textContent).toContain("*");
    expect(hud.textContent).toContain("+2");
    expect(hud.textContent).toContain("Thinking");
    expect(hud.textContent).toContain("5/8");
    expect(
      hud.querySelector('[data-cell="elapsed"]')?.textContent,
    ).toBe("18m 04s");
    expect(hud.querySelector('[data-cell="tool"]')?.textContent).toContain(
      "Edit",
    );
    expect(hud.querySelector('[data-cell="tool"]')?.textContent).toContain(
      "4s",
    );
    for (const cell of [
      "model",
      "ctx",
      "tokens",
      "cost",
      "elapsed",
      "git",
      "tool",
      "thinking",
      "todo",
    ]) {
      expect(hud.querySelector(`[data-cell="${cell}"]`)).not.toBeNull();
    }
  });

  it("omits the model cell when model is null", () => {
    hudBox.current = fullHud({ model: null });
    render(<SessionHud paneId="pane-1" cwd={undefined} exited={false} />);
    const hud = screen.getByTestId("session-hud");
    expect(hud.querySelector('[data-cell="model"]')).toBeNull();
    expect(hud.querySelector('[data-cell="cost"]')).not.toBeNull();
  });

  it("omits both ctx cells when context_tokens is null", () => {
    hudBox.current = fullHud({ context_tokens: null });
    render(<SessionHud paneId="pane-1" cwd={undefined} exited={false} />);
    const hud = screen.getByTestId("session-hud");
    expect(hud.querySelector('[data-cell="ctx"]')).toBeNull();
    expect(hud.querySelector('[data-cell="tokens"]')).toBeNull();
  });

  it("omits both ctx cells when the model has no known window", () => {
    hudBox.current = fullHud({ context_window: null });
    render(<SessionHud paneId="pane-1" cwd={undefined} exited={false} />);
    const hud = screen.getByTestId("session-hud");
    expect(hud.querySelector('[data-cell="ctx"]')).toBeNull();
    expect(hud.querySelector('[data-cell="tokens"]')).toBeNull();
  });

  it("omits the tool cell when current_tool is null", () => {
    hudBox.current = fullHud({ current_tool: null });
    render(<SessionHud paneId="pane-1" cwd={undefined} exited={false} />);
    expect(
      screen.getByTestId("session-hud").querySelector('[data-cell="tool"]'),
    ).toBeNull();
  });

  it("omits the tool and thinking cells on a dimmed pane", () => {
    // A pane whose process exited but whose DB row is still "active" — the
    // exact case plan-review-1's note 1 flags: without `!exited` in the
    // `live` formula this would still show a spinning gear and "Thinking".
    hudBox.current = fullHud({ status: "active" });
    render(<SessionHud paneId="pane-1" cwd={undefined} exited={true} />);
    const hud = screen.getByTestId("session-hud");
    expect(hud.dataset.dimmed).toBe("true");
    expect(hud.querySelector('[data-cell="tool"]')).toBeNull();
    expect(hud.querySelector('[data-cell="thinking"]')).toBeNull();
  });

  it("omits the todo cell when todo_total is null", () => {
    hudBox.current = fullHud({ todo_total: null, todo_done: null });
    render(<SessionHud paneId="pane-1" cwd={undefined} exited={false} />);
    expect(
      screen.getByTestId("session-hud").querySelector('[data-cell="todo"]'),
    ).toBeNull();
  });

  it("freezes elapsed at ended_at when present", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:10:00Z"));
    hudBox.current = fullHud({
      started_at: "2026-01-01T00:00:00",
      ended_at: "2026-01-01T00:10:00",
    });
    render(<SessionHud paneId="pane-1" cwd={undefined} exited={false} />);

    const elapsedBefore = screen
      .getByTestId("session-hud")
      .querySelector('[data-cell="elapsed"]')?.textContent;
    expect(elapsedBefore).toBe("10m 00s");

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    const elapsedAfter = screen
      .getByTestId("session-hud")
      .querySelector('[data-cell="elapsed"]')?.textContent;
    expect(elapsedAfter).toBe(elapsedBefore);
  });

  it("omits elapsed when the pane exited with no ended_at", () => {
    hudBox.current = fullHud({ ended_at: null });
    render(<SessionHud paneId="pane-1" cwd={undefined} exited={true} />);
    expect(
      screen
        .getByTestId("session-hud")
        .querySelector('[data-cell="elapsed"]'),
    ).toBeNull();
  });

  it.each([
    ["active", false],
    ["idle", false],
    ["stopped", true],
    ["ended", true],
  ] as const)("is dimmed=%s for status %s", (status, expectedDimmed) => {
    hudBox.current = fullHud({ status });
    render(<SessionHud paneId="pane-1" cwd={undefined} exited={false} />);
    expect(screen.getByTestId("session-hud").dataset.dimmed).toBe(
      String(expectedDimmed),
    );
  });

  it("never renders a placeholder for an absent value", () => {
    hudBox.current = fullHud({
      model: null,
      context_tokens: null,
      context_window: null,
      current_tool: null,
      current_tool_started_at: null,
      thinking: false,
      todo_done: null,
      todo_total: null,
    });
    render(<SessionHud paneId="pane-1" cwd={undefined} exited={false} />);
    const hud = screen.getByTestId("session-hud");
    const text = hud.textContent ?? "";
    expect(text).not.toMatch(/—|\?|NaN|undefined|null/);
    for (const cell of hud.querySelectorAll<HTMLElement>("[data-cell]")) {
      expect(cell.textContent?.trim()).not.toBe("0");
    }
  });
});
