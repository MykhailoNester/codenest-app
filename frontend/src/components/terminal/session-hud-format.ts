/**
 * Pure formatting helpers for `<SessionHud/>`. No React import here on
 * purpose — `eslint.config.js`'s `reactRefresh.configs.vite` fires
 * `only-export-components` on a `.tsx` file that exports something other
 * than a component, so these live in a plain `.ts` module and are unit
 * tested directly (D13).
 *
 * This file is also the only place `Date.now()` is read for the HUD (see
 * `elapsedSecondsSince` below) — `react-hooks/purity` treats a direct
 * `Date.now()` call in a component/hook body as impure, so the component
 * only ever calls this wrapper, never the clock itself (same idiom as
 * `lib/format-helpers.ts`'s `relativeTime`).
 */

import { parseUtcMs } from "../../lib/format-helpers";

const MODEL_FAMILIES = new Set(["opus", "sonnet", "haiku"]);

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Display label for a raw model id: strips a leading `claude-` and a
 * trailing `-YYYYMMDD` release-date suffix, then title-cases the known
 * family token (opus / sonnet / haiku) and joins the remaining numeric
 * segments with `.` — `"claude-opus-4-8"` → `"Opus 4.8"`,
 * `"claude-3-5-haiku-20241022"` → `"Haiku 3.5"`.
 *
 * Anything that doesn't contain a recognized family token is returned
 * completely unchanged — never a placeholder, never `"Unknown"`. The raw id
 * always belongs in the cell's `title=` regardless of what this returns.
 */
export function formatModelLabel(model: string): string {
  let stripped = model;
  if (stripped.startsWith("claude-")) {
    stripped = stripped.slice("claude-".length);
  }
  stripped = stripped.replace(/-\d{8}$/, "");
  const segments = stripped.split("-");
  const familyIndex = segments.findIndex((seg) =>
    MODEL_FAMILIES.has(seg.toLowerCase()),
  );
  if (familyIndex === -1) return model;
  const family = segments[familyIndex];
  if (!family) return model;
  const title = family.charAt(0).toUpperCase() + family.slice(1).toLowerCase();
  const version = segments.filter((_seg, i) => i !== familyIndex).join(".");
  return version ? `${title} ${version}` : title;
}

/** `812` / `76k` — a token count, rounded to the nearest thousand above 1k. */
export function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * Elapsed-time formatter: `42s` / `18m 04s` (zero-padded seconds, matching
 * the prototype) / `2h 05m`. Deliberately not `lib/format-helpers`'s
 * `formatDuration`, which emits unpadded `"18m 4s"` — changing that shared
 * helper would alter unrelated call sites.
 */
export function formatElapsed(seconds: number): string {
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

/** Context-window occupancy as a rounded, clamped percentage string. */
export function formatContextPercent(used: number, window: number): string {
  if (window <= 0) return "0%";
  const pct = Math.min(100, Math.round((used / window) * 100));
  return `${pct}%`;
}

/**
 * Seconds elapsed, right now, since a naive-UTC ISO timestamp. `parseUtcMs`
 * appends the `Z` the sidecar omits; a value that doesn't parse yields `0`
 * rather than `NaN` (the caller is expected to have already checked the
 * timestamp is present — this only guards against a malformed one).
 */
export function elapsedSecondsSince(iso: string): number {
  const ms = parseUtcMs(iso);
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 1000));
}

/** Whole seconds between two naive-UTC ISO timestamps — no clock read. */
export function elapsedSecondsBetween(startIso: string, endIso: string): number {
  return Math.max(0, Math.floor((parseUtcMs(endIso) - parseUtcMs(startIso)) / 1000));
}

/**
 * Whole seconds since an epoch-milliseconds timestamp.
 *
 * The agent-pane strip (`agent-session-hud.tsx`) measures from frame arrival
 * times, which are already `Date.now()` values from the reducer, so it has no
 * ISO string to hand to `elapsedSecondsSince` above. Reading the clock lives
 * here rather than at the call site because that call site is a component
 * render, where `react-hooks/purity` rightly forbids it.
 */
export function elapsedSecondsSinceMs(startMs: number): number {
  return Math.max(0, Math.floor((Date.now() - startMs) / 1000));
}
