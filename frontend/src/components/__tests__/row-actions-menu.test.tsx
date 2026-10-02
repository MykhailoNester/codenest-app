/**
 * RowActionsMenu, on Deck (#283).
 *
 * It had no test. It portals to `document.body`, which is the one shape this
 * migration keeps getting wrong: a portalled surface that does not carry its
 * own `deck` class resolves every token to nothing and renders a white box.
 * Nothing but an eye would catch that, so it is asserted here.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { RowActionsMenu, type RowAction } from "../row-actions-menu";

afterEach(cleanup);

function actions(over: Partial<RowAction> = {}): RowAction[] {
  return [
    { label: "Copy ref", onSelect: vi.fn() },
    { label: "Archive", onSelect: vi.fn(), disabled: true },
    { label: "Delete", onSelect: vi.fn(), danger: true, ...over },
  ];
}

describe("RowActionsMenu", () => {
  it("stays closed until the trigger is activated", () => {
    render(<RowActionsMenu actions={actions()} />);
    const trigger = screen.getByRole("button", { name: "Row actions" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("scopes the portalled menu to `.deck` so its tokens resolve", () => {
    render(<RowActionsMenu actions={actions()} />);
    fireEvent.click(screen.getByRole("button", { name: "Row actions" }));

    const menu = screen.getByRole("menu");
    // The menu lands under document.body, outside whatever `.deck` the page
    // draws inside, so a `deck` ancestor must have travelled with it.
    expect(menu.closest(".deck")).not.toBeNull();
  });

  it("carries every action, marking the destructive and the disabled one", () => {
    render(<RowActionsMenu actions={actions()} />);
    fireEvent.click(screen.getByRole("button", { name: "Row actions" }));

    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "Copy ref",
      "Archive",
      "Delete",
    ]);
    expect(items[1]?.hasAttribute("disabled")).toBe(true);
    // Deck gives `.dk-menu button.danger` the one coloured treatment it has.
    expect(items[2]?.classList.contains("danger")).toBe(true);
    expect(items[0]?.classList.contains("danger")).toBe(false);
  });

  it("runs the chosen action and closes", () => {
    const list = actions();
    render(<RowActionsMenu actions={list} />);
    fireEvent.click(screen.getByRole("button", { name: "Row actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy ref" }));

    expect(list[0]?.onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on an outside click and on a scroll anywhere", () => {
    render(<RowActionsMenu actions={actions()} />);
    const trigger = screen.getByRole("button", { name: "Row actions" });

    fireEvent.click(trigger);
    // The backdrop is the sibling the menu is portalled next to.
    const backdrop = screen.getByRole("presentation");
    fireEvent.click(backdrop);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeTruthy();
    // Capture-phase scroll: the row under the menu can move, and a menu that
    // stays put is then pointing at the wrong row.
    fireEvent.scroll(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("flips the menu above the trigger when it would not fit below", () => {
    render(<RowActionsMenu actions={actions()} />);
    const trigger = screen.getByRole("button", { name: "Row actions" });

    // jsdom reports a zero-size rect, which fits below; pin the trigger to the
    // bottom edge instead so the measurement has something to reject.
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      top: window.innerHeight - 10,
      bottom: window.innerHeight - 4,
      right: 300,
      left: 280,
      width: 20,
      height: 6,
      x: 280,
      y: window.innerHeight - 10,
      toJSON: () => ({}),
    });
    fireEvent.click(trigger);

    const menu = screen.getByRole("menu") as HTMLElement;
    expect(menu.style.bottom).not.toBe("");
    expect(menu.style.top).toBe("");
  });
});
