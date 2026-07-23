/**
 * ActivityPulse — hero-left panel.
 *
 * Shows cost, session count, and tasks-done stats for the last 24h,
 * plus an SVG area chart of cost over time.
 *
 * Data note: useDashboardTrends returns daily-resolution data (one point
 * per day). When only daily resolution is available the chart will have
 * at most 7 data points. Future work can replace this with an hourly
 * endpoint once the sidecar exposes one.
 */

import { useMemo, type ReactElement } from "react";
import { useDailySpend, useDashboardTrends } from "../../../lib/api";
import { formatUSD, formatDelta } from "../../../lib/format-helpers";
import styles from "./activity-pulse.module.css";

// ─── SVG chart helpers ────────────────────────────────────────────────────────

const CHART_W = 800;
const CHART_H = 180;
const CHART_BOTTOM = 165; // y-position representing zero cost

function normalizeSeries(values: number[]): number[] {
  const max = Math.max(...values, 0.001);
  return values.map((v) => v / max);
}

function buildPath(normalized: number[]): string {
  if (normalized.length === 0) return "";
  const step = CHART_W / Math.max(normalized.length - 1, 1);
  const pts = normalized.map((v, i) => {
    const x = i * step;
    const y = CHART_BOTTOM - v * (CHART_BOTTOM - 10);
    return { x, y };
  });

  // Build a smooth cubic bezier path
  let d = `M ${pts[0]?.x ?? 0},${pts[0]?.y ?? CHART_BOTTOM}`;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1]!;
    const curr = pts[i]!;
    const cpX = (prev.x + curr.x) / 2;
    d += ` C ${cpX},${prev.y} ${cpX},${curr.y} ${curr.x},${curr.y}`;
  }
  return d;
}

