/**
 * Shared formatting helpers used across multiple pages and components.
 */

export function formatUSD(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatDelta(
  current: number,
  previous: number,
): { label: string; direction: "up" | "down" | "neutral" } {
  if (previous === 0) {
    if (current === 0) return { label: "no change", direction: "neutral" };
    return { label: "+100%", direction: "up" };
  }
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.5) return { label: "no change", direction: "neutral" };
  const sign = pct > 0 ? "+" : "";
  return {
    label: `${sign}${pct.toFixed(0)}% vs yesterday`,
    direction: pct > 0 ? "up" : "down",
  };
}

/**
 * Returns the number of seconds elapsed since an ISO-8601 timestamp.
 */
export function secondsSince(isoTimestamp: string): number {
  return Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / 1000);
}

/**
 * Format seconds into a human-readable duration like "2m 18s".
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Normalize a naive ISO timestamp (no trailing Z) to UTC millis.
 * The sidecar returns timestamps without a timezone suffix; appending "Z"
 * makes the browser parse them as UTC instead of local time.
 */
export function parseUtcMs(iso: string): number {
  return Date.parse(iso.endsWith("Z") ? iso : iso + "Z");
}

/**
 * Millis for a timestamp that may or may not carry a timezone.
 *
 * The sidecar emits naive UTC — `2026-09-11T14:10:14`, no suffix — and
 * `new Date()` reads a naive ISO string as *local* time, so every age computed
 * from one was wrong by the machine's UTC offset (three hours on a EEST
 * machine: a freshly created row read as three hours old). That was live in
 * `relativeTime` for every caller that did not hand-wrap its argument, which
 * was most of them.
 *
 * Unlike `parseUtcMs`, which appends `"Z"` unconditionally, this appends one
 * only when the string carries no timezone designator at all — so a stamp that
 * already ends in `Z` or carries a `+03:00` / `-0500` offset is passed through
 * as written instead of being corrupted into an unparseable hybrid. See
 * `lib/task-runs.ts`, which grew its own parser to dodge exactly that.
 */
function relativeTimeMs(iso: string): number {
  // A designator is `Z`, or a ±HH:MM / ±HHMM offset, and can only appear after
  // the time part — `2026-09-11` alone is a date, not an offset-bearing stamp.
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) && iso.includes("T");
  return Date.parse(hasZone ? iso : `${iso}Z`);
}

/**
 * Relative-time formatter: "Xs ago" / "Xm ago" / "Xh ago" / "Xd ago".
 * Handles both past and future timestamps.
 * Accepts null/undefined for convenience at call sites that may have optional dates.
 * Naive (suffix-less) timestamps are read as UTC — see `relativeTimeMs`.
 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - relativeTimeMs(iso);
  const future = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  const phrase = (value: string): string =>
    future ? `in ${value}` : `${value} ago`;
  if (s < 60) return phrase(`${s}s`);
  const m = Math.floor(s / 60);
  if (m < 60) return phrase(`${m}m`);
  const h = Math.floor(m / 60);
  if (h < 24) return phrase(`${h}h`);
  return phrase(`${Math.floor(h / 24)}d`);
}

/**
 * Duration between two ISO timestamps (or from startIso to now when endIso is
 * absent/null). Returns a human-readable string like "3m 42s" or "1h 5m".
 * Handles the naive-timestamp (no Z) pattern the sidecar emits.
 */
export function formatElapsed(
  startIso: string,
  endIso?: string | null,
): string {
  const start = parseUtcMs(startIso);
  if (isNaN(start)) return "";
  const end = endIso ? parseUtcMs(endIso) : Date.now();
  let s = Math.max(0, Math.floor((end - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  s = s % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Format a duration in milliseconds as a human-readable string like "2m 15s".
 * Accepts null/undefined (returns "—").
 */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

/**
 * Format an integer with thousands separators, e.g. 1234567 -> "1,234,567".
 * Pinned to en-US so the grouping separator stays stable regardless of the
 * host machine's locale (bare toLocaleString() varies, e.g. "1 234" under
 * locales that group with a space instead of a comma).
 */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Format a byte count as a human-readable string (B / KB / MB / GB / TB).
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  for (const u of units) {
    if (n < 1024) return `${n.toFixed(1)} ${u}`;
    n /= 1024;
  }
  return `${n.toFixed(1)} TB`;
}
