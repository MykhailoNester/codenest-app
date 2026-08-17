// The composer's editor box at the component layer: the transparent textarea
// and the overlay that paints its text stay one box, and the gutter counter
// reports what is on screen.
//
// The reported bug was that a long multiline draft went invisible — blank
// space where the text should be, with the caret sitting where the text
// really was. The draft was never lost; the overlay had simply been left
// behind, because the only thing that ever put it back was the textarea's
// `onScroll` and React rewrites the overlay's children on every keystroke.
// The regression guard is therefore "typing alone re-aligns the overlay",
// with no scroll event fired at all.
//
// jsdom lays nothing out, so geometry is stubbed per test. That bounds what is
// provable here to the *wiring* — that a draft change drives the sync and the
// count — which is exactly the part that regressed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AgentComposer } from "../agent-composer";
import { useComposerStore } from "../../../stores/composer-store";
import { COMPOSER_EDITOR_LINE_HEIGHT_PX } from "../../../lib/composer-editor-layout";

const { useTasksMock, useLibraryItemsMock } = vi.hoisted(() => ({
  useTasksMock: vi.fn(),
  useLibraryItemsMock: vi.fn(),
}));

vi.mock("../../../lib/api", () => ({
  useTasks: (filters?: unknown) => useTasksMock(filters),
  useLibraryItems: () => useLibraryItemsMock(),
}));

vi.mock("../../../lib/ipc", () => ({
  agentInterrupt: vi.fn(async () => undefined),
  agentSetModel: vi.fn(async () => undefined),
  agentSetPermissionMode: vi.fn(async () => undefined),
}));

const LEAF = "leaf-1";

function renderComposer(draft = ""): void {
  useComposerStore.setState({
    panes: { [LEAF]: { draft, pills: [], queued: [], fanoutAll: false } },
    history: [],
  });
  render(
    <AgentComposer
      leafId={LEAF}
      status="idle"
      providerId={null}
      model={null}
      permissionMode={null}
      onRequestRestart={() => undefined}
    />,
  );
}

function editor(): HTMLTextAreaElement {
  return document.querySelector("textarea[data-agent-composer]") as HTMLTextAreaElement;
}

/** The `aria-hidden` mirror that paints the visible copy of the draft. */
function overlay(): HTMLElement {
  return editor().parentElement?.querySelector("[aria-hidden='true']") as HTMLElement;
}

function stub(el: Element, prop: string, value: number): void {
  Object.defineProperty(el, prop, { value, configurable: true });
}

/** The gutter counter's text, whitespace-normalised. */
function gutter(): string {
  const stack = editor().parentElement as HTMLElement;
  const texts = [...stack.querySelectorAll("span")].map((s) =>
    (s.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
  return texts.find((t) => /\bchars?$/.test(t)) ?? "";
}

beforeEach(() => {
  useComposerStore.setState({ panes: {}, history: [] });
  useLibraryItemsMock.mockReturnValue({ data: { items: [] } });
  useTasksMock.mockReturnValue({ data: [] });
});

afterEach(() => {
  cleanup();
  useComposerStore.setState({ panes: {}, history: [] });
});

describe("composer editor box", () => {
  it("re-aligns the overlay on a draft change, with no scroll event", () => {
    renderComposer();
    const el = editor();
    // A draft past the box's max height: the textarea is scrolled down to the
    // caret, and the overlay was reset to the top by the last re-render.
    stub(el, "clientWidth", 380);
    stub(el, "clientHeight", 264);
    el.scrollTop = 210;
    overlay().scrollTop = 0;

    fireEvent.change(el, { target: { value: "a".repeat(900) } });

    expect(overlay().scrollTop).toBe(210);
    expect(overlay().style.width).toBe("380px");
    expect(overlay().style.height).toBe("264px");
  });

  it("width-matches the overlay to the textarea's content box", () => {
    // Past the max height the textarea grows a scrollbar, narrowing its own
    // line box. An overlay left at the wider measure wraps later and paints
    // the draft further off with every wrapped row.
    renderComposer();
    const el = editor();
    stub(el, "clientWidth", 366);
    stub(el, "clientHeight", 264);

    fireEvent.change(el, { target: { value: "wrapped\ndraft" } });

    expect(overlay().style.width).toBe("366px");
  });

  it("counts the rows on screen, not the newlines", () => {
    renderComposer();
    const el = editor();
    stub(el, "clientWidth", 380);
    stub(el, "clientHeight", 96);
    // One logical line that wrapped to four.
    stub(el, "scrollHeight", COMPOSER_EDITOR_LINE_HEIGHT_PX * 4);

    fireEvent.change(el, { target: { value: "one long line with no newline in it" } });

    expect(gutter()).toBe("4 lines · 35 chars");
  });

  it("says 1 line and 1 char, not 1 lines and 1 chars", () => {
    renderComposer();
    const el = editor();
    stub(el, "clientWidth", 380);
    stub(el, "clientHeight", 48);
    stub(el, "scrollHeight", COMPOSER_EDITOR_LINE_HEIGHT_PX);

    fireEvent.change(el, { target: { value: "x" } });

    expect(gutter()).toBe("1 line · 1 char");
  });

  it("reports nothing drafted as 0 lines", () => {
    renderComposer();
    expect(gutter()).toBe("0 lines · 0 chars");
  });
});
