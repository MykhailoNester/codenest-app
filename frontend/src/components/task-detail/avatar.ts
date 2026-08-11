/**
 * Deterministic `.td-av` avatar helpers, shared by `properties-card.tsx`
 * (the Assignee property row) and `task-detail.tsx` (the title's quickmeta
 * row) — the two call sites this ticket adds.
 *
 * D12 in the plan calls this "duplicated, not extracted": `hashHue`/
 * `initialsOf` already exist per-file in `task-card.tsx`,
 * `active-sessions.tsx` and `session-card.tsx`, and hoisting all of those
 * into a shared `lib/avatar.ts` is listed as a follow-up, not done here.
 * This file is narrower than that follow-up — it only dedupes between this
 * ticket's own two new call sites, in their own `components/task-detail/`
 * directory, so it touches none of the existing three. A plain function
 * export (not a component) also can't live in the same module as
 * `PropertiesCard` without breaking `react-refresh/only-export-components`.
 */

const AVATAR_HUES = [
  "--accent",
  "--ok",
  "--warn",
  "--violet",
  "--info",
  "--err",
] as const;

export function hashHue(name: string): string {
  let sum = 0;
  for (let i = 0; i < name.length; i += 1) sum += name.charCodeAt(i);
  const key = AVATAR_HUES[sum % AVATAR_HUES.length] ?? "--accent";
  return `var(${key})`;
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}
