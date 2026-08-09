import { describe, it, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WorkflowLabelsTab } from "../workflow-labels-tab";
import type { Taxonomy } from "../../../lib/api";

const { mockUseTaxonomies } = vi.hoisted(() => ({
  mockUseTaxonomies: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../lib/api", () => ({
  useTaxonomies: () => mockUseTaxonomies(),
  useUpdateTaxonomy: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useReorderTaxonomy: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useCreateTaxonomy: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useDeleteTaxonomy: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

function row(overrides: Partial<Taxonomy>): Taxonomy {
  return {
    id: 1,
    kind: "task_status",
    slug: "slug",
    display_name: "Display",
    sort_order: 10,
    color: "#6b7280",
    is_default: false,
    is_active: true,
    ...overrides,
  };
}

const ROWS: Taxonomy[] = [
  row({ id: 1, kind: "task_status", slug: "todo", display_name: "To do" }),
  row({ id: 2, kind: "task_priority", slug: "high", display_name: "High" }),
  row({
    id: 3,
    kind: "task_label",
    slug: "bug",
    display_name: "Bug",
    color: "#ef4444",
    sort_order: 10,
  }),
];

afterEach(() => {
  cleanup();
  mockUseTaxonomies.mockReset();
});

describe("WorkflowLabelsTab", () => {
  it("renders all three vocabulary groups", () => {
    mockUseTaxonomies.mockReturnValue({
      data: ROWS,
      isPending: false,
      isError: false,
      error: null,
    });

    render(<WorkflowLabelsTab />);

    // This project has no `@testing-library/jest-dom` — `getByText` etc.
    // already throw when nothing matches, so a plain call is the assertion,
    // matching every other test file here.
    screen.getByText("Task statuses");
    screen.getByText("Task priorities");
    screen.getByText("Task labels");
  });

  it("renders a task_label row with its slug and add affordance", () => {
    mockUseTaxonomies.mockReturnValue({
      data: ROWS,
      isPending: false,
      isError: false,
      error: null,
    });

    render(<WorkflowLabelsTab />);

    screen.getByDisplayValue("Bug");
    screen.getByText("bug");
    screen.getByPlaceholderText("Add label…");
  });

  it("shows the empty state instead of crashing when no task_label rows exist", () => {
    mockUseTaxonomies.mockReturnValue({
      data: ROWS.filter((r) => r.kind !== "task_label"),
      isPending: false,
      isError: false,
      error: null,
    });

    render(<WorkflowLabelsTab />);

    screen.getByText("Task labels");
    screen.getByText("None yet — add one below.");
  });
});