function buildAreaPath(normalized: number[]): string {
  const linePart = buildPath(normalized);
  if (!linePart) return "";
  return `${linePart} L ${CHART_W},${CHART_BOTTOM} L 0,${CHART_BOTTOM} Z`;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface ActivityPulseProps {
  /** Injected for testing; defaults to live SSE session count. */
  liveSessionCount?: number;
}

export function ActivityPulse({
  liveSessionCount = 0,
}: ActivityPulseProps): ReactElement {
  const spendQ = useDailySpend();
  const trends7Q = useDashboardTrends(7);
  const trends2Q = useDashboardTrends(2);

  const costToday = spendQ.data?.cost_usd ?? 0;
  const costYesterday = trends2Q.data?.cost_usd[0] ?? 0;
  const costDelta = formatDelta(costToday, costYesterday);

  // Sessions today — from trends last 1 day (agent_runs field)
  const sessionsToday = trends7Q.data?.agent_runs.at(-1) ?? 0;
  // Tasks done today — from trends last 1 day
  const tasksDoneToday = trends7Q.data?.tasks_done.at(-1) ?? 0;
  // Task delta vs yesterday
  const tasksDoneYesterday = trends7Q.data?.tasks_done.at(-2) ?? 0;
  const tasksDelta = formatDelta(tasksDoneToday, tasksDoneYesterday);

  const isLoading = trends7Q.isLoading;

  // Build chart points from trends (daily resolution fallback)
  const normalized = useMemo(() => {
    const series = trends7Q.data?.cost_usd ?? [];
    if (series.length === 0) return [];
    return normalizeSeries(series);
  }, [trends7Q.data]);

  const lastX = CHART_W;
  const lastNorm = normalized.at(-1) ?? 0;
  const lastY = CHART_BOTTOM - lastNorm * (CHART_BOTTOM - 10);

  // Event glyph positions — place at each data point
  const eventPoints = useMemo(() => {
    if (normalized.length < 2) return [];
    const step = CHART_W / Math.max(normalized.length - 1, 1);
    return normalized.map((v, i) => ({
      x: i * step,
      y: CHART_BOTTOM - v * (CHART_BOTTOM - 10),
    }));
  }, [normalized]);

  const linePath = buildPath(normalized);
  const areaPath = buildAreaPath(normalized);

  // X-axis labels: last 4 days + "now"
  const xLabels = ["-24h", "-18h", "-12h", "-6h"];
  const xPositions = [0, 200, 400, 600];

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div className={styles.sectionLabel}>Activity Pulse · last 24h</div>
        <div className={styles.meta}>
          <span>
            <span className={styles.liveDot} />
            {liveSessionCount} active
          </span>
          <span>{sessionsToday} sessions today</span>
        </div>
      </div>

      <div className={styles.stats}>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Cost</div>
          <div className={styles.statValue}>{formatUSD(costToday)}</div>
          <div
            className={`${styles.statDelta} ${costDelta.direction === "down" ? styles.down : costDelta.direction === "neutral" ? styles.neutral : ""}`}
          >
            {costDelta.label}
          </div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Sessions</div>
          <div className={styles.statValue}>{sessionsToday}</div>
          <div className={`${styles.statDelta} ${styles.neutral}`}>today</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Tasks done</div>
          <div className={styles.statValue}>{tasksDoneToday}</div>
          <div
            className={`${styles.statDelta} ${tasksDelta.direction === "down" ? styles.down : tasksDelta.direction === "neutral" ? styles.neutral : ""}`}
          >
            {tasksDelta.label}
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className={styles.skeleton}>
          <span className={styles.skeletonText}>loading chart…</span>
        </div>
      ) : (
        <div className={styles.chart}>
          <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none">
            <defs>
              <linearGradient id="apCostFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.45" />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="apCostLine" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#38bdf8" />
                <stop offset="50%" stopColor="#3b82f6" />
                <stop offset="100%" stopColor="#a855f7" />
              </linearGradient>
              <filter id="apGlow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="2.5" />
              </filter>
            </defs>

            {/* Horizontal gridlines */}
            <line
              x1="0"
              y1="45"
              x2={CHART_W}
              y2="45"
              stroke="rgba(255,255,255,0.04)"
            />
            <line
              x1="0"
              y1="90"
              x2={CHART_W}
              y2="90"
              stroke="rgba(255,255,255,0.04)"
            />
            <line
              x1="0"
              y1="135"
              x2={CHART_W}
              y2="135"
              stroke="rgba(255,255,255,0.04)"
            />

            {/* Area fill */}
            {areaPath && <path d={areaPath} fill="url(#apCostFill)" />}

            {/* Glow stroke */}
            {linePath && (
              <>
                <path
                  d={linePath}
                  fill="none"
                  stroke="url(#apCostLine)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  filter="url(#apGlow)"
                  opacity="0.7"
                />
                {/* Crisp top stroke */}
                <path
                  d={linePath}
                  fill="none"
                  stroke="url(#apCostLine)"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </>
            )}

            {/* Event glyphs at each data point */}
            {eventPoints.map((pt, i) => (
              <circle
                key={i}
                cx={pt.x}
                cy={pt.y}
                r="3.5"
                fill="#a855f7"
                stroke="rgba(168,85,247,0.30)"
                strokeWidth="3"
              />
            ))}

            {/* "Now" indicator */}
            <line
              x1={lastX}
              y1="0"
              x2={lastX}
              y2={CHART_H}
              stroke="var(--ok)"
              strokeWidth="1"
              strokeDasharray="2,3"
              opacity="0.5"
            />
            <circle cx={lastX} cy={lastY} r="5" fill="var(--ok)">
              <animate
                attributeName="r"
                values="5;8;5"
                dur="1.6s"
                repeatCount="indefinite"
              />
              <animate
                attributeName="opacity"
                values="1;0.4;1"
                dur="1.6s"
                repeatCount="indefinite"
              />
            </circle>

            {/* X-axis labels */}
            {xLabels.map((label, i) => (
              <text
                key={label}
                x={xPositions[i]}
                y={CHART_H - 2}
                fill="var(--fg-4)"
                fontSize="9"
                fontFamily="var(--font-mono)"
              >
                {label}
              </text>
            ))}
            <text
              x={CHART_W - 2}
              y={CHART_H - 2}
              fill="var(--ok)"
              fontSize="9"
              fontFamily="var(--font-mono)"
              textAnchor="end"
            >
              now
            </text>
          </svg>
        </div>
      )}
    </div>
  );
}
