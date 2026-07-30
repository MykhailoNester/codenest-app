// Root resolution for the workspace navigator. Pure — no IPC, no React.
//
// A "root" is one of the navigator's top-level trees: an imported project,
// or the virtual Shared root for the workspace's `.claude/` directory
// (org agents, skills, commands — see `WorkspaceManager::bootstrap`,
// `src-tauri/src/workspace/mod.rs:81-97`).

import type { Project } from "../api";
import { findLeaf, type PaneLeaf } from "../layout-tree";
import type { Tab } from "../../stores/terminal-store";

export type RootKind = "project" | "shared";

export interface RootDescriptor {
  /** Stable across a session: `project:${id}` or `shared`. */
  id: string;
  kind: RootKind;
  /** Project name, or "Agents & skills" for the shared root. */
  label: string;
  /**
   * The path as requested — `root_path ?? path` for a project row, or
   * `${workspacePath}/.claude` for the shared root. May differ from what
   * the shell returns once canonicalised (`/tmp` → `/private/tmp`, a
   * symlink resolved) — see `canonicalPath`.
   */
  requestedPath: string;
  /**
   * Filled from the `path`/`root` field of the first successful IPC
   * response for this root (`fsListDir`, `fsBuildFileIndex`,
   * `gitStatusForRoots`, a watch batch). `null` until one lands.
   */
  canonicalPath: string | null;
}

export const SHARED_ROOT_ID = "shared";
export const SHARED_ROOT_LABEL = "Agents & skills";

/**
 * Resolve every imported project plus the shared `.claude/` root into a
 * stable, ordered list of navigator roots.
 *
 * `root_path ?? path`, not `path` alone: `project_import_service.py:63-77`
 * (the Import Projects flow) writes both columns to the same value, but
 * `project_service.py:78-96` (`POST /api/v1/projects`) sets only `path`.
 * `root_path` is the column `attribution_service.py` and
 * `workspace_context_service.py` treat as the actual filesystem root, so
 * `root_path ?? path` is the only expression that covers both creation
 * paths.
 *
 * Filtering to `is_workspace !== 1 && is_active === 1` with a non-empty,
 * absolute resolved path drops the seeded `Unassigned` row (both columns
 * `NULL`) and the synthetic workspace-aggregate project without a
 * hardcoded name check.
 */
export function resolveRoots(
  projects: Project[],
  workspacePath: string | null,
): RootDescriptor[] {
  const projectRoots: RootDescriptor[] = projects
    .filter((p) => p.is_workspace !== 1 && p.is_active === 1)
    .map((p) => ({
      id: `project:${p.id}`,
      kind: "project" as const,
      label: p.name,
      requestedPath: (p.root_path ?? p.path ?? "").trim(),
    }))
    .filter((r) => r.requestedPath.startsWith("/"))
    .map((r) => ({ ...r, canonicalPath: null }))
    .sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );

  if (workspacePath) {
    projectRoots.push({
      id: SHARED_ROOT_ID,
      kind: "shared",
      label: SHARED_ROOT_LABEL,
      requestedPath: `${workspacePath.replace(/\/+$/, "")}/.claude`,
      canonicalPath: null,
    });
  }

  return projectRoots;
}

/**
 * The longest (most specific) root that `cwd` is under, or `null` when it
 * isn't under any of them — the caller then treats `cwd` itself as an
 * ad-hoc root. Longest-prefix-wins on a `/`-terminated comparison, mirroring
 * `agent_service._match_project`'s `ORDER BY LENGTH(path) DESC`
 * (`app/services/agent_service.py:92-105`) but without its substring-`in`
 * looseness — a project at `/home/x/app` must not match a cwd of
 * `/home/x/app-other`.
 */
export function rootForCwd(
  roots: RootDescriptor[],
  cwd: string,
): RootDescriptor | null {
  const normalizedCwd = cwd.endsWith("/") ? cwd : `${cwd}/`;
  let best: RootDescriptor | null = null;
  let bestLen = -1;
  for (const root of roots) {
    const base = root.canonicalPath ?? root.requestedPath;
    const normalizedBase = base.endsWith("/") ? base : `${base}/`;
    if (
      normalizedBase.length > bestLen &&
      normalizedCwd.startsWith(normalizedBase)
    ) {
      best = root;
      bestLen = normalizedBase.length;
    }
  }
  return best;
}

/**
 * The focused terminal pane's leaf, resolved across every tab (a pane lives
 * in exactly one tab's layout tree). `null` when nothing is focused. Shared
 * by `focusedPaneCwd` and by callers that also need `PaneLeaf.exited` — the
 * "(pane exited)" annotation on Project mode's header and the disabled
 * reason on the Find "paste into shell pane" action both read it from here
 * so the two never disagree about whether the followed pane is still alive.
 */
export function focusedPaneLeaf(
  tabs: Tab[],
  focusedLeafId: string | null,
): PaneLeaf | null {
  if (!focusedLeafId) return null;
  for (const tab of tabs) {
    const leaf = findLeaf(tab.layout, focusedLeafId);
    if (leaf) return leaf;
  }
  return null;
}

/**
 * The cwd of the focused terminal pane. `null` when nothing is focused or
 * the focused pane never received an OSC 7 sequence. Shared by
 * `use-explorer-sync.ts` (to pick Project mode's watched root) and
 * `<ExplorerTree mode="proj">` (to render it) — one implementation so the
 * two never disagree about which pane is being followed.
 */
export function focusedPaneCwd(
  tabs: Tab[],
  focusedLeafId: string | null,
): string | null {
  return focusedPaneLeaf(tabs, focusedLeafId)?.cwd ?? null;
}
