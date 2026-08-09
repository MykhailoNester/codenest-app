import { describe, it, expect } from "vitest";
import { caretAnchor, type CaretAnchorInput } from "../caret-anchor";

function base(over: Partial<CaretAnchorInput> = {}): CaretAnchorInput {
  return {
    markerLeft: 0,
    markerTop: 0,
    scrollTop: 0,
    hostWidth: 300,
    hostHeight: 200,
    padLeft: 10,
    padTop: 8,
    panelWidth: 320,
    gapPx: 6,
    ...over,
  };
}

describe("caretAnchor", () => {
  it("anchors near the host's bottom edge for a marker on the first line", () => {
    const { bottom } = caretAnchor(base({ markerTop: 0 }));
    expect(bottom).toBe(200 - 8 + 6);
  });

  it("anchors lower (a smaller `bottom`) for a marker further down the draft", () => {
    const first = caretAnchor(base({ markerTop: 0 })).bottom;
    const later = caretAnchor(base({ markerTop: 100 })).bottom;
    expect(later).toBeLessThan(first);
  });

  it("shifts `bottom` by exactly the scroll offset", () => {
    const unscrolled = caretAnchor(base({ markerTop: 50, scrollTop: 0 })).bottom;
    const scrolled = caretAnchor(base({ markerTop: 50, scrollTop: 20 })).bottom;
    expect(scrolled - unscrolled).toBe(20);
  });

  it("never goes negative — clamps to 0 for a marker below the visible host", () => {
    const { bottom } = caretAnchor(base({ markerTop: 1000 }));
    expect(bottom).toBe(0);
  });

  it("clamps `left` to [0, hostWidth - panelWidth]", () => {
    const atOrigin = caretAnchor(base({ markerLeft: -50 })).left;
    expect(atOrigin).toBe(0);

    const farRight = caretAnchor(base({ markerLeft: 1000, hostWidth: 300, panelWidth: 320 })).left;
    // `hostWidth < panelWidth` here, so the only legal `left` is 0.
    expect(farRight).toBe(0);
  });

  it("clamps `left` at hostWidth - panelWidth when the panel fits", () => {
    const { left } = caretAnchor(base({ markerLeft: 1000, hostWidth: 400, panelWidth: 320 }));
    expect(left).toBe(400 - 320);
  });

  it("never overflows the pane when the panel is wider than the host", () => {
    const { left } = caretAnchor(base({ markerLeft: 50, hostWidth: 200, panelWidth: 320 }));
    expect(left).toBe(0);
  });
});
