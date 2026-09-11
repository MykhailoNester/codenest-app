/**
 * Mission Control — surface S1 at `/` (epic #153 / #166).
 *
 * The page is mostly composition, so these tests pin the things composition
 * cannot be trusted to preserve — the claims the page makes and the constraints
 * §2 of the design records:
 *
 *   * **A lane that does not exist renders an em dash, never 0.** This is the
 *     whole of the P1/P2/P3 discipline, and it is one careless `?? 0` away from
 *     being lost. A `0` beside "Tool failures" asserts that the app looked and
 *     found none; it has no OTLP receiver with which to look.
 *   * **The KPI tile box has exactly one definition.** Asserted the way the
 *     ticket asks — by grepping `frontend/src` for the tile's 96px height rule,
 *     which is the proxy for "nobody copied the tile CSS again".
 *   * **No `backdrop-filter` on a full-size panel.** d3-creative.css records
 *     that property driving the WebKit Graphics process to ~5 cores across four
 *     large panels; this page mounts four large panels. The 96px KPI tile is
 *     the one exemption §2 grants.
 *   * **Plan headroom's range comes from the payload.** The observed bounds
 *     move (0–43 and 0–36 one day, 0–64 and 0–46 the next), so a literal range
 *     in the source is a panel that will quietly start lying.
 *   * **The five reused overview components are still mounted.** The ticket's
 *     instruction was to reuse them, and a regression here looks like a working
 *     page with half its content silently gone.
 */

// `node:fs` resolves at runtime (vitest runs on node) but not at type level:
// the app's tsconfig carries only `vite/client` types, and adding `node` to it
// so one test can read files would put `process`, `Buffer` and friends in scope
// for every browser module in the app. The gap is named here instead, and the
// two functions used are given their real shapes just below, so nothing
// downstream of this import is untyped.
// prettier-ignore
// @ts-expect-error -- node builtins are outside this project's type roots
import { readdirSync, readFileSync } from "node:fs";

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { MissionControlPage } from "../mission-control";
import type { AttentionQueue } from "../../lib/api";
import type { PlanUsagePayload } from "../../lib/plan-usage";

interface DirEntry {
  name: string;
  isDirectory(): boolean;
}

const readdir = readdirSync as (
  dir: string,
  options: { withFileTypes: true },
) => DirEntry[];
const readFile = readFileSync as (path: string, encoding: "utf8") => string;

declare const process: { cwd(): string };

/**
 * `frontend/src`. Vitest's working directory is the vite root (`frontend`),
 * and `import.meta.url` is an `http://` URL under the jsdom environment, so the
 * cwd is the only handle on the tree that actually resolves.
 *
 * These tests read the source rather than `import.meta.glob` it, because vitest
 * does not process CSS: a `*.module.css` glob comes back as an empty class map,
 * and every rule asserted below lives in a CSS module.
 */
const SRC_DIR = `${process.cwd()}/src`;

/** Every file under `frontend/src`, so a rule about the source can be counted. */
function walk(dir: string): string[] {
  return readdir(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(full) : [full];
  });
}

interface Hit {
  where: string;
  text: string;
}

/** `grep -rn <needle> frontend/src` — one entry per matching line. */
function grepSrc(needle: string): Hit[] {
  return walk(SRC_DIR).flatMap((file) =>
    readFile(file, "utf8")
      .split("\n")
      .flatMap((line, i) =>
        line.includes(needle)
          ? [
              {
                where: `${file.slice(SRC_DIR.length)}:${i + 1}`,
                text: line.trim(),
              },
            ]
          : [],
      ),
  );
}

/** `path:line: text` lines, for an assertion message worth reading. */
function report(hits: Hit[]): string {
  return hits.map((h) => `${h.where}: ${h.text}`).join("\n");
}

/** One file's text, by its path under `src`. */
function source(relative: string): string {
  return readFile(`${SRC_DIR}/${relative}`, "utf8");
}

/**
 * The needles are assembled rather than written out, because this file lives
 * under `frontend/src` and `grepSrc` reads it too, so spelling the tile's
 * height rule out here would make this test its own second match and the
 * criterion unsatisfiable. Prose elsewhere in the tree has the same hazard,
 * which is why the comments around the tile say "96px floor" instead.
 */
