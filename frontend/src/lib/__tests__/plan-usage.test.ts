// Display helpers for the plan-headroom panel (#164). The load-bearing tests
// are the honesty ones: nothing this module renders may claim a unit, a ceiling
// or a percentage for two counters whose meaning Claude desktop has never
// documented. The rest pins the degraded states — a panel that draws a bar from
// a missing file is worse than one that draws nothing.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PLAN_USAGE_CAVEAT,
  formatLatest,
  formatMaxGap,
  formatObservedRange,
  formatSampleAge,
  observedPosition,
  planUsageNotice,
  planUsageSeries,
  type PlanUsagePayload,
  type PlanUsageReason,
  type PlanUsageSeries,
} from "../plan-usage";

// Same list the sidecar test greps for, and for the same reason.
const FORBIDDEN_TOKENS = [
  "hours",
  "days",
  "five_hour",
  "weekly",
  "pct",
  "remaining",
  "limit",
];

function makeSeries(overrides: Partial<PlanUsageSeries> = {}): PlanUsageSeries {
  return {
    key: "fh",
    label: "rolling short window",
    latest: 15,
    observed_min: 0,
    observed_max: 64,
    ...overrides,
  };
}

function makePayload(
  overrides: Partial<PlanUsagePayload> = {},
): PlanUsagePayload {
  return {
    available: true,
    supported: true,
    version: 2,
    reason: null,
    sample_count: 338,
    org_count: 1,
    first_sample_at: 1788162117147,
    last_sample_at: 1789136667943,
    max_gap_seconds: 900,
    series: [
      makeSeries(),
      makeSeries({
        key: "sd",
        label: "rolling long window",
        latest: 46,
        observed_max: 46,
      }),
    ],
    samples: [{ t: 1789136667943, fh: 15, sd: 46 }],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the no-claimed-unit constraint", () => {
  const REASONS: PlanUsageReason[] = [
    null,
    "missing",
    "unreadable",
    "malformed",
    "oversize",
    "unsupported_version",
    "no_samples",
  ];

  it("never emits a unit, ceiling or percentage token", () => {
    const rendered = [
      PLAN_USAGE_CAVEAT,
      ...REASONS.map(
        (reason) => planUsageNotice(makePayload({ reason })) ?? "",
      ),
      formatLatest(makeSeries()),
      formatLatest(makeSeries({ latest: null })),
      formatObservedRange(makeSeries()),
      formatObservedRange(makeSeries({ observed_min: null })),
      formatMaxGap(900),
      formatMaxGap(75 * 60),
      formatMaxGap(null),
      JSON.stringify(planUsageSeries(makePayload())),
    ]
      .join(" ")
      .toLowerCase();

    for (const token of FORBIDDEN_TOKENS) {
      expect(rendered).not.toContain(token);
    }
  });

  it("keeps the word window, which the labels are built from", () => {
    expect(
      planUsageSeries(makePayload())
        .map((s) => s.label)
        .join(" "),
    ).toBe("rolling short window rolling long window");
  });

  it("renders the latest reading bare, with no suffix", () => {
    expect(formatLatest(makeSeries({ latest: 0 }))).toBe("0");
    expect(formatLatest(makeSeries({ latest: 64 }))).toBe("64");
  });
});

describe("planUsageSeries", () => {
  it("returns the series for a healthy payload", () => {
    expect(planUsageSeries(makePayload())).toHaveLength(2);
  });

  it("draws nothing when the file is absent", () => {
    const payload = makePayload({
      available: false,
      supported: false,
      reason: "missing",
      series: [],
    });
    expect(planUsageSeries(payload)).toEqual([]);
  });

  it("draws nothing for a version it cannot parse, even if series arrived", () => {
    // Belt and braces: the sidecar already empties `series` here, and the panel
    // must not render them if a future payload ever stops doing so.
    const payload = makePayload({
      supported: false,
      reason: "unsupported_version",
    });
    expect(planUsageSeries(payload)).toEqual([]);
  });
});

describe("planUsageNotice", () => {
  it("is null when there is nothing to explain", () => {
    expect(planUsageNotice(makePayload())).toBeNull();
  });

  it("distinguishes an absent file from an unparsed version", () => {
    const missing = planUsageNotice(makePayload({ reason: "missing" }));
    const unsupported = planUsageNotice(
      makePayload({ reason: "unsupported_version" }),
    );
    expect(missing).not.toBe(unsupported);
    expect(missing).toBeTruthy();
    expect(unsupported).toBeTruthy();
  });

  it("has a sentence for every reason the sidecar can send", () => {
    const reasons: Exclude<PlanUsageReason, null>[] = [
      "missing",
      "unreadable",
      "malformed",
      "oversize",
      "unsupported_version",
      "no_samples",
    ];
    for (const reason of reasons) {
      expect(planUsageNotice(makePayload({ reason }))).toBeTruthy();
    }
  });
});

