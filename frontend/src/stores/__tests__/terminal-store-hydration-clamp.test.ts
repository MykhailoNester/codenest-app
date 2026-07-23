/**
 * Verifies that `hydrateFromStorage` clamps every Split.ratio to [0.05, 0.95]
 * so a corrupted localStorage value cannot produce a near-zero pane.
 *
 * The test exercises `clampSplitRatios` (the pure helper) directly and then
 * exercises the store's hydration path with a pre-seeded localStorage payload
 * that contains out-of-range ratios.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../lib/ipc", () => {
  let counter = 0;
  return {
    openTerminal: vi.fn(async () => {
      counter += 1;
      return { id: `pty-clamp-${counter}` };
    }),
    closeTerminal: vi.fn(async () => undefined),
    sendTerminalInput: vi.fn(async () => undefined),
    resizeTerminal: vi.fn(async () => undefined),
    useTerminalOutput: vi.fn(),
  };
});

import { clampSplitRatios } from "../../lib/layout-tree";
import { useTerminalStore, TERMINAL_STORAGE_KEY } from "../terminal-store";
import type { Split, PaneLeaf } from "../../lib/layout-tree";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLeaf(id: string): PaneLeaf {
  return { type: "leaf", terminalId: id, title: "zsh" };
}

function makeSplit(ratio: number, leftId: string, rightId: string): Split {
  return {
    type: "split",
    direction: "h",
    children: [makeLeaf(leftId), makeLeaf(rightId)],
    ratio,
  };
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

function resetStore(): void {
  useTerminalStore.setState({
    tabs: [],
    activeTabId: "",
    focusedLeafId: null,
    hydrated: false,
  });
}

// ---------------------------------------------------------------------------
// Pure clampSplitRatios tests
// ---------------------------------------------------------------------------

describe("clampSplitRatios (pure)", () => {
  it("leaves an in-range ratio unchanged", () => {
    const node = makeSplit(0.5, "a", "b");
    const result = clampSplitRatios(node) as Split;
    expect(result.ratio).toBe(0.5);
  });

  it("clamps a ratio below the min (0) up to 0.05", () => {
    const node = makeSplit(0, "a", "b");
    const result = clampSplitRatios(node) as Split;
    expect(result.ratio).toBe(0.05);
  });

  it("clamps a ratio above the max (1) down to 0.95", () => {
    const node = makeSplit(1, "a", "b");
    const result = clampSplitRatios(node) as Split;
    expect(result.ratio).toBe(0.95);
  });

  it("clamps a negative ratio to 0.05", () => {
    const node = makeSplit(-0.3, "a", "b");
    const result = clampSplitRatios(node) as Split;
    expect(result.ratio).toBe(0.05);
  });

  it("clamps a ratio of 0.99 down to 0.95", () => {
    const node = makeSplit(0.99, "a", "b");
    const result = clampSplitRatios(node) as Split;
    expect(result.ratio).toBe(0.95);
  });

  it("respects custom min/max overrides", () => {
    const node = makeSplit(0.1, "a", "b");
    const result = clampSplitRatios(node, 0.2, 0.8) as Split;
    expect(result.ratio).toBe(0.2);
  });

  it("passes through a leaf node unchanged", () => {
    const leaf = makeLeaf("x");
    const result = clampSplitRatios(leaf);
    expect(result).toBe(leaf); // same reference
  });

  it("recursively clamps nested splits", () => {
    const inner = makeSplit(0.02, "c", "d");
    const outer: Split = {
      type: "split",
      direction: "v",
      children: [makeLeaf("a"), inner],
      ratio: 0.98,
    };
    const result = clampSplitRatios(outer) as Split;
    expect(result.ratio).toBe(0.95);
    const innerResult = result.children[1] as Split;
    expect(innerResult.ratio).toBe(0.05);
  });
});

// ---------------------------------------------------------------------------
// Store hydration path — ratio clamp applied on restore
// ---------------------------------------------------------------------------

describe("hydrateFromStorage — ratio clamp", () => {
  beforeEach(() => {
    installLocalStorage();
    resetStore();
  });

  it("clamps out-of-range ratios when restoring tabs from localStorage", async () => {
    // Seed localStorage with a tab whose split has a near-zero ratio.
    const badSplit = makeSplit(0.01, "old-a", "old-b");
    const persisted = {
      tabs: [{ id: "tab-1", title: "Terminal 1", layout: badSplit }],
      activeTabId: "tab-1",
    };
    localStorage.setItem(TERMINAL_STORAGE_KEY, JSON.stringify(persisted));

    await useTerminalStore.getState().hydrateFromStorage();

    const { tabs } = useTerminalStore.getState();
    expect(tabs).toHaveLength(1);
    const layout = tabs[0]!.layout as Split;
    expect(layout.type).toBe("split");
    // The bad ratio 0.01 must have been clamped to 0.05.
    expect(layout.ratio).toBe(0.05);
  });

  it("does not alter an in-range ratio on restore", async () => {
    const goodSplit = makeSplit(0.6, "old-a", "old-b");
    const persisted = {
      tabs: [{ id: "tab-2", title: "Terminal 2", layout: goodSplit }],
      activeTabId: "tab-2",
    };
    localStorage.setItem(TERMINAL_STORAGE_KEY, JSON.stringify(persisted));

    await useTerminalStore.getState().hydrateFromStorage();

    const { tabs } = useTerminalStore.getState();
    const layout = tabs[0]!.layout as Split;
    expect(layout.ratio).toBe(0.6);
  });
});
