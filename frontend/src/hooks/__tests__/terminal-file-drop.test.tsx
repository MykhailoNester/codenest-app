// The functional break: dragging a file from the in-app explorer tree, or
// from macOS Finder/Desktop, onto an agent pane inserted nothing. Two causes,
// two sets of regression tests:
//
// 1. Native OS drops (Finder/Desktop, the screenshot ring's drag-out) whose
//    reported position could be either true physical pixels or CSS pixels
//    already relative to the webview — `nativeDropPointCandidates` tries
//    both, and the "which reading is right" tests below pin that the fix
//    does not depend on knowing the answer.
// 2. In-app drags (a row dragged out of the workspace navigator), which on
//    macOS never reach the DOM at all (wry intercepts every in-page drag at
//    the WKWebView level) and are instead resolved from the drag source's
//    own `dragend` or from the same drag's native empty-paths `"drop"` — see
//    `lib/explorer/active-path-drag.ts` and this hook's module header.
//
// What this file does NOT prove: WebKit's actual `dragend` coordinates, and
// the real behaviour of a Finder/Desktop drag. Both require a hand-check in
// a dev build — see the plan's verification-honesty section.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { useTerminalFileDrop, nativeDropPointCandidates } from "../use-terminal-file-drop";
import { useComposerStore } from "../../stores/composer-store";
import { useTerminalStore, type Tab } from "../../stores/terminal-store";
import { writePathDragPayload } from "../../lib/explorer/drag-payload";
import {
  beginPathDrag,
  clearPathDrag,
  peekPathDrag,
} from "../../lib/explorer/active-path-drag";

const {
  onDragDropEventMock,
  unlistenMock,
  scaleFactorMock,
  sendTerminalInputMock,
} = vi.hoisted(() => ({
  onDragDropEventMock: vi.fn(),
  unlistenMock: vi.fn(),
  scaleFactorMock: vi.fn(async () => 2),
  sendTerminalInputMock: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: onDragDropEventMock }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ scaleFactor: scaleFactorMock }),
}));

vi.mock("../../lib/ipc", () => ({
  sendTerminalInput: sendTerminalInputMock,
}));

// A *deferring* rAF stub, same pattern as
// `components/terminal/__tests__/composer-focus-restore.test.tsx` — real
// enough that `focusComposerAt`'s frame can be flushed on demand rather than
// running synchronously for the wrong reason.
const frames: FrameRequestCallback[] = [];
function flushFrames(): void {
  for (let guard = 0; guard < 8 && frames.length > 0; guard += 1) {
    for (const cb of frames.splice(0, frames.length)) cb(0);
  }
}

let dragDropHandler: ((event: { payload: DragDropEvent }) => Promise<void> | void) | null = null;

/** Stubs `document.elementFromPoint` to answer only at the exact
 * coordinates given in `hits` — anywhere else returns `null`, matching a
 * real hit test finding nothing under the pointer. jsdom does not implement
 * `elementFromPoint` at all (no layout engine), so this assigns it directly
 * rather than `vi.spyOn`-wrapping a property that does not exist. */
function stubElementFromPoint(hits: Array<{ x: number; y: number; el: Element }>): void {
  document.elementFromPoint = ((x: number, y: number): Element | null => {
    const hit = hits.find((h) => h.x === x && h.y === y);
    return hit ? hit.el : null;
  }) as typeof document.elementFromPoint;
}

function agentPaneEl(leafId: string): HTMLDivElement {
  const el = document.createElement("div");
  el.dataset.agentPaneId = leafId;
  document.body.appendChild(el);
  return el;
}

function shellPaneEl(terminalId: string): HTMLDivElement {
  const el = document.createElement("div");
  el.dataset.terminalId = terminalId;
  document.body.appendChild(el);
  return el;
}

/** A synthetic drag event. jsdom has no `DragEvent`/`DataTransfer`
 * (`lib/explorer/__tests__/drag-payload.test.ts`'s header), so a plain
 * `MouseEvent` carries `clientX`/`clientY` and a `dataTransfer` property is
 * bolted on afterward only when a test needs one. */
function dragEvent(
  type: string,
  init: { clientX?: number; clientY?: number; bubbles?: boolean; dataTransfer?: unknown } = {},
): Event {
  const event = new MouseEvent(type, {
    bubbles: init.bubbles ?? true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  });
  if (init.dataTransfer !== undefined) {
    Object.defineProperty(event, "dataTransfer", { value: init.dataTransfer, configurable: true });
  }
  return event;
}

