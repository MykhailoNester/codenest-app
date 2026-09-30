import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DeckGrid, DeckHead, DeckLine, DECK_COLS } from "../deck-grid";

afterEach(cleanup);

function Board({ onOpen }: { onOpen?: () => void } = {}) {
  return (
    <DeckGrid cols={DECK_COLS.simple} label="needs you">
      <DeckHead cells={["what", "r age"]} />
      <DeckLine state="block" cells={["permission prompt", "2h"]} onOpen={onOpen} />
      <DeckLine state="stall" cells={["idle session", "23m"]} onOpen={onOpen} />
      <DeckLine state="wait" cells={["ready to promote", "12m"]} onOpen={onOpen} />
    </DeckGrid>
  );
}

const rows = () => screen.getAllByRole("row").filter((r) => r.classList.contains("dk-line"));

describe("DeckGrid", () => {
  it("exposes the list as a grid with named columns", () => {
    render(<Board />);
    expect(screen.getByRole("grid").getAttribute("aria-label")).toBe("needs you");
    expect(screen.getAllByRole("columnheader")).toHaveLength(3); // state + 2
    expect(screen.getAllByRole("gridcell")).toHaveLength(9); // 3 rows x (state + 2)
  });

  it("labels each state so it is not colour or a pseudo-element alone", () => {
    render(<Board />);
    for (const word of ["blocking", "stalled", "waiting"]) {
      expect(screen.getByLabelText(word)).toBeTruthy();
    }
  });

  it("keeps exactly one tab stop and moves focus with the arrows", () => {
    render(<Board />);
    const r = rows();
    expect(r.filter((x) => x.tabIndex === 0)).toHaveLength(1);

    r[0]!.focus();
    const grid = screen.getByRole("grid");

    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(document.activeElement).toBe(r[1]);
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(document.activeElement).toBe(r[2]);
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(document.activeElement).toBe(r[2]); // holds at the end

    fireEvent.keyDown(grid, { key: "Home" });
    expect(document.activeElement).toBe(r[0]);
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    expect(document.activeElement).toBe(r[0]); // holds at the top
    fireEvent.keyDown(grid, { key: "End" });
    expect(document.activeElement).toBe(r[2]);

    expect(rows().filter((x) => x.tabIndex === 0)).toHaveLength(1);
  });

  it("activates a row on click, Enter and Space", () => {
    const onOpen = vi.fn();
    render(<Board onOpen={onOpen} />);
    const r = rows();

    fireEvent.click(r[0]!);
    fireEvent.keyDown(r[1]!, { key: "Enter" });
    fireEvent.keyDown(r[2]!, { key: " " });
    expect(onOpen).toHaveBeenCalledTimes(3);
  });
});
