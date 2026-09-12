/**
 * Hooks page (#171).
 *
 * The page's whole worth is in what it claims about the user's machine, so
 * these pin the claims rather than the layout. Each one corresponds to a way
 * the page could quietly say something untrue:
 *
 *   * **Hooks merge and all of them run.** The page may never suggest that one
 *     source stands in for another. The last block here greps this page's own
 *     source for the vocabulary of scalar settings resolution, the same guard
 *     `tests/sidecar/test_effective_hooks.py` holds the sidecar modules to.
 *   * **Eight sources on every event, empty ones included.** A bucket that
 *     disappeared when empty would make an event look as if fewer things could
 *     reach it than can.
 *   * **`--settings` is unknown, never zero.** It arrives with `count: 0`
 *     because the field is an integer; printing that 0 asserts something the
 *     report explicitly says it cannot know.
 *   * **No duration anywhere.** `timeout_seconds` is a declared ceiling and
 *     must be labelled as configured; no ms figure, percentile or elapsed time
 *     may appear at all.
 *   * **A third-party command is never reconstructed.** The sidecar hands back
 *     a bare executable name on purpose — a hook command can carry a token in
 *     its argv.
 *   * **The install writes only after a plan and an explicit confirm.**
 *   * **The stale `PreToolUse` install is surfaced.** It is the one thing this
 *     page knows that no other layer can tell the user: verify grades that file
 *     green while every permission decision is thrown away.
 */

// `node:fs` resolves at runtime (vitest runs on node) but not at type level —
// see `mission-control.test.tsx`, which names the same gap for the same reason.
// prettier-ignore
// @ts-expect-error -- node builtins are outside this project's type roots
import { readFileSync } from "node:fs";

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { HooksPage } from "../hooks";
import type {
  EffectiveHookContribution,
  EffectiveHookEvent,
  EffectiveHooksReport,
  HookInstallEventPlan,
  HookInstallReport,
} from "../../lib/api";

const readFile = readFileSync as (path: string, encoding: "utf8") => string;
declare const process: { cwd(): string };
const SRC_DIR = `${process.cwd()}/src`;

const {
  mockUseEffectiveHooks,
  mockUseHookInstallPlan,
  mockInstallMutate,
  mockUseProjects,
  mockUseProviders,
} = vi.hoisted(() => ({
  mockUseEffectiveHooks: vi.fn(),
  mockUseHookInstallPlan: vi.fn(),
  mockInstallMutate: vi.fn(),
  mockUseProjects: vi.fn(),
  mockUseProviders: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  useEffectiveHooks: (...a: unknown[]) => mockUseEffectiveHooks(...a),
  useHookInstallPlan: (...a: unknown[]) => mockUseHookInstallPlan(...a),
  useInstallHooks: () => ({
    mutate: mockInstallMutate,
    isPending: false,
    data: undefined,
  }),
  useProjects: () => mockUseProjects(),
  useProviders: () => mockUseProviders(),
}));

