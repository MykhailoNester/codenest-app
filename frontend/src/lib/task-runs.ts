/**
 * Honest derivation layer for the task detail Agent runs card (`.td-runs`).
 *
 * `agent_runs.started_at`/`ended_at` are written by
 * `agent_runs_service._now()` (`datetime.now(UTC).isoformat(timespec="seconds")`)
 * — an offset-suffixed stamp like `"2026-08-11T16:08:25+00:00"` — which is
 * NOT what `format-helpers.parseUtcMs` expects: it blindly appends `"Z"`
 * unless the string already ends in one, and `Date.parse("…+00:00Z")` is
 * `NaN`. That is the verified bug behind `agent-run-row.tsx`'s always-empty
 * elapsed cell (see the plan's Follow-ups) — this module's `runStampMs`
 * exists so this card does not inherit it. `formatElapsed`/`parseUtcMs`
 * themselves are untouched: they are correct for the naive stamps every
 * other caller feeds them, and widening them is a wider, separate fix.
 */
import type { AgentRun } from "./api"; // type-only: erased, no cycle

export const RUN_COST_TITLE =
  "The CLI's own total_cost_usd for this session. On a subscription this is notional pricing, not billing.";

export const RUN_IDENTITY_TITLE =
  "Runs record the provider that ran them. Per-run team-member attribution needs its own column — it does not exist yet.";

/** Matches a trailing `Z` or a numeric UTC offset (`+00:00` / `-0500`). */
const HAS_TZ_DESIGNATOR = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Epoch millis for either of the two stamp shapes this card sees:
 * offset-suffixed (`agent_runs`, e.g. `"…+00:00"`) or naive (everywhere
 * else, e.g. `"…14:00:00"`, read as UTC). Unlike `parseUtcMs`, this never
 * appends `"Z"` to a string that already carries its own timezone
 * designator — appending one to an offset-suffixed stamp is exactly what
 * makes `Date.parse` return `NaN`.
 */
export function runStampMs(iso: string): number {
  return Date.parse(HAS_TZ_DESIGNATOR.test(iso) ? iso : `${iso}Z`);
}

export const RUN_STAMP_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

/** Renders a run stamp in the viewer's local time. Duplicated from
 * `task-activity.formatActivityStamp` on purpose (two lines) — it keeps
 * this card's helper module independent of the activity feed's. */
export function formatRunStamp(iso: string): string {
  return new Date(runStampMs(iso)).toLocaleString(undefined, RUN_STAMP_OPTIONS);
}

/**
 * `"running"` while the run has not ended — never a number computed
 * against the render clock. Once ended, a floored `Xs`/`Xm Ys`/`Xh Ym` from
 * the two stored stamps. `"—"` if either stamp fails to parse.
 */
export function formatRunDuration(
  startIso: string,
  endIso: string | null,
): string {
  if (endIso == null) return "running";
  const start = runStampMs(startIso);
  const end = runStampMs(endIso);
  if (isNaN(start) || isNaN(end)) return "—";
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** The subset of `AgentRun` this card's pure helpers need. */
export type RunRow = Pick<
  AgentRun,
  | "model"
  | "prompt_preview"
  | "status"
  | "started_at"
  | "ended_at"
  | "provider_name"
  | "provider_display_name"
  | "provider_color"
  | "session_cost_usd"
  | "session_initial_prompt"
  | "session_total_tool_calls"
  | "session_id"
>;

/** Provider display name, else provider name, else the honest "no provider
 * row" fallback — never a member name, never `profile`. */
export function runIdentity(run: RunRow): string {
  return run.provider_display_name ?? run.provider_name ?? "Unknown agent";
}

/** `prompt_preview` (this run's own launch prompt) takes priority over
 * `session_initial_prompt` (the linked session's, which can be re-pointed
 * after `/clear` — see `agent_runs_service.relink_run_to_session`). Both
 * absent -> `null`, never an invented summary. */
export function runSummary(run: RunRow): string | null {
  const preview = run.prompt_preview?.trim();
  if (preview) return preview;
  const initial = run.session_initial_prompt?.trim();
  return initial ? initial : null;
}

/**
 * The mono meta line, in order: when, duration, calls (omitted when the
 * session's tool-call count is unknown, not when it is zero), model
 * (omitted when null/empty). The card joins the result with `" · "`.
 */
export function runMetaSegments(run: RunRow): string[] {
  const segments: string[] = [
    formatRunStamp(run.started_at),
    formatRunDuration(run.started_at, run.ended_at),
  ];
  const calls = run.session_total_tool_calls;
  if (calls != null) segments.push(`${calls} call${calls === 1 ? "" : "s"}`);
  if (run.model) segments.push(run.model);
  return segments;
}

export interface RunsSummary {
  sessions: number;
  costUsd: number | null;
  calls: number | null;
}

/**
 * Aggregates over exactly the rows passed in — the card's header reads
 * "N sessions · $X.XX · N calls" summed over the rows it renders, not a
 * server-side total. `costUsd`/`calls` sum only the rows that carry a
 * non-null value and are `null` (segment omitted) when none do.
 */
export function summariseRuns(runs: readonly RunRow[]): RunsSummary {
  let costUsd: number | null = null;
  let calls: number | null = null;
  for (const run of runs) {
    if (run.session_cost_usd != null) {
      costUsd = (costUsd ?? 0) + run.session_cost_usd;
    }
    if (run.session_total_tool_calls != null) {
      calls = (calls ?? 0) + run.session_total_tool_calls;
    }
  }
  return { sessions: runs.length, costUsd, calls };
}
