// Coverage for the AGENTS panel's row actions.
//
// A run row does not record which *kind* of pane produced it, and the two kinds
// are killed by different commands: a provider pane is a PTY (`close_terminal`),
// an agent pane is a duplex `claude` child with no PTY (`agent_stop`). Stop used
// to issue only the former, so pressing it on an agent pane left the session
// running and the row stuck at "running". These tests pin both halves, and the
// popout branch that has to reach the detached window instead of this store.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentRunRow } from "../agent-run-row";
import type { AgentRun } from "../../../lib/api";
import { useTerminalStore, type Tab } from "../../../stores/terminal-store";

const {
  closeTerminalMock,
  agentStopMock,
  emitStopAgentPaneToTerminalsMock,
} = vi.hoisted(() => ({
  closeTerminalMock: vi.fn(),
  agentStopMock: vi.fn(),
  emitStopAgentPaneToTerminalsMock: vi.fn(),
}));

vi.mock("../../../lib/ipc", () => ({
  closeTerminal: (id: string) => closeTerminalMock(id),
  agentStop: (id: string) => agentStopMock(id),
  emitStopAgentPaneToTerminals: (id: string) =>
    emitStopAgentPaneToTerminalsMock(id),
}));

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    row_kind: "run",
    id: 1,
    session_id: "session-1",
    provider_id: 1,
    project_id: null,
    pane_id: "leaf-1",
    model: "claude-opus-5",
    prompt_preview: null,
    status: "running",
    source_kind: null,
    source_id: null,
    started_at: "2026-07-31T10:00:00Z",
    ended_at: null,
    profile: null,
    target: "embedded",
    provider_name: "claude-work",
    provider_display_name: "claude-work",
    provider_color: "#8b5cf6",
    project_name: "acme",
    ...overrides,
  } as AgentRun;
}

/** One tab holding the agent leaf the row points at. */
function seedPane(paneId: string): void {
  const tab: Tab = {
    id: "tab-1",
    title: "Agent 1",
    layout: {
      type: "leaf",
      terminalId: paneId,
      title: "claude",
      kind: "agent",
      cwd: "/w/acme",
    },
  };
  useTerminalStore.setState({
    tabs: [tab],
    activeTabId: tab.id,
    focusedLeafId: paneId,
    hydrated: true,
    hydrating: false,
    maximizedLeafId: null,
  });
}

beforeEach(() => {
  closeTerminalMock.mockReset().mockResolvedValue(undefined);
  agentStopMock.mockReset().mockResolvedValue(undefined);
  emitStopAgentPaneToTerminalsMock.mockReset().mockResolvedValue(undefined);
  seedPane("leaf-1");
});

afterEach(() => {
  cleanup();
});

function noop(): void {
  /* row callback stub */
}

describe("AgentRunRow actions", () => {
  it("shows Focus and Stop for a running pane it owns", () => {
    render(<AgentRunRow run={makeRun()} onFocus={noop} />);

    expect(screen.getByText("Focus")).toBeTruthy();
    expect(screen.getByText("Stop")).toBeTruthy();
  });

  it("Stop kills both pane kinds, since the row cannot tell them apart", () => {
    render(<AgentRunRow run={makeRun()} onFocus={noop} />);

    fireEvent.click(screen.getByText("Stop"));

    // Both are idempotent for an id they do not know, and the two id namespaces
    // never overlap — so issuing both is what makes one button correct for a
    // PTY pane and an agent pane alike.
    expect(agentStopMock).toHaveBeenCalledWith("leaf-1");
    expect(closeTerminalMock).toHaveBeenCalledWith("leaf-1");
  });

  it("Stop on a popout run reaches the detached window, not this store", () => {
    render(
      <AgentRunRow run={makeRun({ target: "popout" })} onFocus={noop} />,
    );

    fireEvent.click(screen.getByText("Stop"));

    expect(emitStopAgentPaneToTerminalsMock).toHaveBeenCalledWith("leaf-1");
  });

  it("Stop on an embedded run does not emit to the detached window", () => {
    render(<AgentRunRow run={makeRun()} onFocus={noop} />);

    fireEvent.click(screen.getByText("Stop"));

    expect(emitStopAgentPaneToTerminalsMock).not.toHaveBeenCalled();
  });

  it("Focus hands the whole run up so the parent can branch on target", () => {
    const onFocus = vi.fn();
    const run = makeRun({ target: "popout" });
    render(<AgentRunRow run={run} onFocus={onFocus} />);

    fireEvent.click(screen.getByText("Focus"));

    expect(onFocus).toHaveBeenCalledWith(run);
  });

  it("offers no actions for an ended run", () => {
    render(<AgentRunRow run={makeRun({ status: "ended" })} onFocus={noop} />);

    expect(screen.queryByText("Focus")).toBeNull();
    expect(screen.queryByText("Stop")).toBeNull();
  });

  it("offers no actions for an observe-only row", () => {
    // Hook-driven: Claude Code ran outside the dashboard, so there is no pane
    // to focus and no child this app may kill.
    render(
      <AgentRunRow
        run={makeRun({ row_kind: "observe", pane_id: null })}
        onFocus={noop}
      />,
    );

    expect(screen.queryByText("Focus")).toBeNull();
    expect(screen.queryByText("Stop")).toBeNull();
  });
});
