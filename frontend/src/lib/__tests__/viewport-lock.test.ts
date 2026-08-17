// #43 — the app rendered at the window's previous, smaller size in the top-left
// corner and the whole page became scrollable, because nothing re-measured the
// root after the window changed size under a reload. These pin the re-measure:
// the root's box is written from the viewport's own metrics, on install and on
// every signal that the viewport may have moved.
//
// jsdom implements no layout, so `documentElement.clientWidth/Height` are stubbed
// here — the point under test is what the module reads and writes, not what a
// real engine would compute from it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  installViewportLock,
  readViewportSize,
  syncRootToViewport,
} from "../viewport-lock";

/** Point `documentElement.clientWidth/Height` at a fake viewport. */
function setViewport(width: number, height: number): void {
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    get: () => width,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    configurable: true,
    get: () => height,
  });
}

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
  setViewport(1200, 800);
});

afterEach(() => {
  root.remove();
  vi.restoreAllMocks();
});

describe("viewport-lock", () => {
  it("reads the viewport from the document element, not from the root", () => {
    expect(readViewportSize(document)).toEqual({ width: 1200, height: 800 });
  });

  it("writes the viewport size onto the root as inline pixels", () => {
    expect(syncRootToViewport(root)).toEqual({ width: 1200, height: 800 });
    expect(root.style.width).toBe("1200px");
    expect(root.style.height).toBe("800px");
  });

  it("locks the root to the window on install and on every resize", () => {
    const dispose = installViewportLock(root);

    // Installed before the first render, so the size is right from frame one.
    expect(root.style.height).toBe("800px");

    // The bug's shape: the window grows and the root has to follow it rather
    // than keeping the size it was laid out at.
    setViewport(1900, 1272);
    window.dispatchEvent(new Event("resize"));
    expect(root.style.width).toBe("1900px");
    expect(root.style.height).toBe("1272px");

    dispose();
  });

  it("re-measures on pageshow, which is the reload an applied update triggers", () => {
    const dispose = installViewportLock(root);
    setViewport(1440, 900);
    window.dispatchEvent(new Event("pageshow"));
    expect(root.style.height).toBe("900px");
    dispose();
  });

  it("observes the document element rather than the root it writes to", () => {
    // Observing `#root` would mean observing this module's own writes, which is
    // how a ResizeObserver feedback loop starts.
    const observed: Element[] = [];
    class SpyObserver {
      cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe(target: Element): void {
        observed.push(target);
        this.cb();
      }
      disconnect(): void {}
      unobserve(): void {}
    }
    vi.stubGlobal("ResizeObserver", SpyObserver);

    const dispose = installViewportLock(root);
    expect(observed).toEqual([document.documentElement]);
    dispose();
  });

  it("stops re-measuring once disposed", () => {
    const dispose = installViewportLock(root);
    dispose();

    setViewport(640, 480);
    window.dispatchEvent(new Event("resize"));
    // Still the size from install time — the listeners are gone.
    expect(root.style.height).toBe("800px");
  });
});
