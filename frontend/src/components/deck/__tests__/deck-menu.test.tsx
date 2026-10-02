import { describe, it, expect, vi, afterEach } from "vitest";
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DeckGrid, DeckLine } from "../deck-grid";
import { DeckMenu } from "../deck-menu";

afterEach(() => {
  cleanup();
});

/** A dialog that closes on Escape the way the launch composer does — a
 *  `document` listener, not a React handler. */
function EscapeCloser({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return null;
}

describe("DeckMenu inside an activatable DeckLine", () => {
  it("opening the menu with Enter does not also activate the row", () => {
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    render(
      <DeckGrid cols="14px 1fr auto" label="Rows">
        <DeckLine
          onOpen={onOpen}
          cells={[
            { v: "a schedule" },
            {
              v: (
                <DeckMenu
                  label="Actions for a schedule"
                  items={[{ label: "Delete", onSelect, danger: true }]}
                />
              ),
            },
          ]}
        />
      </DeckGrid>,
    );

    const trigger = screen.getByRole("button", {
      name: "Actions for a schedule",
    });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });

    // The row must not have navigated. Before the fix the keydown bubbled to
    // `DeckLine`, which called `onOpen` as well as opening the menu.
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("the same guard applies to Space", () => {
    const onOpen = vi.fn();
    render(
      <DeckGrid cols="14px 1fr auto" label="Rows">
        <DeckLine
          onOpen={onOpen}
          cells={[
            { v: "a schedule" },
            { v: <DeckMenu label="Actions" items={[{ label: "x", onSelect: () => {} }]} /> },
          ]}
        />
      </DeckGrid>,
    );
    const trigger = screen.getByRole("button", { name: "Actions" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: " " });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("an open menu consumes Escape so the dialog around it stays open", () => {
    const onClose = vi.fn();
    render(
      <>
        <EscapeCloser onClose={onClose} />
        <DeckMenu label="Actions" items={[{ label: "Delete", onSelect: () => {} }]} />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    // Menu closed, dialog untouched: one Escape, one dismissal.
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape reaches the dialog once no menu is open", () => {
    const onClose = vi.fn();
    render(
      <>
        <EscapeCloser onClose={onClose} />
        <DeckMenu label="Actions" items={[{ label: "Delete", onSelect: () => {} }]} />
      </>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
