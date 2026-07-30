import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SessionHud } from "../session-hud";
import type { SessionHudPane } from "../../../lib/api";
import type { GitPaneStatus } from "../../../lib/ipc";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
//
// Both `lib/ipc` and `stores/session-hud-store` factories must return every
// export `SessionHud` touches — Vitest 4 proxies a factory mock's namespace
// and THROWS on the first access to an export the factory did not return.

const { hudBox, gitBox, acquireSpy } = vi.hoisted(() => {
  return {
    hudBox: { current: null as SessionHudPane | null },
    gitBox: {
      isTauriAvailable: vi.fn(() => true),
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      getGitPaneStatus: vi.fn(async (_cwd: string) => null as GitPaneStatus | null),
    },
    acquireSpy: vi.fn(() => () => undefined),
  };
});

vi.mock("../../../stores/session-hud-store", () => ({
  useSessionHudPane: () => hudBox.current,
  acquireSessionHudStream: acquireSpy,
}));

vi.mock("../../../lib/ipc", () => ({
  isTauriAvailable: () => gitBox.isTauriAvailable(),
  getGitPaneStatus: (cwd: string) => gitBox.getGitPaneStatus(cwd),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fullPane(overrides: Partial<SessionHudPane> = {}): SessionHudPane {
  return {
    pane_id: "pane-1",
    session_id: "sess-1",
    status: "active",
    model: "claude-opus-4-5-20251101",
    model_display: null,
    context_tokens: 76_000,
    context_window: 200_000,
    cost_usd: 1.84,
    started_at: "2026-01-01T00:00:00",
    current_tool: "Edit",
    current_tool_started_at: "2026-01-01T00:04:55",
    thinking: true,
    todo_done: 5,
    todo_total: 8,
    ...overrides,
  };
}

function cleanBranch(overrides: Partial<GitPaneStatus> = {}): GitPaneStatus {
  return {
    branch: "develop",
    headShort: "abc1234",
    dirty: true,
    ahead: 2,
    behind: 0,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SessionHud", () => {
  beforeEach(() => {
    hudBox.current = null;
    gitBox.isTauriAvailable.mockReturnValue(true);
    gitBox.getGitPaneStatus.mockReset();
    gitBox.getGitPaneStatus.mockResolvedValue(null);
    acquireSpy.mockClear();
  });

  afterEach(() => {
    // Mandatory: `frontend/vite.config.ts` does not set `globals: true`, so
    // Testing Library's auto-cleanup never registers (same note as
    // `terminal-tab-persistence.test.tsx`).
    cleanup();
    vi.useRealTimers();
  });

  it("renders nothing when there is no session and no git status", async () => {
    const { container } = render(
      <SessionHud paneId="pane-1" cwd="/repo" active={true} exited={false} />,
    );
    await flush();
    expect(container.firstChild).toBeNull();
  });

  it("renders regardless of the pane header", async () => {
    gitBox.getGitPaneStatus.mockResolvedValue(cleanBranch());
    render(
      <SessionHud paneId="pane-1" cwd="/repo" active={true} exited={false} />,
    );
    await flush();
    expect(screen.getByTestId("session-hud")).not.toBeNull();
  });

  it("renders only the git cell, dimmed, for a pane with no agent session", async () => {
    gitBox.getGitPaneStatus.mockResolvedValue(cleanBranch());
    render(
      <SessionHud paneId="pane-1" cwd="/repo" active={true} exited={false} />,
    );
    await flush();

    const hud = screen.getByTestId("session-hud");
    expect(hud.dataset.dimmed).toBe("true");
    expect(hud.querySelector('[data-cell="git"]')).not.toBeNull();
    expect(hud.querySelector('[data-cell="model"]')).toBeNull();
    expect(hud.querySelector('[data-cell="cost"]')).toBeNull();
    expect(hud.querySelector('[data-cell="ctx"]')).toBeNull();
  });

  it("renders every cell for a full session row", async () => {
    hudBox.current = fullPane();
    gitBox.getGitPaneStatus.mockResolvedValue(cleanBranch());
    render(
      <SessionHud paneId="pane-1" cwd="/repo" active={true} exited={false} />,
    );
    await flush();

    const hud = screen.getByTestId("session-hud");
    expect(hud.dataset.dimmed).toBe("false");
    expect(hud.textContent).toContain("opus-4-5");
    expect(hud.textContent).toContain("38%");
    expect(hud.textContent).toContain("76k/200k");
    expect(hud.textContent).toContain("$1.84");
    expect(hud.textContent).toContain("develop");
    expect(hud.textContent).toContain("*");
    expect(hud.textContent).toContain("+2");
    expect(hud.textContent).toContain("Edit");
    expect(hud.textContent).toContain("Thinking");
    expect(hud.textContent).toContain("5/8");
  });

  it("omits the ctx and tokens cells when context_tokens is null", async () => {
    hudBox.current = fullPane({ context_tokens: null });
    render(
      <SessionHud paneId="pane-1" cwd={undefined} active={false} exited={false} />,
    );
    await flush();

    const hud = screen.getByTestId("session-hud");
    expect(hud.querySelector('[data-cell="ctx"]')).toBeNull();
    expect(hud.querySelector('[data-cell="tokens"]')).toBeNull();
    expect(hud.querySelector('[data-cell="cost"]')).not.toBeNull();
    expect(hud.querySelector('[data-cell="elapsed"]')).not.toBeNull();
  });

  it("omits the tool cell when current_tool is null", async () => {
    hudBox.current = fullPane({ current_tool: null });
    render(
      <SessionHud paneId="pane-1" cwd={undefined} active={false} exited={false} />,
    );
    await flush();
    expect(
      screen.getByTestId("session-hud").querySelector('[data-cell="tool"]'),
    ).toBeNull();
  });

  it("omits the thinking cell when thinking is false", async () => {
    hudBox.current = fullPane({ thinking: false });
    render(
      <SessionHud paneId="pane-1" cwd={undefined} active={false} exited={false} />,
    );
    await flush();
    expect(
      screen
        .getByTestId("session-hud")
        .querySelector('[data-cell="thinking"]'),
    ).toBeNull();
  });

  it("omits the todo cell when todo_total is null", async () => {
    hudBox.current = fullPane({ todo_total: null, todo_done: null });
    render(
      <SessionHud paneId="pane-1" cwd={undefined} active={false} exited={false} />,
    );
    await flush();
    expect(
      screen.getByTestId("session-hud").querySelector('[data-cell="todo"]'),
    ).toBeNull();
  });

  it("renders no dirty marker and no ahead count for a clean, up-to-date branch", async () => {
    gitBox.getGitPaneStatus.mockResolvedValue(
      cleanBranch({ dirty: false, ahead: 0 }),
    );
    render(
      <SessionHud paneId="pane-1" cwd="/repo" active={true} exited={false} />,
    );
    await flush();

    const gitCell = screen
      .getByTestId("session-hud")
      .querySelector('[data-cell="git"]');
    expect(gitCell).not.toBeNull();
    expect(gitCell?.textContent).toContain("develop");
    expect(gitCell?.textContent).not.toContain("*");
    expect(gitCell?.textContent?.includes("+")).toBe(false);
  });

  it("renders the short oid when HEAD is detached", async () => {
    gitBox.getGitPaneStatus.mockResolvedValue(
      cleanBranch({ branch: null, headShort: "abc1234", dirty: false, ahead: null }),
    );
    render(
      <SessionHud paneId="pane-1" cwd="/repo" active={true} exited={false} />,
    );
    await flush();

    const gitCell = screen
      .getByTestId("session-hud")
      .querySelector('[data-cell="git"]');
    expect(gitCell?.textContent).toContain("abc1234");
  });

  it("does not poll git for an inactive pane", async () => {
    render(
      <SessionHud paneId="pane-1" cwd="/repo" active={false} exited={false} />,
    );
    await flush();
    expect(gitBox.getGitPaneStatus).not.toHaveBeenCalled();
  });

  it("does not poll git when the pane has no cwd", async () => {
    render(
      <SessionHud
        paneId="pane-1"
        cwd={undefined}
        active={true}
        exited={false}
      />,
    );
    await flush();
    expect(gitBox.getGitPaneStatus).not.toHaveBeenCalled();
  });

  it("dims and freezes a pane whose process exited", async () => {
    vi.useFakeTimers();
    hudBox.current = fullPane();
    render(
      <SessionHud paneId="pane-1" cwd={undefined} active={false} exited={true} />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const hud = screen.getByTestId("session-hud");
    expect(hud.dataset.dimmed).toBe("true");
    const elapsedBefore = hud.querySelector(
      '[data-cell="elapsed"]',
    )?.textContent;
    expect(elapsedBefore).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    const elapsedAfter = hud.querySelector(
      '[data-cell="elapsed"]',
    )?.textContent;
    expect(elapsedAfter).toBe(elapsedBefore);
  });
});