function oneAgentTab(leafId: string): Tab {
  return {
    id: "tab-1",
    title: "tab",
    layout: { type: "leaf", terminalId: leafId, title: "agent", kind: "agent" },
  };
}

async function mountHook(): Promise<void> {
  renderHook(() => useTerminalFileDrop());
  // `onDragDropEvent` is called synchronously inside the effect and captures
  // the handler synchronously inside the mock; the microtask queue still
  // needs a turn for the `.then((fn) => unlisten = fn)` continuation, which
  // matters only for the unmount path, not for firing the handler.
  await act(async () => {
    await Promise.resolve();
  });
}

async function fireDrop(payload: DragDropEvent): Promise<void> {
  expect(dragDropHandler).not.toBeNull();
  await act(async () => {
    await dragDropHandler?.({ payload });
  });
}

/** A `"drop"` payload as `onDragDropEvent` actually delivers it — `position`
 * is a real `PhysicalPosition`, not a plain `{x, y}` literal. */
function dropPayload(paths: string[], x: number, y: number): DragDropEvent {
  return { type: "drop", paths, position: new PhysicalPosition(x, y) };
}

beforeEach(() => {
  useComposerStore.setState({ panes: {}, history: [], targetPaneId: null });
  useTerminalStore.setState({ tabs: [], activeTabId: "", focusedLeafId: null });
  clearPathDrag();
  dragDropHandler = null;
  onDragDropEventMock.mockReset();
  onDragDropEventMock.mockImplementation(async (handler: typeof dragDropHandler) => {
    dragDropHandler = handler;
    return unlistenMock;
  });
  scaleFactorMock.mockReset();
  scaleFactorMock.mockImplementation(async () => 2);
  sendTerminalInputMock.mockReset();
  sendTerminalInputMock.mockImplementation(async () => undefined);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  // jsdom's default `innerWidth`/`innerHeight` are 1024/768; pin them so a
  // future jsdom bump cannot silently change the viewport prune's behaviour
  // under these tests.
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
  Object.defineProperty(window, "outerHeight", { value: 768, configurable: true });
  // Default: nothing under the pointer. Individual tests override via
  // `stubElementFromPoint`.
  stubElementFromPoint([]);
});

