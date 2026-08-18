// The composer focus/caret-restore bug class: every programmatic write to a
// draft except the in-editor drop used to leave focus, the caret and the
// auto-grow box exactly where they were — the reported "cursor position is
// broken, cannot add new text at the end". These tests pin the fix: the
// history-pill recall, the (simulated) external-draft insertion, the
// in-editor drop's own specific caret, and the two paths that must NOT move
// focus — ordinary typing and a send's eventual clear.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentComposer } from "../agent-composer";
import { useComposerStore } from "../../../stores/composer-store";
import { findComposerEditor } from "../../../lib/composer-focus";

const { agentSendMock } = vi.hoisted(() => ({
  agentSendMock: vi.fn(async () => undefined),
}));

// One stable `data` per hook, like react-query's — see the note in
// `composer-slash-commands.test.tsx`: a fresh object per call turns the mention
// probe's report-upward effect into an infinite render loop. `useInvocables` is
// mocked because a draft that reads as a command line (`/tmp/shot.png` is one)
// opens the `/` menu, which mounts that probe.
const { EMPTY_TASKS, EMPTY_LIBRARY, NO_CATALOG } = vi.hoisted(() => ({
  EMPTY_TASKS: { data: [] as unknown[] },
  EMPTY_LIBRARY: { data: { items: [] as unknown[] } },
  NO_CATALOG: { data: undefined },
}));

vi.mock("../../../lib/api", () => ({
  useTasks: () => EMPTY_TASKS,
  useLibraryItems: () => EMPTY_LIBRARY,
  useInvocables: () => NO_CATALOG,
  fetchLibraryItemBySlug: vi.fn(async () => null),
  fetchSidecar: vi.fn(async () => []),
}));

vi.mock("../../../lib/ipc", () => ({
  agentInterrupt: vi.fn(async () => undefined),
  agentSetModel: vi.fn(async () => undefined),
  agentSetPermissionMode: vi.fn(async () => undefined),
  agentRespondPermission: vi.fn(async () => undefined),
  agentSend: agentSendMock,
}));

const LEAF = "leaf-1";

// A *deferring* rAF stub — see `lib/__tests__/composer-focus.test.ts` for why
// a synchronous one would let a caret-offset assertion pass for the wrong
// reason.
const frames: FrameRequestCallback[] = [];
function flushFrames(): void {
  for (let guard = 0; guard < 8 && frames.length > 0; guard += 1) {
    for (const cb of frames.splice(0, frames.length)) cb(0);
  }
}

function renderComposer(status: "idle" | "running" | "exited" = "idle"): void {
  render(
    <AgentComposer
      leafId={LEAF}
      status={status}
      providerId={null}
      model={null}
      permissionMode={null}
      onRequestRestart={() => undefined}
    />,
  );
}

beforeEach(() => {
  useComposerStore.setState({ panes: {}, history: [], targetPaneId: null });
  agentSendMock.mockClear();
  agentSendMock.mockImplementation(async () => undefined);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
});

afterEach(() => {
  flushFrames();
  frames.length = 0;
  cleanup();
  vi.unstubAllGlobals();
});

