import type { ProfileOut } from "./api";

export const PROFILE_COLOR_FALLBACK = "#94a3b8";

// Stable sentinel — use `lookups?.profiles ?? NO_PROFILES` instead of
// `?? []`. Preserves referential identity until the real lookups
// payload arrives so React.memo equality on Constellation / SessionCard
// is not falsified on every render before the query resolves.
export const NO_PROFILES: ProfileOut[] = [];

export function profileColor(
  profiles: ProfileOut[] | undefined,
  name: string | null | undefined,
): string {
  if (!name || !profiles) return PROFILE_COLOR_FALLBACK;
  return profiles.find((p) => p.name === name)?.color ?? PROFILE_COLOR_FALLBACK;
}
