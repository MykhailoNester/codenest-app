/**
 * ProjectsPulse — live-zone right panel.
 *
 * Shows all imported projects with a status indicator and task count.
 *
 * Status heuristic (from project.status field):
 *   "active" / "in development" → act (green)
 *   "stable" / "production" / "post-mvp" / "mvp complete" → idle (blue)
 *   "planned" → cold
 *   anything else → idle
 */

import { type ReactElement } from "react";
import { useProjects, type Project } from "../../../lib/api";
import { isHiddenCatchAllProject } from "../../../lib/project-display";
import styles from "./projects-pulse.module.css";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type DotStatus = "act" | "idle" | "warn" | "cold";

function projectDotStatus(p: Project): DotStatus {
  const s = (p.status ?? "").toLowerCase();
  if (s === "active" || s === "in development") return "act";
  if (
    s === "stable" ||
    s === "production" ||
    s === "post-mvp" ||
    s === "mvp complete"
  )
    return "idle";
  if (s === "planned") return "cold";
  return "idle";
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProjectsPulse(): ReactElement {
  const projectsQ = useProjects();
  // Hide the empty internal "Unassigned" catch-all (shared filter — see
  // isHiddenCatchAllProject) so the count + list match the Projects page.
  const projects = (projectsQ.data ?? []).filter(
    (p) => !isHiddenCatchAllProject(p),
  );

  // Workspace project first, then the rest sorted alphabetically
  const workspace = projects.filter((p) => p.is_workspace === 1);
  const regular = projects
    .filter((p) => p.is_workspace !== 1)
    .sort((a, b) => a.name.localeCompare(b.name));
  const sorted = [...workspace, ...regular];

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div className={styles.sectionLabel}>
          Projects pulse
          <span className={styles.tag}>{projects.length} projects</span>
        </div>
      </div>

      <div className={styles.list}>
        {sorted.map((p) => {
          const isWs = p.is_workspace === 1;
          const dotStatus = projectDotStatus(p);
          const taskTotal = p.total_tasks ?? 0;

          return (
            <div
              key={p.id}
              className={`${styles.row} ${isWs ? styles.workspace : ""}`}
            >
              <span className={`${styles.dot} ${styles[dotStatus]}`} />
              <span className={styles.name}>
                {p.name}
                {isWs && (
                  <span className={styles.workspaceBadge}>workspace</span>
                )}
              </span>
              <span className={styles.count}>{taskTotal} tasks</span>
            </div>
          );
        })}
        {projects.length === 0 && !projectsQ.isLoading && (
          <div
            style={{ fontSize: 12, color: "var(--fg-4)", padding: "12px 0" }}
          >
            No projects imported yet
          </div>
        )}
      </div>
    </div>
  );
}
