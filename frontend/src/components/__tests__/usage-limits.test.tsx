import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { UsageLimits } from "../budgets/usage-limits";
import type { UsageConsumption } from "../../lib/api";

const { mockUseUsageConsumption } = vi.hoisted(() => ({
  mockUseUsageConsumption: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  USAGE_WINDOWS: ["24h", "7d", "30d"],
  useUsageConsumption: () => mockUseUsageConsumption(),
  usePlanUsage: () => ({ data: undefined, isLoading: true }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function report(over: Partial<UsageConsumption> = {}): UsageConsumption {
  return {
    window: "7d",
    since: "2026-09-05T12:00:00",
    sessions: {
      total: 4,
      vendor_observed: 1,
      not_observed: 3,
      superseded: 1,
    },
    estimate: {
      lane: "A",
      observed: true,
      sessions: 3,
      cost_usd: 1.5,
      tokens_in: 1000,
      tokens_out: 200,
    },
    vendor: {
      lane: "B",
      observed: true,
      sessions: 1,
      cost_usd: 0.25,
      tokens_input: 900,
      tokens_output: 100,
      tokens_cache_read: null,
      tokens_cache_creation: null,
    },
    ...over,
  };
}

describe("usage & limits", () => {
  it("shows the estimate and the vendor figure as two separate cards", () => {
    mockUseUsageConsumption.mockReturnValue({
      data: report(),
      isPending: false,
      isError: false,
    });
    render(<UsageLimits />);

    expect(screen.getByText("$1.5000")).toBeTruthy();
    expect(screen.getByText("$0.2500")).toBeTruthy();
    expect(screen.getByText(/Flat-rate estimate/)).toBeTruthy();
    expect(screen.getByText(/Vendor-reported/)).toBeTruthy();
  });

  it("reads an unexported counter as not observed rather than zero", () => {
    mockUseUsageConsumption.mockReturnValue({
      data: report({
        sessions: {
          total: 4,
          vendor_observed: 0,
          not_observed: 4,
          superseded: 0,
        },
        vendor: {
          lane: "B",
          observed: false,
          sessions: 0,
          cost_usd: null,
          tokens_input: null,
          tokens_output: null,
          tokens_cache_read: null,
          tokens_cache_creation: null,
        },
      }),
      isPending: false,
      isError: false,
    });
    render(<UsageLimits />);

    expect(screen.getAllByText("not observed").length).toBeGreaterThan(0);
    expect(screen.queryByText("$0.0000")).toBeNull();
    expect(screen.getByText(/silence, not zero/)).toBeTruthy();
  });
});
