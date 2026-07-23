/**
 * Pure routing helper: maps a notification kind + payload to the in-app
 * destination URL. Deep-links where a specific item id is available; falls
 * back to the nearest list page otherwise.
 *
 * Kept in its own module so it can be unit-tested without importing React.
 */
import type { Notification } from "./api";

export function notifRoute(n: Notification): string {
  try {
    const payload = n.payload_json
      ? (JSON.parse(n.payload_json) as Record<string, unknown>)
      : {};
    switch (n.type) {
      case "task_assigned":
      case "blocker_resolved":
        return typeof payload["task_id"] === "number"
          ? `/tasks/${payload["task_id"]}`
          : "/tasks";
      case "session_failed":
      case "session_info":
        return typeof payload["session_id"] === "string" &&
          payload["session_id"]
          ? `/command?session=${encodeURIComponent(payload["session_id"])}`
          : "/command";
      case "cost_threshold":
        return "/command";
      case "budget_threshold":
        return "/budgets";
      case "inbox_new":
        return typeof payload["inbox_id"] === "number"
          ? `/inbox?focus=${payload["inbox_id"]}`
          : "/inbox";
      default:
        return "/";
    }
  } catch {
    return "/";
  }
}
