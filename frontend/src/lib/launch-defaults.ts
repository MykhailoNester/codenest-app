/**
 * launch-defaults.ts — sticky "last used" launch preferences.
 *
 * Moved out of the deleted `launch-modal.tsx` verbatim: same
 * `localStorage` key, same shape, same behaviour. `launch-composer-dialog.tsx`
 * reads this once per mount (for the top-bar/OmniBar launch, and as the
 * `has_override: false` fallback for a seeded one — see design decision 6 in
 * the plan) and writes it after every successful launch.
 *
 * This is deliberately distinct from `launch_source_overrides` (the
 * sidecar's per-task/per-inbox-item memory, read via `GET
 * /api/v1/launch/seed`): this key is the user's global "last target/profile
 * I picked", with no source attached.
 */

import type { LaunchTarget } from "./launch-seed";

export const LAUNCH_DEFAULTS_KEY = "codenest.launch.defaults";

export interface StoredLaunchDefaults {
  provider_id?: number;
  target?: LaunchTarget;
  /** Written by the deleted grid modal; read by nobody now — preserved on
   *  write (see `saveLaunchDefaults`) so a downgrade is not lossy. */
  rows?: number;
  cols?: number;
  profile_id?: number | null;
}

export function loadLaunchDefaults(): StoredLaunchDefaults {
  try {
    const raw = localStorage.getItem(LAUNCH_DEFAULTS_KEY);
    if (raw) return JSON.parse(raw) as StoredLaunchDefaults;
  } catch {
    // ignore corrupt storage
  }
  return {};
}

/** Merges `patch` over whatever is already stored, so a field this ticket
 *  does not own (`rows`/`cols`, written only by the deleted modal) survives
 *  the upgrade untouched. */
export function saveLaunchDefaults(patch: Partial<StoredLaunchDefaults>): void {
  try {
    const merged = { ...loadLaunchDefaults(), ...patch };
    localStorage.setItem(LAUNCH_DEFAULTS_KEY, JSON.stringify(merged));
  } catch {
    // ignore quota errors
  }
}
