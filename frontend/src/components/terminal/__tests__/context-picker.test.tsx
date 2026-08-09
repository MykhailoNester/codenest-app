// The composer's "+ context" picker.
//
// It used to request `status: "in-progress"` alone, so a workspace whose work
// was all `todo` — the normal state before you start something — showed "No
// tasks" and there was no way to attach one. These tests pin which statuses are
// offered, the filter that makes a long backlog usable, and the two dismissals
// (outside click, Escape) it was missing.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentComposer } from "../agent-composer";
import { useComposerStore } from "../../../stores/composer-store";

const { useTasksMock, useLibraryItemsMock } = vi.hoisted(() => ({
  useTasksMock: vi.fn(),
  useLibraryItemsMock: vi.fn(),
}));

vi.mock("../../../lib/api", () => ({
  useTasks: (filters?: unknown) => useTasksMock(filters),
  useLibraryItems: () => useLibraryItemsMock(),
  // Not exercised by any test in this file — listed because a `vi.mock`
  // factory replaces the module wholesale, and once `agent-composer.tsx`
  // statically imports `composer-suggest.tsx` (the mention menu's data
  // probe) the mocked namespace is asked for these on any render path that
  // reaches them. Vitest's proxy throws on *access*, not on link, so this
  // suite would very likely pass without them too — they are added so its
  // correctness does not depend on which branches happen to render.
  useTeamMembers: () => ({ data: [] }),
  fetchLibraryItemBySlug: vi.fn(async () => null),
  fetchSidecar: vi.fn(async () => []),
}));

vi.mock("../../../lib/ipc", () => ({
  agentInterrupt: vi.fn(async () => undefined),
  agentSend: vi.fn(async () => undefined),
  agentSetModel: vi.fn(async () => undefined),
  agentSetPermissionMode: vi.fn(async () => undefined),
}));

interface TaskRow {
  id: number;
  title: string;
  status: string;
  description: string | null;
}

function task(id: number, title: string, status: string): TaskRow {
  return { id, title, status, description: null };
}

const LEAF = "leaf-1";

function renderComposer(): void {
  render(
    <AgentComposer
      leafId={LEAF}
      status="idle"
      providerId={null}
      model={null}
      permissionMode={null}
      onRequestRestart={() => undefined}
    />,
  );
}

/** Open the picker via its trigger, the way a user does. */
function openPicker(): void {
  fireEvent.click(screen.getByText("+ context"));
}

beforeEach(() => {
  useComposerStore.setState({ panes: {}, history: [] });
  useLibraryItemsMock.mockReturnValue({ data: { items: [] } });
  useTasksMock.mockReturnValue({
    data: [
      task(1, "Wire the exporter", "todo"),
      task(2, "Ship the migration", "in-progress"),
      task(3, "Old thing", "done"),
      task(4, "Blocked on review", "blocked"),
      task(5, "Someday idea", "backlog"),
    ],
  });
});

afterEach(() => {
  cleanup();
});

describe("ContextPicker", () => {
  it("asks for every task, not just the in-progress ones", () => {
    renderComposer();
    openPicker();

    // A status filter here is what hid a `todo`-only workspace's work.
    const filters = useTasksMock.mock.calls.at(-1)?.[0];
    expect(filters ?? {}).not.toHaveProperty("status");
  });

  it("offers open tasks of every status and hides done ones", () => {
    renderComposer();
    openPicker();

    expect(screen.getByText("Wire the exporter")).toBeTruthy();
    expect(screen.getByText("Ship the migration")).toBeTruthy();
    expect(screen.getByText("Blocked on review")).toBeTruthy();
    expect(screen.getByText("Someday idea")).toBeTruthy();
    // The list points the agent at work that remains.
    expect(screen.queryByText("Old thing")).toBeNull();
  });

  it("puts the most actionable status first", () => {
    renderComposer();
    openPicker();

    const titles = Array.from(
      document.querySelectorAll("[class*='pickerRowTitle']"),
    ).map((el) => el.textContent);
    expect(titles).toEqual([
      "Ship the migration", // in-progress
      "Blocked on review", // blocked
      "Wire the exporter", // todo
      "Someday idea", // backlog
    ]);
  });

  it("filters by title", () => {
    renderComposer();
    openPicker();

    fireEvent.change(screen.getByLabelText("Filter context"), {
      target: { value: "migration" },
    });

    expect(screen.getByText("Ship the migration")).toBeTruthy();
    expect(screen.queryByText("Wire the exporter")).toBeNull();
  });

  it("filters by ticket number, with or without the hash", () => {
    renderComposer();
    openPicker();
    const input = screen.getByLabelText("Filter context");

    fireEvent.change(input, { target: { value: "#4" } });
    expect(screen.getByText("Blocked on review")).toBeTruthy();
    expect(screen.queryByText("Ship the migration")).toBeNull();

    fireEvent.change(input, { target: { value: "1" } });
    expect(screen.getByText("Wire the exporter")).toBeTruthy();
  });

  it("says nothing matched rather than claiming there are no tasks", () => {
    renderComposer();
    openPicker();

    fireEvent.change(screen.getByLabelText("Filter context"), {
      target: { value: "zzzz" },
    });

    expect(screen.getByText("No matching tasks")).toBeTruthy();
    expect(screen.queryByText("No open tasks")).toBeNull();
  });

  it("closes on a click outside", () => {
    renderComposer();
    openPicker();
    expect(screen.getByLabelText("Filter context")).toBeTruthy();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByLabelText("Filter context")).toBeNull();
  });

  it("stays open while clicking inside itself", () => {
    // The dismissal must not fire for the search box, or typing would be
    // impossible.
    renderComposer();
    openPicker();

    fireEvent.mouseDown(screen.getByLabelText("Filter context"));

    expect(screen.getByLabelText("Filter context")).toBeTruthy();
  });

  it("closes on Escape", () => {
    renderComposer();
    openPicker();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByLabelText("Filter context")).toBeNull();
  });

  it("attaches the picked task as a context pill", () => {
    renderComposer();
    openPicker();

    fireEvent.click(screen.getByText("Ship the migration"));

    const pills = useComposerStore.getState().panes[LEAF]?.pills ?? [];
    expect(pills).toHaveLength(1);
    expect(pills[0]).toMatchObject({ kind: "task", taskId: 2 });
    // Picking is a completed choice — the panel closes behind it.
    expect(screen.queryByLabelText("Filter context")).toBeNull();
  });
});