vi.mock("../../components/layout/shell", () => ({
  Shell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// ─── fixtures ────────────────────────────────────────────────────────────────

/** The eight contributor sources, in the order the sidecar emits them. */
const SOURCES = [
  {
    slug: "user",
    label: "User settings",
    where: "<config home>/settings.json",
  },
  {
    slug: "project",
    label: "Project settings",
    where: "<repo>/.claude/settings.json",
  },
  {
    slug: "project_local",
    label: "Project-local settings",
    where: "<repo>/.claude/settings.local.json",
  },
  {
    slug: "settings_flag",
    label: "--settings flag",
    where: "a file named on the command line",
  },
  {
    slug: "managed_policy",
    label: "Managed policy settings",
    where: "the OS-level managed settings file",
  },
  { slug: "plugin", label: "Plugin hooks", where: "<plugin>/hooks/hooks.json" },
  {
    slug: "skill",
    label: "Skill frontmatter",
    where: "<skill>/SKILL.md frontmatter",
  },
  {
    slug: "agent",
    label: "Agent definition",
    where: "<agents dir>/<agent>.md frontmatter",
  },
] as const;

const OURS: EffectiveHookContribution = {
  event: "PreToolUse",
  source: "user",
  origin: "/Users/x/.claude/settings.json",
  matcher: "*",
  hook_type: "command",
  executable: "curl",
  command:
    "curl -s --fail --max-time 5 -X POST http://localhost:8002/api/v1/hooks/pre-tool",
  redacted: false,
  codenest_authored: true,
  timeout_seconds: 6,
};

const THEIRS: EffectiveHookContribution = {
  event: "PreToolUse",
  source: "plugin",
  origin: "/Users/x/.claude/plugins/guard/hooks/hooks.json",
  matcher: "Bash",
  hook_type: "command",
  executable: "guard.sh",
  command: null,
  redacted: true,
  codenest_authored: false,
  timeout_seconds: 30,
};

function event(
  name: string,
  contributions: EffectiveHookContribution[] = [],
): EffectiveHookEvent {
  const by_source = SOURCES.map((s) => {
    const rows = contributions.filter((c) => c.source === s.slug);
    return {
      source: s.slug,
      label: s.label,
      observable: s.slug !== "settings_flag",
      count: rows.length,
      contributions: rows,
    };
  });
  return {
    event: name,
    tier: name === "PreToolUse" ? "core" : "extended",
    ingest_path: `/api/v1/hooks/${name.toLowerCase()}`,
    total: by_source.reduce((sum, b) => sum + b.count, 0),
    by_source,
  };
}

function report(
  events: EffectiveHookEvent[] = [event("PreToolUse", [OURS, THEIRS])],
): EffectiveHooksReport {
  return {
    base_url: "http://localhost:8002",
    sources: SOURCES.map((s) => ({
      slug: s.slug,
      label: s.label,
      where: s.where,
      observable: s.slug !== "settings_flag",
      note: `note for ${s.slug}`,
    })),
    scanned: [
      {
        source: "user",
        path: "/Users/x/.claude/settings.json",
        status: "ok",
        detail: null,
      },
      {
        source: "project",
        path: "/repo/.claude/settings.json",
        status: "missing_file",
        detail: null,
      },
    ],
    events,
  };
}

function planEvent(
  name: string,
  overrides: Partial<HookInstallEventPlan> = {},
): HookInstallEventPlan {
  return {
    event: name,
    action: "ok",
    repaired: 0,
    left_narrow: 0,
    left_foreign: 0,
    left_malformed: 0,
    detail: null,
    ...overrides,
  };
}

function plan(events: HookInstallEventPlan[]): HookInstallReport {
  const changes = events.some(
    (e) => e.action === "add" || e.action === "repair",
  );
  return {
    base_url: "http://localhost:8002",
    dry_run: true,
    overall: changes ? "planned" : "unchanged",
    results: [
      {
        config_home: "",
        settings_path: "/Users/x/.claude/settings.json",
        status: changes ? "planned" : "unchanged",
        refusal: null,
        changed: false,
        created_file: false,
        backup_path: null,
        events,
      },
    ],
  };
}

function renderPage(
  data: EffectiveHooksReport = report(),
  planData: HookInstallReport = plan([planEvent("PreToolUse")]),
): void {
  mockUseProviders.mockReturnValue({ data: [] });
  mockUseProjects.mockReturnValue({ data: [] });
  mockUseEffectiveHooks.mockReturnValue({
    data,
    isPending: false,
    isError: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  });
  mockUseHookInstallPlan.mockReturnValue({
    data: planData,
    refetch: vi.fn(),
  });
  render(<HooksPage />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ─── the eight sources ───────────────────────────────────────────────────────

describe("Hooks page — the eight contributors", () => {
  it("renders all eight buckets on an event, empty ones included", () => {
    renderPage();
    fireEvent.click(screen.getByText("PreToolUse"));
    for (const s of SOURCES) {
      expect(screen.getAllByText(s.label).length).toBeGreaterThan(0);
    }
  });

  it("lists all eight sources in the legend", () => {
    renderPage();
    expect(screen.getByText(/The 8 places a hook can come from/)).toBeTruthy();
    // …and the header makes the same claim in prose, so the count is never
    // something the reader has to infer from how many cards happen to render.
    expect(
      screen.getByText(/There are 8 places a hook can come from/),
    ).toBeTruthy();
  });
});

// ─── the unobservable source ─────────────────────────────────────────────────

describe("Hooks page — the --settings flag", () => {
  it("renders its contribution as unknown, never as a number", () => {
    renderPage();
    fireEvent.click(screen.getByText("PreToolUse"));

    // The bucket for `--settings` must carry the word, not a count.
    const flag = screen.getByText("--settings flag").parentElement;
    expect(flag?.textContent).toContain("unknown");
    expect(flag?.textContent).not.toMatch(/\b0\b/);
  });

  it("marks the event total as a floor rather than a complete count", () => {
    renderPage();
    expect(screen.getByText(/2 hooks \+ unknown/)).toBeTruthy();
  });

  it("says so in the legend too", () => {
    renderPage();
    expect(
      screen.getByText(/--settings flag — contribution unknown/),
    ).toBeTruthy();
  });
});

// ─── no latency, anywhere ────────────────────────────────────────────────────

describe("Hooks page — timing", () => {
  it("labels a timeout as configured and shows no elapsed time", () => {
    renderPage();
    fireEvent.click(screen.getByText("PreToolUse"));
    expect(screen.getAllByText("configured timeout 6s").length).toBe(1);
    expect(document.body.textContent).not.toMatch(/\bms\b/);
    expect(document.body.textContent).not.toMatch(
      /latency|percentile|p95|elapsed/i,
    );
  });

  it("never renders a duration in the page source", () => {
    // Belt and braces: a future edit could introduce one from a field that does
    // not exist today. The words are what would have to appear.
    const src = readFile(`${SRC_DIR}/pages/hooks.tsx`, "utf8");
    expect(src).not.toMatch(/duration_ms|elapsed_ms|latency|percentile/i);
  });
});

// ─── redaction ───────────────────────────────────────────────────────────────

describe("Hooks page — somebody else's hook", () => {
  it("shows the executable name and never a reconstructed command", () => {
    renderPage();
    fireEvent.click(screen.getByText("PreToolUse"));
    expect(screen.getByText("guard.sh")).toBeTruthy();
    expect(document.body.textContent).not.toContain("--token");
  });

  it("states the rule rather than apologising for missing data", () => {
    renderPage();
    fireEvent.click(screen.getByText("PreToolUse"));
    expect(
      screen.getByText(
        /does not print the arguments of a command it did not write/,
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /unavailable|missing command|could not read the command/i,
    );
  });
});

// ─── the stale install ───────────────────────────────────────────────────────

describe("Hooks page — a PreToolUse install from before #172", () => {
  const stale = plan([
    planEvent("PreToolUse", {
      action: "repair",
      repaired: 1,
      detail: "ours, in a shape we no longer emit",
    }),
  ]);

  it("says the permission decisions are being thrown away", () => {
    renderPage(report(), stale);
    expect(
      screen.getByText(/permission decisions are being thrown away/i),
    ).toBeTruthy();
  });

  it("explains why nothing else reports it", () => {
    renderPage(report(), stale);
    expect(screen.getByText(/a verify pass\s+grades it fine/i)).toBeTruthy();
  });

  it("shows no such banner when every hook is current", () => {
    renderPage();
    expect(screen.queryByText(/thrown away/i)).toBeNull();
  });
});

// ─── plan first, confirm before the write ────────────────────────────────────

describe("Hooks page — install", () => {
  const needsWork = plan([
    planEvent("PreToolUse", { action: "repair", repaired: 1 }),
    planEvent("Stop", { action: "add", left_foreign: 2 }),
  ]);

  it("shows the plan before offering to write anything", () => {
    renderPage(report(), needsWork);
    expect(screen.getByText(/Nothing below has been written/)).toBeTruthy();
    expect(screen.getByText(/Would add 1 event/)).toBeTruthy();
  });

  it("does not write on the first click — it asks", () => {
    renderPage(report(), needsWork);
    fireEvent.click(screen.getByText(/Repair these hooks/));
    expect(mockInstallMutate).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Write to \/Users\/x\/\.claude\/settings\.json\?/),
    ).toBeTruthy();
  });

  it("names where the backup goes before the write", () => {
    renderPage(report(), needsWork);
    fireEvent.click(screen.getByText(/Repair these hooks/));
    expect(
      screen.getByText(
        /timestamped copy of the current contents is written beside it/,
      ),
    ).toBeTruthy();
  });

  it("writes only after the explicit confirm", () => {
    renderPage(report(), needsWork);
    fireEvent.click(screen.getByText(/Repair these hooks/));
    fireEvent.click(screen.getByText("Yes, write the file"));
    expect(mockInstallMutate).toHaveBeenCalledTimes(1);
    expect(mockInstallMutate.mock.calls[0]?.[0]).toEqual({
      config_homes: [""],
    });
  });

  it("offers nothing to confirm when the plan changes nothing", () => {
    renderPage();
    expect(
      screen.getByText(/Running the install would rewrite nothing/),
    ).toBeTruthy();
    expect(screen.queryByText(/Yes, write the file/)).toBeNull();
  });

  it("promises that hooks it did not write are left alone", () => {
    renderPage(report(), needsWork);
    expect(screen.getByText(/left exactly where they are/)).toBeTruthy();
  });
});

// ─── the vocabulary the page may not use ─────────────────────────────────────

describe("Hooks page — vocabulary", () => {
  it("never reaches for the language of scalar settings resolution", () => {
    // Hooks accumulate; every hook on an event runs alongside every other. The
    // banned words all belong to how a single *scalar* setting is resolved, and
    // borrowing them here would teach a reader the exact opposite of what the
    // page is for. Prose is the one thing no behavioural test can check, so it
    // is checked as text. Mirrors
    // `tests/sidecar/test_effective_hooks.py::test_module_avoids_the_scalar_resolution_vocabulary`.
    const banned = /winner|winning|shadow|overridden|precedence/gi;
    for (const relative of ["pages/hooks.tsx", "pages/hooks-copy.ts"]) {
      const src = readFile(`${SRC_DIR}/${relative}`, "utf8");
      expect(src.match(banned) ?? [], relative).toEqual([]);
    }
  });

  it("says out loud that hooks merge and all of them run", () => {
    const src = readFile(`${SRC_DIR}/pages/hooks.tsx`, "utf8");
    expect(src).toMatch(/merge/i);
    renderPage();
    expect(
      screen.getByText(/every hook that was collected runs/i),
    ).toBeTruthy();
  });
});
