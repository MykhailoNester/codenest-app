// The composer editor's one measurement, from three angles: the box height it
// produces, the overlay geometry it keeps aligned, and the row count it
// reports. Exercised against bare elements appended to `document.body` — no
// React, in the style of `composer-focus.test.ts`.
//
// jsdom lays nothing out, so `scrollHeight`/`clientWidth` are stubbed per test.
// That is the point rather than a limitation here: these functions exist to
// turn a measurement into geometry, and stubbing the measurement is the only
// way to pin that mapping.

import { describe, it, expect, afterEach } from "vitest";
import {
  composerRowCount,
  layoutComposerEditor,
  measureComposerContentHeight,
  resizeComposerEditor,
  syncComposerOverlay,
  COMPOSER_EDITOR_LINE_HEIGHT_PX,
  COMPOSER_EDITOR_MAX_HEIGHT_PX,
  COMPOSER_EDITOR_MIN_HEIGHT_PX,
} from "../composer-editor-layout";

function stub(el: Element, prop: string, value: number): void {
  Object.defineProperty(el, prop, { value, configurable: true });
}

function editor(contentPx: number): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  el.style.minHeight = `${COMPOSER_EDITOR_MIN_HEIGHT_PX}px`;
  stub(el, "scrollHeight", contentPx);
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("measureComposerContentHeight", () => {
  it("restores the box's own height and minimum before returning", () => {
    const el = editor(120);
    el.style.height = "88px";
    expect(measureComposerContentHeight(el)).toBe(120);
    expect(el.style.height).toBe("88px");
    expect(el.style.minHeight).toBe(`${COMPOSER_EDITOR_MIN_HEIGHT_PX}px`);
  });
});

describe("resizeComposerEditor", () => {
  it("grows the box to the draft", () => {
    const el = editor(120);
    expect(resizeComposerEditor(el)).toBe(120);
    expect(el.style.height).toBe("120px");
  });

  it("clamps to the max so the box scrolls instead of growing forever", () => {
    const el = editor(9999);
    resizeComposerEditor(el);
    expect(el.style.height).toBe(`${COMPOSER_EDITOR_MAX_HEIGHT_PX}px`);
  });

  it("floors at the min so an empty draft keeps the box's resting size", () => {
    const el = editor(0);
    resizeComposerEditor(el);
    expect(el.style.height).toBe(`${COMPOSER_EDITOR_MIN_HEIGHT_PX}px`);
  });

  it("shrinks a box that was previously taller", () => {
    const el = editor(200);
    resizeComposerEditor(el);
    expect(el.style.height).toBe("200px");
    stub(el, "scrollHeight", 60);
    resizeComposerEditor(el);
    expect(el.style.height).toBe("60px");
  });
});

describe("syncComposerOverlay", () => {
  it("width-matches the textarea's content box, not its border box", () => {
    // The gap between the two is the scrollbar a past-max draft grows. An
    // overlay laid out at the wider measure wraps later than the textarea, so
    // the painted text drifts a line further from the caret with every
    // wrapped row — the reported "empty space where the text should be".
    const el = editor(300);
    stub(el, "clientWidth", 380);
    stub(el, "clientHeight", COMPOSER_EDITOR_MAX_HEIGHT_PX);
    const overlay = document.createElement("div");
    document.body.appendChild(overlay);

    syncComposerOverlay(el, overlay);

    expect(overlay.style.width).toBe("380px");
    expect(overlay.style.height).toBe(`${COMPOSER_EDITOR_MAX_HEIGHT_PX}px`);
  });

  it("carries the textarea's scroll offset onto the overlay", () => {
    const el = editor(600);
    stub(el, "clientWidth", 400);
    stub(el, "clientHeight", 264);
    el.scrollTop = 180;
    const overlay = document.createElement("div");
    document.body.appendChild(overlay);

    syncComposerOverlay(el, overlay);

    expect(overlay.scrollTop).toBe(180);
  });
});

describe("composerRowCount", () => {
  it("is 0 for an empty draft", () => {
    expect(composerRowCount(0, "")).toBe(0);
  });

  it("counts rows on screen, not newlines", () => {
    // One logical line that wrapped to three: the whole point of measuring.
    const threeRows = COMPOSER_EDITOR_LINE_HEIGHT_PX * 3;
    expect(composerRowCount(threeRows, "a very long single line")).toBe(3);
  });

  it("never reports fewer rows than the draft has newlines", () => {
    // A measurement rounding a hair low cannot make a 4-line draft read as 3.
    expect(composerRowCount(COMPOSER_EDITOR_LINE_HEIGHT_PX, "a\nb\nc\nd")).toBe(4);
  });

  it("falls back to the logical count where nothing is measurable", () => {
    expect(composerRowCount(0, "a\nb")).toBe(2);
  });
});

describe("layoutComposerEditor", () => {
  it("sizes the box, aligns the overlay and reports the rows in one pass", () => {
    const el = editor(COMPOSER_EDITOR_LINE_HEIGHT_PX * 4);
    stub(el, "clientWidth", 360);
    stub(el, "clientHeight", 77);
    el.scrollTop = 12;
    const overlay = document.createElement("div");
    document.body.appendChild(overlay);

    const rows = layoutComposerEditor(el, overlay, "one long wrapped draft");

    expect(rows).toBe(4);
    expect(el.style.height).toBe(`${COMPOSER_EDITOR_LINE_HEIGHT_PX * 4}px`);
    expect(overlay.style.width).toBe("360px");
    expect(overlay.scrollTop).toBe(12);
  });

  it("still sizes the box when no overlay is mounted", () => {
    const el = editor(120);
    expect(() => layoutComposerEditor(el, null, "draft")).not.toThrow();
    expect(el.style.height).toBe("120px");
  });
});
