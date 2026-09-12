import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { BudgetsPage } from "../budgets";
import type { QuerySourceReport } from "../../lib/api";

const { mockUseQuerySourceSpend } = vi.hoisted(() => ({
  mockUseQuerySourceSpend: vi.fn(),
}));

const idle = { data: undefined, isPending: false, mutate: vi.fn() };

vi.mock("../../lib/api", () => ({
  useQuerySourceSpend: () => mockUseQuerySourceSpend(),
  useBudgetBurn: () => ({ data: [], isPending: false }),
  useProjects: () => ({ data: [] }),
  useCreateBudget: () => idle,
  useUpdateBudget: () => idle,
  useDeleteBudget: () => idle,
  USAGE_WINDOWS: ["24h", "7d", "30d"],
  useUsageConsumption: () => ({ data: undefined, isPending: true }),
  usePlanUsage: () => ({ data: undefined, isLoading: true }),
}));

vi.mock("../../components/layout/shell", () => ({
  Shell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function bucket(query_source: string | null, cost_usd: number) {
  return {
    query_source,
    sessions: 1,
    series: 1,
    cost_usd,
    tokens_input: 100,
    tokens_output: 10,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
  };
}

const report: QuerySourceReport = {
  lane: "B",
  sources: [bucket("something_the_cli_chose", 0.75), bucket(null, 0.25)],
  total_cost_usd: 1.0,
  attribution: {
    sessions: 1,
    lane_b_cost_usd: 1.0,
    attributed_cost_usd: 0.4,
    delta_usd: 0.6,
  },
};

describe("the budgets page query-source split", () => {
  it("renders whatever sources arrived, an unattributed bucket, and the attribution gap", () => {
    mockUseQuerySourceSpend.mockReturnValue({
      data: report,
      isPending: false,
      isError: false,
    });
    render(<BudgetsPage />);

    expect(screen.getByText("something_the_cli_chose")).toBeTruthy();
    expect(screen.getAllByText("unattributed").length).toBeGreaterThan(0);
    expect(screen.getByText(/difference of/)).toBeTruthy();
  });
});
