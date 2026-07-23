/**
 * Shared display helpers for command-center components.
 */

import type { EventLike } from "./event-detail-modal";

/**
 * Returns the Direction-3 CSS class string for an agent/session status value.
 * Used by both SessionCard and AgentRunRow so the mapping stays in one place.
 */
export function agentStatusClass(
  status: "active" | "idle" | "ended" | string,
): string {
  if (status === "active") return "d3-status d3-status--active";
  if (status === "idle") return "d3-status d3-status--idle";
  return "d3-status d3-status--ended";
}

/**
 * Returns a human-readable label for an agent event_type.
 * Canonical source: covers all event types seen in live-activity and replay-panel.
 */
export function eventLabel(ev: EventLike): string {
  if (ev.event_type === "UserPromptSubmit") return "Prompt";
  if (ev.event_type === "SessionStart") return "Started";
  if (ev.event_type === "SessionEnd") return "Ended";
  if (ev.event_type === "Stop") return "Idle";
  if (ev.event_type === "PreToolUse") return ev.tool_name ?? "Tool";
  if (ev.event_type === "PostToolUse") return `✓ ${ev.tool_name ?? "Tool"}`;
  return ev.event_type;
}
