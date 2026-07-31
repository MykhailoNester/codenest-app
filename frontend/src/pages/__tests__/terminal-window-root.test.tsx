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
import { act, cleanup, render, screen } from "@testing-library/react";
import { TerminalWindowRoot } from "../terminal-window-root";

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
