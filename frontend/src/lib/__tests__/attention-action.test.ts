/**
 * `primaryAction` / `inspectPath` (#265).
 *
 * The queue's rows are the only thing on the page, and the whole of #265 is
 * that each one must take you to its subject. That resolution is a pure
 * function of the row, so it is pinned here — without a router, a store or a
 * shell — and the page test is left to prove the wiring rather than the rules.
 *
 * The two rules worth stating out loud:
 *
 *   * **A stale `pane_id` is not a pane.** `attention_service.list_items`
 *     joins `pane_id` live from `agent_sessions`, and a session that has ended
 *     keeps the column it was last attached to. The page used to offer "Jump
 *     to pane" on the strength of that column alone, which focused nothing.
 *   * **No row offers an action it cannot perform.** An item with no session,
 *     no ticket, no project and no surface resolves to `none`, which the page
 *     renders as an em dash naming what is missing.
 */

import { describe, it, expect } from "vitest";
import {
  primaryAction,
  inspectPath,
  sessionIsLive,
} from "../attention-action";
import type { AttentionItem } from "../api";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 1,
    kind: "session_stalled",
    severity: "stalled",
    state: "open",
    dedup_key: "session_stalled:s1",
    seen_count: 1,
    title: "Session idle 42m with unfinished work",
    detail: null,
    session_id: null,
    project_id: null,
    task_id: null,
    schedule_id: null,
    payload_json: null,
    first_seen_at: "2026-09-10 11:00:00",
    last_seen_at: "2026-09-10 12:00:00",
    resolved_at: null,
    resolution: null,
    muted_until: null,
    pane_id: null,
    session_status: null,
    project_name: null,
    ...overrides,
  };
}

describe("sessionIsLive", () => {
  it("treats active and idle as live", () => {
    expect(sessionIsLive("active")).toBe(true);
    expect(sessionIsLive("idle")).toBe(true);
  });

  it("treats ended as over, and an absent status as no session", () => {
    expect(sessionIsLive("ended")).toBe(false);
    expect(sessionIsLive(null)).toBe(false);
  });
});

describe("primaryAction — a live pane", () => {
  it("focuses the pane", () => {
    const action = primaryAction(
      item({ pane_id: "pane-7", session_id: "s1", session_status: "active" }),
    );
    expect(action).toEqual({
      kind: "pane",
      label: "jump to pane",
      paneId: "pane-7",
      sessionId: "s1",
    });
  });

  it("does not offer the pane of a session that has ended", () => {
    // `pane_id` is joined live and survives the session; offering it was the
    // page's dead button.
    const action = primaryAction(
      item({ pane_id: "pane-7", session_id: "s1", session_status: "ended" }),
    );
    expect(action).toEqual({
      kind: "route",
      label: "open session",
      path: "/sessions/s1",
    });
  });
});

describe("primaryAction — a session with no pane here", () => {
  it("opens the session's own record", () => {
    // The owner's complaint: a session that is real and is simply not a pane
    // in this window had nowhere to go at all.
    expect(primaryAction(item({ session_id: "abc 123" }))).toEqual({
      kind: "route",
      label: "open session",
      path: "/sessions/abc%20123",
    });
  });
});

describe("primaryAction — the producer's own surface", () => {
  it("sends a failed schedule with no session to Schedules", () => {
    const action = primaryAction(
      item({ kind: "schedule_failed", schedule_id: 3 }),
    );
    expect(action).toEqual({
      kind: "route",
      label: "open schedules",
      path: "/schedules",
    });
  });

  it("sends a crossed budget to Budgets, never to a launch", () => {
    // A project-scoped budget carries `project_id`, and "start a session" is
    // not what a crossed budget wants from anyone — so the surface rule has to
    // win over the generic project rule below it.
    const action = primaryAction(
      item({ kind: "budget_threshold", project_id: 2 }),
    );
    expect(action).toEqual({
      kind: "route",
      label: "open budgets",
      path: "/budgets",
    });
  });

  it("sends the inbox backlog to triage", () => {
    expect(primaryAction(item({ kind: "inbox_backlog" }))).toEqual({
      kind: "route",
      label: "triage inbox",
      path: "/tasks",
    });
  });
});

describe("primaryAction — nothing is running yet", () => {
  it("offers a launch seeded from the ticket", () => {
    const action = primaryAction(
      item({ kind: "task_blocked", task_id: 42, project_id: 2 }),
    );
    expect(action).toEqual({
      kind: "launch",
      label: "start session",
      source: { kind: "task", id: 42 },
      projectId: 2,
    });
  });

  it("falls back to the project when there is no ticket", () => {
    const action = primaryAction(item({ kind: "session_stalled", project_id: 5 }));
    expect(action).toEqual({
      kind: "launch",
      label: "start session",
      source: null,
      projectId: 5,
    });
  });
});

describe("primaryAction — nothing to open", () => {
  it("resolves to none rather than inventing a destination", () => {
    const action = primaryAction(item({ kind: "session_stalled" }));
    expect(action.kind).toBe("none");
    expect(action).toHaveProperty("waitingOn");
  });
});

describe("inspectPath", () => {
  it("is the ticket's page when the primary action is not", () => {
    expect(inspectPath(item({ kind: "task_blocked", task_id: 42 }))).toBe(
      "/tasks/42",
    );
  });

  it("is the project's context page when there is no ticket", () => {
    expect(
      inspectPath(
        item({ pane_id: "p1", session_id: "s1", session_status: "active", project_id: 2 }),
      ),
    ).toBe("/projects/2/context");
  });

  it("is null when the item names neither a ticket nor a project", () => {
    expect(inspectPath(item({ kind: "inbox_backlog" }))).toBeNull();
  });
});
