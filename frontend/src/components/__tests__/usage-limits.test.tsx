import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
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

  it("marks an unobserved lane on the figure itself, not only on its frame", () => {
    // #283: the "no data" lane used to be a dashed card border. Deck has no
    // card, so the distinction moved onto `.dk-big .v.na` — the figure's own
    // ink. A border style is lost at a glance and in a screenshot; this is not.
    mockUseUsageConsumption.mockReturnValue({
      data: report({
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
    const { container } = render(<UsageLimits />);

    const figures = Array.from(container.querySelectorAll(".dk-big .v"));
    expect(figures).toHaveLength(2);
    // The observed lane keeps full ink; the unobserved one is dimmed.
    expect(figures[0]?.classList.contains("na")).toBe(false);
    expect(figures[1]?.classList.contains("na")).toBe(true);
  });

  it("switches the window and says which one is current", () => {
    mockUseUsageConsumption.mockReturnValue({
      data: report(),
      isPending: false,
      isError: false,
    });
    render(<UsageLimits />);

    expect(screen.getByText(/last 7 days/)).toBeTruthy();
    const month = screen.getByRole("button", { name: "30d" });
    // `.dk-seg`'s active segment inverts, which is visual only — `aria-pressed`
    // is what makes the current window readable without seeing it.
    expect(month.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen.getByRole("button", { name: "7d" }).getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(month);

    expect(screen.getByText(/last 30 days/)).toBeTruthy();
    expect(month.getAttribute("aria-pressed")).toBe("true");
  });

  it("distinguishes a failed read from a read still in flight", () => {
    mockUseUsageConsumption.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: new Error("sidecar unreachable"),
    });
    render(<UsageLimits />);
    expect(
      screen.getByText(/Could not read consumption: sidecar unreachable/),
    ).toBeTruthy();

    cleanup();
    mockUseUsageConsumption.mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
    });
    render(<UsageLimits />);
    expect(screen.getByText("Reading…")).toBeTruthy();
  });
});
