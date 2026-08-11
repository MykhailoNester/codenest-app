// Pure helpers for the task detail Agent runs card (`.td-runs`): stamp
// parsing that survives `agent_runs`' offset-suffixed timestamps, duration
// formatting that never reads the clock, and the identity/summary/aggregate
// rules pinned in the plan.

import { describe, it, expect, vi } from "vitest";
import type { RunRow } from "../task-runs";
import {
  RUN_STAMP_OPTIONS,
  formatRunDuration,
  formatRunStamp,
  runIdentity,
  runMetaSegments,
  runStampMs,
  runSummary,
  summariseRuns,
} from "../task-runs";

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    model: null,
    prompt_preview: null,
    status: "ended",
    started_at: "2026-08-11T16:08:25+00:00",
    ended_at: "2026-08-11T16:08:37+00:00",
    provider_name: null,
    provider_display_name: null,
    provider_color: null,
    session_cost_usd: null,
    session_initial_prompt: null,
    session_total_tool_calls: null,
    session_id: null,
    ...overrides,
  };
}

describe("runStampMs", () => {
  it("parses an offset-suffixed agent_runs stamp verbatim", () => {
    expect(runStampMs("2026-08-11T16:08:25+00:00")).toBe(
      Date.UTC(2026, 7, 11, 16, 8, 25),
    );
  });

  it("appends Z to a naive stamp, same as parseUtcMs", () => {
    expect(runStampMs("2026-08-11 14:00:00")).toBe(
      Date.UTC(2026, 7, 11, 14, 0, 0),
    );
  });

  it("leaves an already-Z-suffixed stamp alone", () => {
    expect(runStampMs("2026-08-11T14:00:00Z")).toBe(
      Date.UTC(2026, 7, 11, 14, 0, 0),
    );
  });
});

describe("formatRunStamp", () => {
  it("renders in the viewer's local time with the pinned options", () => {
    const iso = "2026-08-11T14:00:00+00:00";
    expect(formatRunStamp(iso)).toBe(
      new Date(Date.UTC(2026, 7, 11, 14, 0, 0)).toLocaleString(
        undefined,
        RUN_STAMP_OPTIONS,
      ),
    );
  });
});

describe("formatRunDuration", () => {
  it('renders "running" for a run still in flight, never a number', () => {
    expect(
      formatRunDuration("2026-08-11T16:08:25+00:00", null),
    ).toBe("running");
  });

  it("never consults the clock: the same in-flight run is stable across two different \"now\"s", () => {
    vi.setSystemTime(new Date("2026-08-11T16:09:00Z"));
    const first = formatRunDuration("2026-08-11T16:08:25+00:00", null);
    vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
    const second = formatRunDuration("2026-08-11T16:08:25+00:00", null);
    vi.useRealTimers();
    expect(first).toBe("running");
    expect(second).toBe("running");
  });

  it("computes seconds/minutes/hours from the two stored stamps", () => {
    expect(
      formatRunDuration(
        "2026-08-11T16:08:00+00:00",
        "2026-08-11T16:08:45+00:00",
      ),
    ).toBe("45s");
    expect(
      formatRunDuration(
        "2026-08-11T16:00:00+00:00",
        "2026-08-11T16:03:20+00:00",
      ),
    ).toBe("3m 20s");
    expect(
      formatRunDuration(
        "2026-08-11T14:00:00+00:00",
        "2026-08-11T16:05:00+00:00",
      ),
    ).toBe("2h 5m");
  });
});

describe("runIdentity", () => {
  it("prefers provider_display_name over provider_name", () => {
    expect(
      runIdentity(
        makeRun({ provider_display_name: "Claude Code", provider_name: "claude-code" }),
      ),
    ).toBe("Claude Code");
  });

  it("falls back to provider_name when display_name is null", () => {
    expect(runIdentity(makeRun({ provider_name: "claude-code" }))).toBe(
      "claude-code",
    );
  });

  it("falls back to Unknown agent when neither is set — never a member name", () => {
    expect(runIdentity(makeRun())).toBe("Unknown agent");
  });
});

describe("runSummary", () => {
  it("prefers prompt_preview over session_initial_prompt", () => {
    expect(
      runSummary(
        makeRun({
          prompt_preview: "This run's own prompt",
          session_initial_prompt: "The session's prompt",
        }),
      ),
    ).toBe("This run's own prompt");
  });

  it("falls back to session_initial_prompt when prompt_preview is absent", () => {
    expect(
      runSummary(makeRun({ session_initial_prompt: "The session's prompt" })),
    ).toBe("The session's prompt");
  });

  it("returns null when both are absent — never an invented summary", () => {
    expect(runSummary(makeRun())).toBeNull();
  });

  it("treats a blank prompt_preview as absent", () => {
    expect(
      runSummary(
        makeRun({
          prompt_preview: "   ",
          session_initial_prompt: "The session's prompt",
        }),
      ),
    ).toBe("The session's prompt");
  });
});

describe("runMetaSegments", () => {
  const base = makeRun({
    started_at: "2026-08-11T16:00:00+00:00",
    ended_at: "2026-08-11T16:03:20+00:00",
  });

  it("omits the calls segment when session_total_tool_calls is null", () => {
    const segments = runMetaSegments(makeRun({ ...base, session_total_tool_calls: null }));
    expect(segments.some((s) => /call/.test(s))).toBe(false);
  });

  it("renders '0 calls' for a real zero — zero is a value, not unknown", () => {
    const segments = runMetaSegments(makeRun({ ...base, session_total_tool_calls: 0 }));
    expect(segments).toContain("0 calls");
  });

  it("singularizes '1 call'", () => {
    const segments = runMetaSegments(makeRun({ ...base, session_total_tool_calls: 1 }));
    expect(segments).toContain("1 call");
  });

  it("omits model when null, includes it when set", () => {
    const withoutModel = runMetaSegments(makeRun({ ...base, model: null }));
    expect(withoutModel.some((s) => s === "claude-opus")).toBe(false);

    const withModel = runMetaSegments(makeRun({ ...base, model: "claude-opus" }));
    expect(withModel).toContain("claude-opus");
  });

  it("orders when, then duration, then calls, then model", () => {
    const segments = runMetaSegments(
      makeRun({ ...base, session_total_tool_calls: 3, model: "claude-opus" }),
    );
    expect(segments).toEqual([
      formatRunStamp(base.started_at),
      "3m 20s",
      "3 calls",
      "claude-opus",
    ]);
  });
});

describe("summariseRuns", () => {
  it("sums cost/calls over only the rows passed in", () => {
    const runs: RunRow[] = [
      makeRun({ session_cost_usd: 0.1, session_total_tool_calls: 3 }),
      makeRun({ session_cost_usd: 0.2, session_total_tool_calls: 0 }),
      makeRun({ session_cost_usd: null, session_total_tool_calls: null }),
    ];
    expect(summariseRuns(runs)).toEqual({
      sessions: 3,
      costUsd: 0.30000000000000004,
      calls: 3,
    });
  });

  it("returns null cost/calls when every row is null — not zero", () => {
    const runs: RunRow[] = [
      makeRun({ session_cost_usd: null, session_total_tool_calls: null }),
      makeRun({ session_cost_usd: null, session_total_tool_calls: null }),
    ];
    expect(summariseRuns(runs)).toEqual({
      sessions: 2,
      costUsd: null,
      calls: null,
    });
  });

  it("an empty run list summarises to zero sessions and null cost/calls", () => {
    expect(summariseRuns([])).toEqual({ sessions: 0, costUsd: null, calls: null });
  });
});
