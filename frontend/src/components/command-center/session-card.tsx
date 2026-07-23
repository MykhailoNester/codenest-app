import { memo, type ReactElement } from "react";
import type { AgentSession, ProfileOut } from "../../lib/api";
import { profileColor } from "../../lib/profile-utils";
import { formatElapsed } from "../../lib/format-helpers";
import { agentStatusClass } from "./status-utils";

interface SessionCardProps {
  session: AgentSession;
  selected: boolean;
  onSelect: (id: string) => void;
  profiles: ProfileOut[];
}

function projectLabel(s: AgentSession): string {
  if (s.project_name) return s.project_name;
  if (s.cwd) {
    const parts = s.cwd.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? s.cwd;
  }
  return "unknown";
}

function buildSparkline(seed: string, totalCalls: number): number[] {
  // Stable pseudo-random bars seeded by session_id
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const bars = 10;
  return Array.from({ length: bars }, (_, i) => {
    const r = ((h * (i + 1) * 2654435761) >>> 0) / 0xffffffff;
    const base = totalCalls > 0 ? 20 : 5;
    return Math.max(base, Math.round(r * 100));
  });
}

const fmtElapsed = formatElapsed;

const statusClass = agentStatusClass;

function SessionCardInner({
  session,
  selected,
  onSelect,
  profiles,
}: SessionCardProps): ReactElement {
  const color = profileColor(profiles, session.profile);
  const project = projectLabel(session);
  const elapsed = fmtElapsed(session.started_at, session.ended_at);

  return (
    <button
      className={`d3-card d3-card--${session.status}${selected ? " is-selected" : ""}`}
      style={{ "--ac": color } as React.CSSProperties}
      onClick={() => onSelect(session.session_id)}
      type="button"
    >
      <div className="d3-card__head">
        <div className="d3-card__agent">
          <span
            className="d3-card__avatar"
            style={{ background: color + "33", color }}
          >
            {session.profile[0]?.toUpperCase() ?? "?"}
          </span>
          <div>
            <div className="d3-card__name">{session.profile}</div>
            <div className="d3-card__role">{project}</div>
          </div>
        </div>
        <div className={statusClass(session.status)}>
          {session.status === "active" && <span className="d3-status__pulse" />}
          {session.status}
        </div>
      </div>

      <div className="d3-card__task">
        {session.initial_prompt ?? "(no prompt yet)"}
      </div>

      <div className="d3-card__foot">
        <span className="d3-tag mono">
          <span className="d3-tag__dot" style={{ background: color }} />
          {session.profile}
        </span>
        <span className="d3-tag mono">{project}</span>
        {session.model && (
          <span className="d3-tag mono" style={{ color: "var(--fg-3)" }}>
            {session.model.split("-").slice(0, 2).join("-")}
          </span>
        )}
        {session.current_tool && (
          <span className="d3-tag mono" style={{ color: "var(--warn)" }}>
            {session.current_tool}
          </span>
        )}
        {session.cost_usd > 0 && (
          <span className="d3-card__cost tabular">
            ${session.cost_usd.toFixed(3)}
          </span>
        )}
      </div>

      <div className="d3-card__sparkrow">
        <div className="d3-mini" aria-hidden="true">
          {buildSparkline(session.session_id, session.total_tool_calls).map(
            (h, i) => (
              <span
                key={i}
                className="d3-mini__b"
                style={{ height: `${h}%`, background: color }}
              />
            ),
          )}
        </div>
        <span className="d3-card__time tabular mono">
          {session.total_tool_calls} calls · {elapsed}
        </span>
      </div>
    </button>
  );
}

function sessionsEqual(
  prev: SessionCardProps,
  next: SessionCardProps,
): boolean {
  if (prev.selected !== next.selected) return false;
  if (prev.onSelect !== next.onSelect) return false;
  // `profiles` ref is treated as effectively immutable — see
  // constellationEqual for rationale.
  const a = prev.session;
  const b = next.session;
  return (
    a.session_id === b.session_id &&
    a.status === b.status &&
    a.current_tool === b.current_tool &&
    a.cost_usd === b.cost_usd &&
    a.total_tool_calls === b.total_tool_calls
  );
}

export const SessionCard = memo(SessionCardInner, sessionsEqual);
