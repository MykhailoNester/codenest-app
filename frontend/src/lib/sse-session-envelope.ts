import type { AgentSession } from "./api";

/**
 * `agent_service._broadcast` publishes `{kind, session, event?, hud?}` — the
 * session is nested, not the payload itself. Reading the envelope as the
 * session yields `session_id: undefined`, which appends a junk row that later
 * crashes any renderer touching one of its fields.
 */
export function sessionFromDelta(data: unknown): AgentSession | null {
  if (typeof data !== "object" || data === null) return null;
  const nested = (data as { session?: unknown }).session;
  if (typeof nested !== "object" || nested === null) return null;
  const id = (nested as { session_id?: unknown }).session_id;
  return typeof id === "string" && id.length > 0
    ? (nested as AgentSession)
    : null;
}

export function sessionIdFromDelta(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const nested = (data as { session?: unknown }).session;
  const fromNested =
    typeof nested === "object" && nested !== null
      ? (nested as { session_id?: unknown }).session_id
      : undefined;
  const id = fromNested ?? (data as { session_id?: unknown }).session_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
