import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ActivityEntry } from "../../../lib/api";
import { ActivityCard } from "../activity-card";

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 1,
    entity_type: "task",
    entity_id: 1,
    action: "created",
    old_value: null,
    new_value: null,
    actor: "system",
    created_at: "2026-08-08 00:00:00",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("ActivityCard", () => {
  it("renders one row per entry, actor bold", () => {
    const entries = [
      entry({ id: 1, actor: "Ada" }),
      entry({ id: 2, actor: "Bob" }),
      entry({ id: 3, actor: "Cy" }),
    ];
    const { container } = render(
      <ActivityCard
        entries={entries}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        statusLabels={{}}
      />,
    );
    const items = container.querySelectorAll(".td-feed li");
    expect(items.length).toBe(3);
    for (const li of items) {
      expect(li.querySelector("b")).not.toBeNull();
    }
  });

  it("empty state is the literal copy", () => {
    const { container } = render(
      <ActivityCard
        entries={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        statusLabels={{}}
      />,
    );
    screen.getByText("No activity recorded yet.");
    expect(container.querySelector(".td-feed")).toBeNull();
  });

  it("a null actor never invents a name", () => {
    const { container } = render(
      <ActivityCard
        entries={[entry({ actor: null })]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        statusLabels={{}}
      />,
    );
    expect(screen.getByText("Someone")).not.toBeNull();
    expect(container.textContent).not.toMatch(/Ada|Bob|Cy|system/);
  });

  it("an unmapped action renders raw", () => {
    render(
      <ActivityCard
        entries={[entry({ action: "frobnicated" })]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        statusLabels={{}}
      />,
    );
    screen.getByText("frobnicated", { exact: false });
  });

  it("the tab strip renders only the tabs that exist", () => {
    render(
      <ActivityCard
        entries={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        statusLabels={{}}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBe(1);
    const [tab] = tabs;
    expect(tab?.textContent).toBe("Activity");
    expect(tab?.getAttribute("aria-selected")).toBe("true");
  });

  it("error state offers a retry", () => {
    const onRetry = vi.fn();
    render(
      <ActivityCard
        entries={[]}
        isLoading={false}
        isError={true}
        onRetry={onRetry}
        statusLabels={{}}
      />,
    );
    screen.getByText("Could not load activity.");
    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("loading state resolves to text, not an indefinite spinner", () => {
    render(
      <ActivityCard
        entries={[]}
        isLoading={true}
        isError={false}
        onRetry={vi.fn()}
        statusLabels={{}}
      />,
    );
    screen.getByText("Loading activity…");
  });
});
