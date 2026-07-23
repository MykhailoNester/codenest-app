/**
 * MomentumTimeline — full-width bottom panel.
 *
 * A 1200×130 SVG horizontal timeline showing activity over the last 24 hours.
 *
 * Data sources:
 * - Commits: getRecentCommits() IPC call across all project root paths
 * - Sessions / task completions: useDashboard().recent_activity
 *   (filtered by entity_type / action).
 *
 * Data availability notes:
 * - recent_activity carries ActivityEntry rows with entity_type + action fields.
 *   We classify: task→done as task completions and session as session events.
 *   Only events classifiable from available fields are rendered.
 * - Commits need project root_paths; if a project has no root_path it is skipped.
 * - Glyph positions are computed by linear interpolation of event timestamps
 *   against the [now-24h, now] window.
 */

import { useEffect, useState, useMemo, type ReactElement } from "react";
import { useDashboard, useProjects } from "../../../lib/api";
import { getRecentCommits, type CommitEntry } from "../../../lib/ipc";
import type { ActivityEntry } from "../../../lib/api";
import styles from "./momentum-timeline.module.css";

// ─── Constants ────────────────────────────────────────────────────────────────

const SVG_W = 1200;
const SVG_H = 130;
const BASELINE_Y = 65;
const NOW_X = 1150;
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeToX(isoDate: string): number | null {
  const t = new Date(isoDate).getTime();
  const now = Date.now();
  const start = now - WINDOW_MS;
  if (t < start || t > now) return null;
  return Math.round(((t - start) / WINDOW_MS) * NOW_X);
}

function buildHourTicks(): Array<{ x: number; label: string }> {
  const ticks: Array<{ x: number; label: string }> = [];
  const now = Date.now();
  // Ticks every 3 hours from -24h to -3h
  for (let h = 24; h >= 3; h -= 3) {
    const t = now - h * 3600 * 1000;
    const x = Math.round(((t - (now - WINDOW_MS)) / WINDOW_MS) * NOW_X);
    const d = new Date(t);
    const label = `${String(d.getHours()).padStart(2, "0")}:00`;
    ticks.push({ x, label });
  }
  return ticks;
}

// ─── Glyph renderers ─────────────────────────────────────────────────────────

function CommitGlyph({ x, y }: { x: number; y: number }): ReactElement {
  return (
    <rect
      x={x - 4.5}
      y={y - 4.5}
      width="9"
      height="9"
      transform={`rotate(45 ${x} ${y})`}
      fill="var(--accent)"
      stroke="rgba(59,130,246,0.30)"
      strokeWidth="2"
    />
  );
}

function SessionGlyph({ x, y }: { x: number; y: number }): ReactElement {
  return (
    <circle
      cx={x}
      cy={y}
      r="3.5"
      fill="var(--violet)"
      stroke="rgba(168,85,247,0.35)"
      strokeWidth="2"
    />
  );
}

