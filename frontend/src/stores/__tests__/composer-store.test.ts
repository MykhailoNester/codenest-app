import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../lib/ipc", () => ({
  agentSend: vi.fn(async () => undefined),
  agentRespondPermission: vi.fn(async () => undefined),
  openTerminal: vi.fn(async () => ({ id: "pty-unused" })),
  closeTerminal: vi.fn(async () => undefined),
  sendTerminalInput: vi.fn(async () => undefined),
  getWorkspacePath: vi.fn(async () => "/tmp/workspace"),
}));

import {
  useComposerStore,
  CODENEST_PATHS_MIME,
  type ContextPill,
} from "../composer-store";
import { useAgentSessionStore } from "../agent-session-store";
import { useTerminalStore } from "../terminal-store";
import type { AgentFrame } from "../../lib/ipc";
import * as ipc from "../../lib/ipc";

const agentSendMock = ipc.agentSend as unknown as ReturnType<typeof vi.fn>;
const agentRespondPermissionMock = ipc.agentRespondPermission as unknown as ReturnType<
  typeof vi.fn
>;

function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const fake: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
  };
  vi.stubGlobal("localStorage", fake);
  return store;
}

function frame(paneId: string, kind: AgentFrame["kind"], raw: unknown): AgentFrame {
  return { pane_id: paneId, session_id: "s1", kind, raw };
}

