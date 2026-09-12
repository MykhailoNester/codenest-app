/**
 * `hooks-copy.ts` — the Hooks page's claims, without a DOM (#171).
 *
 * Split from `hooks-page.test.tsx` the way the module is split from the page:
 * these are statements about a report, and a statement is cheaper and clearer
 * to pin as a value than as rendered text.
 */

import { describe, it, expect } from "vitest";
import {
  CONTRIBUTOR_SOURCE_COUNT,
  UNKNOWN_COUNT_LABEL,
  commandLabel,
  eventTotal,
  eventTotalLabel,
  planHeadline,
  planSummary,
  redactionNote,
  scanCopy,
  scanIsIncomplete,
  sourceCountLabel,
  staleFindings,
  timeoutLabel,
} from "../hooks-copy";
import type {
  EffectiveHookContribution,
  EffectiveHookEvent,
  EffectiveHookSourceBucket,
  HookInstallEventPlan,
  HookInstallReport,
  HookInstallResult,
} from "../../lib/api";

function bucket(
  over: Partial<EffectiveHookSourceBucket> = {},
): EffectiveHookSourceBucket {
  return {
    source: "user",
    label: "User settings",
    observable: true,
    count: 0,
    contributions: [],
    ...over,
  };
}

function hookEvent(buckets: EffectiveHookSourceBucket[]): EffectiveHookEvent {
  return {
    event: "PreToolUse",
    tier: "core",
    ingest_path: "/api/v1/hooks/pre-tool",
    total: buckets.reduce((s, b) => s + b.count, 0),
    by_source: buckets,
  };
}

function contribution(
  over: Partial<EffectiveHookContribution> = {},
): EffectiveHookContribution {
  return {
    event: "PreToolUse",
    source: "plugin",
    origin: "/plugins/guard/hooks/hooks.json",
    matcher: "*",
    hook_type: "command",
    executable: "guard.sh",
    command: null,
    redacted: true,
    codenest_authored: false,
    timeout_seconds: null,
    ...over,
  };
}

function planEvent(
  over: Partial<HookInstallEventPlan> = {},
): HookInstallEventPlan {
  return {
    event: "PreToolUse",
    action: "ok",
    repaired: 0,
    left_narrow: 0,
    left_foreign: 0,
    left_malformed: 0,
    detail: null,
    ...over,
  };
}

function result(events: HookInstallEventPlan[]): HookInstallResult {
  return {
    config_home: "",
    settings_path: "/Users/x/.claude/settings.json",
    status: "planned",
    refusal: null,
    changed: false,
    created_file: false,
    backup_path: null,
    events,
  };
}

function report(events: HookInstallEventPlan[]): HookInstallReport {
  return {
    base_url: "http://localhost:8002",
    dry_run: true,
    overall: "planned",
    results: [result(events)],
  };
}

describe("sourceCountLabel", () => {
  it("prints the count for a source that can be read off disk", () => {
    expect(sourceCountLabel(bucket({ count: 3 }))).toBe("3");
    expect(sourceCountLabel(bucket({ count: 0 }))).toBe("0");
  });

  it("refuses to print zero for the source it cannot read", () => {
    // `--settings` comes back with count 0 because the field is an integer.
    // Rendering that 0 would assert something the report says it cannot know.
    expect(
      sourceCountLabel(
        bucket({ source: "settings_flag", observable: false, count: 0 }),
      ),
    ).toBe(UNKNOWN_COUNT_LABEL);
  });
});

describe("eventTotal", () => {
  it("sums every bucket — nothing is ever deducted", () => {
    const e = hookEvent([
      bucket({ source: "user", count: 2 }),
      bucket({ source: "project", count: 1 }),
      bucket({ source: "plugin", count: 3 }),
    ]);
    expect(eventTotal(e).found).toBe(6);
  });

  it("marks the total a floor when a source cannot be read", () => {
    const e = hookEvent([
      bucket({ count: 2 }),
      bucket({ source: "settings_flag", observable: false, count: 0 }),
    ]);
    expect(eventTotal(e)).toEqual({ found: 2, atLeast: true });
    expect(eventTotalLabel(e)).toBe("2 hooks + unknown");
  });

  it("is a complete count when every source was readable", () => {
    const e = hookEvent([bucket({ count: 1 })]);
    expect(eventTotalLabel(e)).toBe("1 hook");
  });

  it("says none found rather than printing a bare zero", () => {
    expect(eventTotalLabel(hookEvent([bucket({ count: 0 })]))).toBe(
      "none found",
    );
  });

  it("names all eight sources as the contributor count", () => {
    expect(CONTRIBUTOR_SOURCE_COUNT).toBe(8);
  });
});