function TaskGlyph({ x }: { x: number }): ReactElement {
  const y = 95;
  return (
    <polygon
      points={`${x},${y} ${x + 6},${y + 10} ${x - 6},${y + 10}`}
      fill="var(--ok)"
      stroke="rgba(34,197,94,0.30)"
      strokeWidth="2"
    />
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MomentumTimeline(): ReactElement {
  const dashQ = useDashboard();
  const projectsQ = useProjects();
  const [commits, setCommits] = useState<CommitEntry[]>([]);

  // Fetch commits from all projects with a root_path
  useEffect(() => {
    const paths = (projectsQ.data ?? [])
      .map((p) => p.root_path)
      .filter((r): r is string => typeof r === "string" && r.length > 0);

    if (paths.length === 0) return;

    void getRecentCommits({ paths, limit: 30 })
      .then(setCommits)
      .catch(() => {
        // Silently swallow — IPC may not be available in browser dev mode
      });
  }, [projectsQ.data]);

  // Classify recent_activity entries
  const activity = useMemo<ActivityEntry[]>(() => {
    return dashQ.data?.recent_activity ?? [];
  }, [dashQ.data]);

  const taskEvents = useMemo(
    () =>
      activity.filter(
        (e) =>
          e.entity_type === "task" &&
          e.action === "status_changed" &&
          e.new_value === "done",
      ),
    [activity],
  );

  const sessionEvents = useMemo(
    () => activity.filter((e) => e.entity_type === "session"),
    [activity],
  );

  const hourTicks = useMemo(() => buildHourTicks(), []);

  // Count glyphs for footer summary
  const commitCount = commits.filter((c) => timeToX(c.date) !== null).length;
  const sessionCount = sessionEvents.filter(
    (e) => timeToX(e.created_at) !== null,
  ).length;
  const taskCount = taskEvents.filter(
    (e) => timeToX(e.created_at) !== null,
  ).length;

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div className={styles.sectionLabel}>Momentum · last 24 hours</div>
        <div className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={`${styles.legendGlyph} ${styles.commit}`} />
            commit
          </span>
          <span className={styles.legendItem}>
            <span className={`${styles.legendGlyph} ${styles.session}`} />
            session
          </span>
          <span className={styles.legendItem}>
            <span className={`${styles.legendGlyph} ${styles.task}`} />
            task done
          </span>
        </div>
      </div>

      <div className={styles.timeline}>
        <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} preserveAspectRatio="none">
          {/* Baseline */}
          <line
            x1="0"
            y1={BASELINE_Y}
            x2={SVG_W}
            y2={BASELINE_Y}
            stroke="rgba(255,255,255,0.06)"
          />

          {/* Hour ticks + labels */}
          <g stroke="rgba(255,255,255,0.04)">
            {hourTicks.map((t) => (
              <line
                key={t.x}
                x1={t.x}
                y1={BASELINE_Y - 7}
                x2={t.x}
                y2={BASELINE_Y + 7}
              />
            ))}
          </g>
          <g fill="var(--fg-4)" fontSize="9" fontFamily="var(--font-mono)">
            {hourTicks.map((t) => (
              <text key={t.x} x={t.x} y={SVG_H - 10} textAnchor="middle">
                {t.label}
              </text>
            ))}
          </g>

          {/* Commits — diamonds at y=36 */}
          {commits.map((c) => {
            const x = timeToX(c.date);
            if (x === null) return null;
            return <CommitGlyph key={c.shortHash + c.repoPath} x={x} y={36} />;
          })}

          {/* Sessions — circles along baseline */}
          {sessionEvents.map((e) => {
            const x = timeToX(e.created_at);
            if (x === null) return null;
            return <SessionGlyph key={e.id} x={x} y={BASELINE_Y} />;
          })}

          {/* Task completions — green triangles below baseline */}
          {taskEvents.map((e) => {
            const x = timeToX(e.created_at);
            if (x === null) return null;
            return <TaskGlyph key={e.id} x={x} />;
          })}

          {/* "Now" pulsing indicator */}
          <line
            x1={NOW_X}
            y1="20"
            x2={NOW_X}
            y2="110"
            stroke="var(--ok)"
            strokeWidth="1"
            strokeDasharray="2,3"
            opacity="0.5"
          />
          <circle cx={NOW_X} cy={BASELINE_Y} r="6" fill="var(--ok)">
            <animate
              attributeName="r"
              values="5;9;5"
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
          <text
            x={NOW_X}
            y="14"
            fill="var(--ok)"
            fontSize="9"
            fontFamily="var(--font-mono)"
            textAnchor="middle"
          >
            NOW
          </text>
        </svg>
      </div>

      <div className={styles.foot}>
        <span>
          {commitCount} commit{commitCount !== 1 ? "s" : ""} · {sessionCount}{" "}
          session{sessionCount !== 1 ? "s" : ""} · {taskCount} task
          {taskCount !== 1 ? "s" : ""} done
        </span>
        <span>tap any glyph for context →</span>
      </div>
    </div>
  );
}
