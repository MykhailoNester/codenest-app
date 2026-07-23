/**
 * terminal-store-prompt.test.ts
 *
 * Covers the D4 prompt delivery logic in `applyGridLayout`:
 * - Primary fan-out writes prompt to one pane only (the (0,0) pane).
 * - Every fan-out writes to all panes.
 * - None fan-out skips prompt delivery entirely.
 * - First-output triggers the write.
 * - 250ms debounce triggers the write when no output arrives.
 * - A failed pane does not block prompt delivery to others.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Track listen callbacks so tests can fire simulated terminal_output events.
type ListenCallback = (event: { payload: string }) => void;
const _listeners: Map<string, ListenCallback[]> = new Map();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (eventName: string, handler: ListenCallback): Promise<() => void> => {
      if (!_listeners.has(eventName)) {
        _listeners.set(eventName, []);
      }
      _listeners.get(eventName)!.push(handler);
      return () => {
        const arr = _listeners.get(eventName);
        if (arr) {
          const idx = arr.indexOf(handler);
          if (idx !== -1) arr.splice(idx, 1);
        }
      };
    },
  ),
}));

let _paneCounter = 0;
const _failSet = new Set<number>(); // indices of panes to fail

vi.mock("../../lib/ipc", () => ({
  openTerminal: vi.fn(async () => {
    const idx = _paneCounter++;
    if (_failSet.has(idx)) throw new Error(`PTY ${idx} failed`);
    return { id: `pty-${idx}` };
  }),
  closeTerminal: vi.fn(async () => undefined),
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sendTerminalInput: vi.fn(async (_id: string, _data: string) => undefined),
  resizeTerminal: vi.fn(async () => undefined),
  useTerminalOutput: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  fetchSidecar: vi.fn(async () => undefined),
}));

import { useTerminalStore } from "../terminal-store";
import type { LaunchSpec } from "../../lib/launch";
import * as ipc from "../../lib/ipc";

const sendInputMock = ipc.sendTerminalInput as unknown as ReturnType<
  typeof vi.fn
>;

function resetStore() {
  useTerminalStore.setState({
    tabs: [],
    activeTabId: "",
    focusedLeafId: null,
    hydrated: false,
  });
}

function installLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  });
}

/** Fire a terminal_output event for the given pane id. */
function emitOutput(paneId: string, chunk = "some output") {
  const handlers = _listeners.get(`terminal_output:${paneId}`) ?? [];
  for (const h of handlers) h({ payload: chunk });
}

