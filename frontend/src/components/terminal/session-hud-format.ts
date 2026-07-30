/**
 * Pure formatting helpers for `<SessionHud/>`. No React import here on
 * purpose — keeps `react-refresh/only-export-components` out of the
 * picture entirely and lets vitest exercise every function directly.
 *
 * This file is also the *only* place `Date.now()` is read for the HUD (see
 * `elapsedSecondsSince` below) — `react-hooks/purity` treats `Date.now` as
 * impure, so every other call site re-renders off a shared tick counter
 * (see `session-hud.tsx`'s module-level ticker, copied from
 * `pages/schedules.tsx`) instead of reading the clock itself.
 */

import { parseUtcMs } from "../../lib/format-helpers";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Session-elapsed formatter: `4s` / `18m 04s` / `1h 05m`, zero-padded to
 * match the prototype (`18m 04s`, not `18m 4s`). `lib/format-helpers`'s
 * `formatElapsed` is not reused here — it emits `18m 4s`, unpadded.
 */
export function formatHudElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${pad2(s)}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${pad2(m)}m`;
}

/**
 * Tool-elapsed formatter: `1s` / `95s` / `3m 12s`. Bare seconds stay bare
 * until they'd need a third digit (< 100s) — a running tool is usually
 * gone in well under two minutes, so the common case reads as a single
 * short number rather than "0m 04s".
 */
export function formatToolElapsed(seconds: number): string {
  if (seconds < 100) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${pad2(s)}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${pad2(m)}m`;
}

/** `842` / `76k` / `1.2M` — a token count, never more than one decimal. */
export function formatTokensShort(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Display-only shortening of a raw model id: strips a leading `claude-` and
 * a trailing `-YYYYMMDD` release-date suffix, and returns the rest
 * verbatim — no title-casing, no invention. The full raw id belongs in the
 * cell's `title=`.
 */
export function shortModelLabel(model: string): string {
  let s = model;
  if (s.startsWith("claude-")) s = s.slice("claude-".length);
  s = s.replace(/-\d{8}$/, "");
  return s;
}

/** Context-window occupancy, 0-100, clamped, with a zero-window guard. */
export function contextPercent(tokens: number, window: number): number {
  if (window <= 0) return 0;
  return Math.min(100, Math.round((tokens / window) * 100));
}

/**
 * Seconds elapsed since a naive-UTC ISO timestamp — `null` on anything that
 * doesn't parse (nullish, empty, malformed), never `0` and never `NaN`.
 * The single `Date.now()` read for the whole HUD lives here.
 */
export function elapsedSecondsSince(
  iso: string | null | undefined,
): number | null {
  if (!iso) return null;
  const ms = parseUtcMs(iso);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 1000));
}
