import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../lib/ipc", () => ({
  agentSend: vi.fn(async () => undefined),
  agentRespondPermission: vi.fn(async () => undefined),
  openTerminal: vi.fn(async () => ({ id: "pty-unused" })),
  closeTerminal: vi.fn(async () => undefined),
  sendTerminalInput: vi.fn(async () => undefined),
  getWorkspacePath: vi.fn(async () => "/tmp/workspace"),
}));

import { useAgentSessionStore } from "../agent-session-store";
import { useComposerStore } from "../composer-store";
import { useTerminalStore } from "../terminal-store";
import type { AgentFrame } from "../../lib/ipc";

function frame(kind: AgentFrame["kind"], raw: unknown): AgentFrame {
  return { pane_id: "pane-1", session_id: "s1", kind, raw };
}

describe("agent-session-store", () => {
  beforeEach(() => {
    useAgentSessionStore.setState({ panes: {}, sessionAllowed: {} });
    useComposerStore.setState({ panes: {}, history: [], targetPaneId: null });
    useTerminalStore.setState({
      tabs: [
        { id: "tab-1", title: "Tab", layout: { type: "leaf", terminalId: "pane-1", title: "claude", kind: "agent" } },
      ],
      activeTabId: "tab-1",
      focusedLeafId: "pane-1",
      hydrated: true,
      hydrating: false,
    });
  });

  it("ensurePane seeds an empty conversation, and a second call never clobbers existing state", () => {
    useAgentSessionStore.getState().ensurePane("pane-1");
    expect(useAgentSessionStore.getState().panes["pane-1"]?.status).toBe("starting");

    useAgentSessionStore.getState().markSendStart("pane-1", "hello");
    expect(useAgentSessionStore.getState().panes["pane-1"]?.turns).toHaveLength(1);

    useAgentSessionStore.getState().ensurePane("pane-1");
    expect(useAgentSessionStore.getState().panes["pane-1"]?.turns).toHaveLength(1);
  });

  it("markStarting sets status starting on a fresh pane", () => {
    useAgentSessionStore.getState().markStarting("pane-1");
    expect(useAgentSessionStore.getState().panes["pane-1"]?.status).toBe("starting");
  });

  it("resolvePermission removes only the named requestId", () => {
    useAgentSessionStore
      .getState()
      .applyFrame("pane-1", frame("permission", { request_id: "req_1", request: { tool_name: "Bash" } }));
    useAgentSessionStore
      .getState()
      .applyFrame("pane-1", frame("permission", { request_id: "req_2", request: { tool_name: "Read" } }));
    expect(useAgentSessionStore.getState().panes["pane-1"]?.permissions).toHaveLength(2);

    useAgentSessionStore.getState().resolvePermission("pane-1", "req_1");

    const remaining = useAgentSessionStore.getState().panes["pane-1"]?.permissions ?? [];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.requestId).toBe("req_2");
  });

  it("an exit frame delegates to terminalStore.markLeafExited", () => {
    useAgentSessionStore.getState().applyFrame("pane-1", frame("exit", { exit_code: 0 }));
    const layout = useTerminalStore.getState().tabs[0]!.layout;
    expect(layout.type === "leaf" ? layout.exited : undefined).toBe(true);
  });

  it("reset clears both the conversation and the session-allowed list for that pane", () => {
    useAgentSessionStore.getState().markStarting("pane-1");
    useAgentSessionStore.getState().allowSession("pane-1", "Bash *");
    useAgentSessionStore.getState().reset("pane-1");
    expect(useAgentSessionStore.getState().panes["pane-1"]).toBeUndefined();
    expect(useAgentSessionStore.getState().sessionAllowed["pane-1"]).toBeUndefined();
  });

  it("allowSession dedups an identical key", () => {
    useAgentSessionStore.getState().allowSession("pane-1", "Bash *");
    useAgentSessionStore.getState().allowSession("pane-1", "Bash *");
    expect(useAgentSessionStore.getState().sessionAllowed["pane-1"]).toEqual(["Bash *"]);
  });
});
