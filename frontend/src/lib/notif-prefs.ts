/**
 * Per-type notification preferences, shared between the Settings UI (which
 * edits them) and ToastHost (which honours them when delivering live events).
 *
 * Stored as the `notification_prefs_json` app setting: a JSON object mapping
 * notification `type` → `{ toast, native }`. `toast` controls the in-app
 * Sonner toast; `native` controls the macOS Notification Center notification.
 */

export interface NotifPrefs {
  [key: string]: { toast: boolean; native: boolean };
}

/** Defaults applied when a type has no stored preference yet. */
export const DEFAULT_PREFS: NotifPrefs = {
  task_assigned: { toast: true, native: false },
  blocker_resolved: { toast: true, native: false },
  session_completed: { toast: true, native: false },
  session_failed: { toast: true, native: true },
  session_info: { toast: true, native: false },
  cost_threshold: { toast: true, native: true },
  budget_threshold: { toast: true, native: true },
};

/** Shared react-query key so the Settings editor and ToastHost share one cache. */
export const NOTIF_QUERY_KEY = ["settings", "notification_prefs_json"] as const;

/**
 * Parse the raw `value_json` string from the settings row into a NotifPrefs
 * object.  Handles three cases:
 *   1. Not yet persisted → returns DEFAULT_PREFS.
 *   2. Correctly stored as a JSON object string → merged over defaults.
 *   3. Previously double-encoded (legacy corruption) → unwraps one extra layer.
 */
export function parseNotifPrefs(raw: string | null | undefined): NotifPrefs {
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Merge with defaults so new keys introduced by later releases are
      // visible to existing users without a DB migration.
      return { ...DEFAULT_PREFS, ...(parsed as NotifPrefs) };
    }
    // Legacy double-encoding: the value is a string (the inner JSON).
    if (typeof parsed === "string") {
      const inner: unknown = JSON.parse(parsed);
      if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
        return { ...DEFAULT_PREFS, ...(inner as NotifPrefs) };
      }
    }
    return { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Resolve the effective preference for a notification type. */
export function prefFor(prefs: NotifPrefs, type: string | undefined): {
  toast: boolean;
  native: boolean;
} {
  return (type && prefs[type]) || { toast: true, native: false };
}