afterEach(() => {
  flushFrames();
  frames.length = 0;
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("nativeDropPointCandidates", () => {
  it("a scale-1 window with no titlebar yields one candidate", () => {
    const candidates = nativeDropPointCandidates({ x: 100, y: 200 }, 1, 0, {
      width: 1024,
      height: 768,
    });
    expect(candidates).toEqual([{ x: 100, y: 200 }]);
  });

  it("a retina window yields both readings in source-verified order", () => {
    const candidates = nativeDropPointCandidates({ x: 200, y: 400 }, 2, 0, {
      width: 1024,
      height: 768,
    });
    expect(candidates).toEqual([
      { x: 200, y: 400 },
      { x: 100, y: 200 },
    ]);
  });

  it("a candidate outside the viewport is dropped", () => {
    // The raw reading is beyond innerWidth (1200 > 1024); dividing by the
    // scale factor brings it back inside, so only the /scaleFactor reading
    // survives.
    const beyondViewport = nativeDropPointCandidates({ x: 1200, y: 400 }, 2, 0, {
      width: 1024,
      height: 768,
    });
    expect(beyondViewport).toEqual([{ x: 600, y: 200 }]);

    // A titlebar correction that pushes the converted y negative prunes the
    // *second* reading instead.
    const negativeConverted = nativeDropPointCandidates({ x: 100, y: 100 }, 1, 150, {
      width: 1024,
      height: 768,
    });
    expect(negativeConverted).toEqual([{ x: 100, y: 100 }]);
  });
});

describe("useTerminalFileDrop — native OS drop", () => {
  it("writes the paths into an agent pane's draft", async () => {
    useTerminalStore.setState({ tabs: [oneAgentTab("leaf-a")], activeTabId: "tab-1" });
    const pane = agentPaneEl("leaf-a");
    stubElementFromPoint([{ x: 50, y: 60, el: pane }]);
    scaleFactorMock.mockImplementation(async () => 1);

    await mountHook();
    await fireDrop(dropPayload(["/Users/me/shot.png"], 50, 60));

    expect(useComposerStore.getState().panes["leaf-a"]?.draft).toContain("/Users/me/shot.png");
    expect(useTerminalStore.getState().focusedLeafId).toBe("leaf-a");
  });

  it("still bracket-pastes onto a shell pane", async () => {
    const pane = shellPaneEl("term-1");
    stubElementFromPoint([{ x: 50, y: 60, el: pane }]);
    scaleFactorMock.mockImplementation(async () => 1);

    await mountHook();
    await fireDrop(dropPayload(["/p"], 50, 60));

    expect(sendTerminalInputMock).toHaveBeenCalledWith("term-1", "\x1b[200~/p\x1b[201~");
  });

  it("finds the pane when the reported point is already CSS pixels", async () => {
    const pane = shellPaneEl("term-1");
    // Only the raw (unconverted) point resolves — the /scaleFactor point
    // does not.
    stubElementFromPoint([{ x: 300, y: 150, el: pane }]);
    scaleFactorMock.mockImplementation(async () => 2);

    await mountHook();
    await fireDrop(dropPayload(["/p"], 300, 150));

    expect(sendTerminalInputMock).toHaveBeenCalledWith("term-1", "\x1b[200~/p\x1b[201~");
  });

  it("finds the pane when the reported point is physical pixels", async () => {
    const pane = shellPaneEl("term-1");
    // Only the /scaleFactor point resolves — the raw point does not (it is
    // off in a part of the viewport with nothing mounted).
    stubElementFromPoint([{ x: 150, y: 75, el: pane }]);
    scaleFactorMock.mockImplementation(async () => 2);

    await mountHook();
    await fireDrop(dropPayload(["/p"], 300, 150));

    expect(sendTerminalInputMock).toHaveBeenCalledWith("term-1", "\x1b[200~/p\x1b[201~");
  });

  it("falls back to the focused agent leaf when no candidate hits a pane", async () => {
    useTerminalStore.setState({
      tabs: [oneAgentTab("leaf-a")],
      activeTabId: "tab-1",
      focusedLeafId: "leaf-a",
    });
    stubElementFromPoint([]); // nothing under either candidate point
    scaleFactorMock.mockImplementation(async () => 1);

    await mountHook();
    await fireDrop(dropPayload(["/dropped/on/tabbar.png"], 9999, 9999));

    expect(useComposerStore.getState().panes["leaf-a"]?.draft).toContain(
      "/dropped/on/tabbar.png",
    );
  });
});

describe("useTerminalFileDrop — in-app drag (explorer -> composer)", () => {
  it("a dragend after an explorer drag inserts at the pane under the cursor, using the raw point", async () => {
    const pane = agentPaneEl("leaf-a");
    stubElementFromPoint([{ x: 42, y: 84, el: pane }]);
    const dt = { setData: () => undefined, effectAllowed: "" } as unknown as DataTransfer;
    writePathDragPayload(dt, ["/w/x.ts"]);

    await mountHook();
    window.dispatchEvent(dragEvent("dragend", { clientX: 42, clientY: 84 }));

    expect(useComposerStore.getState().panes["leaf-a"]?.draft).toContain("/w/x.ts");
    expect(useTerminalStore.getState().focusedLeafId).toBe("leaf-a");
  });

  it("a dragend that ends over no pane inserts nothing and keeps the record", async () => {
    stubElementFromPoint([]);
    const dt = { setData: () => undefined, effectAllowed: "" } as unknown as DataTransfer;
    writePathDragPayload(dt, ["/w/x.ts"]);

    await mountHook();
    window.dispatchEvent(dragEvent("dragend", { clientX: 1, clientY: 1 }));

    expect(useComposerStore.getState().panes["leaf-a"]?.draft ?? "").toBe("");
    expect(peekPathDrag()).toEqual(["/w/x.ts"]);
  });

  it("an in-app drag resolved from the native empty-paths drop inserts once, and the following dragend inserts nothing", async () => {
    const pane = agentPaneEl("leaf-a");
    stubElementFromPoint([{ x: 42, y: 84, el: pane }]);
    scaleFactorMock.mockImplementation(async () => 1);
    const dt = { setData: () => undefined, effectAllowed: "" } as unknown as DataTransfer;
    writePathDragPayload(dt, ["/w/x.ts"]);

    await mountHook();
    await fireDrop(dropPayload([], 42, 84));

    expect(useComposerStore.getState().panes["leaf-a"]?.draft).toContain("/w/x.ts");
    const draftAfterNativeDrop = useComposerStore.getState().panes["leaf-a"]?.draft ?? "";

    window.dispatchEvent(dragEvent("dragend", { clientX: 42, clientY: 84 }));
    expect(useComposerStore.getState().panes["leaf-a"]?.draft).toBe(draftAfterNativeDrop);
  });

  it("a native empty-paths drop with no record in flight does nothing", async () => {
    const pane = agentPaneEl("leaf-a");
    stubElementFromPoint([{ x: 42, y: 84, el: pane }]);

    await mountHook();
    await fireDrop(dropPayload([], 42, 84));

    expect(useComposerStore.getState().panes["leaf-a"]).toBeUndefined();
    expect(sendTerminalInputMock).not.toHaveBeenCalled();
  });

  it("a native empty-paths drop that hits no pane leaves the record for dragend", async () => {
    const pane = agentPaneEl("leaf-a");
    // Nothing is under the native-drop candidate points, but the pane is
    // there for `dragend`'s own hit test at a different point.
    stubElementFromPoint([{ x: 42, y: 84, el: pane }]);
    scaleFactorMock.mockImplementation(async () => 1);
    const dt = { setData: () => undefined, effectAllowed: "" } as unknown as DataTransfer;
    writePathDragPayload(dt, ["/w/x.ts"]);

    await mountHook();
    await fireDrop(dropPayload([], 9999, 9999));
    expect(useComposerStore.getState().panes["leaf-a"]).toBeUndefined();

    window.dispatchEvent(dragEvent("dragend", { clientX: 42, clientY: 84 }));
    expect(useComposerStore.getState().panes["leaf-a"]?.draft).toContain("/w/x.ts");
  });

  it("a DOM drop consumes the record so dragend cannot insert twice", async () => {
    const pane = agentPaneEl("leaf-a");
    stubElementFromPoint([{ x: 42, y: 84, el: pane }]);
    const dt = { setData: () => undefined, effectAllowed: "" } as unknown as DataTransfer;
    writePathDragPayload(dt, ["/w/x.ts"]);

    await mountHook();
    window.dispatchEvent(dragEvent("drop", { bubbles: true }));
    window.dispatchEvent(dragEvent("dragend", { clientX: 42, clientY: 84 }));

    expect(useComposerStore.getState().panes["leaf-a"]).toBeUndefined();
  });

  it("an unrelated dragend with no record is inert", async () => {
    const pane = agentPaneEl("leaf-a");
    stubElementFromPoint([{ x: 42, y: 84, el: pane }]);

    await mountHook();
    expect(() => window.dispatchEvent(dragEvent("dragend", { clientX: 42, clientY: 84 }))).not.toThrow();

    expect(useComposerStore.getState().panes["leaf-a"]).toBeUndefined();
    expect(sendTerminalInputMock).not.toHaveBeenCalled();
  });

  it("a stale record is not claimed by the next unrelated drag", async () => {
    const pane = agentPaneEl("leaf-a");
    stubElementFromPoint([{ x: 42, y: 84, el: pane }]);
    // Simulates a `dragend` orphaned by a Changes-list row that unmounted
    // mid-drag: the record exists with no source node left to end it.
    beginPathDrag(["/stale"]);

    await mountHook();
    window.dispatchEvent(dragEvent("dragstart", { bubbles: true }));
    window.dispatchEvent(dragEvent("dragend", { clientX: 42, clientY: 84 }));

    expect(useComposerStore.getState().panes["leaf-a"]).toBeUndefined();
    expect(peekPathDrag()).toBeNull();
  });

  it("a path drag that starts while a stale record exists still inserts", async () => {
    const pane = agentPaneEl("leaf-a");
    stubElementFromPoint([{ x: 42, y: 84, el: pane }]);
    beginPathDrag(["/stale"]);

    await mountHook();

    // Stands in for React 19's root-container `onDragStart` delegation,
    // which runs in the *bubble* phase: a bubble-phase listener writes the
    // fresh drag's payload only after this hook's capture-phase `dragstart`
    // guard has already cleared the stale one.
    const container = document.createElement("div");
    const child = document.createElement("div");
    container.appendChild(child);
    document.body.appendChild(container);
    container.addEventListener("dragstart", () => {
      const dt = { setData: () => undefined, effectAllowed: "" } as unknown as DataTransfer;
      writePathDragPayload(dt, ["/fresh"]);
    });

    child.dispatchEvent(dragEvent("dragstart", { bubbles: true }));
    window.dispatchEvent(dragEvent("dragend", { clientX: 42, clientY: 84 }));

    expect(useComposerStore.getState().panes["leaf-a"]?.draft).toContain("/fresh");
  });
});
