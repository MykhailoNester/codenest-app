import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../lib/ipc", () => {
  let counter = 0;
  return {
    openTerminal: vi.fn(async () => {
      counter += 1;
      return { id: `pty-${counter}` };
    }),
    closeTerminal: vi.fn(async () => undefined),
    sendTerminalInput: vi.fn(async () => undefined),
    resizeTerminal: vi.fn(async () => undefined),
    useTerminalOutput: vi.fn(),
  };
});

import { useTerminalStore, TERMINAL_STORAGE_KEY } from "../terminal-store";
import type { LayoutNode, PaneLeaf, Split } from "../../lib/layout-tree";
import { collectLeaves, paneKind } from "../../lib/layout-tree";
import type { LaunchSpec } from "../../lib/launch";
import * as ipc from "../../lib/ipc";

const openTerminalMock = ipc.openTerminal as unknown as ReturnType<
  typeof vi.fn
>;
const sendTerminalInputMock = ipc.sendTerminalInput as unknown as ReturnType<
  typeof vi.fn
>;
const closeTerminalMock = ipc.closeTerminal as unknown as ReturnType<
  typeof vi.fn
>;

function resetStore(): void {
  useTerminalStore.setState({
    tabs: [],
    activeTabId: "",
    focusedLeafId: null,
    hydrated: false,
    hydrating: false,
  });
}

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

