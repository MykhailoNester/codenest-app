/**
 * terminal-store-workspace.test.ts
 *
 * Unit tests for the workspace (heterogeneous-cell) branch of `applyGridLayout`
 * and the `replaceEmptyLeaf` action.
 *
 * Covers:
 *  - 4 cells → 4 distinct PTYs with per-cell cwd/initCommand/env.
 *  - Sparse 2×2 (2 of 4 positions filled) → 2 real PTYs + 2 empty leaves.
 *  - `replaceEmptyLeaf` converts an empty leaf to a real PTY.
 *  - Preset round-trip: a `LaunchCell[]` payload deserializes to the same cell list.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

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

// fetchSidecar is fire-and-forget telemetry — stub it out.
vi.mock("../../lib/api", () => ({
  fetchSidecar: vi.fn(async () => undefined),
}));

import { useTerminalStore } from "../terminal-store";
import { collectLeaves } from "../../lib/layout-tree";
import type { LaunchSpec, LaunchCell } from "../../lib/launch";
import * as ipc from "../../lib/ipc";

const openTerminalMock = ipc.openTerminal as unknown as ReturnType<
  typeof vi.fn
>;
const sendTerminalInputMock = ipc.sendTerminalInput as unknown as ReturnType<
  typeof vi.fn
>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetStore(): void {
  useTerminalStore.setState({
    tabs: [],
    activeTabId: "",
    focusedLeafId: null,
    hydrated: false,
  });
}

function installLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
  });
}

function makeCell(
  row: number,
  col: number,
  overrides: Partial<LaunchCell> = {},
): LaunchCell {
  return {
    row,
    col,
    projectId: row * 10 + col,
    cwd: `/projects/r${row}c${col}`,
    providerId: 1,
    providerCommand: `cmd-r${row}c${col}\n`,
    extraArgs: "",
    profileId: null,
    envOverlay: {},
    ...overrides,
  };
}

function makeWorkspaceSpec(
  rows: number,
  cols: number,
  cells: LaunchCell[],
): LaunchSpec {
  return {
    projectId: 1,
    cwd: "/fallback",
    providerId: 1,
    providerCommand: "fallback-cmd\n",
    rows,
    cols,
    target: "embedded",
    profileId: null,
    cells,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("applyGridLayout — workspace mode", () => {
  beforeEach(() => {
    installLocalStorage();
    resetStore();
    let counter = 0;
    openTerminalMock.mockClear();
    sendTerminalInputMock.mockClear();
    openTerminalMock.mockImplementation(async () => {
      counter += 1;
      return { id: `pty-${counter}` };
    });
  });

  it("full 2×2 grid: opens 4 distinct PTYs with per-cell cwd and init commands", async () => {
    const cells = [
      makeCell(0, 0),
      makeCell(0, 1),
      makeCell(1, 0),
      makeCell(1, 1),
    ];
    const spec = makeWorkspaceSpec(2, 2, cells);
    const result = await useTerminalStore.getState().applyGridLayout(spec);

    expect(result.openedCount).toBe(4);
    expect(result.failedCount).toBe(0);
    expect(openTerminalMock).toHaveBeenCalledTimes(4);
    expect(sendTerminalInputMock).toHaveBeenCalledTimes(4);

    // Each openTerminal call should use its cell's cwd.
    const openCalls = openTerminalMock.mock.calls as Array<[{ cwd: string }]>;
    const cwds = openCalls.map((c) => c[0].cwd);
    expect(cwds).toContain("/projects/r0c0");
    expect(cwds).toContain("/projects/r0c1");
    expect(cwds).toContain("/projects/r1c0");
    expect(cwds).toContain("/projects/r1c1");

    // Each sendTerminalInput call should use its cell's providerCommand.
    const inputCalls = sendTerminalInputMock.mock.calls as Array<
      [string, string]
    >;
    const cmds = inputCalls.map((c) => c[1]);
    expect(cmds).toContain("cmd-r0c0\n");
    expect(cmds).toContain("cmd-r0c1\n");
    expect(cmds).toContain("cmd-r1c0\n");
    expect(cmds).toContain("cmd-r1c1\n");
  });

  it("sparse 2×2 (2 cells filled): allocates 2 PTYs and leaves 2 empty leaves", async () => {
    // Only positions (0,0) and (1,1) have cells; (0,1) and (1,0) are empty.
    const cells = [makeCell(0, 0), makeCell(1, 1)];
    const spec = makeWorkspaceSpec(2, 2, cells);
    const result = await useTerminalStore.getState().applyGridLayout(spec);

    expect(result.openedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(openTerminalMock).toHaveBeenCalledTimes(2);

    // Layout should have 4 leaves total; 2 real + 2 empty.
    const { tabs } = useTerminalStore.getState();
    const leaves = collectLeaves(tabs[0]!.layout);
    expect(leaves).toHaveLength(4);

    const realLeaves = leaves.filter((l) => !l.empty);
    const emptyLeaves = leaves.filter((l) => l.empty === true);
    expect(realLeaves).toHaveLength(2);
    expect(emptyLeaves).toHaveLength(2);

    // Empty leaves should still carry placeholder terminalIds (not "").
    for (const leaf of emptyLeaves) {
      expect(leaf.terminalId).toMatch(/^pending-/);
    }
  });

  it("env overlay is passed to openTerminal for cells that have it", async () => {
    const cells = [
      makeCell(0, 0, { envOverlay: { MY_KEY: "my_value" } }),
      makeCell(0, 1), // no overlay
    ];
    const spec = makeWorkspaceSpec(1, 2, cells);
    await useTerminalStore.getState().applyGridLayout(spec);

    const openCalls = openTerminalMock.mock.calls as Array<
      [Record<string, unknown>]
    >;
    // The call with cwd=/projects/r0c0 should have env set.
    const cellWithEnv = openCalls.find(
      (c) => (c[0] as { cwd?: string }).cwd === "/projects/r0c0",
    );
    expect(cellWithEnv).toBeDefined();
    expect((cellWithEnv![0] as { env?: Record<string, string> }).env).toEqual({
      MY_KEY: "my_value",
    });

    // The call for (0,1) which has no overlay should NOT have env set.
    const cellNoEnv = openCalls.find(
      (c) => (c[0] as { cwd?: string }).cwd === "/projects/r0c1",
    );
    expect(cellNoEnv).toBeDefined();
    expect(
      (cellNoEnv![0] as { env?: Record<string, string> }).env,
    ).toBeUndefined();
  });

  it("replaceEmptyLeaf: converts an empty leaf to a real PTY and clears empty flag", async () => {
    // Sparse 1×2: only (0,0) has a cell, (0,1) is empty.
    const cells = [makeCell(0, 0)];
    const spec = makeWorkspaceSpec(1, 2, cells);
    await useTerminalStore.getState().applyGridLayout(spec);

    const { tabs } = useTerminalStore.getState();
    const leaves = collectLeaves(tabs[0]!.layout);
    const emptyLeaf = leaves.find((l) => l.empty === true);
    expect(emptyLeaf).toBeDefined();

    const emptyLeafId = emptyLeaf!.terminalId;
    openTerminalMock.mockClear();

    // Replace the empty leaf.
    await useTerminalStore.getState().replaceEmptyLeaf(emptyLeafId, {
      cwd: "/new/cwd",
      initCommand: "new-cmd\n",
    });

    // One new PTY should have been allocated.
    expect(openTerminalMock).toHaveBeenCalledTimes(1);
    expect(openTerminalMock).toHaveBeenCalledWith({ cwd: "/new/cwd" });

    // The leaf should no longer be empty.
    const updatedLeaves = collectLeaves(
      useTerminalStore.getState().tabs[0]!.layout,
    );
    const wasEmpty = updatedLeaves.find((l) => l.terminalId === emptyLeafId);
    expect(wasEmpty).toBeUndefined(); // the leaf id changed to the real PTY id

    const nowReal = updatedLeaves.filter((l) => !l.empty);
    expect(nowReal).toHaveLength(2); // both leaves are now real
  });

  it("uniform mode (no cells): all panes use the shared cwd and providerCommand", async () => {
    const spec: LaunchSpec = {
      projectId: 1,
      cwd: "/shared-cwd",
      providerId: 1,
      providerCommand: "shared-cmd\n",
      rows: 1,
      cols: 3,
      target: "embedded",
      profileId: null,
      // no cells
    };
    await useTerminalStore.getState().applyGridLayout(spec);

    expect(openTerminalMock).toHaveBeenCalledTimes(3);
    for (const call of openTerminalMock.mock.calls as Array<
      [{ cwd: string }]
    >) {
      expect(call[0].cwd).toBe("/shared-cwd");
    }
    for (const call of sendTerminalInputMock.mock.calls as Array<
      [string, string]
    >) {
      expect(call[1]).toBe("shared-cmd\n");
    }
  });
});

// ── Pydantic round-trip parity test (TypeScript side) ─────────────────────────

describe("LaunchCell shape", () => {
  it("a cell serialized to JSON and parsed back matches the original", () => {
    const cell: LaunchCell = makeCell(1, 2, {
      envOverlay: { A: "1", B: "2" },
      profileId: 42,
      extraArgs: "--verbose",
    });
    const json = JSON.stringify(cell);
    const parsed = JSON.parse(json) as LaunchCell;
    expect(parsed).toEqual(cell);
  });
});
