/**
 * ActiveSessions — live-zone left panel.
 *
 * Subscribes to the SSE agent stream via useSidecarSSE (same pattern as
 * LiveAgentsWidget in the existing widget system). Shows a list of active
 * sessions with avatar, info, status pill, and cost.
 */

import { useCallback, useState, type ReactElement } from "react";
import { useSidecarSSE, type AgentSession } from "../../../lib/api";
import {
  formatUSD,
  formatCount,
  formatDuration,
  secondsSince,
} from "../../../lib/format-helpers";
import styles from "./active-sessions.module.css";

type FilterKind = "all" | "working" | "idle";

// ─── Avatar gradient by provider hint ────────────────────────────────────────

function avatarGradient(profile: string): string {
  const p = profile.toLowerCase();
  if (p.includes("claude") || p.includes("anthropic")) {
    return "linear-gradient(135deg,#d28d4f,#b56b30)";
  }
  if (p.includes("gpt") || p.includes("openai")) {
    return "linear-gradient(135deg,#10a37f,#0c7d62)";
  }
  // Default / local
  return "linear-gradient(135deg,#3b82f6,#6e7cff)";
}

function initials(profile: string): string {
  const parts = profile
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (parts.length >= 2) {
    return `${(parts[0]?.[0] ?? "").toUpperCase()}${(parts[1]?.[0] ?? "").toUpperCase()}`;
  }
  return profile.slice(0, 2).toUpperCase();
}

function statusClass(status: AgentSession["status"]): string {
  switch (status) {
    case "active":
      return styles.working ?? "";
    case "idle":
      return styles.idle ?? "";
    case "stopped":
      return styles.waiting ?? "";
    case "ended":
      return styles.ended ?? "";
    default:
      return styles.idle ?? "";
  }
}

function statusLabel(status: AgentSession["status"]): string {
  switch (status) {
    case "active":
      return "working";
    case "idle":
      return "idle";
    case "stopped":
      return "awaiting";
    case "ended":
      return "ended";
    default:
      return status;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ActiveSessions(): ReactElement {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [filter, setFilter] = useState<FilterKind>("all");

  const handleSSE = useCallback((data: unknown, eventName: string) => {
    if (eventName === "snapshot") {
      const payload = data as { sessions?: AgentSession[] };
      setSessions(payload.sessions ?? []);
    } else if (eventName === "session_started" || eventName === "update") {
      const s = data as AgentSession;
      setSessions((prev) => {
        const idx = prev.findIndex((x) => x.session_id === s.session_id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = s;
          return next;
        }
        return [s, ...prev];
      });
    } else if (
      eventName === "session_ended" ||
      eventName === "session_removed"
    ) {
      const payload = data as { session_id?: string };
      if (payload.session_id) {
        setSessions((prev) =>
          prev.filter((x) => x.session_id !== payload.session_id),
        );
      }
    }
  }, []);

  useSidecarSSE("agents", handleSSE);

  const runningCount = sessions.filter((s) => s.status === "active").length;

  const visible = sessions.filter((s) => {
    if (filter === "working") return s.status === "active";
    if (filter === "idle") return s.status === "idle" || s.status === "stopped";
    return true;
  });

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div className={styles.sectionLabel}>
          Active sessions
          <span className={styles.tag}>{runningCount} running</span>
        </div>
        <div className={styles.filters}>
          {(["all", "working", "idle"] as FilterKind[]).map((f) => (
            <button
              key={f}
              type="button"
              className={`${styles.filterBtn} ${filter === f ? styles.active : ""}`}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>No active sessions</div>
          <div className={styles.emptyHint}>Launch one from the omnibar →</div>
        </div>
      ) : (
        <div className={styles.list}>
          {visible.map((s) => {
            const runtimeSec = secondsSince(s.started_at);
            const isDimmed = s.status === "ended";
            return (
              <div
                key={s.session_id}
                className={`${styles.session} ${isDimmed ? styles.dimmed : ""}`}
              >
                {/* Avatar */}
                <div
                  className={styles.avatar}
                  style={{ background: avatarGradient(s.profile) }}
                >
                  {initials(s.profile)}
                </div>

                {/* Info */}
                <div className={styles.info}>
                  <div className={styles.title}>
                    {s.profile}
                    {s.model && (
                      <span className={styles.provider}>{s.model}</span>
                    )}
                  </div>
                  <div className={styles.sub}>
                    {s.project_name && <span>{s.project_name}</span>}
                    {/* Which client started this session (#153 P1, Lane C).
                        Renders the raw `entrypoint` string — three values exist
                        on this machine (claude-desktop, cli, sdk-cli) and the
                        set is open, so a fixed per-client colour would
                        mis-render the first value nobody has seen yet. Absent
                        (a pre-009 sidecar) and null (scanner has not reached
                        this session) both render the same dashed "unknown",
                        because the app genuinely does not know either way. */}
                    <span
                      className={`${styles.subSep} ${styles.source}${
                        s.source_app ? "" : ` ${styles.sourceUnknown}`
                      }`}
                      title={
                        s.source_app
                          ? `Started by ${s.source_app}${
                              s.cli_version ? ` · CLI ${s.cli_version}` : ""
                            }`
                          : "No transcript has been read for this session yet"
                      }
                    >
                      {s.source_app ?? "unknown"}
                    </span>
                    {s.current_tool && (
                      <span className={styles.subSep}>{s.current_tool}</span>
                    )}
                    {/* Compaction marker. The design calls this "the one
                        element worth arguing for": context exhaustion is the
                        commonest silent failure in a long agent session and no
                        client shows it as history — you only ever see the
                        current number, after the fact. `> 0` rather than
                        `!= null` so a scanned session that was never compacted
                        stays quiet instead of displaying a zero badge. */}
                    {(s.compaction_count ?? 0) > 0 && (
                      <span
                        className={`${styles.subSep} ${styles.compacted}`}
                        title={
                          s.context_peak_tokens
                            ? `Peak context ${formatCount(
                                s.context_peak_tokens,
                              )} tokens before compaction`
                            : "This session was compacted"
                        }
                      >
                        compacted ×{s.compaction_count}
                      </span>
                    )}
                    <span className={styles.subSep}>
                      {formatDuration(runtimeSec)}
                    </span>
                  </div>
                </div>

                {/* Status */}
                <div
                  className={`${styles.statusPill} ${statusClass(s.status)}`}
                >
                  <span className={styles.statusDot} />
                  {statusLabel(s.status)}
                </div>

                {/* Cost */}
                <div className={styles.cost}>
                  {formatUSD(s.cost_usd)}
                  <div className={styles.costDelta}>
                    {s.status === "ended" ? "final" : "running"}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