describe("composer-store", () => {
  beforeEach(() => {
    installLocalStorage();
    useComposerStore.setState({ panes: {}, history: [], targetPaneId: null });
    useAgentSessionStore.setState({ panes: {}, sessionAllowed: {} });
    useTerminalStore.setState({
      tabs: [],
      activeTabId: "",
      focusedLeafId: null,
      hydrated: true,
      hydrating: false,
    });
    agentSendMock.mockClear();
    agentRespondPermissionMock.mockClear();
  });

  it("CODENEST_PATHS_MIME is the exact literal the cross-branch contract names", () => {
    expect(CODENEST_PATHS_MIME).toBe("application/x-codenest-paths");
  });

  describe("send", () => {
    it("sends buildUserMessageText's output once, clears the draft, keeps the pills, and prepends the raw draft to history", async () => {
      const pill: ContextPill = { id: "p1", kind: "file", path: "a/b.ts" };
      useComposerStore.setState({
        panes: { "pane-1": { draft: "fix the bug", pills: [pill], queued: [], fanoutAll: false } },
      });

      await useComposerStore.getState().send("pane-1");

      expect(agentSendMock).toHaveBeenCalledTimes(1);
      expect(agentSendMock).toHaveBeenCalledWith(
        "pane-1",
        "@file: a/b.ts\n\nfix the bug",
      );
      const pane = useComposerStore.getState().panes["pane-1"];
      expect(pane?.draft).toBe("");
      expect(pane?.pills).toEqual([pill]);
      expect(useComposerStore.getState().history).toEqual(["fix the bug"]);
    });

    it("with an empty draft and no pills performs zero ipc calls", async () => {
      useComposerStore.setState({
        panes: { "pane-1": { draft: "", pills: [], queued: [], fanoutAll: false } },
      });
      await useComposerStore.getState().send("pane-1");
      expect(agentSendMock).not.toHaveBeenCalled();
    });

    it("fanoutAll with two agent leaves in the active tab produces two agentSend calls, one per pane id", async () => {
      useTerminalStore.setState({
        tabs: [
          {
            id: "tab-1",
            title: "Tab",
            layout: {
              type: "split",
              direction: "h",
              ratio: 0.5,
              children: [
                { type: "leaf", terminalId: "pane-1", title: "claude", kind: "agent" },
                { type: "leaf", terminalId: "pane-2", title: "claude", kind: "agent" },
              ],
            },
          },
        ],
        activeTabId: "tab-1",
        focusedLeafId: "pane-1",
        hydrated: true,
        hydrating: false,
      });
      useComposerStore.setState({
        panes: { "pane-1": { draft: "run it", pills: [], queued: [], fanoutAll: true } },
      });

      await useComposerStore.getState().send("pane-1");

      expect(agentSendMock).toHaveBeenCalledTimes(2);
      const targets = agentSendMock.mock.calls.map((c) => c[0]).sort();
      expect(targets).toEqual(["pane-1", "pane-2"]);
    });
  });

  describe("seedDraft (#32)", () => {
    it("fills an empty draft verbatim, including a fenced code block", () => {
      const prompt = ["Fix this:", "", "```ts", "const x = 1;", "```"].join(
        "\n",
      );
      useComposerStore.getState().seedDraft("pane-1", prompt);
      expect(useComposerStore.getState().panes["pane-1"]?.draft).toBe(prompt);
    });

    it("appends after a blank line rather than clobbering a draft the user already typed", () => {
      useComposerStore.getState().setDraft("pane-1", "notes I already wrote");
      useComposerStore.getState().seedDraft("pane-1", "the seeded prompt");
      expect(useComposerStore.getState().panes["pane-1"]?.draft).toBe(
        "notes I already wrote\n\nthe seeded prompt",
      );
    });

    it("with empty text is a no-op", () => {
      useComposerStore.getState().setDraft("pane-1", "unchanged");
      useComposerStore.getState().seedDraft("pane-1", "");
      expect(useComposerStore.getState().panes["pane-1"]?.draft).toBe(
        "unchanged",
      );
    });

    it("does not send and does not touch history", () => {
      useComposerStore.getState().seedDraft("pane-1", "a seeded prompt");
      expect(agentSendMock).not.toHaveBeenCalled();
      expect(useComposerStore.getState().history).toEqual([]);
    });
  });

  describe("queue / flushQueue", () => {
    it("queue while running stores the composed text and clears the draft", () => {
      useComposerStore.setState({
        panes: { "pane-1": { draft: "run make check-all", pills: [], queued: [], fanoutAll: false } },
      });
      useComposerStore.getState().queue("pane-1");
      const pane = useComposerStore.getState().panes["pane-1"];
      expect(pane?.draft).toBe("");
      expect(pane?.queued).toEqual(["run make check-all"]);
    });

    it("applying a result frame sends the queued entry exactly once; a second result with an empty queue sends nothing", () => {
      useComposerStore.setState({
        panes: { "pane-1": { draft: "", pills: [], queued: ["do the thing"], fanoutAll: false } },
      });

      useAgentSessionStore
        .getState()
        .applyFrame("pane-1", frame("pane-1", "result", { subtype: "success", is_error: false }));

      expect(agentSendMock).toHaveBeenCalledTimes(1);
      expect(agentSendMock).toHaveBeenCalledWith("pane-1", "do the thing");
      expect(useComposerStore.getState().panes["pane-1"]?.queued).toEqual([]);

      agentSendMock.mockClear();
      useAgentSessionStore
        .getState()
        .applyFrame("pane-1", frame("pane-1", "result", { subtype: "success", is_error: false }));
      expect(agentSendMock).not.toHaveBeenCalled();
    });

    it("two queued entries flush one per result frame, in order", () => {
      useComposerStore.setState({
        panes: { "pane-1": { draft: "", pills: [], queued: ["first", "second"], fanoutAll: false } },
      });

      useAgentSessionStore
        .getState()
        .applyFrame("pane-1", frame("pane-1", "result", { subtype: "success" }));
      expect(agentSendMock).toHaveBeenNthCalledWith(1, "pane-1", "first");
      expect(useComposerStore.getState().panes["pane-1"]?.queued).toEqual(["second"]);

      useAgentSessionStore
        .getState()
        .applyFrame("pane-1", frame("pane-1", "result", { subtype: "success" }));
      expect(agentSendMock).toHaveBeenNthCalledWith(2, "pane-1", "second");
      expect(useComposerStore.getState().panes["pane-1"]?.queued).toEqual([]);
    });
  });

  describe("attachComposerContext (C3)", () => {
    it("adds one pill to targetPaneId, deduping identical paths", () => {
      useComposerStore.getState().setTargetPane("pane-1");
      useComposerStore.getState().attachComposerContext(["/a/b.ts", "/a/b.ts"]);
      const pane = useComposerStore.getState().panes["pane-1"];
      expect(pane?.pills).toHaveLength(1);
      expect(pane?.pills[0]).toMatchObject({ kind: "file", path: "/a/b.ts" });
    });

    it("is a no-op and throws nothing when targetPaneId is null", () => {
      expect(() => useComposerStore.getState().attachComposerContext(["/x"])).not.toThrow();
      expect(useComposerStore.getState().panes).toEqual({});
    });
  });

  describe("permission auto-allow (agent-session-store + composer-store)", () => {
    it("an auto-allowed session key answers a second matching permission frame and never enqueues it; a different key still enqueues", () => {
      useAgentSessionStore.getState().allowSession("pane-1", "Bash curl -s https://example.com");

      const raw = {
        request_id: "req_2",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "curl -s https://example.com" },
          permission_suggestions: [
            { rules: [{ toolName: "Bash", ruleContent: "curl -s https://example.com" }] },
          ],
        },
      };
      useAgentSessionStore.getState().applyFrame("pane-1", frame("pane-1", "permission", raw));

      expect(agentRespondPermissionMock).toHaveBeenCalledTimes(1);
      expect(agentRespondPermissionMock).toHaveBeenCalledWith(
        expect.objectContaining({ paneId: "pane-1", requestId: "req_2", allow: true }),
      );
      expect(useAgentSessionStore.getState().panes["pane-1"]?.permissions).toEqual([]);

      // A different rule content (different session key) still enqueues.
      const differentRaw = {
        request_id: "req_3",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "rm -rf /tmp/x" },
          permission_suggestions: [{ rules: [{ toolName: "Bash", ruleContent: "rm -rf /tmp/x" }] }],
        },
      };
      useAgentSessionStore
        .getState()
        .applyFrame("pane-1", frame("pane-1", "permission", differentRaw));
      expect(useAgentSessionStore.getState().panes["pane-1"]?.permissions).toHaveLength(1);
      expect(agentRespondPermissionMock).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * A dropped file's path goes into the draft text, which is what every other
   * editor does and what the user gets to type around. Drops used to become
   * `file` context pills, so the path never appeared in the prompt at all.
   */
  describe("insertPathsIntoDraft", () => {
    it("inserts into an empty draft with no leading space", () => {
      const caret = useComposerStore
        .getState()
        .insertPathsIntoDraft("pane-1", ["/Users/me/app/main.py"]);
      expect(useComposerStore.getState().panes["pane-1"]?.draft).toBe(
        "/Users/me/app/main.py ",
      );
      expect(caret).toBe("/Users/me/app/main.py ".length);
    });

    it("appends with exactly one separating space", () => {
      useComposerStore.getState().setDraft("pane-1", "look at");
      useComposerStore.getState().insertPathsIntoDraft("pane-1", ["/a/b.ts"]);
      expect(useComposerStore.getState().panes["pane-1"]?.draft).toBe("look at /a/b.ts ");
    });

    it("does not double a space the draft already ends with", () => {
      useComposerStore.getState().setDraft("pane-1", "look at ");
      useComposerStore.getState().insertPathsIntoDraft("pane-1", ["/a/b.ts"]);
      expect(useComposerStore.getState().panes["pane-1"]?.draft).toBe("look at /a/b.ts ");
    });

    it("inserts at the caret and returns the offset just past the insertion", () => {
      useComposerStore.getState().setDraft("pane-1", "compare and tell me why");
      const caret = useComposerStore
        .getState()
        .insertPathsIntoDraft("pane-1", ["/a/b.ts"], "compare".length);
      expect(useComposerStore.getState().panes["pane-1"]?.draft).toBe(
        "compare /a/b.ts and tell me why",
      );
      // Just past the path and *before* the space that was already there — no
      // second space is added when the text after the caret starts with one.
      expect(caret).toBe("compare /a/b.ts".length);
    });

    it("quotes a path containing spaces so it stays one argument", () => {
      useComposerStore
        .getState()
        .insertPathsIntoDraft("pane-1", ["/Users/me/My Docs/a b.md"]);
      expect(useComposerStore.getState().panes["pane-1"]?.draft).toBe(
        '"/Users/me/My Docs/a b.md" ',
      );
    });

    it("joins a multi-file drop with single spaces", () => {
      useComposerStore.getState().insertPathsIntoDraft("pane-1", ["/a.ts", "/b.ts"]);
      expect(useComposerStore.getState().panes["pane-1"]?.draft).toBe("/a.ts /b.ts ");
    });

    it("is a no-op for an empty or whitespace-only payload", () => {
      useComposerStore.getState().setDraft("pane-1", "unchanged");
      useComposerStore.getState().insertPathsIntoDraft("pane-1", ["", "   "]);
      expect(useComposerStore.getState().panes["pane-1"]?.draft).toBe("unchanged");
    });

    it("leaves pills alone — inserting a path is not attaching context", () => {
      useComposerStore.getState().insertPathsIntoDraft("pane-1", ["/a.ts"]);
      expect(useComposerStore.getState().panes["pane-1"]?.pills).toEqual([]);
    });
  });

  describe("recall", () => {
    it("replaces the draft with the history entry and leaves history alone", () => {
      useComposerStore.setState({
        panes: { "pane-1": { draft: "in progress", pills: [], queued: [], fanoutAll: false } },
        history: ["second most recent", "fix the parser bug"],
      });

      useComposerStore.getState().recall(1, "pane-1");

      expect(useComposerStore.getState().panes["pane-1"]?.draft).toBe("fix the parser bug");
      expect(useComposerStore.getState().history).toEqual([
        "second most recent",
        "fix the parser bug",
      ]);
    });

    it("is a no-op for an out-of-range index", () => {
      useComposerStore.setState({
        panes: { "pane-1": { draft: "unchanged", pills: [], queued: [], fanoutAll: false } },
        history: ["only entry"],
      });

      useComposerStore.getState().recall(5, "pane-1");

      expect(useComposerStore.getState().panes["pane-1"]?.draft).toBe("unchanged");
    });
  });

  describe("history persistence", () => {
    it("survives a store re-import via the stubbed localStorage", async () => {
      localStorage.setItem(
        "codenest.composer.history",
        JSON.stringify(["a previous prompt"]),
      );
      vi.resetModules();
      const fresh = await import("../composer-store");
      expect(fresh.useComposerStore.getState().history).toEqual(["a previous prompt"]);
    });
  });
});
