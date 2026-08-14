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
 *   - JSON  → serialized `AnyLaunchSpec` waiting for the matching target window
 *
 * One slot holds either launch shape (`LaunchSpec`, the rows×cols grid; or
 * `PaneLaunchSpec`, the ordered typed pane list) — never two slots. A second
 * slot would mean `hasPendingPopoutLaunch` has to check both and the two
 * would have to stay in step forever; `isPaneLaunchSpec` (`lib/launch.ts`) is
 * what a consumer narrows the union with.
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

import type { LaunchSpec, PaneLaunchSpec } from "../lib/launch";

/** Either shape the one pending-launch slot can hold. Both members declare
 *  `target` as a required field, so every function below can read it without
 *  narrowing first. */
export type AnyLaunchSpec = LaunchSpec | PaneLaunchSpec;

const STORAGE_KEY = "codenest.pendingLaunch";

// ---------------------------------------------------------------------------
// enqueue
// ---------------------------------------------------------------------------

/**
 * Write `spec` into the pending-launch slot.
 * Overwrites any previously queued spec.
 */
export function enqueue(spec: AnyLaunchSpec): void {
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
 * Returns the queued `AnyLaunchSpec` if:
 *   - a spec is present, AND
 *   - `spec.target === target`.
 *
 * Returns `null` and leaves the slot unchanged when the target does not match,
 * so the correct window can still claim the spec later.
 *
 * Returns `null` when the slot is empty or contains invalid JSON.
 */
export function consume(target: "embedded" | "popout"): AnyLaunchSpec | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }

  if (raw === null) return null;

  let spec: AnyLaunchSpec;
  try {
    spec = JSON.parse(raw) as AnyLaunchSpec;
  } catch {
    // Corrupt slot — clear it and return null.
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    return null;
  }

  if (spec.target !== target) {
    // Target mismatch: leave the slot intact for the correct window.
    return null;
  }

  // Claim the spec: write null back so subsequent reads return nothing.
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }

  return spec;
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
 */
export function hasPendingPopoutLaunch(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return false;
    const spec = JSON.parse(raw) as { target?: string };
    return spec.target === "popout";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// subscribe
// ---------------------------------------------------------------------------

type LaunchCallback = (spec: AnyLaunchSpec) => void;

/**
 * Subscribe to future cross-window launch broadcasts for the given `target`.
 *
 * When another window calls `enqueue(spec)` with a matching target, this
 * callback fires once and the slot is claimed (consume semantics apply).
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

    let spec: AnyLaunchSpec;
    try {
      spec = JSON.parse(event.newValue) as AnyLaunchSpec;
    } catch {
      return;
    }

    if (spec.target !== target) return;

    // Claim the spec so no other subscriber fires for it.
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }

    cb(spec);
  }

  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener("storage", handleStorage);
  };
}