const TILE_HEIGHT_RULE = ["min-height", "96"].join(": ");
const RETIRED_MODULE = ["overview", "page"].join("-");
const RETIRED_COMPONENT = ["Overview", "Page"].join("");

const { mockUseAttention, mockUseDailySpend, mockUseDashboard, mockUsePlan } =
  vi.hoisted(() => ({
    mockUseAttention: vi.fn(),
    mockUseDailySpend: vi.fn(),
    mockUseDashboard: vi.fn(),
    mockUsePlan: vi.fn(),
  }));

vi.mock("../../lib/api", () => ({
  useAttention: () => mockUseAttention(),
  useDailySpend: () => mockUseDailySpend(),
  useDashboard: () => mockUseDashboard(),
  usePlanUsage: () => mockUsePlan(),
}));

vi.mock("../../components/layout/shell", () => ({
  Shell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// The five reused components are stubbed by name rather than rendered: what
// this file is asserting is that the page still *mounts* each of them, and
// their own data plumbing (SSE, trends) has nothing to do with S1's claims.
vi.mock("../../components/dashboard/overview/activity-pulse", () => ({
  ActivityPulse: () => <div data-testid="activity-pulse" />,
}));
vi.mock("../../components/dashboard/overview/kpi-stack", () => ({
  KpiStack: () => <div data-testid="kpi-stack" />,
}));
vi.mock("../../components/dashboard/overview/active-sessions", () => ({
  ActiveSessions: () => <div data-testid="active-sessions" />,
}));
vi.mock("../../components/dashboard/overview/projects-pulse", () => ({
  ProjectsPulse: () => <div data-testid="projects-pulse" />,
}));
vi.mock("../../components/dashboard/overview/momentum-timeline", () => ({
  MomentumTimeline: () => <div data-testid="momentum-timeline" />,
}));

function emptyQueue(): AttentionQueue {
  return {
    items: [],
    counts: {
      blocking: 0,
      stalled: 0,
      queued: 0,
      open: 0,
      muted: 0,
      resolved_today: 0,
      resolved_today_avg_seconds: null,
    },
  };
}

/**
 * A healthy plan-usage payload whose bounds are deliberately NOT the ones the
 * design doc printed — if the panel ever hardcodes a range, this is what
 * catches it.
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

function renderPage(): void {
  render(
    <MemoryRouter>
      <MissionControlPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockUseAttention.mockReturnValue({ data: emptyQueue(), isLoading: false });
  mockUseDailySpend.mockReturnValue({
    data: { tokens_in: 100, tokens_out: 50, cost_usd: 7.42 },
  });
  mockUseDashboard.mockReturnValue({
    data: {
      task_counts: {
        backlog: 29,
        todo: 13,
        "in-progress": 2,
        blocked: 0,
        done: 40,
      },
    },
  });
  mockUsePlan.mockReturnValue({ data: planPayload(), isLoading: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Mission Control — P1 only, dashes for the rest", () => {
  it("renders an em dash, never 0, for every tile whose lane is unbuilt", () => {
    renderPage();

    for (const label of ["Tool failures", "Vendor cost", "Agent todo lists"]) {
      const tile = screen.getByText(label).closest("div")?.parentElement;
      expect(tile, `${label} tile is missing`).toBeTruthy();
      expect(tile?.textContent).toContain("—");
      // The point of the dash: the tile must not put a number — above all not
      // a zero — where the measurement would go. The phase tag is the one
      // numeral allowed on these tiles, and it is not a reading.
      const withoutPhaseTag = (tile?.textContent ?? "").replace(/P[23]/g, "");
      expect(withoutPhaseTag).not.toMatch(/\d/);
    }
  });

  it("tags the unbuilt tiles with the phase that will build them", () => {
    renderPage();
    expect(screen.getAllByText("P3")).toHaveLength(2); // tool failures, vendor cost
    expect(screen.getByText("P2")).toBeTruthy(); // agent todo lists
  });

  it("shows real P1 figures: estimated spend and the board counts", () => {
    renderPage();
    expect(screen.getByText("$7.42")).toBeTruthy();
    // §2's honesty rule: an estimate is chipped as one until the cost lane
    // makes it authoritative.
    expect(screen.getByText("est")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy(); // 13 todo + 29 backlog
  });

  it("mounts the five reused overview components rather than new ones", () => {
    renderPage();
    for (const id of [
      "activity-pulse",
      "kpi-stack",
      "active-sessions",
      "projects-pulse",
      "momentum-timeline",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });
});

describe("Needs You panel", () => {
  it("names the 30-second re-check and the P2 hook lane when empty", () => {
    renderPage();
    expect(
      screen.getByText(/re-checks every 30 seconds/i, { exact: false }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /blocking permission prompts arrive with the hooks lane/i,
      ),
    ).toBeTruthy();
  });

  it("previews at most four items and reports the longest wait", () => {
    const now = Date.now();
    const iso = (msAgo: number): string =>
      new Date(now - msAgo).toISOString().replace("T", " ").replace("Z", "");
    mockUseAttention.mockReturnValue({
      isLoading: false,
      data: {
        ...emptyQueue(),
        counts: { ...emptyQueue().counts, open: 6 },
        // Severity-grouped, oldest-first *within* a group — so the oldest item
        // overall sits in the middle of the list, not at either end.
        items: [1, 2, 3, 4, 5, 6].map((n) => ({
          ...baseItem,
          id: n,
          title: `Item ${n}`,
          first_seen_at: iso(n === 3 ? 3 * 3600_000 : 60_000 * n),
        })),
      },
    });
    renderPage();

    expect(screen.getByText("Item 4")).toBeTruthy();
    expect(screen.queryByText("Item 5")).toBeNull();
    expect(screen.getByText(/6 open · oldest 3h ago/)).toBeTruthy();
  });
});

describe("Plan headroom", () => {
  it("reads its range from the payload's observed bounds", () => {
    renderPage();
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
    renderPage();
    expect(
      screen.getByText("No plan-usage history on this machine."),
    ).toBeTruthy();
    expect(screen.queryByText(/^observed /)).toBeNull();
  });
});

describe("design constraints from §2", () => {
  it("defines the KPI tile height exactly once in frontend/src", () => {
    const hits = grepSrc(TILE_HEIGHT_RULE);
    expect(hits, report(hits)).toHaveLength(1);
    expect(hits[0]?.where).toContain("kpi-tile.module.css");
  });

  it("uses the app's real page and topbar padding, not the doc's 24", () => {
    // The design doc prints both as 24px horizontally. The app has always used
    // 28, and the code is what ships.
    expect(source("pages/mission-control.module.css")).toContain(
      "padding: 20px 28px 28px;",
    );
    expect(source("styles/d3-creative.css")).toContain(
      "padding: 18px 28px 10px;",
    );
  });

  it("keeps backdrop-filter off every full-size panel", () => {
    const declarations = grepSrc("backdrop-filter:").filter(
      // A comment explaining the ban is not the ban being broken.
      (hit) => /^(-webkit-)?backdrop-filter:/.test(hit.text),
    );
    const onThisPage = declarations.filter(
      (hit) =>
        hit.where.includes("/dashboard/") ||
        hit.where.includes("mission-control"),
    );
    expect(onThisPage, report(onThisPage)).toHaveLength(1);
    expect(onThisPage[0]?.where).toContain("kpi-tile.module.css");
  });

  it("leaves no trace of the overview page it replaced", () => {
    expect(report(grepSrc(RETIRED_MODULE))).toBe("");
    expect(report(grepSrc(RETIRED_COMPONENT))).toBe("");
  });
});

/** A minimal open queue row; only the fields the preview panel reads matter. */
const baseItem = {
  id: 1,
  kind: "session_stalled",
  severity: "stalled",
  state: "open",
  dedup_key: "session_stalled:s1",
  seen_count: 1,
  title: "Session idle 42m with unfinished work",
  detail: "3 uncommitted files",
  session_id: "s1",
  project_id: 2,
  task_id: null,
  schedule_id: null,
  payload_json: null,
  first_seen_at: "2026-09-10 11:00:00",
  last_seen_at: "2026-09-10 12:00:00",
  resolved_at: null,
  resolution: null,
  muted_until: null,
  pane_id: null,
  session_status: "active",
  project_name: "codenest-app",
};
