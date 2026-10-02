/**
 * attention-action.ts — what one attention item's single obvious action is.
 *
 * #265. Needs You could name a problem and not take you to it: the page offered
 * "Inspect", which went to a list, and "Jump to pane", which was offered
 * whenever `pane_id` was non-null — including for sessions that had already
 * ended, where it focused nothing. An item that cannot reach its subject is an
 * item you have to go and find by hand, which is the whole thing the queue
 * exists to stop.
 *
 * One item, one primary action, resolved here so it is a pure function of the
 * row and can be tested without a router, a terminal store or a Tauri shell.
 *
 * The order below is the order of *directness*, not of importance. A live pane
 * is the problem itself; a session record is the problem's transcript; a launch
 * is the problem's next step; a surface is the problem's neighbourhood. Each
 * rule only fires when the one above it had nothing to point at.
 *
 * `none` is a real outcome and not a failure of this function. An item with no
 * subject renders an em dash naming what it is waiting on — the same rule the
 * app applies to an unmeasurable number — rather than a button that does
 * nothing when pressed.
 */

import type { AttentionItem } from "./api";

/** A task or inbox item a seeded launch can be composed from. */
export interface AttentionLaunchSource {
  kind: "task";
  id: number;
}

export type AttentionAction =
  /** Focus a pane that is running right now. */
  | { kind: "pane"; label: string; paneId: string; sessionId: string | null }
  /** Navigate to a page that is about this item's subject. */
  | { kind: "route"; label: string; path: string }
  /** Open the launch composer, seeded so agent/project/model are already
   *  chosen. `source` seeds from a ticket; `projectId` is the weaker form for
   *  an item that names a project and no ticket. */
  | {
      kind: "launch";
      label: string;
      source: AttentionLaunchSource | null;
      projectId: number | null;
    }
  /** Nothing to open. `waitingOn` names what would have to exist. */
  | { kind: "none"; waitingOn: string };

/**
 * Session statuses that mean the session is over. `agent_service` writes
 * `active`, `idle` and `ended`; anything else a future writer invents is
 * treated as live, because the cost of being wrong that way is a focus call
 * that misses, while the other way round hides a pane that is really there.
 */
const SESSION_OVER: ReadonlySet<string> = new Set(["ended", "stopped", "failed"]);

export function sessionIsLive(status: string | null): boolean {
  return status !== null && !SESSION_OVER.has(status);
}

/** The surface that owns a producer when the item itself points nowhere. */
const KIND_SURFACE: Readonly<Record<string, { path: string; label: string }>> = {
  schedule_failed: { path: "/schedules", label: "open schedules" },
  budget_threshold: { path: "/budgets", label: "open budgets" },
  inbox_backlog: { path: "/tasks", label: "triage inbox" },
};

/**
 * The one action an item offers.
 *
 * Callers render exactly one button from this, and use `none` to render the em
 * dash instead. `inspectPath` below is the *second*, optional action — the
 * subject's own record page — and is deliberately a different function so a
 * row can never end up with two buttons that do the same thing.
 */
export function primaryAction(item: AttentionItem): AttentionAction {
  // 1. The problem itself, running right now.
  if (item.pane_id && sessionIsLive(item.session_status)) {
    return {
      kind: "pane",
      label: "jump to pane",
      paneId: item.pane_id,
      sessionId: item.session_id,
    };
  }

  // 2. A session that has ended, or one running outside this app: its record.
  //    This is the case the owner's complaint was about — an item whose
  //    session is real and is simply not a pane in this window.
  if (item.session_id) {
    return {
      kind: "route",
      label: "open session",
      path: `/sessions/${encodeURIComponent(item.session_id)}`,
    };
  }

  // 3. The producer's own surface, before the generic ticket rules. A budget
  //    threshold names a project, and "start a session" is not what a crossed
  //    budget wants from anyone.
  const surface = KIND_SURFACE[item.kind];
  if (surface) {
    return { kind: "route", label: surface.label, path: surface.path };
  }

  // 4. A ticket with no session: the next step is to start one, with the
  //    agent, project and model the launch seed already knows.
  if (item.task_id !== null) {
    return {
      kind: "launch",
      label: "start session",
      source: { kind: "task", id: item.task_id },
      projectId: item.project_id,
    };
  }
  if (item.project_id !== null) {
    return {
      kind: "launch",
      label: "start session",
      source: null,
      projectId: item.project_id,
    };
  }

  return {
    kind: "none",
    waitingOn: "nothing on this item names a session, ticket or project",
  };
}

/**
 * The optional second action: the subject's own record page.
 *
 * Returns null when there is no record page, and — the rule that keeps a row to
 * one meaning — when it would duplicate the primary action's destination.
 */
export function inspectPath(item: AttentionItem): string | null {
  const primary = primaryAction(item);
  const path =
    item.task_id !== null
      ? `/tasks/${item.task_id}`
      : item.project_id !== null
        ? `/projects/${item.project_id}/context`
        : null;
  if (path === null) return null;
  if (primary.kind === "route" && primary.path === path) return null;
  return path;
}
