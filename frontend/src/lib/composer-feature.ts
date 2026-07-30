/**
 * The provider-free gate for the native agent pane + composer surface.
 *
 * `useEnabledFeatures()` (`api.ts`) cannot be called from inside the
 * pane tree: it is built on `useLookups()` → `useQuery`, and
 * `terminal-tab-persistence.test.tsx` renders `<TerminalsLayout/>` directly,
 * five times, with no `QueryClientProvider` — putting a query in
 * `SplitContainer` or `TerminalsLayout` would turn all five red. Instead this
 * module reads the same `localStorage[FEATURE_CACHE_KEY]` map
 * `useEnabledFeatures()` already writes, falling back to
 * `FEATURE_DEFAULTS.composer` (`false`) when the cache is empty, malformed,
 * or unavailable.
 *
 * Imports only `./nav-items` — no React-query, no zustand, so this stays a
 * leaf any pane-tree component (or the keyboard shortcut hook, which needs a
 * fresh read per keystroke rather than a subscription) can depend on without
 * dragging in a provider.
 */

import { useSyncExternalStore } from "react";
import { FEATURE_DEFAULTS, FEATURE_CACHE_KEY, FEATURE_CACHE_EVENT } from "./nav-items";

/**
 * Pure, synchronous read of the `composer` feature flag. Swallows every
 * failure — no `localStorage` (some WebView contexts), invalid JSON, or a
 * non-boolean value all fall back to `FEATURE_DEFAULTS.composer`.
 */
export function readComposerFeature(): boolean {
  try {
    const raw = localStorage.getItem(FEATURE_CACHE_KEY);
    if (!raw) return FEATURE_DEFAULTS["composer"] === true;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("composer" in parsed)
    ) {
      return FEATURE_DEFAULTS["composer"] === true;
    }
    const value = (parsed as Record<string, unknown>)["composer"];
    return typeof value === "boolean"
      ? value
      : FEATURE_DEFAULTS["composer"] === true;
  } catch {
    return FEATURE_DEFAULTS["composer"] === true;
  }
}

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener(FEATURE_CACHE_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener(FEATURE_CACHE_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

/**
 * React binding over `readComposerFeature`. Re-renders when this window
 * announces a fresh `enabled_features` cache write (`FEATURE_CACHE_EVENT`,
 * same-window) or another window's `storage` event fires (cross-window,
 * best-effort — a WebView `storage` event may lag).
 */
export function useComposerFeature(): boolean {
  return useSyncExternalStore(subscribe, readComposerFeature);
}
