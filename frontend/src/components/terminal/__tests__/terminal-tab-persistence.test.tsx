// Regression coverage for "terminal scrollback survives a tab switch".
//
// Before this change, `pages/terminal.tsx` rendered only the active tab's
// `<SplitContainer>`, so switching tabs unmounted the inactive one — the
// xterm instance it held (the only place the transcript lives) was disposed
// and the `terminal_output:{id}` subscription torn down, discarding every
// byte the child process wrote while the tab was hidden.
//
// The fix keeps every tab's pane tree mounted and hides the inactive ones
// with `visibility: hidden` (see `terminal.module.css`'s `.tabPane`) rather
// than unmounting them, so the xterm instance, its buffer and its output
// subscription are all continuous across a switch.
//
// jsdom + xterm reality check: `term.open(el)` throws
// `this._parentWindow.matchMedia is not a function` without a `matchMedia`
// stub; with that plus a `ResizeObserver` stub, xterm's DOM renderer writes
// real text into `.xterm-rows` even when the container is 0x0 (jsdom never
// runs real layout, so `offsetWidth`/`offsetHeight` are always 0 — the
// `doFirstFit`/WebGL path is simply never exercised here, which is fine: it
// is untouched by this fix and covered by its own existing guard).

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TerminalsLayout } from "../../../pages/terminal";
import { useTerminalStore, type Tab } from "../../../stores/terminal-store";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Shared handler registries, created inside `vi.hoisted` so they can be
// referenced both by the `vi.mock` factory below (which Vitest hoists above
// all imports) and by the test bodies further down, without hitting
// Vitest's "no out-of-scope variables in a mock factory" restriction.
const { outputHandlers, exitHandlers } = vi.hoisted(() => {
  return {
    outputHandlers: new Map<string, (chunk: string) => void>(),
    exitHandlers: new Map<
      string,
      (payload: { id: string; exit_code: number | null }) => void
    >(),
  };
});

// One mock covers every subtree import of `lib/ipc` — `terminal-pane.tsx`
// (sendTerminalInput, resizeTerminal, openPath, useTerminalOutput,
// usePtyExited), `pane-context-menu.tsx` (openPath) and `terminal-store.ts`
// (openTerminal, closeTerminal, getWorkspacePath) all resolve to this same
// module id. `useTerminalOutput`/`usePtyExited` register the latest handler
// for a given terminal id into the maps above inside a `useEffect`, so the
// test can drive PTY output / exit events without a real Tauri backend.
//
// Declared as an async factory so `useEffect` can be obtained via a dynamic
// `import("react")` inside the factory body — referencing the test file's
// top-level `import { useEffect } from "react"` directly would hit the same
// hoisting restriction the shared Maps above work around.
vi.mock("../../../lib/ipc", async () => {
  const { useEffect } = await import("react");
  return {
    sendTerminalInput: vi.fn(async () => undefined),
    resizeTerminal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => undefined),
    emitNativeNotification: vi.fn(async () => undefined),
    openTerminal: vi.fn(async () => ({ id: "pty-new" })),
    closeTerminal: vi.fn(async () => undefined),
    getWorkspacePath: vi.fn(async () => "/workspace"),
    useTerminalOutput: (
      id: string | null,
      handler: (chunk: string) => void,
    ): void => {
      useEffect(() => {
        if (!id) return;
        outputHandlers.set(id, handler);
        return () => {
          outputHandlers.delete(id);
        };
      }, [id, handler]);
    },
    usePtyExited: (
      id: string | null,
      handler: (payload: { id: string; exit_code: number | null }) => void,
    ): void => {
      useEffect(() => {
        if (!id) return;
        exitHandlers.set(id, handler);
        return () => {
          exitHandlers.delete(id);
        };
      }, [id, handler]);
    },
  };
});

// `useTerminalFileDrop` calls `getCurrentWebview()` on mount, which throws
// without `window.__TAURI_INTERNALS__`. Not under test here — no-op it.
vi.mock("../../../hooks/use-terminal-file-drop", () => ({
  useTerminalFileDrop: (): void => undefined,
  // `use-pane-path-drop.ts` — pulled in by terminal-pane.tsx — imports these
  // two from this module. A vi.mock factory replaces the module wholesale,
  // so every export the subtree reads must be listed here or Vitest throws
  // on access.
  pastePathsIntoTerminal: vi.fn((): void => undefined),
  bracketedPaste: vi.fn((path: string): string => path),
}));

// ---------------------------------------------------------------------------
// jsdom stubs — local to this file (frontend/vite.config.ts deliberately has
// no global setupFiles).
// ---------------------------------------------------------------------------

beforeAll(() => {
  // Without this, `term.open()` throws
  // `this._parentWindow.matchMedia is not a function`.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });

  // jsdom has no ResizeObserver; terminal-pane.tsx's mount effect constructs
  // one unconditionally.
  class StubResizeObserver {
    observe(): void {
      /* no-op */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  }
  (
    globalThis as unknown as { ResizeObserver: typeof ResizeObserver }
  ).ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;

  // Silences jsdom's "Not implemented" canvas noise. Never actually exercised
  // here: `offsetWidth` is always 0 in jsdom (no real layout), so
  // `doFirstFit` — the only place a canvas/WebGL context is touched — never
  // runs, and the DOM renderer (xterm's default without addon-canvas /
  // addon-webgl) is what writes into `.xterm-rows` below.
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    writable: true,
    value: () => null,
  });
});

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const tabA: Tab = {
  id: "tab-a",
  title: "Tab A",
  layout: { type: "leaf", terminalId: "pty-a", title: "Tab A" },
};