describe("observedPosition", () => {
  it("places the latest reading inside the observed span", () => {
    expect(
      observedPosition(
        makeSeries({ latest: 16, observed_min: 0, observed_max: 64 }),
      ),
    ).toBeCloseTo(0.25);
  });

  it("is computed from the span it was handed, not from a fixed one", () => {
    // The observed bounds move as the file rolls; the same reading sits in a
    // different place once the span changes, and nothing here may pin them.
    expect(
      observedPosition(
        makeSeries({ latest: 16, observed_min: 0, observed_max: 32 }),
      ),
    ).toBeCloseTo(0.5);
  });

  it("is null when the reading is absent", () => {
    expect(observedPosition(makeSeries({ latest: null }))).toBeNull();
  });

  it("is null when the span has not separated yet", () => {
    expect(
      observedPosition(
        makeSeries({ latest: 5, observed_min: 5, observed_max: 5 }),
      ),
    ).toBeNull();
  });

  it("clamps a reading that falls outside the recorded span", () => {
    expect(
      observedPosition(
        makeSeries({ latest: 99, observed_min: 0, observed_max: 64 }),
      ),
    ).toBe(1);
    expect(
      observedPosition(
        makeSeries({ latest: -5, observed_min: 0, observed_max: 64 }),
      ),
    ).toBe(0);
  });
});

describe("formatObservedRange", () => {
  it("renders the span the file actually held", () => {
    expect(formatObservedRange(makeSeries())).toBe("0–64");
  });

  it("is an em dash when the file recorded nothing for this key", () => {
    expect(
      formatObservedRange(
        makeSeries({ latest: null, observed_min: null, observed_max: null }),
      ),
    ).toBe("—");
  });
});

describe("formatSampleAge", () => {
  it("reads the epoch-millis stamp as UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T12:00:00Z"));
    // Ten minutes before the frozen clock.
    expect(formatSampleAge(Date.UTC(2026, 8, 11, 11, 50, 0))).toBe("10m ago");
  });

  it("is an em dash without a stamp", () => {
    expect(formatSampleAge(null)).toBe("—");
    expect(formatSampleAge(NaN)).toBe("—");
  });
});

describe("formatMaxGap", () => {
  it("renders the cadence gap as a duration", () => {
    // "15m", not "15m 0s": this stopped delegating to `formatDuration` so that
    // a multi-hour hole reads as hours instead of a four-digit minute count
    // (see the #164 hardening block below). Dropping a trailing zero component
    // is a deliberate part of that change, not a regression.
    expect(formatMaxGap(900)).toBe("15m");
    expect(formatMaxGap(45)).toBe("45s");
  });

  it("is an em dash when there is no interval to report", () => {
    expect(formatMaxGap(null)).toBe("—");
  });
});

describe("out-of-range and long-gap formatting (#164 hardening)", () => {
  it("returns an em dash for a finite but un-Date-able stamp", () => {
    // `Number.isFinite(1e20)` is true, and `new Date(1e20).toISOString()`
    // throws RangeError — which would take down the panel's React subtree.
    expect(formatSampleAge(1e20)).toBe("—");
    expect(formatSampleAge(-1e20)).toBe("—");
  });

  it("still returns an em dash for the non-finite cases", () => {
    expect(formatSampleAge(Infinity)).toBe("—");
    expect(formatSampleAge(NaN)).toBe("—");
    expect(formatSampleAge(null)).toBe("—");
  });

  it("renders a multi-hour gap in hours, not four-digit minutes", () => {
    // The real observed gap on this machine. `formatDuration` rendered this as
    // "2836m 32s", which buries the staleness signal the field exists for.
    // 170,192s is 47h 16m — just under the 48h point where this switches to
    // days. My first assertion here said "1d 23h" and was simply wrong.
    expect(formatMaxGap(170_192)).toBe("47h 16m");
    expect(formatMaxGap(50 * 3600)).toBe("2d 2h");
    expect(formatMaxGap(48 * 3600)).toBe("2d");
    expect(formatMaxGap(3 * 3600)).toBe("3h");
    expect(formatMaxGap(3 * 3600 + 25 * 60)).toBe("3h 25m");
  });

  it("keeps short gaps in their natural units", () => {
    expect(formatMaxGap(45)).toBe("45s");
    expect(formatMaxGap(15 * 60)).toBe("15m");
    expect(formatMaxGap(null)).toBe("—");
  });
});
