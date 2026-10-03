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

const { useTasksMock, useLibraryItemsMock, NO_CATALOG } = vi.hoisted(() => ({
  useTasksMock: vi.fn(),
  useLibraryItemsMock: vi.fn(),
  // One stable object, like react-query's `data`: a fresh one per call makes the
  // probe's report-upward effect fire every render and the parent setState it
  // performs loop forever.
  NO_CATALOG: { data: undefined },
}));

vi.mock("../../../lib/api", () => ({
  useTasks: (filters?: unknown) => useTasksMock(filters),
  useLibraryItems: () => useLibraryItemsMock(),
  // A draft that reads as a command line opens the `/` menu, which mounts the
  // probe that calls this. `data: undefined` is the still-loading shape.
  useInvocables: () => NO_CATALOG,
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

// The three layers of the stack — the real textarea, the overlay that paints
// its text, and the hidden mirror that locates the caret — used to share their
// font metrics by sitting in one CSS rule group. #283 deleted that stylesheet,
// so the guarantee now rests on one spread object. These pin it, because a
// divergence here is the whole class of bug the overlay can produce: the
// highlight drifts off the text, or the suggestion panel opens away from the
// caret, and neither is visible in a unit test that only checks wiring.
describe("editor stack — shared metrics", () => {
  const METRICS = ["font-family", "font-size", "line-height", "white-space", "word-break"];

  function metricsOf(el: HTMLElement): string[] {
    return METRICS.map((p) => `${p}:${el.style.getPropertyValue(p)}`);
  }

  it("paints the overlay with the textarea's own font metrics", () => {
    renderComposer();

    // Not "both are non-empty" — the actual values have to be equal, which is
    // what keeps a glyph in the overlay over the same glyph in the textarea.
    expect(metricsOf(overlay())).toEqual(metricsOf(editor()));
    expect(overlay().style.fontSize).toBe("12px");
  });

  // The caret mirror is the third layer, and it only mounts with an open menu
  // — so its half of this guarantee is pinned in `composer-mention-menu`,
  // which has a catalog to open one with.
});

// The hint the empty box carries. It used to be the textarea's own
// `::placeholder`, which #283 could not keep: an inline style cannot set a
// pseudo-element, and the UA default is not a safe fallback when the
// textarea's `color` is `transparent` — Chromium derives the placeholder from
// `currentcolor`, so the hint would vanish on the WebView2 and WebKitGTK
// targets. It is painted by the overlay now, and carried as the textarea's
// accessible name so the two cannot disagree.
describe("editor placeholder", () => {
  const HINT = "Message the agent…";

  it("paints the hint in the overlay while the draft is empty", () => {
    renderComposer();

    expect(overlay().textContent).toBe(HINT);
  });

  it("replaces it with the draft on the first keystroke", () => {
    renderComposer();

    fireEvent.change(editor(), { target: { value: "x" } });

    expect(overlay().textContent).toBe("x");
    expect(overlay().textContent).not.toContain("Message");
  });

  it("names the textarea for assistive tech with the same words", () => {
    renderComposer();

    expect(editor().getAttribute("aria-label")).toBe(HINT);
  });
});

// The `@mention` highlight is the overlay's entire reason to exist, and it had
// no test before #283 — the conversion moved it from a CSS-module class to an
// inline style, so this pins the behaviour rather than the class.
describe("mention highlight", () => {
  /** The overlay spans carrying their own colour — the highlighted runs. */
  function highlighted(): string[] {
    return [...overlay().querySelectorAll<HTMLElement>("span")]
      .filter((s) => s.style.color !== "")
      .map((s) => s.textContent ?? "");
  }

  it("highlights an `@token` and leaves the prose around it alone", () => {
    renderComposer();

    fireEvent.change(editor(), { target: { value: "ask @vega about it" } });

    expect(highlighted()).toEqual(["@vega"]);
    // The unhighlighted text is still painted — the overlay is the only copy
    // of the draft the user can see.
    expect(overlay().textContent).toBe("ask @vega about it");
  });

  it("highlights every token, not just the first", () => {
    renderComposer();

    fireEvent.change(editor(), { target: { value: "@vega and @atlas" } });

    expect(highlighted()).toEqual(["@vega", "@atlas"]);
  });
});

// The box's focus ring. It was `.cedit:focus-within`, which an inline style
// cannot express; it is React focus state now. `onFocus`/`onBlur` are
// focusin/focusout and bubble, so the ring still answers for the whole box —
// the picker's search field included — and not only for the textarea.
describe("editor focus ring", () => {
  function box(): HTMLElement {
    return document.querySelector("[data-editor-box]") as HTMLElement;
  }

  it("is off until something inside the box takes focus", () => {
    renderComposer();

    expect(box().dataset.focused).toBeUndefined();
    expect(box().style.borderColor).toBe("var(--line-2)");
  });

  it("lights when the textarea is focused and clears when it blurs", () => {
    renderComposer();

    fireEvent.focus(editor());
    expect(box().dataset.focused).toBe("true");
    expect(box().style.borderColor).toBe("var(--fg-3)");

    fireEvent.blur(editor());
    expect(box().dataset.focused).toBeUndefined();
    expect(box().style.borderColor).toBe("var(--line-2)");
  });
});

// The drag affordance over the editor. Untested before #283; the conversion
// moved it to an inline style, and `pointer-events: none` on it is
// load-bearing — without it the zone swallows the drop it is advertising.
describe("editor dropzone", () => {
  function zone(): HTMLElement | null {
    const stack = editor().parentElement as HTMLElement;
    return [...stack.querySelectorAll<HTMLElement>("div")].find((d) =>
      (d.textContent ?? "").startsWith("drop to insert"),
    ) ?? null;
  }

  function dragOver(items: number): void {
    fireEvent.dragOver(editor(), {
      dataTransfer: { types: ["text/plain"], items: new Array(items).fill({}) },
    });
  }

  it("stays out of the way until a drag arrives", () => {
    renderComposer();
    expect(zone()).toBeNull();
  });

  it("counts the paths being dragged, and never eats the drop", () => {
    renderComposer();

    dragOver(3);

    expect(zone()?.textContent).toBe("drop to insert3 paths");
    // Cosmetic only: with pointer events on, this element sits above the
    // textarea and the drop it is advertising never reaches the caret-precise
    // handler underneath it.
    expect(zone()?.style.pointerEvents).toBe("none");
  });

  it("says `1 path`, not `1 paths`", () => {
    renderComposer();

    dragOver(1);

    expect(zone()?.textContent).toBe("drop to insert1 path");
  });

  it("goes away when the drag leaves", () => {
    renderComposer();
    dragOver(2);

    fireEvent.dragLeave(editor());

    expect(zone()).toBeNull();
  });
});
