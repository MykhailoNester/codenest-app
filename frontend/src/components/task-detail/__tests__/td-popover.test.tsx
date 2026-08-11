import { useState, type ReactElement } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TdPopover } from "../td-popover";

// Controlled harness: `TdPopover` owns no state of its own (D6 in the
// plan), so the test double stands in for the real caller (`PropertiesCard`)
// managing `open` via its own `useState`.
function Harness({
  initialOpen = false,
}: {
  initialOpen?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(initialOpen);
  return (
    <TdPopover
      label="Status"
      open={open}
      onOpenChange={setOpen}
      renderTrigger={({ ref, open: isOpen, onClick }) => (
        <button
          ref={ref}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          onClick={onClick}
        >
          Trigger
        </button>
      )}
    >
      {({ close }) => (
        <button
          type="button"
          role="option"
          aria-selected={true}
          onClick={close}
        >
          Item
        </button>
      )}
    </TdPopover>
  );
}

afterEach(() => {
  cleanup();
});

describe("TdPopover", () => {
  it("Escape closes the popover and does not reach a bubble-phase listener", () => {
    const bubbleListener = vi.fn();
    document.addEventListener("keydown", bubbleListener);
    try {
      render(<Harness initialOpen />);
      expect(screen.queryByRole("option")).not.toBeNull();

      // Fired on a descendant, not on `document` itself, so the capturing
      // traversal actually visits `document` (running the popover's
      // capture-phase listener and its `stopPropagation()`) before the
      // event would otherwise bubble back up to `document`'s own
      // bubble-phase listener.
      fireEvent.keyDown(document.body, { key: "Escape" });

      expect(screen.queryByRole("option")).toBeNull();
      expect(bubbleListener).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", bubbleListener);
    }
  });

  it("an outside mousedown closes it, an inside one does not", () => {
    render(<Harness initialOpen />);
    const menu = document.querySelector(".td-pop__menu");
    expect(menu).not.toBeNull();

    fireEvent.mouseDown(menu as Element);
    expect(document.querySelector(".td-pop__menu")).not.toBeNull();

    fireEvent.mouseDown(document.body);
    expect(document.querySelector(".td-pop__menu")).toBeNull();
  });

  it("closing returns focus to the trigger", () => {
    render(<Harness initialOpen />);
    const trigger = screen.getByRole("button", { name: "Trigger" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
  });

  it("the trigger carries aria-expanded", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Trigger" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });
});
