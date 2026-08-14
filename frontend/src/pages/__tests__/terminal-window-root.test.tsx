// The detached terminals window's composition contract.
//
// It originally withheld the workspace navigator on purpose ("a popped-out
// window gets the ⌘P palette instead of the 262 px panel"). That rule is gone —
// a popped-out pane is where real work happens, so the window now composes the
// same navigator the main window does — and this file is what keeps the prop
// from being quietly dropped again, since nothing else would fail if it were.
//
// `TerminalsLayout` is stubbed rather than rendered: the assertion is about
// which props this root passes, and mounting the real layout would drag in
// xterm, the explorer's filesystem calls and the whole pane tree.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { TerminalWindowRoot } from "../terminal-window-root";
import { useTerminalStore } from "../../stores/terminal-store";
import { enqueue } from "../../stores/pending-launch-store";
import type { LaunchSpec, PaneLaunchSpec } from "../../lib/launch";

const { layoutProps, destroyMock, onCloseRequestedMock } = vi.hoisted(() => ({
  layoutProps: [] as Array<Record<string, unknown>>,
  destroyMock: vi.fn(),
  onCloseRequestedMock: vi.fn(),
}));

vi.mock("../terminal", () => ({
  TerminalsLayout: (props: Record<string, unknown>) => {
    layoutProps.push(props);
    return <div data-testid="terminals-layout" />;
  },
}));

vi.mock("../../components/explorer/find-palette-overlay", () => ({
  FindPaletteOverlay: () => <div data-testid="find-palette" />,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    destroy: destroyMock,
    close: vi.fn(async () => undefined),
    onCloseRequested: onCloseRequestedMock,
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("../../lib/ipc", () => ({
  useEvent: (): void => undefined,
  closeTerminal: vi.fn(async () => undefined),
  agentStop: vi.fn(async () => undefined),
}));

beforeEach(() => {
  layoutProps.length = 0;
  destroyMock.mockReset().mockResolvedValue(undefined);
  onCloseRequestedMock.mockReset().mockResolvedValue(() => undefined);
});

afterEach(() => {
  cleanup();
});

describe("TerminalWindowRoot", () => {
  it("gives the detached window the workspace navigator", async () => {
    await act(async () => {
      render(<TerminalWindowRoot />);
    });

    expect(layoutProps[0]?.showNavigator).toBe(true);
  });

  it("keeps the ⌘P palette alongside it", async () => {
    // The navigator is additive: the palette is still the fast path, and it is
    // mounted here rather than inside the layout so the layout stays renderable
    // without a `QueryClientProvider`.
    await act(async () => {
      render(<TerminalWindowRoot />);
    });

    expect(screen.getByTestId("find-palette")).toBeTruthy();
    expect(screen.getByTestId("terminals-layout")).toBeTruthy();
  });

  it("supplies its own no-reseed tab-close handler", async () => {
    // Removing the last tab in this window must close the window rather than
    // spawn a replacement shell, so the root always overrides the default.
    await act(async () => {
      render(<TerminalWindowRoot />);
    });

    expect(typeof layoutProps[0]?.onCloseTab).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// The popout half of the ordered-typed-pane-list AC: both entry points branch
// on `isPaneLaunchSpec` and call the same store action embedded does. The
// store's own `applyPaneLayout`/`applyGridLayout` are stubbed here — this
// file's job is only to prove *which* one gets called, not to re-exercise
// either action's own PTY/agent behaviour (covered elsewhere).
// ---------------------------------------------------------------------------

// A plain `Map`-backed stub — jsdom's own `localStorage` collides with Node's
// `--localstorage-file` implementation in this repo's test runner (see the
// warning vitest prints), same reason every other file that touches
// `localStorage` stubs one instead of using the real global.
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

describe("TerminalWindowRoot — popout launch routing", () => {
  const applyPaneLayoutMock = vi.fn(async () => ({
    openedCount: 1,
    failedCount: 0,
  }));
  const applyGridLayoutMock = vi.fn(async () => ({
    openedCount: 1,
    failedCount: 0,
  }));

  beforeEach(() => {
    installLocalStorage();
    applyPaneLayoutMock.mockClear();
    applyGridLayoutMock.mockClear();
    useTerminalStore.setState({
      applyPaneLayout: applyPaneLayoutMock,
      applyGridLayout: applyGridLayoutMock,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a queued popout PaneLaunchSpec is applied through applyPaneLayout", async () => {
    const spec: PaneLaunchSpec = {
      panes: [{ kind: "agent", providerId: 1 }],
      split: "cols",
      target: "popout",
    };
    enqueue(spec);

    await act(async () => {
      render(<TerminalWindowRoot />);
    });

    await waitFor(() => expect(applyPaneLayoutMock).toHaveBeenCalledTimes(1));
    expect(applyPaneLayoutMock).toHaveBeenCalledWith(spec);
    expect(applyGridLayoutMock).not.toHaveBeenCalled();
  });

  it("a queued popout LaunchSpec still goes to applyGridLayout", async () => {
    const spec: LaunchSpec = {
      projectId: 1,
      cwd: "/tmp/proj",
      providerId: 1,
      providerCommand: "claude\n",
      rows: 1,
      cols: 1,
      target: "popout",
      profileId: null,
    };
    enqueue(spec);

    await act(async () => {
      render(<TerminalWindowRoot />);
    });

    await waitFor(() => expect(applyGridLayoutMock).toHaveBeenCalledTimes(1));
    expect(applyGridLayoutMock).toHaveBeenCalledWith(spec);
    expect(applyPaneLayoutMock).not.toHaveBeenCalled();
  });
});
