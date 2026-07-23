import type { Project } from "./api";

/**
 * The internal "Unassigned" catch-all project is plumbing — it's the
 * reassignment target used when a project is deleted (so its tasks survive),
 * not a project the user manages. Hide it from project lists while it holds no
 * tasks. It reappears the moment it holds tasks (e.g. after a project delete
 * reassigns orphaned tasks to it) so the user can still find them.
 *
 * Single source of truth so every project view (Projects page, Overview
 * "Projects pulse", …) filters identically and can't drift.
 */
export function isHiddenCatchAllProject(p: Project): boolean {
  return (
    p.name === "Unassigned" && !p.is_workspace && (p.total_tasks ?? 0) === 0
  );
}
