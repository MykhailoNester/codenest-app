import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Popover } from "../popover";

/**
 * Styling is assertable for the first time here: the old `tb-*` classes lived
 * in a plain stylesheet vitest never loaded, so nothing below could be checked
 * except by eye. The `.deck` wrapper in particular is invisible in jsdom and
 * silently fatal in the app — a portal outside it resolves every Deck token to
 * nothing and ships an unstyled white box.
 */

function anchorAt(rect: Partial<DOMRect>): HTMLElement {
  const el = document.createElement("button");
  document.body.appendChild(el);
  el.getBoundingClientRect = () =>
    ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, ...rect }) as DOMRect;
  return el;
}

function panel(): HTMLElement {
  return screen.getByRole("dialog");
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("Popover", () => {
  it("renders nothing when closed or unanchored", () => {
    const { rerender } = render(
      <Popover anchor={anchorAt({})} open={false} onClose={vi.fn()}>
        <p>body</p>
      </Popover>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(
      <Popover anchor={null} open onClose={vi.fn()}>
        <p>body</p>
      </Popover>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("portals the panel inside a .deck wrapper so Deck tokens resolve", () => {
    render(
      <Popover anchor={anchorAt({})} open onClose={vi.fn()}>
        <p>body</p>
      </Popover>,
    );
    const deck = panel().closest(".deck");
    expect(deck).not.toBeNull();
    // `display: contents` — the wrapper must not become a layout box between
    // the portal root and a `position: fixed` panel.
    expect((deck as HTMLElement).style.display).toBe("contents");
  });

  it("is a .dk-modal, which is also the only opt-out from Deck's 900px row floor", () => {
    render(
      <Popover anchor={anchorAt({})} open onClose={vi.fn()}>
        <p>body</p>
      </Popover>,
    );
    expect(panel().classList.contains("dk-modal")).toBe(true);
  });

  it("overrides .dk-modal's dialog width with the dropdown's own", () => {
    render(
      <Popover anchor={anchorAt({})} open onClose={vi.fn()}>
        <p>body</p>
      </Popover>,
    );
    expect(panel().style.width).toBe("auto");
    expect(panel().style.minWidth).toBe("200px");
    expect(panel().style.maxWidth).toBe("280px");
  });

  it("minWidth overrides the panel default", () => {
    render(
      <Popover anchor={anchorAt({})} open onClose={vi.fn()} minWidth={320}>
        <p>body</p>
      </Popover>,
    );
    expect(panel().style.minWidth).toBe("320px");
  });

  it("drops below the anchor and pins its left edge by default", () => {
    render(
      <Popover anchor={anchorAt({ top: 100, bottom: 120, left: 40, right: 140 })} open onClose={vi.fn()}>
        <p>body</p>
      </Popover>,
    );
    const s = panel().style;
    expect(s.position).toBe("fixed");
    expect(s.top).toBe("124px");
    // Written explicitly: a half-specified inset lets a class-level edge stay
    // in place and stretches the panel across the viewport.
    expect(s.bottom).toBe("auto");
    expect(s.left).toBe("40px");
    expect(s.right).toBe("auto");
  });

  it("flips up when the panel would not fit below", () => {
    // window.innerHeight is 768 in jsdom; 700 + 320 + 4 clears it.
    render(
      <Popover anchor={anchorAt({ top: 680, bottom: 700, left: 10, right: 60 })} open onClose={vi.fn()}>
        <p>body</p>
      </Popover>,
    );
    const s = panel().style;
    expect(s.bottom).toBe(`${768 - 680 + 4}px`);
    expect(s.top).toBe("auto");
  });

  it("align=end pins the right edge instead", () => {
    render(
      <Popover
        anchor={anchorAt({ top: 10, bottom: 30, left: 100, right: 300 })}
        open
        onClose={vi.fn()}
        align="end"
      >
        <p>body</p>
      </Popover>,
    );
    const s = panel().style;
    expect(s.right).toBe(`${1024 - 300}px`);
    expect(s.left).toBe("auto");
  });

  it("a click on the backdrop closes", () => {
    const onClose = vi.fn();
    render(
      <Popover anchor={anchorAt({})} open onClose={onClose}>
        <p>body</p>
      </Popover>,
    );
    const backdrop = document.querySelector<HTMLElement>('.deck [role="presentation"]');
    expect(backdrop).not.toBeNull();
    // Below the panel, above everything else — a dropdown catches the click
    // without dimming the page, which is why it is not a `.dk-scrim`.
    expect(backdrop!.style.zIndex).toBe("199");
    expect(panel().style.zIndex).toBe("200");
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a scroll anywhere, including one that never reaches window", () => {
    const onClose = vi.fn();
    const scroller = document.createElement("div");
    document.body.appendChild(scroller);
    render(
      <Popover anchor={anchorAt({})} open onClose={onClose}>
        <p>body</p>
      </Popover>,
    );
    // Capture phase: a scroll on a nested, non-bubbling target still arrives.
    fireEvent.scroll(scroller);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("consumes Escape in the capture phase so an outer dialog keeps its state", () => {
    const onClose = vi.fn();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    render(
      <Popover anchor={anchorAt({})} open onClose={onClose}>
        <p>body</p>
      </Popover>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outer);
  });

  it("leaves other keys alone", () => {
    const onClose = vi.fn();
    render(
      <Popover anchor={anchorAt({})} open onClose={onClose}>
        <p>body</p>
      </Popover>,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("unsubscribes its listeners when it closes", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Popover anchor={anchorAt({})} open onClose={onClose}>
        <p>body</p>
      </Popover>,
    );
    rerender(
      <Popover anchor={anchorAt({})} open={false} onClose={onClose}>
        <p>body</p>
      </Popover>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.scroll(document);
    expect(onClose).not.toHaveBeenCalled();
  });
});
