/**
 * KpiStack — hero-right panel with 4 KPI tiles.
 *
 * - Active tasks: in_progress + todo from useDashboard()
 * - Live agents: live count from SSE sessions
 * - Attention queue: blocked_count + inbox_count from useDashboard()
 * - Budget burn: from useBudgetBurn() — first daily workspace budget found
 *
 * The tile box is `../kpi-tile`, not this file's stylesheet: #166 needed the
 * same box on Mission Control's record row and the design's numbers for it
 * (r12, 96px floor, corner glow) may exist in exactly one place. This component
 * kept every figure it had; only the box around each one changed hands.
 */

import { useCallback, useState, type ReactElement } from "react";
import {
  useDashboard,
  useDashboardTrends,
  useBudgetBurn,
  useSidecarSSE,
  type AgentSession,
} from "../../../lib/api";
import { formatUSD } from "../../../lib/format-helpers";
import { KpiTile, KPI_UNAVAILABLE } from "../kpi-tile";
import styles from "./kpi-stack.module.css";

// ─── Live sessions hook (reuses the same SSE pattern as LiveAgentsWidget) ─────

function useLiveSessions(): AgentSession[] {
  const [sessions, setSessions] = useState<AgentSession[]>([]);

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
  return sessions;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function KpiStack(): ReactElement {
  const dashQ = useDashboard();
  const trends7Q = useDashboardTrends(7);
  const budgetBurnQ = useBudgetBurn();
  const sessions = useLiveSessions();

  // Active tasks
  const counts = dashQ.data?.task_counts;
  const inProgress = counts?.["in-progress"] ?? 0;
  const todo = counts?.todo ?? 0;

  // Live agents
  const activeSessions = sessions.filter(
    (s) => s.status === "active" || s.status === "idle",
  );
  const sessionsToday = trends7Q.data?.agent_runs.at(-1) ?? 0;

  // Attention queue
  const blockedCount = counts?.blocked ?? 0;
  const inboxCount = dashQ.data?.inbox_count ?? 0;
  const attentionTotal = blockedCount + inboxCount;

  // Budget burn — find the first workspace/global daily budget
  const dailyBurn = budgetBurnQ.data?.find(
    (b) => b.period === "daily" && b.enabled,
  );
  const budgetPct = dailyBurn
    ? Math.min(100, (dailyBurn.spent_usd / dailyBurn.limit_usd) * 100)
    : 0;

  return (
    <div className={styles.grid}>
      {/* Tile 1: Active tasks */}
      <KpiTile
        label="Active tasks"
        glow="rgba(34,197,94,0.12)"
        value={inProgress + todo}
        foot={
          <>
            <strong>{inProgress}</strong> in progress · <strong>{todo}</strong>{" "}
            ready
          </>
        }
      />

      {/* Tile 2: Live agents */}
      <KpiTile
        label="Live agents"
        glow="rgba(168,85,247,0.14)"
        value={activeSessions.length}
        unit="running"
        foot={
          <>
            <strong>{sessionsToday}</strong> sessions today
          </>
        }
      />

      {/* Tile 3: Attention queue */}
      <KpiTile
        label="Attention queue"
        glow="rgba(239,68,68,0.14)"
        foot={
          attentionTotal > 0
            ? `${attentionTotal} item${attentionTotal !== 1 ? "s" : ""} need a decision today`
            : "Nothing needs attention"
        }
      >
        <div className={styles.chips}>
          {blockedCount > 0 && (
            <span className={`${styles.chip} ${styles.err}`}>
              ▲ {blockedCount} blocked
            </span>
          )}
          {inboxCount > 0 && (
            <span className={`${styles.chip} ${styles.warn}`}>
              ◷ {inboxCount} inbox
            </span>
          )}
          {blockedCount === 0 && inboxCount === 0 && (
            <span className={`${styles.chip} ${styles.ok}`}>✓ all clear</span>
          )}
        </div>
      </KpiTile>

      {/* Tile 4: Budget burn */}
      {dailyBurn ? (
        <KpiTile
          label="Budget burn"
          glow="rgba(59,130,246,0.14)"
          value={`${budgetPct.toFixed(0)}%`}
          unit={`of ${formatUSD(dailyBurn.limit_usd)} daily`}
          foot={
            <>
              {formatUSD(dailyBurn.spent_usd)} spent ·{" "}
              <strong>
                {formatUSD(dailyBurn.limit_usd - dailyBurn.spent_usd)} left
              </strong>
            </>
          }
        >
          <div className={styles.budgetBar}>
            <div
              className={styles.budgetFill}
              style={{ width: `${budgetPct}%` }}
            />
          </div>
        </KpiTile>
      ) : (
        <KpiTile
          label="Budget burn"
          glow="rgba(59,130,246,0.14)"
          value={KPI_UNAVAILABLE}
        >
          <div className={styles.noBudget}>No budget configured</div>
        </KpiTile>
      )}
    </div>
  );
}
