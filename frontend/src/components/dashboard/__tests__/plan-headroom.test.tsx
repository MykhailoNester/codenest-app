/**
 * PlanHeadroom — the plan-usage panel, now mounted by Budgets
 * (`components/budgets/usage-limits.tsx`).
 *
 * These assertions are re-homed from the test file of the page that used to
 * mount this panel (#345). That page is deleted; the panel is not,
 * and the rules it was guarded by are about this component rather than about
 * that page:
 *
 *   * **The observed range comes from the payload.** The bounds move — 0–43 and
 *     0–36 one day, 0–64 and 0–46 the next — so a literal range written into
 *     the source is a panel that will quietly start lying. Asserted both ways:
 *     from what the panel renders for a payload whose bounds are deliberately
 *     not the design doc's, and by grepping the source for the doc's figures.
 *   * **A degraded read is explained, not drawn as an empty gauge.**
 *   * **No `backdrop-filter`.** `d3-creative.css` records that property driving
 *     the WebKit Graphics process to ~5 cores across four large panels. This is
 *     the last large panel left in `components/dashboard/`; the rule used to be
 *     stated over the whole directory, and it now has one file to state it
 *     over.
 */

// `node:fs` resolves at runtime (vitest runs on node) but not at type level:
// the app's tsconfig carries only `vite/client` types, and adding `node` to it
// so one test can read a file would put `process`, `Buffer` and friends in
// scope for every browser module in the app. The gap is named here instead.
// prettier-ignore
// @ts-expect-error -- node builtins are outside this project's type roots
import { readFileSync } from "node:fs";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PlanHeadroom } from "../plan-headroom";
import type { PlanUsagePayload } from "../../../lib/plan-usage";

const readFile = readFileSync as (path: string, encoding: "utf8") => string;

declare const process: { cwd(): string };

/**
 * `frontend/src`. Vitest's working directory is the vite root (`frontend`), and
 * `import.meta.url` is an `http://` URL under jsdom, so the cwd is the only
 * handle on the tree that resolves. The file is read rather than imported
 * because vitest does not process CSS: a `*.module.css` import comes back as an
 * empty class map, and the rule asserted below lives in one.
 */
function source(relative: string): string {
  return readFile(`${process.cwd()}/src/${relative}`, "utf8");
}

const { mockUsePlan } = vi.hoisted(() => ({ mockUsePlan: vi.fn() }));

vi.mock("../../../lib/api", () => ({
  usePlanUsage: () => mockUsePlan(),
}));

/**
 * A healthy payload whose bounds are deliberately NOT the ones the design doc
 * printed — if the panel ever hardcodes a range, this is what catches it.
 */
function planPayload(
  overrides: Partial<PlanUsagePayload> = {},
): PlanUsagePayload {
  return {
    available: true,
    supported: true,
    version: 1,
    reason: null,
    sample_count: 12,
    org_count: 1,
    first_sample_at: 1_757_000_000_000,
    last_sample_at: 1_757_000_900_000,
    max_gap_seconds: 900,
    series: [
      {
        key: "fh",
        label: "rolling short window",
        latest: 32,
        observed_min: 0,
        observed_max: 64,
      },
      {
        key: "sd",
        label: "rolling long window",
        latest: 11,
        observed_min: 2,
        observed_max: 46,
      },
    ],
    samples: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockUsePlan.mockReturnValue({ data: planPayload(), isLoading: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Plan headroom", () => {
  it("reads its range from the payload's observed bounds", () => {
    render(<PlanHeadroom />);
    expect(screen.getByText("observed 0–64")).toBeTruthy();
    expect(screen.getByText("observed 2–46")).toBeTruthy();
    // No unit, no percentage, no ceiling — just the reading.
    expect(screen.getByText("32")).toBeTruthy();
  });

  it("hardcodes no observed range in its source", () => {
    const panel = source("components/dashboard/plan-headroom.tsx");
    for (const stale of ["0–43", "0-43", "0–36", "0-36"]) {
      expect(panel).not.toContain(stale);
    }
  });

  it("explains a degraded read instead of drawing an empty gauge", () => {
    mockUsePlan.mockReturnValue({
      isLoading: false,
      data: planPayload({
        available: false,
        supported: true,
        reason: "missing",
        series: [],
      }),
    });
    render(<PlanHeadroom />);
    expect(
      screen.getByText("No plan-usage history on this machine."),
    ).toBeTruthy();
    expect(screen.queryByText(/^observed /)).toBeNull();
  });

  it("declares no backdrop-filter", () => {
    const declarations = source("components/dashboard/plan-headroom.module.css")
      .split("\n")
      .map((line) => line.trim())
      // A comment explaining the ban is not the ban being broken.
      .filter((line) => /^(-webkit-)?backdrop-filter:/.test(line));
    expect(declarations, declarations.join("\n")).toHaveLength(0);
  });
});
