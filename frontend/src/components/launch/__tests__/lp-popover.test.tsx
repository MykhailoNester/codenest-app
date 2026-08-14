import { useState, type ReactElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LpSelect, type LpSelectItem } from "../lp-popover";

// Pins the elevation/clipping fix — the part the mockup's `position:
// absolute` menu gets wrong (D1 in the plan). `LpSelect` is exercised rather
// than `LpPopover` directly since it is the concrete instance every selector
// in the composer uses, and it is a thinner harness than reimplementing
// `renderTrigger`/`children` here.

const ITEMS: LpSelectItem[] = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
];

function Harness({
  items = ITEMS,
  width,
}: {
  items?: readonly LpSelectItem[];
  width?: number;
}): ReactElement {
  const [value, setValue] = useState("a");
  return (
    // Mirrors `.lp-left`'s `overflow-y: auto` — the column whose scrolling
    // must not clip the portalled menu.
    <div style={{ overflowY: "auto", height: 200 }}>
      <LpSelect label="Pick" value={value} items={items} onPick={setValue} width={width} />
    </div>
  );
}

/** Stubs every button's `getBoundingClientRect()` — only the trigger's is
 *  ever read by production code, so one shared stub is enough. */
function stubAnchorRect(rect: {
  top: number;
  bottom: number;
  left: number;
  right: number;
}): void {
  vi.spyOn(HTMLButtonElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    right: rect.right,
    toJSON() {
      return this;
    },
  } as DOMRect);
}

function openMenu(name: RegExp = /Alpha/): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

beforeEach(() => {
  // jsdom's defaults (1024/768) are pinned so a future jsdom bump cannot
  // silently change the flip decisions under these tests.
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LpPopover / LpSelect", () => {
  it("portals the menu to document.body, not inside the scrolling wrapper", () => {
    stubAnchorRect({ top: 100, bottom: 130, left: 10, right: 110 });
    render(<Harness />);
    openMenu();
    const menu = document.querySelector(".lp-pop__menu");
    expect(menu).not.toBeNull();
    // This is the assertion that would fail if the menu were left absolute:
    // it would be a descendant of the scrolling wrapper, not of body.
    expect(menu?.parentElement).toBe(document.body);
  });

  it("flips up when the anchor sits near the bottom of the viewport", () => {
    stubAnchorRect({ top: 760, bottom: 780, left: 10, right: 110 });
    render(<Harness />);
    openMenu();
    const menu = document.querySelector(".lp-pop__menu") as HTMLElement;
    expect(menu.classList.contains("is-up")).toBe(true);
    expect(menu.style.bottom).not.toBe("");
    expect(menu.style.top).toBe("");
  });

  it("does not flip when the anchor sits near the top", () => {
    stubAnchorRect({ top: 20, bottom: 50, left: 10, right: 110 });
    render(<Harness />);
    openMenu();
    const menu = document.querySelector(".lp-pop__menu") as HTMLElement;
    expect(menu.classList.contains("is-up")).toBe(false);
    expect(menu.style.top).not.toBe("");
  });

  it("flips right when the anchor sits near the right edge", () => {
    stubAnchorRect({ top: 20, bottom: 50, left: 900, right: 1000 });
    render(<Harness width={250} />);
    openMenu();
    const menu = document.querySelector(".lp-pop__menu") as HTMLElement;
    expect(menu.classList.contains("is-right")).toBe(true);
    expect(menu.style.right).not.toBe("");
    expect(menu.style.left).toBe("");
  });

  it("a capture-phase scroll closes it, proving the listener is registered with capture: true", () => {
    stubAnchorRect({ top: 20, bottom: 50, left: 10, right: 110 });
    const { container } = render(<Harness />);
    openMenu();
    expect(document.querySelector(".lp-pop__menu")).not.toBeNull();

    const scrollWrapper = container.firstElementChild;
    if (!scrollWrapper) throw new Error("expected the scrolling wrapper");
    // A scroll event does not bubble — this only closes the menu if the
    // listener was registered on `window` with `capture: true`.
    fireEvent.scroll(scrollWrapper);
    expect(document.querySelector(".lp-pop__menu")).toBeNull();
  });

  it("Escape closes the menu only, not reaching a bubble-phase document listener", () => {
    stubAnchorRect({ top: 20, bottom: 50, left: 10, right: 110 });
    render(<Harness />);
    openMenu();
    const bubbleListener = vi.fn();
    document.addEventListener("keydown", bubbleListener);
    try {
      // Fired on a descendant, not on `document` itself, so the capturing
      // traversal actually visits `document` (running the popover's
      // capture-phase listener and its `stopPropagation()`) before the
      // event would otherwise bubble back up to `document`'s own listener.
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(document.querySelector(".lp-pop__menu")).toBeNull();
      expect(bubbleListener).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", bubbleListener);
    }
  });

  it("an outside mousedown closes it; a mousedown inside the portalled menu does not", () => {
    stubAnchorRect({ top: 20, bottom: 50, left: 10, right: 110 });
    render(<Harness />);
    openMenu();
    const menu = document.querySelector(".lp-pop__menu");
    expect(menu).not.toBeNull();

    fireEvent.mouseDown(menu as Element);
    expect(document.querySelector(".lp-pop__menu")).not.toBeNull();

    fireEvent.mouseDown(document.body);
    expect(document.querySelector(".lp-pop__menu")).toBeNull();
  });

  it("empty items renders a disabled trigger showing the placeholder, and opens nothing", () => {
    render(<Harness items={[]} />);
    const trigger = screen.getByRole("button", { name: /—/ }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(document.querySelector(".lp-pop__menu")).toBeNull();
  });

  it("a null dot still renders a swatch, with the neutral fallback background", () => {
    stubAnchorRect({ top: 20, bottom: 50, left: 10, right: 110 });
    render(
      <Harness
        items={[
          { id: "a", label: "Alpha", dot: null },
          { id: "b", label: "Beta", dot: "#ff0000" },
        ]}
      />,
    );
    openMenu();
    const dots = document.querySelectorAll(".lp-dot");
    expect(dots).toHaveLength(2);
    expect((dots[0] as HTMLElement).style.background).toBe("var(--fg-4)");
    // jsdom's CSSOM normalises a recognised colour literal to `rgb(...)`;
    // the point of this assertion is that it is *not* the neutral fallback.
    expect((dots[1] as HTMLElement).style.background).toBe("rgb(255, 0, 0)");
  });
});