describe("commandLabel / redactionNote / timeoutLabel", () => {
  it("returns the executable name for a hook this app did not write", () => {
    expect(commandLabel(contribution())).toBe("guard.sh");
  });

  it("returns the full command only for one this app itself wrote", () => {
    const ours = contribution({
      codenest_authored: true,
      redacted: false,
      command: "curl -s http://localhost:8002/api/v1/hooks/pre-tool",
      executable: "curl",
    });
    expect(commandLabel(ours)).toContain("/api/v1/hooks/pre-tool");
    expect(redactionNote(ours)).toBeNull();
  });

  it("states the redaction rule rather than treating it as missing data", () => {
    expect(redactionNote(contribution())).toMatch(
      /does not print the arguments/,
    );
  });

  it("labels a timeout as configured, never as a measurement", () => {
    expect(timeoutLabel(contribution({ timeout_seconds: 30 }))).toBe(
      "configured timeout 30s",
    );
    expect(timeoutLabel(contribution())).toBeNull();
  });
});

describe("scanCopy", () => {
  it("tells a missing file apart from a malformed one", () => {
    const missing = scanCopy({
      source: "project",
      path: "/repo/.claude/settings.json",
      status: "missing_file",
      detail: null,
    });
    const invalid = scanCopy({
      source: "project",
      path: "/repo/.claude/settings.json",
      status: "invalid_json",
      detail: "line 3",
    });
    expect(missing.tone).toBe("info");
    expect(invalid.tone).toBe("warn");
    expect(missing.label).not.toBe(invalid.label);
  });

  it("flags a scan whose counts are incomplete", () => {
    expect(
      scanIsIncomplete([
        { source: "user", path: "a", status: "ok", detail: null },
      ]),
    ).toBe(false);
    expect(
      scanIsIncomplete([
        { source: "user", path: "a", status: "ok", detail: null },
        { source: "plugin", path: "b", status: "truncated", detail: null },
      ]),
    ).toBe(true);
  });
});

describe("staleFindings", () => {
  it("finds nothing when every hook is current", () => {
    expect(staleFindings(report([planEvent()]))).toEqual([]);
  });

  it("flags a repaired PreToolUse as the permission-decision case", () => {
    const found = staleFindings(
      report([planEvent({ action: "repair", repaired: 1 })]),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.discardsPermissionDecisions).toBe(true);
    expect(found[0]?.settingsPath).toBe("/Users/x/.claude/settings.json");
  });

  it("does not raise that alarm for a stale hook on another event", () => {
    const found = staleFindings(
      report([planEvent({ event: "Stop", action: "repair", repaired: 1 })]),
    );
    expect(found[0]?.discardsPermissionDecisions).toBe(false);
    expect(found[0]?.events).toEqual(["Stop"]);
  });

  it("returns nothing at all before the plan has arrived", () => {
    expect(staleFindings(undefined)).toEqual([]);
  });
});

describe("planSummary / planHeadline", () => {
  it("counts the hooks the installer would leave alone", () => {
    const s = planSummary(
      result([
        planEvent({ action: "add", left_foreign: 2 }),
        planEvent({ event: "Stop", left_narrow: 1, left_malformed: 1 }),
      ]),
    );
    expect(s.add).toBe(1);
    expect(s.ok).toBe(1);
    expect(s.left).toBe(4);
    expect(s.changes).toBe(true);
  });

  it("says nothing would change when nothing would", () => {
    expect(planHeadline(result([planEvent()]))).toMatch(/Nothing to change/);
    expect(planSummary(result([planEvent()])).changes).toBe(false);
  });

  it("describes a repair as rewriting this app's own older shape", () => {
    expect(
      planHeadline(result([planEvent({ action: "repair", repaired: 1 })])),
    ).toMatch(/rewrite 1 hook this app wrote in an older shape/);
  });

  it("surfaces a refusal instead of a plan", () => {
    const refused: HookInstallResult = {
      ...result([]),
      status: "refused",
      refusal: "settings.json is not valid JSON",
    };
    expect(planHeadline(refused)).toBe("settings.json is not valid JSON");
  });
});
