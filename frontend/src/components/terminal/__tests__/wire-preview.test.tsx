// The `{}` popover that replaced the composer's persistent WRITES strip.
//
// The strip used to dump a truncated, always-visible copy of the exact stdin
// line Send writes. These tests pin that the line only appears once the
// popover is opened, that what it shows is byte-identical to what
// `previewUserMessageLine`/`buildUserMessageText` — the real encoder path —
// produce for the live draft and pills (not a re-derived or memoized copy),
// and that opening/closing it never steals focus from the textarea or
// interrupts a running session.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { AgentComposer } from "../agent-composer";
import { useComposerStore } from "../../../stores/composer-store";
import {
  buildUserMessageText,
  previewUserMessageLine,
} from "../../../lib/agent-conversation";
import { agentInterrupt } from "../../../lib/ipc";

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
}));

vi.mock("../../../lib/ipc", () => ({
  agentInterrupt: vi.fn(async () => undefined),
  agentSetModel: vi.fn(async () => undefined),
  agentSetPermissionMode: vi.fn(async () => undefined),
}));

const LEAF = "leaf-1";

function renderComposer(status: "idle" | "running" = "idle"): void {
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

function trigger(): HTMLElement {
  return screen.getByLabelText("Show what Send writes to the agent");
}

function panel(): HTMLElement | null {
  return screen.queryByRole("group", { name: "Wire preview" });
}

function textarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText("Message the agent…") as HTMLTextAreaElement;
}

function openPreview(): void {
  fireEvent.click(trigger());
}

beforeEach(() => {
  useComposerStore.setState({ panes: {}, history: [] });
});

afterEach(() => {
  cleanup();
});

describe("WirePreview", () => {
  it("renders no wire JSON until the button is pressed", () => {
    renderComposer();

    expect(panel()).toBeNull();
    expect(document.body.textContent).not.toContain('"type":"user"');
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the exact line Send would write for the current draft", () => {
    renderComposer();
    useComposerStore.getState().setDraft(LEAF, "ship it");

    openPreview();

    expect(panel()!.querySelector("code")!.textContent).toBe(
      previewUserMessageLine("ship it"),
    );
  });

  it("keeps tracking the draft while the popover is open", () => {
    renderComposer();
    openPreview();

    fireEvent.change(textarea(), { target: { value: "typed after open" } });

    expect(panel()!.querySelector("code")!.textContent).toBe(
      previewUserMessageLine("typed after open"),
    );
  });

  it("previews the pills, not just the draft", () => {
    renderComposer();
    useComposerStore
      .getState()
      .addPills(LEAF, [{ id: "p1", kind: "file", path: "/repo/app/main.py" }]);
    useComposerStore.getState().setDraft(LEAF, "look at this");

    openPreview();

    const expected = previewUserMessageLine(
      buildUserMessageText([{ kind: "file", path: "/repo/app/main.py" }], "look at this"),
    );
    expect(panel()!.querySelector("code")!.textContent).toBe(expected);
  });

  it("previews the empty-text envelope when nothing is drafted", () => {
    renderComposer();

    openPreview();

    expect(panel()!.querySelector("code")!.textContent).toBe(
      previewUserMessageLine(""),
    );
    const sendButton = screen.getByRole("button", { name: /^Send/ }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
  });

  it("closes on Escape without interrupting a running session", () => {
    renderComposer("running");
    openPreview();

    fireEvent.keyDown(textarea(), { key: "Escape" });

    expect(panel()).toBeNull();
    expect(agentInterrupt).not.toHaveBeenCalled();
  });

  it("still interrupts on Escape when no popover is open", () => {
    renderComposer("running");

    fireEvent.keyDown(textarea(), { key: "Escape" });

    expect(agentInterrupt).toHaveBeenCalledWith(LEAF);
  });

  it("closes on Escape from anywhere in the document", () => {
    renderComposer();
    openPreview();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(panel()).toBeNull();
  });

  it("does not take focus from the textarea when opened", () => {
    renderComposer();
    textarea().focus();

    const ev = createEvent.mouseDown(trigger());
    fireEvent(trigger(), ev);
    fireEvent.click(trigger());

    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(textarea());
  });

  it("closes on an outside click and on its own ×", () => {
    renderComposer();

    openPreview();
    fireEvent.mouseDown(document.body);
    expect(panel()).toBeNull();

    openPreview();
    fireEvent.click(screen.getByLabelText("Close preview"));
    expect(panel()).toBeNull();
  });

  it("never shows the picker and the preview at once", () => {
    renderComposer();

    fireEvent.click(screen.getByText("+ context"));
    openPreview();

    expect(screen.queryByLabelText("Filter context")).toBeNull();
    expect(panel()).not.toBeNull();

    fireEvent.click(screen.getByText("+ context"));

    expect(panel()).toBeNull();
    expect(screen.getByLabelText("Filter context")).toBeTruthy();
  });
});