describe("composer focus/caret restore", () => {
  it("clicking a history pill refills the draft, returns focus to the editor and leaves the caret at the end", () => {
    useComposerStore.setState({ history: ["fix the parser bug"] });
    renderComposer();

    fireEvent.click(screen.getByTitle("fix the parser bug"));
    flushFrames();

    expect(useComposerStore.getState().panes[LEAF]?.draft).toBe("fix the parser bug");
    const el = findComposerEditor(LEAF);
    expect(document.activeElement).toBe(el);
    expect(el?.selectionStart).toBe("fix the parser bug".length);
  });

  it("a recalled multi-line prompt re-measures the editor instead of leaving a collapsed box", () => {
    const entry = "one\ntwo\nthree\nfour\nfive\nsix\nseven";
    useComposerStore.setState({ history: [entry] });
    renderComposer();

    const el = findComposerEditor(LEAF);
    expect(el).not.toBeNull();
    if (el) Object.defineProperty(el, "scrollHeight", { value: 120, configurable: true });

    // `getByTitle` normalizes (collapses) whitespace in the DOM text it
    // reads but not in the string matcher, so a `\n`-bearing multi-line
    // entry never matches exactly — find the pill by its exact `title`
    // attribute instead.
    const pill = Array.from(document.querySelectorAll("button")).find(
      (b) => b.title === entry,
    );
    expect(pill).toBeDefined();
    fireEvent.click(pill as HTMLButtonElement);
    flushFrames();

    expect(el?.style.height).toBe("120px");
  });

  it("typing writes the draft locally and schedules no focus restore", () => {
    useComposerStore.getState().setDraft(LEAF, "hello world");
    renderComposer();
    const el = findComposerEditor(LEAF);
    expect(el).not.toBeNull();
    if (!el) return;
    Object.defineProperty(el, "scrollHeight", { value: 64, configurable: true });
    el.setSelectionRange(2, 2);

    fireEvent.change(el, { target: { value: "hello there world" } });

    // Asserted *before* flushFrames(): the local write must queue no restore
    // at all — frames.length is the count of restores requested but not yet
    // applied.
    expect(frames.length).toBe(0);
    expect(document.activeElement).not.toBe(el);
    // The local path re-measures synchronously inside handleDraftChange, so
    // this needs no frame.
    expect(el.style.height).toBe("64px");

    // Not asserted: the caret position. `fireEvent.change` assigns through
    // the prototype `value` setter, and jsdom's textarea setter resets the
    // selection to end-of-text on any real value change *before*
    // `onChange` runs — so `selectionStart` here says nothing about the
    // component. See `use-event`-driven test below for real caret coverage.
  });

  it("typing mid-draft keeps the caret where the user is typing (userEvent)", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    useComposerStore.getState().setDraft(LEAF, "hello world");
    renderComposer();
    const el = findComposerEditor(LEAF);
    expect(el).not.toBeNull();
    if (!el) return;

    const user = userEvent.setup();
    await user.type(el, "there ", { initialSelectionStart: 6, initialSelectionEnd: 6 });

    expect(useComposerStore.getState().panes[LEAF]?.draft).toBe("hello there world");
    expect(el.selectionStart).toBe(12);
    expect(el.selectionStart).not.toBe(el.value.length);
    expect(frames.length).toBe(0);
  });

  it("a drop inside the editor leaves the caret just past the insertion, not at the end of the text", () => {
    useComposerStore.getState().setDraft(LEAF, "compare and tell me why");
    renderComposer();
    const el = findComposerEditor(LEAF);
    expect(el).not.toBeNull();
    if (!el) return;
    el.setSelectionRange("compare".length, "compare".length);

    fireEvent.drop(el, {
      dataTransfer: {
        types: ["text/plain"],
        getData: (t: string) => (t === "text/plain" ? "/a/b.ts" : ""),
      } as unknown as DataTransfer,
    });
    flushFrames();

    expect(useComposerStore.getState().panes[LEAF]?.draft).toBe(
      "compare /a/b.ts and tell me why",
    );
    expect(el.selectionStart).toBe("compare /a/b.ts".length);
    expect(el.selectionStart).not.toBe(el.value.length);
  });

  it("an external draft insertion restores focus and puts the caret at the end", () => {
    renderComposer();
    const el = findComposerEditor(LEAF);

    act(() => {
      useComposerStore.getState().insertPathsIntoDraft(LEAF, ["/tmp/shot.png"]);
    });
    flushFrames();

    const draft = useComposerStore.getState().panes[LEAF]?.draft ?? "";
    expect(document.activeElement).toBe(el);
    expect(el?.selectionStart).toBe(draft.length);
  });

  it("does not steal focus for a draft that is already present at mount", () => {
    useComposerStore.getState().setDraft(LEAF, "left over");
    renderComposer();
    flushFrames();
    expect(document.activeElement).toBe(document.body);
  });

  it("stamps the pane id where focusComposerAt can find it", () => {
    renderComposer();
    const el = findComposerEditor(LEAF);
    expect(el).not.toBeNull();
    expect(el?.tagName).toBe("TEXTAREA");
  });

  it("clearing the draft on send does not move focus", async () => {
    let release: (() => void) | undefined;
    agentSendMock.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    useComposerStore.getState().setDraft(LEAF, "ship it");
    renderComposer("idle");

    // Anchored: the `{}` wire-preview trigger is labelled "Show what Send
    // writes to the agent", so a loose /Send/ matches two buttons.
    fireEvent.click(screen.getByRole("button", { name: /^Send/ }));

    // Simulate the user moving on while the send is in flight.
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    expect(document.activeElement).toBe(other);

    release?.();
    await act(async () => {});

    expect(useComposerStore.getState().panes[LEAF]?.draft).toBe("");
    expect(document.activeElement).toBe(other);
    expect(frames.length).toBe(0);

    other.remove();
  });
});
