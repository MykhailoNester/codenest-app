import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChipPicker, MultiChipPicker } from "../chip-picker";
import type { ChipOption } from "../types";

/**
 * The picker's chrome is assertable for the first time: the old `tb-*` classes
 * lived in a plain stylesheet vitest never loaded. The two class assertions
 * that are not cosmetic are the `.deck` wrapper (without it every token
 * resolves to nothing) and the `.dk-modal` ancestor (the only opt-out from the
 * 900px row floor Deck puts on `.dk-line` below a 1100px viewport — without it
 * a 280px dropdown renders 900px-wide rows).
 */

const SIMPLE: readonly ChipOption[] = [
  { value: "todo", label: "To do", color: "#6fa3c4" },
  { value: "doing", label: "Doing" },
  { value: "done", label: "Done" },
];

const GROUPED: readonly ChipOption[] = [
  { value: "", label: "— Unassigned" },
  { value: "1", label: "Ada", group: "Humans" },
  { value: "2", label: "Bea", group: "Humans" },
  { value: "9", label: "Claudia", group: "Agents", hint: "does not start a session" },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function trigger(name: string): HTMLElement {
  return screen.getByLabelText(name);
}

function options(): HTMLElement[] {
  return screen.getAllByRole("option");
}

describe("ChipPicker trigger", () => {
  it("is a .dk-btn, bare until a value is set", () => {
    const { rerender } = render(
      <ChipPicker label="Status" value="" options={SIMPLE} onSelect={vi.fn()} />,
    );
    const empty = trigger("Status: Status");
    expect(empty.classList.contains("dk-btn")).toBe(true);
    expect(empty.classList.contains("bare")).toBe(true);

    rerender(
      <ChipPicker label="Status" value="todo" options={SIMPLE} onSelect={vi.fn()} />,
    );
    const set = trigger("Status: To do");
    expect(set.classList.contains("dk-btn")).toBe(true);
    expect(set.classList.contains("bare")).toBe(false);
  });

  it("shows the selected option's label, colour dot and a caret", () => {
    render(
      <ChipPicker label="Status" value="todo" options={SIMPLE} onSelect={vi.fn()} />,
    );
    const btn = trigger("Status: To do");
    expect(btn.textContent).toContain("To do");
    const dot = Array.from(btn.querySelectorAll("span")).find(
      (s) => s.style.borderRadius === "50%",
    );
    expect(dot?.style.background).toBe("rgb(111, 163, 196)");
    expect(btn.textContent).toContain("▾");
  });

  it("falls back to the picker's own name when nothing is selected", () => {
    render(<ChipPicker label="Effort" value="" options={SIMPLE} onSelect={vi.fn()} />);
    expect(trigger("Effort: Effort").textContent).toContain("Effort");
  });

  it("honours disabled and compact", () => {
    const { rerender } = render(
      <ChipPicker label="Status" value="" options={SIMPLE} onSelect={vi.fn()} disabled />,
    );
    expect((trigger("Status: Status") as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <ChipPicker label="Status" value="" options={SIMPLE} onSelect={vi.fn()} compact />,
    );
    // Deck's small end bottoms out at --fs-xs; compact is height, not a
    // sub-11px type size.
    expect(trigger("Status: Status").style.fontSize).toBe("var(--fs-xs)");
  });

  it("renderTrigger replaces the chip but keeps the picker's behaviour", () => {
    const onSelect = vi.fn();
    render(
      <ChipPicker
        label="Status"
        value="todo"
        options={SIMPLE}
        onSelect={onSelect}
        renderTrigger={({ open, resolvedLabel, onOpen }) => (
          <button type="button" aria-label={`custom ${resolvedLabel}`} aria-expanded={open} onClick={onOpen}>
            {resolvedLabel}
          </button>
        )}
      />,
    );
    const btn = trigger("custom To do");
    expect(btn.classList.contains("dk-btn")).toBe(false);
    fireEvent.click(btn);
    expect(options().length).toBe(3);
    fireEvent.click(screen.getByRole("option", { name: /Done/ }));
    expect(onSelect).toHaveBeenCalledWith("done");
  });

  it("toggles the panel open and shut", () => {
    render(<ChipPicker label="Status" value="" options={SIMPLE} onSelect={vi.fn()} />);
    const btn = trigger("Status: Status");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(btn);
    expect(screen.queryAllByRole("option").length).toBe(0);
  });
});

describe("ChipPicker option list", () => {
  it("rows are .dk-line inside a .dk-modal, which is the 900px floor opt-out", () => {
    render(<ChipPicker label="Status" value="todo" options={SIMPLE} onSelect={vi.fn()} />);
    fireEvent.click(trigger("Status: To do"));
    for (const opt of options()) {
      expect(opt.classList.contains("dk-line")).toBe(true);
      expect(opt.closest(".dk-modal")).not.toBeNull();
      expect(opt.closest(".deck")).not.toBeNull();
    }
  });

  it("the listbox sets its own column template and opts into wrapping rows", () => {
    render(<ChipPicker label="Status" value="" options={SIMPLE} onSelect={vi.fn()} />);
    fireEvent.click(trigger("Status: Status"));
    const list = screen.getByRole("listbox", { name: "Status" });
    expect(list.classList.contains("dk-list")).toBe(true);
    // Without `prose`, `.dk-line > *` truncates to one line and an option's
    // hint disappears behind an ellipsis.
    expect(list.classList.contains("prose")).toBe(true);
    expect(list.style.getPropertyValue("--cols")).toBe("10px minmax(0, 1fr) 12px");
  });

  it("marks the selected option with .on, aria-selected and a check", () => {
    render(<ChipPicker label="Status" value="todo" options={SIMPLE} onSelect={vi.fn()} />);
    fireEvent.click(trigger("Status: To do"));
    const [todo, doing, done] = options();
    expect(todo!.classList.contains("on")).toBe(true);
    expect(todo!.getAttribute("aria-selected")).toBe("true");
    expect(todo!.textContent).toContain("✓");
    expect(doing!.classList.contains("on")).toBe(false);
    expect(doing!.textContent).not.toContain("✓");
    expect(done!.getAttribute("aria-selected")).toBe("false");
  });

  it("the check is aria-hidden, so it never joins an option's name", () => {
    render(<ChipPicker label="Status" value="todo" options={SIMPLE} onSelect={vi.fn()} />);
    fireEvent.click(trigger("Status: To do"));
    screen.getByRole("option", { name: "To do" });
  });

  it("selecting calls back and closes", () => {
    const onSelect = vi.fn();
    render(<ChipPicker label="Status" value="" options={SIMPLE} onSelect={onSelect} />);
    fireEvent.click(trigger("Status: Status"));
    fireEvent.click(screen.getByRole("option", { name: /Done/ }));
    expect(onSelect).toHaveBeenCalledWith("done");
    expect(screen.queryAllByRole("option").length).toBe(0);
  });

  it("groups are labelled role=group, not bare divs hidden from assistive tech", () => {
    render(<ChipPicker label="Assignee" value="" options={GROUPED} onSelect={vi.fn()} searchable />);
    fireEvent.click(trigger("Assignee: — Unassigned"));
    const humans = screen.getByRole("group", { name: "Humans" });
    expect(within(humans).getAllByRole("option").map((o) => o.textContent)).toEqual(["Ada", "Bea"]);
    const agents = screen.getByRole("group", { name: "Agents" });
    expect(within(agents).getAllByRole("option").length).toBe(1);
    // The ungrouped option is a direct child of the listbox, not of a group.
    const unassigned = screen.getByRole("option", { name: /Unassigned/ });
    expect(unassigned.closest('[role="group"]')).toBeNull();
  });

  it("a hint renders as a dimmed second line, never on Deck's --fg-4", () => {
    render(<ChipPicker label="Assignee" value="" options={GROUPED} onSelect={vi.fn()} />);
    fireEvent.click(trigger("Assignee: — Unassigned"));
    const agent = screen.getByRole("option", { name: /Claudia/ });
    const hint = agent.querySelector(".dim");
    expect(hint?.textContent).toBe("does not start a session");
    expect(hint && (hint as HTMLElement).style.display).toBe("block");
  });

  it("shows the empty text when there is nothing to pick", () => {
    render(
      <ChipPicker label="Status" value="" options={[]} onSelect={vi.fn()} emptyText="Nothing here" />,
    );
    fireEvent.click(trigger("Status: Status"));
    expect(screen.getByText("Nothing here").classList.contains("dk-note")).toBe(true);
  });
});

describe("ChipPicker search", () => {
  it("has no search box unless asked for one", () => {
    render(<ChipPicker label="Status" value="" options={SIMPLE} onSelect={vi.fn()} />);
    fireEvent.click(trigger("Status: Status"));
    expect(screen.queryByPlaceholderText(/Search/)).toBeNull();
    // Without a search box the list itself takes the keyboard.
    expect(screen.getByRole("listbox", { name: "Status" }).tabIndex).toBe(0);
  });

  it("filters case-insensitively on the label", () => {
    render(<ChipPicker label="Assignee" value="" options={GROUPED} onSelect={vi.fn()} searchable />);
    fireEvent.click(trigger("Assignee: — Unassigned"));
    const box = screen.getByPlaceholderText("Search assignee…");
    expect(box.classList.contains("dk-ctl")).toBe(true);
    fireEvent.change(box, { target: { value: "AD" } });
    expect(options().map((o) => o.textContent)).toEqual(["Ada"]);
  });

  it("an empty filter result falls back to the empty text", () => {
    render(<ChipPicker label="Assignee" value="" options={GROUPED} onSelect={vi.fn()} searchable />);
    fireEvent.click(trigger("Assignee: — Unassigned"));
    fireEvent.change(screen.getByPlaceholderText("Search assignee…"), {
      target: { value: "zzz" },
    });
    expect(screen.queryAllByRole("option").length).toBe(0);
    screen.getByText("No options");
  });

  it("re-opening clears the previous query", () => {
    render(<ChipPicker label="Assignee" value="" options={GROUPED} onSelect={vi.fn()} searchable />);
    const btn = trigger("Assignee: — Unassigned");
    fireEvent.click(btn);
    fireEvent.change(screen.getByPlaceholderText("Search assignee…"), {
      target: { value: "Ada" },
    });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(options().length).toBe(4);
  });

  it("Arrow keys move the cursor and Enter picks the row it is on", () => {
    const onSelect = vi.fn();
    render(<ChipPicker label="Assignee" value="" options={GROUPED} onSelect={onSelect} searchable />);
    fireEvent.click(trigger("Assignee: — Unassigned"));
    const box = screen.getByPlaceholderText("Search assignee…");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("1");
  });

  it("the cursor is drawn apart from the selection, a tone below it", () => {
    render(<ChipPicker label="Assignee" value="9" options={GROUPED} onSelect={vi.fn()} searchable />);
    fireEvent.click(trigger("Assignee: Claudia"));
    fireEvent.keyDown(screen.getByPlaceholderText("Search assignee…"), { key: "ArrowDown" });
    const rows = options();
    expect(rows[1]!.style.background).toBe("var(--sel)");
    expect(rows[3]!.classList.contains("on")).toBe(true);
    expect(rows[3]!.style.background).toBe("");
  });

  it("the cursor stops at both ends of the list", () => {
    const onSelect = vi.fn();
    render(<ChipPicker label="Assignee" value="" options={GROUPED} onSelect={onSelect} searchable />);
    fireEvent.click(trigger("Assignee: — Unassigned"));
    const box = screen.getByPlaceholderText("Search assignee…");
    for (let i = 0; i < 8; i += 1) fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("9");
  });
});

describe("MultiChipPicker", () => {
  const LABELS = [
    { id: 1, label: "Bug", color: "#ef4444" },
    { id: 2, label: "Docs", color: null },
  ];

  it("counts the selection on its add trigger", () => {
    const { rerender } = render(
      <MultiChipPicker label="Labels" selected={[]} options={LABELS} onToggle={vi.fn()} />,
    );
    const add = trigger("Add labels");
    expect(add.textContent).toBe("+");
    expect(add.classList.contains("bare")).toBe(true);
    rerender(
      <MultiChipPicker label="Labels" selected={[1]} options={LABELS} onToggle={vi.fn()} />,
    );
    const one = trigger("Labels: 1 selected");
    expect(one.textContent).toBe("+1");
    expect(one.classList.contains("bare")).toBe(false);
  });

  it("toggles an option on without closing the panel", () => {
    const onToggle = vi.fn();
    render(<MultiChipPicker label="Labels" selected={[]} options={LABELS} onToggle={onToggle} />);
    fireEvent.click(trigger("Add labels"));
    fireEvent.click(screen.getByRole("option", { name: "Bug" }));
    expect(onToggle).toHaveBeenCalledWith(1, true);
    expect(screen.queryAllByRole("option").length).toBe(2);
  });

  it("toggles a selected option back off", () => {
    const onToggle = vi.fn();
    render(<MultiChipPicker label="Labels" selected={[2]} options={LABELS} onToggle={onToggle} />);
    fireEvent.click(trigger("Labels: 1 selected"));
    const docs = screen.getByRole("option", { name: "Docs" });
    expect(docs.getAttribute("aria-selected")).toBe("true");
    expect(docs.classList.contains("on")).toBe(true);
    fireEvent.click(docs);
    expect(onToggle).toHaveBeenCalledWith(2, false);
  });

  it("shares the picker's row shape, so both lists line up", () => {
    render(<MultiChipPicker label="Labels" selected={[1]} options={LABELS} onToggle={vi.fn()} />);
    fireEvent.click(trigger("Labels: 1 selected"));
    const list = screen.getByRole("listbox", { name: "Labels" });
    expect(list.style.getPropertyValue("--cols")).toBe("10px minmax(0, 1fr) 12px");
    expect(options()[0]!.closest(".dk-modal")).not.toBeNull();
  });

  it("shows the empty text when there are no labels to add", () => {
    render(
      <MultiChipPicker
        label="Labels"
        selected={[]}
        options={[]}
        onToggle={vi.fn()}
        emptyText="No labels yet"
      />,
    );
    fireEvent.click(trigger("Add labels"));
    screen.getByText("No labels yet");
  });
});
