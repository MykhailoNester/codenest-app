/**
 * Display helpers for the plan-headroom panel (epic #153 / #164).
 *
 * Pure functions and constants only — no fetching, no react-query, no
 * component. `GET /api/v1/agents/plan-usage` is read by whoever mounts the
 * panel (#166); this module exists so the honesty rules the sidecar's
 * `plan_usage_service` enforces on the payload are enforced again on the way to
 * the screen, in one testable place rather than scattered through JSX.
 *
 * The rule that shapes everything here: **`fh` and `sd` have no documented
 * meaning or unit.** Claude desktop records two counters and says nothing about
 * what they measure or where they top out. So nothing in this module appends a
 * unit, computes a percentage of anything, or implies a ceiling. The only
 * quantity it derives is `observedPosition`, and that is explicitly a position
 * within the range *this file has actually contained* — a range the sidecar
 * recomputes on every read, because it moves (0–43 and 0–36 when the ticket was
 * written; 0–64 and 0–46 a day later).
 *
 * Time formatting reuses `format-helpers`: the samples carry epoch-millis `t`
 * rather than the sidecar's usual naive ISO strings, so `parseUtcMs` has nothing
 * to do here, but `relativeTime` is correct once the stamp is rendered as an
 * ISO string with its `Z`, the way the rest of the app does. Neither needed a
 * new time helper. The gap is formatted here rather than by
 * `format-helpers.formatDuration`, which stops at minutes — see `formatMaxGap`.
 */

import { relativeTime } from "./format-helpers";

/** Why a payload carries no series. `null` when the read was clean. */
export type PlanUsageReason =
  | "missing"
  | "unreadable"
  | "malformed"
  | "oversize"
  | "unsupported_version"
  | "no_samples"
  | null;

/**
 * One counter, described only by what the file has held. `latest` and the two
 * bounds are `null` together when the file never recorded this key — which is
 * not the same as a reading of 0, a value these counters genuinely take.
 */
export interface PlanUsageSeries {
  key: string;
  label: string;
  latest: number | null;
  observed_min: number | null;
  observed_max: number | null;
}

/** A single reading: epoch-millis `t` plus whichever counters it carried. */
export interface PlanUsageSample {
  t: number;
  fh?: number;
  sd?: number;
}

/**
 * The `GET /api/v1/agents/plan-usage` body. Every field is present in every
 * state, healthy or degraded — the sidecar builds all of them through one
 * constructor precisely so this type needs no optional members.
 */
export interface PlanUsagePayload {
  available: boolean;
  supported: boolean;
  version: number | null;
  reason: PlanUsageReason;
  sample_count: number;
  org_count: number;
  first_sample_at: number | null;
  last_sample_at: number | null;
  max_gap_seconds: number | null;
  series: PlanUsageSeries[];
  samples: PlanUsageSample[];
}

/**
 * The standing caveat the panel owes the reader. Worth showing wherever these
 * numbers are: without it a bare pair of counters invites the assumption that
 * they are a percentage of something.
 */
export const PLAN_USAGE_CAVEAT =
  "Claude desktop records these two counters without saying what they measure. They are shown as raw values against the range this file has actually held — not against any ceiling.";

/**
 * What to tell the reader when there are no series to draw, or `null` when the
 * payload is fine. Each sentence names the real condition rather than
 * flattening everything into "no data", because the fixes differ: an absent
 * file usually means Claude desktop was never installed here, while an
 * unrecognised version means this reader is the thing that is out of date.
 */
export function planUsageNotice(payload: PlanUsagePayload): string | null {
  switch (payload.reason) {
    case "missing":
      return "No plan-usage history on this machine.";
    case "unreadable":
      return "Claude desktop's plan-usage history could not be read.";
    case "malformed":
      return "Claude desktop's plan-usage history is not in the shape this reader expects.";
    case "oversize":
      return "Claude desktop's plan-usage history is larger than this reader will open.";
    case "unsupported_version":
      return "Claude desktop's plan-usage history is a version this reader does not understand, so nothing is shown rather than guessed.";
    case "no_samples":
      return "Claude desktop's plan-usage history has no readings yet.";
    default:
      return null;
  }
}

/**
 * The series worth rendering: empty unless the file was both present and a
 * version we parsed. Saves every caller the `available && supported` branch and
 * guarantees a degraded payload draws nothing at all.
 */
export function planUsageSeries(payload: PlanUsagePayload): PlanUsageSeries[] {
  if (!payload.available || !payload.supported) return [];
  return payload.series;
}

/**
 * Where the latest reading sits inside the observed range, as a 0–1 fraction
 * for a bar's width.
 *
 * This is emphatically NOT progress toward a ceiling — no ceiling is known. It
 * is "low or high compared with everything this file has recorded", and it is
 * `null` whenever that comparison is meaningless: a missing reading, or a file
 * whose bounds have not yet separated (one sample, or a counter that has held
 * one value throughout). A caller that gets `null` should draw no bar rather
 * than a full or empty one.
 */
export function observedPosition(series: PlanUsageSeries): number | null {
  const { latest, observed_min: min, observed_max: max } = series;
  if (latest === null || min === null || max === null) return null;
  if (!(max > min)) return null;
  const position = (latest - min) / (max - min);
  return Math.min(Math.max(position, 0), 1);
}

/**
 * The latest reading as a bare number, or an em dash. Deliberately unitless and
 * unsuffixed — the one-line reason this helper exists instead of an inline
 * `{series.latest}` is that it is the place a unit would otherwise be added.
 */
export function formatLatest(series: PlanUsageSeries): string {
  return series.latest === null ? "—" : String(series.latest);
}

/** The observed span as `"min–max"` (en dash), or an em dash when unknown. */
export function formatObservedRange(series: PlanUsageSeries): string {
  const { observed_min: min, observed_max: max } = series;
  if (min === null || max === null) return "—";
  return `${min}–${max}`;
}

/**
 * How long ago the newest reading was taken. The sample stamp is epoch-millis,
 * so it is handed to `relativeTime` as an ISO string with its `Z` — the naive
 * stamp handling in that helper is for the sidecar's own timestamps and has
 * nothing to correct here.
 */
export function formatSampleAge(epochMs: number | null): string {
  // `Number.isFinite` alone is not enough. It admits 1e20, which is finite and
  // still outside the range `Date` can represent, and `toISOString()` then
  // throws RangeError — which would take down the panel's whole React subtree
  // rather than rendering the em dash this function documents. The sidecar puts
  // no bound on `t` (any int parses), so an absurd stamp in a rolled or
  // hand-edited file reaches here. 8.64e15 ms is the ECMAScript Date limit.
  if (epochMs === null || !Number.isFinite(epochMs)) return "—";
  if (Math.abs(epochMs) > 8.64e15) return "—";
  return relativeTime(new Date(epochMs).toISOString());
}

/**
 * The widest hole between consecutive readings. The cadence is roughly 15
 * minutes, so anything much larger says the series has a stretch where nothing
 * was recorded and its shape across that stretch is not a trend.
 */
export function formatMaxGap(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  // Not `formatDuration`: it stops at minutes, so this machine's real 170,192s
  // hole renders as "2836m 32s" — arithmetically right and useless. The point
  // of this field is that a stale file is *visible*, and "47h" is visible in a
  // way that a four-digit minute count is not.
  //
  // Spelling out hours and days does not collide with the no-unit rule. That
  // rule is about `fh` and `sd`, whose meaning is unknown; the gap between two
  // sample timestamps is a plain elapsed duration we computed ourselves, and
  // saying how long it is claims nothing about what the counters measure.
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}