/** Base spec for a 2×2 uniform launch. */
function makeSpec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    projectId: 1,
    cwd: "/tmp/proj",
    providerId: 1,
    providerCommand: "claude\n",
    rows: 2,
    cols: 2,
    target: "embedded",
    profileId: null,
    prompt: "do the thing",
    promptFanout: "primary",
    source: { kind: "task", id: 42 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("applyGridLayout prompt delivery", () => {
  beforeEach(() => {
    installLocalStorage();
    resetStore();
    sendInputMock.mockClear();
    _listeners.clear();
    _paneCounter = 0;
    _failSet.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Primary fan-out ────────────────────────────────────────────────────────

  it("primary fan-out: writes prompt to one pane only (the first pane)", async () => {
    const store = useTerminalStore.getState();
    store.setHydrated();

    const spec = makeSpec({ rows: 2, cols: 2, promptFanout: "primary" });
    const applyPromise = store.applyGridLayout(spec);

    // Advance past 250ms debounce for all panes
    await vi.runAllTimersAsync();
    await applyPromise;

    // Provider commands: 4 panes × 1 write each.
    // safeInjectClaudeArgs appends --session-id, so the command is
    // "claude --session-id <uuid>\n" rather than the bare "claude\n".
    const providerWrites = sendInputMock.mock.calls.filter(
      ([, data]) =>
        (data as string).startsWith("claude") &&
        (data as string).endsWith("\n") &&
        !(data as string).startsWith("\x1b"),
    );
    expect(providerWrites).toHaveLength(4);

    // Prompt writes: exactly 1
    const promptWrites = sendInputMock.mock.calls.filter(
      ([, data]) => data === "\x1b[200~do the thing\x1b[201~",
    );
    expect(promptWrites).toHaveLength(1);
    // Delivered to the first pane (pty-0)
    expect(promptWrites[0]![0]).toBe("pty-0");
  });

  // ── Every fan-out ──────────────────────────────────────────────────────────

  it("every fan-out: writes prompt to all panes", async () => {
    const store = useTerminalStore.getState();
    store.setHydrated();

    const spec = makeSpec({ rows: 1, cols: 3, promptFanout: "every" });
    const applyPromise = store.applyGridLayout(spec);

    await vi.runAllTimersAsync();
    await applyPromise;

    // "every" on a 1×3 layout — spec has "do the thing" as prompt
    const promptWrites = sendInputMock.mock.calls.filter(
      ([, data]) => data === "\x1b[200~do the thing\x1b[201~",
    );
    expect(promptWrites).toHaveLength(3);
  });

  // ── None fan-out ───────────────────────────────────────────────────────────

  it("none fan-out: skips prompt delivery entirely", async () => {
    const store = useTerminalStore.getState();
    store.setHydrated();

    const spec = makeSpec({ rows: 1, cols: 1, promptFanout: "none" });
    const applyPromise = store.applyGridLayout(spec);

    await vi.runAllTimersAsync();
    await applyPromise;

    // "none" fan-out: the only writes should be provider commands (claude ...).
    // Filter out provider commands (start with "claude") to get non-provider writes.
    const promptWrites = sendInputMock.mock.calls.filter(
      ([, data]) => !(data as string).startsWith("claude"),
    );
    expect(promptWrites).toHaveLength(0);
  });

  // ── First-output trigger ───────────────────────────────────────────────────

  it("writes prompt when first PTY output arrives before 250ms", async () => {
    const store = useTerminalStore.getState();
    store.setHydrated();

    const spec = makeSpec({ rows: 1, cols: 1, promptFanout: "primary" });
    const applyPromise = store.applyGridLayout(spec);

    // Advance just 60ms (< 250ms debounce) then emit output
    await vi.advanceTimersByTimeAsync(60);
    emitOutput("pty-0");

    // Let promises settle
    await vi.runAllTimersAsync();
    await applyPromise;

    const promptWrites = sendInputMock.mock.calls.filter(
      ([, data]) => data === "\x1b[200~do the thing\x1b[201~",
    );
    expect(promptWrites).toHaveLength(1);
  });

  // ── Debounce trigger ───────────────────────────────────────────────────────

  it("writes prompt after 250ms debounce when no output arrives", async () => {
    const store = useTerminalStore.getState();
    store.setHydrated();

    const spec = makeSpec({ rows: 1, cols: 1, promptFanout: "primary" });
    const applyPromise = store.applyGridLayout(spec);

    // No output event — let the debounce fire
    await vi.runAllTimersAsync();
    await applyPromise;

    const promptWrites = sendInputMock.mock.calls.filter(
      ([, data]) => data === "\x1b[200~do the thing\x1b[201~",
    );
    expect(promptWrites).toHaveLength(1);
  });

  // ── Failed pane isolation ──────────────────────────────────────────────────

  it("failed pane does not block prompt delivery to successful panes (every fan-out)", async () => {
    // Fail pane index 1 (pty-1) in a 2×2 layout
    _failSet.add(1);

    const store = useTerminalStore.getState();
    store.setHydrated();

    const spec = makeSpec({ rows: 2, cols: 2, promptFanout: "every" });
    const applyPromise = store.applyGridLayout(spec);

    await vi.runAllTimersAsync();
    await applyPromise;

    const promptWrites = sendInputMock.mock.calls.filter(
      ([, data]) => data === "\x1b[200~do the thing\x1b[201~",
    );
    // 3 successful panes (one failed), so 3 prompt writes
    expect(promptWrites).toHaveLength(3);
  });
});