describe("useTerminalStore", () => {
  beforeEach(() => {
    installLocalStorage();
    resetStore();
    openTerminalMock.mockClear();
    sendTerminalInputMock.mockClear();
    closeTerminalMock.mockClear();
    let counter = 0;
    openTerminalMock.mockImplementation(async () => {
      counter += 1;
      return { id: `pty-${counter}` };
    });
  });

  describe("addTab", () => {
    it("defaults to an agent leaf and allocates no PTY", async () => {
      await useTerminalStore.getState().addTab();
      const { tabs, activeTabId, focusedLeafId } = useTerminalStore.getState();
      expect(tabs).toHaveLength(1);
      const leaf = tabs[0]!.layout as PaneLeaf;
      expect(paneKind(leaf)).toBe("agent");
      expect(tabs[0]!.title).toBe("Agent 1");
      expect(activeTabId).toBe(tabs[0]!.id);
      expect(focusedLeafId).toBe(leaf.terminalId);
      // The composer is the default surface: no shell is spawned for it.
      expect(openTerminalMock).not.toHaveBeenCalled();
    });

    it("numbers agent and shell tabs independently", async () => {
      await useTerminalStore.getState().addTab();
      await useTerminalStore.getState().addTab({ kind: "shell" });
      await useTerminalStore.getState().addTab();
      const titles = useTerminalStore.getState().tabs.map((t) => t.title);
      expect(titles).toEqual(["Agent 1", "Shell 1", "Agent 2"]);
    });

    it("with kind: 'shell' creates a tab with one leaf and allocates one PTY", async () => {
      await useTerminalStore.getState().addTab({ kind: "shell" });
      const { tabs, activeTabId, focusedLeafId } = useTerminalStore.getState();
      expect(tabs).toHaveLength(1);
      expect(tabs[0]!.layout.type).toBe("leaf");
      expect((tabs[0]!.layout as PaneLeaf).terminalId).toBe("pty-1");
      expect(activeTabId).toBe(tabs[0]!.id);
      expect(focusedLeafId).toBe("pty-1");
      expect(openTerminalMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("splitPane", () => {
    it("replaces the target leaf with a Split(h, [original, new], 0.5)", async () => {
      await useTerminalStore.getState().addTab({ kind: "shell" });
      const { tabs } = useTerminalStore.getState();
      const targetId = (tabs[0]!.layout as PaneLeaf).terminalId;

      await useTerminalStore.getState().splitPane(targetId, "h");
      const layout = useTerminalStore.getState().tabs[0]!.layout as Split;
      expect(layout.type).toBe("split");
      expect(layout.direction).toBe("h");
      expect(layout.ratio).toBe(0.5);
      expect((layout.children[0] as PaneLeaf).terminalId).toBe(targetId);
      expect((layout.children[1] as PaneLeaf).terminalId).toBe("pty-2");
      expect(useTerminalStore.getState().focusedLeafId).toBe("pty-2");
    });

    it("leaves every other tab untouched (open-shell-beside regression)", async () => {
      await useTerminalStore.getState().addTab(); // Agent 1
      await useTerminalStore.getState().addTab(); // Agent 2
      await useTerminalStore.getState().addTab({ kind: "shell" }); // Shell 1
      const before = useTerminalStore.getState();
      expect(before.tabs).toHaveLength(3);
      // Split the *middle* tab's pane, the way the composer's "open shell
      // beside" button does.
      const middle = before.tabs[1]!;
      useTerminalStore.getState().setActiveTab(middle.id);
      const targetId = (middle.layout as PaneLeaf).terminalId;

      await useTerminalStore.getState().splitPane(targetId, "h");

      const after = useTerminalStore.getState();
      expect(after.tabs.map((t) => t.id)).toEqual(
        before.tabs.map((t) => t.id),
      );
      expect(after.tabs[1]!.layout.type).toBe("split");
      // The untouched tabs keep their exact layout objects.
      expect(after.tabs[0]!.layout).toBe(before.tabs[0]!.layout);
      expect(after.tabs[2]!.layout).toBe(before.tabs[2]!.layout);
    });

    it("uses vertical direction when requested", async () => {
      await useTerminalStore.getState().addTab({ kind: "shell" });
      const targetId = (useTerminalStore.getState().tabs[0]!.layout as PaneLeaf)
        .terminalId;
      await useTerminalStore.getState().splitPane(targetId, "v");
      const layout = useTerminalStore.getState().tabs[0]!.layout as Split;
      expect(layout.direction).toBe("v");
    });

    it("with kind: 'agent' inserts an agent leaf and calls openTerminal zero times", async () => {
      await useTerminalStore.getState().addTab({ kind: "shell" });
      const targetId = (useTerminalStore.getState().tabs[0]!.layout as PaneLeaf)
        .terminalId;
      openTerminalMock.mockClear();

      await useTerminalStore
        .getState()
        .splitPane(targetId, "h", { kind: "agent" });

      const layout = useTerminalStore.getState().tabs[0]!.layout as Split;
      const agentLeaf = layout.children[1] as PaneLeaf;
      expect(agentLeaf.kind).toBe("agent");
      expect(agentLeaf.title).toBe("claude");
      expect(openTerminalMock).not.toHaveBeenCalled();
      expect(useTerminalStore.getState().focusedLeafId).toBe(
        agentLeaf.terminalId,
      );
    });

    it("with no opts still calls openTerminal once and produces a leaf with no kind", async () => {
      await useTerminalStore.getState().addTab({ kind: "shell" });
      const targetId = (useTerminalStore.getState().tabs[0]!.layout as PaneLeaf)
        .terminalId;
      openTerminalMock.mockClear();

      await useTerminalStore.getState().splitPane(targetId, "h");

      const layout = useTerminalStore.getState().tabs[0]!.layout as Split;
      const newLeaf = layout.children[1] as PaneLeaf;
      expect(newLeaf.kind).toBeUndefined();
      expect(openTerminalMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("closePane", () => {
    it("on a split: removes the leaf and collapses parent split to sibling", async () => {
      await useTerminalStore.getState().addTab({ kind: "shell" });
      const targetId = (useTerminalStore.getState().tabs[0]!.layout as PaneLeaf)
        .terminalId;
      await useTerminalStore.getState().splitPane(targetId, "h");
      // Layout now: split(h, [pty-1, pty-2])

      await useTerminalStore.getState().closePane(targetId);
      const layout = useTerminalStore.getState().tabs[0]!.layout;
      expect(layout.type).toBe("leaf");
      expect((layout as PaneLeaf).terminalId).toBe("pty-2");
    });

    it("on the last leaf in a non-last tab: closes the tab", async () => {
      await useTerminalStore.getState().addTab({ kind: "shell" }); // tab 1
      await useTerminalStore.getState().addTab({ kind: "shell" }); // tab 2
      const tabs = useTerminalStore.getState().tabs;
      expect(tabs).toHaveLength(2);
      const tab1 = tabs[0]!;
      const tab1LeafId = (tab1.layout as PaneLeaf).terminalId;

      // Make tab 1 active and close its only leaf
      useTerminalStore.getState().setActiveTab(tab1.id);
      await useTerminalStore.getState().closePane(tab1LeafId);

      const remaining = useTerminalStore.getState().tabs;
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.id).not.toBe(tab1.id);
    });

    it("on the last leaf in the last tab: re-seeds with a new agent tab", async () => {
      await useTerminalStore.getState().addTab({ kind: "shell" });
      const targetId = (useTerminalStore.getState().tabs[0]!.layout as PaneLeaf)
        .terminalId;
      await useTerminalStore.getState().closePane(targetId);

      const tabs = useTerminalStore.getState().tabs;
      expect(tabs).toHaveLength(1);
      // The re-seed goes through `addTab()`, so the replacement is the default
      // surface — an agent pane — even when what was closed was a shell.
      const seeded = tabs[0]!.layout as PaneLeaf;
      expect(paneKind(seeded)).toBe("agent");
      expect(seeded.terminalId).not.toBe(targetId);
    });
  });

  describe("closeTab", () => {
    it("on the only tab: re-seeds with a new empty tab", async () => {
      await useTerminalStore.getState().addTab({ kind: "shell" });
      const onlyTabId = useTerminalStore.getState().tabs[0]!.id;
      await useTerminalStore.getState().closeTab(onlyTabId);
      const tabs = useTerminalStore.getState().tabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0]!.id).not.toBe(onlyTabId);
    });
  });

  describe("hydrateFromStorage", () => {
    it("keeps the tabs whose panes restore when one tab's PTY cannot be allocated", async () => {
      // The regression behind "opening a shell cleared all my other tabs": a
      // single unopenable pane (its cwd was deleted, the sidecar was mid-start)
      // rejected the whole `Promise.all`, fell through to the outer catch, and
      // re-seeded the store with ONE fresh tab — silently discarding every
      // other restored tab.
      const storedTab = (id: string, cwd: string): unknown => ({
        id,
        title: id,
        layout: { type: "leaf", terminalId: `old-${id}`, title: "zsh", cwd },
      });
      localStorage.setItem(
        TERMINAL_STORAGE_KEY,
        JSON.stringify({
          tabs: [
            storedTab("tab-a", "/ok/a"),
            storedTab("tab-doomed", "/gone"),
            storedTab("tab-c", "/ok/c"),
          ],
          activeTabId: "tab-c",
        }),
      );
      openTerminalMock.mockImplementation(async (opts?: { cwd?: string }) => {
        if (opts?.cwd === "/gone") throw new Error("cwd does not exist");
        return { id: `pty-${opts?.cwd ?? "x"}` };
      });

      await useTerminalStore.getState().hydrateFromStorage();

      const { tabs, activeTabId } = useTerminalStore.getState();
      expect(tabs.map((t) => t.id)).toEqual(["tab-a", "tab-c"]);
      expect(activeTabId).toBe("tab-c");
    });

    it("rebuilds layout with fresh PTY ids when storage has two leaves", async () => {
      const stored = {
        tabs: [
          {
            id: "tab-stored",
            title: "Stored",
            layout: {
              type: "split",
              direction: "h",
              ratio: 0.4,
              children: [
                { type: "leaf", terminalId: "old-1", title: "old-1" },
                { type: "leaf", terminalId: "old-2", title: "old-2" },
              ],
            } satisfies LayoutNode,
          },
        ],
        activeTabId: "tab-stored",
      };
      localStorage.setItem(TERMINAL_STORAGE_KEY, JSON.stringify(stored));

      await useTerminalStore.getState().hydrateFromStorage();
      const tabs = useTerminalStore.getState().tabs;
      expect(tabs).toHaveLength(1);
      const layout = tabs[0]!.layout as Split;
      expect(layout.type).toBe("split");
      expect(layout.ratio).toBe(0.4);
      const leftId = (layout.children[0] as PaneLeaf).terminalId;
      const rightId = (layout.children[1] as PaneLeaf).terminalId;
      expect(leftId).toBe("pty-1");
      expect(rightId).toBe("pty-2");
      expect(openTerminalMock).toHaveBeenCalledTimes(2);
      expect(useTerminalStore.getState().hydrated).toBe(true);
    });

    it("falls back to a single default tab when storage is invalid", async () => {
      localStorage.setItem(TERMINAL_STORAGE_KEY, "{not json");
      await useTerminalStore.getState().hydrateFromStorage();
      const tabs = useTerminalStore.getState().tabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0]!.layout.type).toBe("leaf");
    });

    it("over a persisted tree with one shell and one agent leaf, opens exactly one PTY, gives the agent leaf a fresh id, and keeps its kind", async () => {
      const stored = {
        tabs: [
          {
            id: "tab-stored",
            title: "Stored",
            layout: {
              type: "split",
              direction: "h",
              ratio: 0.5,
              children: [
                { type: "leaf", terminalId: "old-shell", title: "zsh" },
                {
                  type: "leaf",
                  terminalId: "old-agent",
                  title: "claude",
                  kind: "agent",
                },
              ],
            } satisfies LayoutNode,
          },
        ],
        activeTabId: "tab-stored",
      };
      localStorage.setItem(TERMINAL_STORAGE_KEY, JSON.stringify(stored));

      await useTerminalStore.getState().hydrateFromStorage();
      const layout = useTerminalStore.getState().tabs[0]!.layout as Split;
      const shellLeaf = layout.children[0] as PaneLeaf;
      const agentLeaf = layout.children[1] as PaneLeaf;

      expect(openTerminalMock).toHaveBeenCalledTimes(1);
      expect(shellLeaf.terminalId).toBe("pty-1");
      expect(shellLeaf.kind).toBeUndefined();
      expect(agentLeaf.kind).toBe("agent");
      expect(agentLeaf.terminalId).not.toBe("old-agent");
      expect(agentLeaf.terminalId.length).toBeGreaterThan(0);
    });

    it("seeds only one default tab when called concurrently (StrictMode double-mount)", async () => {
      // Empty storage → each hydrate would seed a default tab. Two overlapping
      // calls (React StrictMode double-invokes mount effects in dev) must not
      // produce two tabs: the synchronous in-flight guard makes the second call
      // bail out before allocating a PTY.
      await Promise.all([
        useTerminalStore.getState().hydrateFromStorage(),
        useTerminalStore.getState().hydrateFromStorage(),
      ]);
      expect(useTerminalStore.getState().tabs).toHaveLength(1);
      // The seeded default is an agent tab, which has no PTY behind it.
      expect(openTerminalMock).not.toHaveBeenCalled();
      expect(useTerminalStore.getState().hydrating).toBe(false);
    });
  });

  describe("persistToStorage", () => {
    it("keeps kind on a leaf that also carries initCommand (stripInitCommands regression)", () => {
      // `providerId`/`permissionMode` pin the fix `stripLaunchOnlyFields`'s
      // copy-and-delete rewrite makes for free: the field-by-field rebuild it
      // replaced enumerated fields to keep and had silently dropped
      // `permissionMode` from that list — dormant only because no leaf had
      // both `initCommand` and `permissionMode` at once until this test.
      // `seed` pins the new field this rewrite was written to strip.
      const leaf: PaneLeaf = {
        type: "leaf",
        terminalId: "agent-1",
        title: "claude",
        kind: "agent",
        providerId: 3,
        permissionMode: "plan",
        initCommand: "claude\n",
        seed: { projectId: 7, promptPreview: "fix the flaky test" },
      };
      useTerminalStore.setState({
        tabs: [{ id: "tab-1", title: "Tab", layout: leaf }],
        activeTabId: "tab-1",
        hydrated: true,
      });

      useTerminalStore.getState().persistToStorage();

      const raw = localStorage.getItem(TERMINAL_STORAGE_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!) as {
        tabs: Array<{ layout: PaneLeaf }>;
      };
      const persistedLeaf = parsed.tabs[0]!.layout;
      expect(persistedLeaf.kind).toBe("agent");
      expect(persistedLeaf.providerId).toBe(3);
      expect(persistedLeaf.permissionMode).toBe("plan");
      expect(persistedLeaf.initCommand).toBeUndefined();
      expect(persistedLeaf.seed).toBeUndefined();
    });
  });

  describe("teardown with an agent leaf", () => {
    async function makeTabWithShellAndAgentLeaves(): Promise<{
      tabId: string;
      shellId: string;
      agentId: string;
    }> {
      await useTerminalStore.getState().addTab({ kind: "shell" });
      const tab = useTerminalStore.getState().tabs[0]!;
      const shellId = (tab.layout as PaneLeaf).terminalId;
      await useTerminalStore
        .getState()
        .splitPane(shellId, "h", { kind: "agent" });
      const layout = useTerminalStore.getState().tabs[0]!.layout as Split;
      const agentId = (layout.children[1] as PaneLeaf).terminalId;
      return { tabId: tab.id, shellId, agentId };
    }

    it("closeTab calls closeTerminal only for the shell leaf", async () => {
      const { tabId, shellId } = await makeTabWithShellAndAgentLeaves();
      closeTerminalMock.mockClear();

      await useTerminalStore.getState().closeTab(tabId);

      expect(closeTerminalMock).toHaveBeenCalledTimes(1);
      expect(closeTerminalMock).toHaveBeenCalledWith(shellId);
    });

    it("closePane on the agent leaf collapses the split without calling closeTerminal", async () => {
      const { agentId } = await makeTabWithShellAndAgentLeaves();
      closeTerminalMock.mockClear();

      await useTerminalStore.getState().closePane(agentId);

      expect(closeTerminalMock).not.toHaveBeenCalled();
      const layout = useTerminalStore.getState().tabs[0]!.layout;
      expect(layout.type).toBe("leaf");
    });

    it("closePane on the shell leaf calls closeTerminal for it", async () => {
      const { shellId } = await makeTabWithShellAndAgentLeaves();
      closeTerminalMock.mockClear();

      await useTerminalStore.getState().closePane(shellId);

      expect(closeTerminalMock).toHaveBeenCalledTimes(1);
      expect(closeTerminalMock).toHaveBeenCalledWith(shellId);
    });
  });

  describe("updateRatio", () => {
    it("writes the new ratio onto the parent split of the focused leaf", async () => {
      await useTerminalStore.getState().addTab({ kind: "shell" });
      const targetId = (useTerminalStore.getState().tabs[0]!.layout as PaneLeaf)
        .terminalId;
      await useTerminalStore.getState().splitPane(targetId, "h");
      useTerminalStore.getState().updateRatio("pty-2", 0.7);
      const layout = useTerminalStore.getState().tabs[0]!.layout as Split;
      expect(layout.ratio).toBe(0.7);
    });
  });

  describe("applyGridLayout", () => {
    function makeSpec(rows: number, cols: number): LaunchSpec {
      return {
        projectId: 1,
        cwd: "/tmp/proj",
        providerId: 1,
        providerCommand: "claude\n",
        rows,
        cols,
        target: "embedded",
        profileId: null,
      };
    }

    it("opens N PTYs for an N-leaf grid and writes N init commands", async () => {
      const spec = makeSpec(2, 2); // 4 panes
      const result = await useTerminalStore.getState().applyGridLayout(spec);

      expect(result.openedCount).toBe(4);
      expect(result.failedCount).toBe(0);
      expect(openTerminalMock).toHaveBeenCalledTimes(4);
      expect(sendTerminalInputMock).toHaveBeenCalledTimes(4);

      // Each sendTerminalInput call should use the provider command.
      // safeInjectClaudeArgs appends --session-id to claude commands, so the
      // exact string is "claude --session-id <uuid>\n" rather than "claude\n".
      for (const call of sendTerminalInputMock.mock.calls) {
        const cmd = call[1] as string;
        expect(cmd.startsWith("claude")).toBe(true);
        expect(cmd.endsWith("\n")).toBe(true);
        // The safety net must have injected --session-id.
        expect(cmd).toMatch(/--session-id\s+\S+/);
      }
    });

    it("adds a new tab and marks it active after a successful launch", async () => {
      const spec = makeSpec(1, 2);
      await useTerminalStore.getState().applyGridLayout(spec);
      const { tabs, activeTabId } = useTerminalStore.getState();
      expect(tabs).toHaveLength(1);
      expect(activeTabId).toBe(tabs[0]!.id);
    });

    it("layout tree has the correct number of leaves after a 2×2 launch", async () => {
      const spec = makeSpec(2, 2);
      await useTerminalStore.getState().applyGridLayout(spec);
      const { tabs } = useTerminalStore.getState();
      const leaves = collectLeaves(tabs[0]!.layout);
      expect(leaves).toHaveLength(4);
    });

    it("one failed openTerminal yields { openedCount: N-1, failedCount: 1 } without throwing", async () => {
      let callCount = 0;
      openTerminalMock.mockImplementation(async () => {
        callCount += 1;
        if (callCount === 2) {
          throw new Error("PTY allocation failed");
        }
        return { id: `pty-${callCount}` };
      });

      const spec = makeSpec(1, 3); // 3 panes, second one fails
      const result = await useTerminalStore.getState().applyGridLayout(spec);

      expect(result.openedCount).toBe(2);
      expect(result.failedCount).toBe(1);
    });

    it("passes cwd to every openTerminal call", async () => {
      const spec = makeSpec(1, 3);
      await useTerminalStore.getState().applyGridLayout(spec);
      for (const call of openTerminalMock.mock.calls) {
        expect((call[0] as { cwd: string }).cwd).toBe("/tmp/proj");
      }
    });
  });
});