const tabB: Tab = {
  id: "tab-b",
  title: "Tab B",
  layout: { type: "leaf", terminalId: "pty-b", title: "Tab B" },
};

/** Read a pane's rendered transcript through the DOM (probe-verified: the
 * pane root's own `textContent` also includes xterm's char-measure element
 * and its injected `<style>` text, so `.xterm-rows` must be queried
 * specifically). */
function paneText(terminalId: string): string {
  return (
    document.querySelector(`[data-terminal-id="${terminalId}"] .xterm-rows`)
      ?.textContent ?? ""
  );
}

function feed(terminalId: string, text: string): void {
  const handler = outputHandlers.get(terminalId);
  if (!handler) {
    throw new Error(`no output handler registered for ${terminalId}`);
  }
  act(() => {
    handler(btoa(text));
  });
}

function exit(terminalId: string, exitCode: number | null): void {
  const handler = exitHandlers.get(terminalId);
  if (!handler) {
    throw new Error(`no exit handler registered for ${terminalId}`);
  }
  act(() => {
    handler({ id: terminalId, exit_code: exitCode });
  });
}

/** Click the Nth tab strip button (`tab-bar.tsx` renders `role="tab"`; its
 * accessible name is not used here because the button nests a
 * `role="button"` close control). */
function clickTab(index: number): void {
  const tabs = screen.getAllByRole("tab");
  const tab = tabs[index];
  if (!tab) throw new Error(`no tab at index ${index}`);
  fireEvent.click(tab);
}

beforeEach(() => {
  outputHandlers.clear();
  exitHandlers.clear();
  useTerminalStore.setState({
    tabs: [tabA, tabB],
    activeTabId: tabA.id,
    focusedLeafId: "pty-a",
    hydrated: true,
    hydrating: false,
    maximizedLeafId: null,
  });
});

// `afterEach(cleanup)` is mandatory: `frontend/vite.config.ts` does not set
// `globals: true`, so Testing Library's auto-cleanup never registers.
// Without it a second test would find two DOM trees (and, now that panes
// persist across a switch, two leaked xterm instances) and
// `document.querySelector` would read the stale one.
afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("terminal tab persistence", () => {
  it("keeps each tab's buffer when switching away and back", async () => {
    render(<TerminalsLayout />);

    feed("pty-a", "ALPHA-1234\r\n");
    feed("pty-b", "BETA-5678\r\n");

    await waitFor(() => expect(paneText("pty-a")).toContain("ALPHA-1234"));
    await waitFor(() => expect(paneText("pty-b")).toContain("BETA-5678"));

    clickTab(1);
    clickTab(0);

    expect(paneText("pty-a")).toContain("ALPHA-1234");
    expect(paneText("pty-b")).toContain("BETA-5678");
  });

  it("keeps the same xterm DOM node across a tab switch", async () => {
    render(<TerminalsLayout />);

    feed("pty-a", "ALPHA-1234\r\n");
    await waitFor(() => expect(paneText("pty-a")).toContain("ALPHA-1234"));

    const before = document.querySelector('[data-terminal-id="pty-a"] .xterm');
    expect(before).not.toBeNull();

    clickTab(1);
    clickTab(0);

    const after = document.querySelector('[data-terminal-id="pty-a"] .xterm');
    expect(after).toBe(before);
  });

  it("marks the inactive tab hidden rather than unmounting it", () => {
    render(<TerminalsLayout />);

    clickTab(1);

    const wrappers = document.querySelectorAll("[data-tab-pane]");
    expect(wrappers).toHaveLength(2);

    const wrapperA = document.querySelector(`[data-tab-pane="${tabA.id}"]`);
    const wrapperB = document.querySelector(`[data-tab-pane="${tabB.id}"]`);
    expect(wrapperA?.getAttribute("data-active")).toBe("false");
    expect(wrapperB?.getAttribute("data-active")).toBe("true");

    expect(
      document.querySelector('[data-terminal-id="pty-a"] .xterm-rows'),
    ).not.toBeNull();
  });

  it("preserves the transcript of a pane whose process already exited", async () => {
    render(<TerminalsLayout />);

    feed("pty-a", "ALPHA-1234\r\n");
    await waitFor(() => expect(paneText("pty-a")).toContain("ALPHA-1234"));

    exit("pty-a", 0);
    await waitFor(() => expect(paneText("pty-a")).toContain("Process exited"));

    // Round-trip through tab 2 WITHOUT delivering any further output for
    // pty-a — restoration must not depend on the (now-dead) child redrawing.
    clickTab(1);
    clickTab(0);

    expect(paneText("pty-a")).toContain("ALPHA-1234");
    expect(paneText("pty-a")).toContain("Process exited");
  });

  it("keeps delivering output to a background tab", async () => {
    render(<TerminalsLayout />);

    clickTab(1);
    feed("pty-a", "BACKGROUND-9999\r\n");

    clickTab(0);

    await waitFor(() => expect(paneText("pty-a")).toContain("BACKGROUND-9999"));
  });
});
