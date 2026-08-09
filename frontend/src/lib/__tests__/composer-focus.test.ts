// The single restore sequence for a programmatic composer draft write:
// focus() -> setSelectionRange(caret, caret) -> resizeComposerEditor(),
// deferred to a requestAnimationFrame. These tests exercise `composer-focus.ts`
// directly, against bare textareas appended to `document.body` — no React.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  focusComposerAt,
  findComposerEditor,
  resizeComposerEditor,
  COMPOSER_PANE_ATTR,
  COMPOSER_EDITOR_MAX_HEIGHT_PX,
} from "../composer-focus";

// A *deferring* rAF stub, not a synchronous one: a synchronous stub would run
// the restore before the caller's DOM write is visible, which would let a
// caret-offset test pass against a stale `el.value`. Draining explicitly via
// `flushFrames()` reproduces the real ordering (write, then frame).
const frames: FrameRequestCallback[] = [];
function flushFrames(): void {
  for (let guard = 0; guard < 8 && frames.length > 0; guard += 1) {
    for (const cb of frames.splice(0, frames.length)) cb(0);
  }
}

function appendEditor(paneId: string, value = ""): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  el.setAttribute(COMPOSER_PANE_ATTR, paneId);
  el.value = value;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
});

afterEach(() => {
  flushFrames();
  frames.length = 0;
  vi.unstubAllGlobals();
  for (const el of document.querySelectorAll(`[${COMPOSER_PANE_ATTR}]`)) {
    el.remove();
  }
});

describe("focusComposerAt", () => {
  it("focuses the pane's editor and puts the caret at the requested offset", () => {
    const el = appendEditor("pane-1", "abc def");
    focusComposerAt("pane-1", 3);
    flushFrames();
    expect(document.activeElement).toBe(el);
    expect(el.selectionStart).toBe(3);
    expect(el.selectionEnd).toBe(3);
  });

  it("defaults the caret to end-of-text when no caret is given", () => {
    const value = "line one\nline two";
    const el = appendEditor("pane-1", value);
    focusComposerAt("pane-1");
    flushFrames();
    expect(el.selectionStart).toBe(value.length);
    expect(el.selectionEnd).toBe(value.length);
  });

  it("clamps a caret past the end of the value", () => {
    const el = appendEditor("pane-1", "hello");
    focusComposerAt("pane-1", 999);
    flushFrames();
    expect(el.selectionStart).toBe("hello".length);
  });

  it("clamps a negative caret to zero", () => {
    const el = appendEditor("pane-1", "hello");
    focusComposerAt("pane-1", -5);
    flushFrames();
    expect(el.selectionStart).toBe(0);
  });

  it("re-measures the auto-grow height and clamps it to the max", () => {
    const el = appendEditor("pane-1", "one line");
    Object.defineProperty(el, "scrollHeight", { value: 88, configurable: true });
    focusComposerAt("pane-1");
    flushFrames();
    expect(el.style.height).toBe("88px");

    Object.defineProperty(el, "scrollHeight", { value: 999, configurable: true });
    resizeComposerEditor(el);
    expect(el.style.height).toBe(`${COMPOSER_EDITOR_MAX_HEIGHT_PX}px`);
  });

  it("is a no-op when no composer is mounted for that pane", () => {
    expect(() => {
      focusComposerAt("pane-does-not-exist");
      flushFrames();
    }).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });

  it("targets only the matching pane when two composers are mounted", () => {
    const paneOne = appendEditor("pane-1", "one");
    const paneTwo = appendEditor("pane-2", "two");
    focusComposerAt("pane-2");
    flushFrames();
    expect(document.activeElement).toBe(paneTwo);
    expect(document.activeElement).not.toBe(paneOne);
  });

  it("coalesces two requests in one frame and lets an explicit caret win over the default", () => {
    const el = appendEditor("pane-1", "abcdef");
    focusComposerAt("pane-1", 4);
    focusComposerAt("pane-1");
    expect(frames.length).toBe(1);
    flushFrames();
    expect(el.selectionStart).toBe(4);
  });

  it("does not mute a later request when the composer was gone for the first one", () => {
    focusComposerAt("gone");
    flushFrames(); // element absent — no-op, but must clear the pending entry

    const el = appendEditor("gone", "now it exists");
    focusComposerAt("gone");
    flushFrames();
    expect(document.activeElement).toBe(el);
  });
});

describe("findComposerEditor", () => {
  it("returns null when nothing matches", () => {
    expect(findComposerEditor("nope")).toBeNull();
  });

  it("returns the textarea whose dataset id matches", () => {
    const el = appendEditor("pane-3", "hi");
    expect(findComposerEditor("pane-3")).toBe(el);
  });
});
