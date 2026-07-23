/**
 * KpiStack — hero-right panel with 4 KPI tiles.
 *
 * - Active tasks: in_progress + todo from useDashboard()
 * - Live agents: live count from SSE sessions
 * - Attention queue: blocked_count + inbox_count from useDashboard()
 * - Budget burn: from useBudgetBurn() — first daily workspace budget found
 */

import {
  useCallback,
  useState,
  type ReactElement,
  type CSSProperties,
} from "react";
import {
  useDashboard,
  useDashboardTrends,
  useBudgetBurn,
  useSidecarSSE,
  type AgentSession,
} from "../../../lib/api";
import { formatUSD } from "../../../lib/format-helpers";
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
      <div
        className={styles.tile}
        style={{ "--kpi-glow": "rgba(34,197,94,0.12)" } as CSSProperties}
      >
        <div className={styles.label}>Active tasks</div>
        <div className={styles.value}>{inProgress + todo}</div>
        <div className={styles.foot}>
          <strong>{inProgress}</strong> in progress · <strong>{todo}</strong>{" "}
          ready
        </div>
      </div>

      {/* Tile 2: Live agents */}
      <div
        className={styles.tile}
        style={{ "--kpi-glow": "rgba(168,85,247,0.14)" } as CSSProperties}
      >
        <div className={styles.label}>Live agents</div>
        <div className={styles.value}>
          {activeSessions.length}
          <span className={styles.unit}>running</span>
        </div>
        <div className={styles.foot}>
          <strong>{sessionsToday}</strong> sessions today
        </div>
      </div>

      {/* Tile 3: Attention queue */}
      <div
        className={styles.tile}
        style={{ "--kpi-glow": "rgba(239,68,68,0.14)" } as CSSProperties}
      >
        <div className={styles.label}>Attention queue</div>
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
        <div className={styles.foot}>
          {attentionTotal > 0
            ? `${attentionTotal} item${attentionTotal !== 1 ? "s" : ""} need a decision today`
            : "Nothing needs attention"}
        </div>
      </div>

      {/* Tile 4: Budget burn */}
      <div
        className={styles.tile}
        style={{ "--kpi-glow": "rgba(59,130,246,0.14)" } as CSSProperties}
      >
        <div className={styles.label}>Budget burn</div>
        {dailyBurn ? (
          <>
            <div className={styles.value}>
              {budgetPct.toFixed(0)}%
              <span className={styles.unit}>
                of {formatUSD(dailyBurn.limit_usd)} daily
              </span>
            </div>
            <div className={styles.budgetBar}>
              <div
                className={styles.budgetFill}
                style={{ width: `${budgetPct}%` }}
              />
            </div>
            <div className={styles.foot}>
              {formatUSD(dailyBurn.spent_usd)} spent ·{" "}
              <strong>
                {formatUSD(dailyBurn.limit_usd - dailyBurn.spent_usd)} left
              </strong>
            </div>
          </>
        ) : (
          <>
            <div className={styles.value}>—</div>
            <div className={styles.noBudget}>No budget configured</div>
          </>
        )}
      </div>
    </div>
  );
}
