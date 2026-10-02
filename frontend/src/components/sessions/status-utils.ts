/**
 * Shared display helper. `agentStatusClass` lived here too, mapping a status
 * onto a `d3-status` class for SessionCard and AgentRunRow; #269 replaced both
 * with Deck lines, whose state glyph carries that, so it went with them.
 */

import type { EventLike } from "./event-detail-modal";

/**
 * Returns a human-readable label for an agent event_type.
 * Canonical source: covers all event types seen in the activity feed and in
 * replay-panel.
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
