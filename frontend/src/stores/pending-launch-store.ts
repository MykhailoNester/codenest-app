/**
 * pending-launch-store.ts — cross-window launch handoff via localStorage.
 *
 * Design decision D4 from design.md:
 *   Each Tauri window has its own JS context, so direct Zustand sharing is
 *   impossible.  We use `localStorage` + the `storage` event, which fires in
 *   every window that did NOT initiate the write, as the broadcast channel.
 *
 * Slot: `localStorage.getItem("codenest.pendingLaunch")`
 *   - null  → no pending launch
 *   - JSON  → serialized `PaneLaunchSpec` waiting for the matching target window
 *
 * The slot holds exactly one shape now that the grid-modal's `LaunchSpec` is
 * gone (task #35): a `PaneLaunchSpec`. A spec queued by a pre-upgrade build
 * of the app can still be sitting in localStorage across the upgrade, so
 * every read boundary below (`consume`, `subscribe`, `hasPendingPopoutLaunch`)
 * validates with `isPaneLaunchSpec` (`lib/launch.ts`) and drops anything that
 * fails it, rather than making every consumer branch on shape.
 *
 * Atomic CAS in `consume`:
 *   Read the slot, write `null` back atomically.  Only the first reader
 *   whose `target` matches sees a non-null value; subsequent reads return null.
 *
 * Filtering by `target`:
 *   The popout window only consumes `target === "popout"`.
 *   The main window only consumes  `target === "embedded"`.
 *   A mismatch leaves the slot intact so the correct window can claim it.
 */

import { isPaneLaunchSpec, type PaneLaunchSpec } from "../lib/launch";

const STORAGE_KEY = "codenest.pendingLaunch";

// ---------------------------------------------------------------------------
// enqueue
// ---------------------------------------------------------------------------

/**
 * Write `spec` into the pending-launch slot.
 * Overwrites any previously queued spec.
 */
export function enqueue(spec: PaneLaunchSpec): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(spec));
  } catch {
    // localStorage may be unavailable (private-browsing quota, WebView sandbox).
    // Silently swallow — the launch will simply not propagate to the other window.
  }
}

// ---------------------------------------------------------------------------
// consume
// ---------------------------------------------------------------------------

/**
 * Atomically read and clear the pending-launch slot.
 *
 * Returns the queued `PaneLaunchSpec` if:
 *   - a spec is present, AND
 *   - `spec.target === target`, AND
 *   - the spec is a `PaneLaunchSpec` (`isPaneLaunchSpec`) — a spec queued by
 *     a pre-upgrade build (the old grid modal's `LaunchSpec`) is claimed and
 *     dropped here rather than returned, with one `console.warn`.
 *
 * Returns `null` and leaves the slot unchanged when the target does not match,
 * so the correct window can still claim the spec later.
 *
 * Returns `null` when the slot is empty or contains invalid JSON.
 */
export function consume(target: "embedded" | "popout"): PaneLaunchSpec | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }

  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt slot — clear it and return null.
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    return null;
  }

  if ((parsed as { target?: unknown } | null)?.target !== target) {
    // Target mismatch: leave the slot intact for the correct window.
    return null;
  }

  // Claim the spec: write null back so subsequent reads return nothing,
  // regardless of whether it turns out to be a legacy shape below.
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }

  if (!isPaneLaunchSpec(parsed)) {
    console.warn(
      "[pending-launch-store] dropped a legacy launch spec queued before the upgrade",
    );
    return null;
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// hasPendingPopoutLaunch
// ---------------------------------------------------------------------------

/**
 * Synchronous peek — returns `true` when a popout launch spec is queued in
 * localStorage but does NOT consume it.  Safe to call during render.
 *
 * Used by `TerminalWindowRoot` to decide whether to suppress the default
 * `hydrateFromStorage` call in `TerminalsLayout` before the consume effect
 * runs (child effects fire before parent effects on mount).
 *
 * Requires `panes` to be an array (not just `target === "popout"`) so a
 * legacy grid spec queued before the upgrade cannot make the popout skip
 * hydration and then open empty once `consume` drops it as unrecognised.
 */
export function hasPendingPopoutLaunch(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return false;
    const spec = JSON.parse(raw) as { target?: string; panes?: unknown };
    return spec.target === "popout" && Array.isArray(spec.panes);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// subscribe
// ---------------------------------------------------------------------------

type LaunchCallback = (spec: PaneLaunchSpec) => void;

/**
 * Subscribe to future cross-window launch broadcasts for the given `target`.
 *
 * When another window calls `enqueue(spec)` with a matching target, this
 * callback fires once and the slot is claimed (consume semantics apply).
 * A legacy (non-`PaneLaunchSpec`) broadcast is claimed and dropped, with one
 * `console.warn`, the same as `consume`.
 *
 * Returns an unsubscribe function — call it on component unmount to avoid
 * memory leaks.
 */
export function subscribe(
  target: "embedded" | "popout",
  cb: LaunchCallback,
): () => void {
  function handleStorage(event: StorageEvent): void {
    if (event.key !== STORAGE_KEY) return;
    if (event.newValue === null) return; // slot was cleared, not written

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.newValue);
    } catch {
      return;
    }

    if ((parsed as { target?: unknown } | null)?.target !== target) return;

    // Claim the spec so no other subscriber fires for it.
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }

    if (!isPaneLaunchSpec(parsed)) {
      console.warn(
        "[pending-launch-store] dropped a legacy launch spec queued before the upgrade",
      );
      return;
    }

    cb(parsed);
  }

  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener("storage", handleStorage);
  };
}
