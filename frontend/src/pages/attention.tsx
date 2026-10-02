/**
 * Needs You — surface S2 of the v2 design (epic #153 / #162), and since #270
 * the app's only queue.
 *
 * One list, severity-grouped, oldest first, with the action inline. The page's
 * own argument is that if it is empty you close the app, so the empty state is
 * designed rather than left over.
 *
 * Two deliberate departures from the S2 mockup, both owner decisions:
 *
 * 1. **No Allow / Deny.** The mockup's blocking rows answer a
 *    `PermissionRequest` hook from here. That hook is P2, and answering it from
 *    the dashboard keeps the hook's response open until a human clicks — a
 *    person on a hook's critical path, which is the exact failure the
 *    `--max-time` / `|| true` discipline exists to prevent. Until P2 ships the
 *    pre-authorise shape, every row gets its one jump and, where there is one,
 *    **inspect** — which is most of the value: knowing within a second is the
 *    hard part.
 *
 * 2. **The empty state does not promise a tray notification.** The mockup's
 *    copy says "You'll get a tray notification the moment that changes." P1
 *    builds no tray, so that sentence would be a lie told by the one screen
 *    whose entire worth is that you can trust it when it says nothing is
 *    wrong. It names the 30-second re-check instead, which is real and is
 *    exactly what `useAttention`'s poll interval does.
 *
 * #265 — one row, one obvious action
 * ----------------------------------
 * The page used to offer "Inspect" (which went to a *list*) and "Jump to pane"
 * (offered whenever `pane_id` was non-null, including for sessions that had
 * ended, where it focused nothing and then opened an empty detached window).
 * An item could therefore name a problem and not take you to it, which is the
 * owner's own complaint about this page.
 *
 * The action is now resolved per item by `lib/attention-action.ts` and is
 * exactly one of: focus the live pane, open the session's record, start a
 * session seeded from the ticket, open the surface that owns it — or, when the
 * row genuinely points at nothing, an em dash naming what is missing. A dead
 * button is worse than no button, and this page cannot afford either.
 *
 * #270 — Notifications folded in
 * ------------------------------
 * The Notifications page is gone. Its unread rows are derived into the queue by
 * `attention_service._produce_notifications` and carry a **mark read** action
 * here, which is what closes them. The bell in the chrome keeps the full
 * history, read and unread, on every screen.
 */

import { useCallback, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAttention,
  markNotificationRead,
  markAllNotificationsRead,
  type AttentionItem,
} from "../lib/api";
import { TERMINAL_ROUTE } from "../lib/nav-items";
import { useTerminalStore } from "../stores/terminal-store";
import { collectLeaves } from "../lib/layout-tree";
import {
  openTerminalsWindow,
  emitFocusPaneToTerminals,
  listLivePanes,
} from "../lib/ipc";
import { relativeTime } from "../lib/format-helpers";
import {
  primaryAction,
  inspectPath,
  notificationIdOf,
  type AttentionAction,
} from "../lib/attention-action";
import { AttentionLaunchDialog } from "../components/launch/attention-launch-dialog";
import { DeckShell } from "../components/deck/deck-shell";
import {
  DeckGrid,
  DeckGroup,
  DeckHead,
  DeckLine,
  type DeckState,
} from "../components/deck/deck-grid";

type QueueState = "open" | "resolved" | "muted";

/**
 * This page's column template.
 *
 * Not in `DECK_COLS`: that module is a deck primitive and is out of scope for
 * this ticket, so the shape lives with the only list that has it rather than
 * being added to a shared file by a page change. The queue needs a wider last
 * column than any named template has — its rows carry up to two buttons whose
 * labels vary ("jump to pane", "start session", "mark all read") — and the
 * template it used before, `DECK_COLS.default`, declared six columns for the
 * five cells this list renders, which left the action cell 62px and a 96px
 * column with nothing in it.
 */
const ATTENTION_COLS = "14px minmax(0, 1fr) 150px 72px 196px";

/** Action kinds a row's own activation (click / Enter / Space) may run. */
const ROW_ACTIVATES: ReadonlySet<AttentionAction["kind"]> = new Set([
  "pane",
  "route",
  "launch",
]);

const STATE_TABS: readonly { id: QueueState; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "resolved", label: "Resolved" },
  { id: "muted", label: "Muted" },
];

/**
 * Severity order is the page's reading order and the queue's sort key, so it
 * is declared once here and the sections are rendered from it — a group that
 * exists in the data but not in this list would otherwise vanish silently.
 *
 * The notes are the design's own one-line definitions. `blocking` keeps its
 * section (and its definition) even though P1 produces nothing for it, because
 * a severity that appears out of nowhere when P2 lands is a page that changed
 * shape; one that is simply always empty until then is a page that told you
 * what it was watching for.
 */
const SEVERITIES: readonly { id: string; label: string; note: string }[] = [
  { id: "blocking", label: "Blocking", note: "a session cannot continue" },
  {
    id: "stalled",
    label: "Stalled",
    note: "nobody is blocked, nothing is moving",
  },
  { id: "queued", label: "Queued", note: "real work, not this minute" },
];

const SEV_STATE: Record<string, DeckState> = {
  blocking: "block",
  stalled: "stall",
  queued: "wait",
};

/** Seconds → "3m 12s" / "48s" / "2h 04m". Used for the resolution average. */
function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, "0")}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

interface RowHandlers {
  onInspect: (item: AttentionItem) => void;
  onActivate: (item: AttentionItem) => void;
  onMarkRead: (item: AttentionItem) => void;
}

function actionCell(
  item: AttentionItem,
  action: AttentionAction,
  handlers: RowHandlers,
): ReactElement {
  const inspect = inspectPath(item);
  return (
    <span className="dk-actions">
      {inspect && (
        <button
          type="button"
          className="dk-btn bare"
          onClick={(e) => {
            e.stopPropagation();
            handlers.onInspect(item);
          }}
        >
          inspect
        </button>
      )}
      {action.kind === "none" ? (
        // The app's standing rule for a value it cannot measure, applied to an
        // action it cannot offer: an em dash naming what is missing, never a
        // button that does nothing.
        <span className="note" title={action.waitingOn}>
          —
        </span>
      ) : (
        <button
          type="button"
          className="dk-btn"
          onClick={(e) => {
            e.stopPropagation();
            handlers.onActivate(item);
          }}
        >
          {action.label}
        </button>
      )}
      {item.kind === "notification_unread" && (
        <button
          type="button"
          className="dk-btn bare"
          onClick={(e) => {
            e.stopPropagation();
            handlers.onMarkRead(item);
          }}
        >
          mark read
        </button>
      )}
    </span>
  );
}

function attentionCells(item: AttentionItem, handlers: RowHandlers) {
  const meta = [
    item.project_name,
    item.detail,
    item.seen_count > 1 ? `seen ${item.seen_count}×` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return [
    { v: item.title, cls: "sub", title: item.title },
    meta,
    relativeTime(item.first_seen_at),
    { v: actionCell(item, primaryAction(item), handlers), cls: "r" },
  ];
}

export function AttentionPage(): ReactElement {
  const [state, setState] = useState<QueueState>("open");
  const { data, isLoading } = useAttention(state);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  /** The item a launch is being composed for, or null. */
  const [launchFor, setLaunchFor] = useState<AttentionItem | null>(null);

  const items = data?.items ?? [];
  const counts = data?.counts;

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["attention"] });
    void queryClient.invalidateQueries({ queryKey: ["notifications"] });
  }, [queryClient]);

  const handleInspect = useCallback(
    (item: AttentionItem) => {
      const target = inspectPath(item);
      if (target) void navigate(target);
    },
    [navigate],
  );

  /**
   * Focus a live pane. The embedded path first — navigate to Sessions, hydrate
   * the store (a session from a previous app run is not in it until that page
   * has mounted once) and focus the leaf.
   *
   * If no tab owns the pane it may belong to the detached terminals window,
   * which has its own store in its own JS context and can only be reached by
   * raising it and emitting `focus-pane`. That used to be the unconditional
   * fallback, which meant a pane that had simply gone away raised an empty
   * window and focused nothing. The shell's `list_live_panes` is the only
   * authoritative answer to "is this pane still alive?", so it decides: live
   * and unowned → the detached window; not live → the session's own record,
   * which is where the work actually is once its pane is gone.
   */
  const handleJump = useCallback(
    (paneId: string, sessionId: string | null) => {
      void navigate(TERMINAL_ROUTE);
      void (async () => {
        const store = useTerminalStore.getState();
        await store.hydrateFromStorage();
        const fresh = useTerminalStore.getState();
        const tab = fresh.tabs.find((t) =>
          collectLeaves(t.layout).some((l) => l.terminalId === paneId),
        );
        if (tab) {
          // Order matters: `setActiveTab` focuses the tab's first leaf, so the
          // specific pane has to be focused after it.
          fresh.setActiveTab(tab.id);
          fresh.setFocusedLeaf(paneId);
          return;
        }
        const live = await listLivePanes().catch(() => [] as string[]);
        if (live.includes(paneId)) {
          void openTerminalsWindow().catch(() => undefined);
          void emitFocusPaneToTerminals(paneId).catch(() => undefined);
          return;
        }
        if (sessionId) void navigate(`/sessions/${encodeURIComponent(sessionId)}`);
      })();
    },
    [navigate],
  );

  const handleMarkRead = useCallback(
    (item: AttentionItem) => {
      const id = notificationIdOf(item);
      if (id === null) return;
      void markNotificationRead(id)
        .then(refresh)
        .catch(() => undefined);
    },
    [refresh],
  );

  /** The row's one action, run. */
  const handleActivate = useCallback(
    (item: AttentionItem) => {
      const action = primaryAction(item);
      switch (action.kind) {
        case "pane":
          handleJump(action.paneId, action.sessionId);
          return;
        case "route":
          void navigate(action.path);
          return;
        case "launch":
          setLaunchFor(item);
          return;
        case "markAllRead":
          void markAllNotificationsRead()
            .then(refresh)
            .catch(() => undefined);
          return;
        case "none":
          return;
      }
    },
    [handleJump, navigate, refresh],
  );

  const handlers: RowHandlers = {
    onInspect: handleInspect,
    onActivate: handleActivate,
    onMarkRead: handleMarkRead,
  };

  const tiles = (
    <div className="dk-bigs">
      <div className="dk-big">
        <div className="v">{counts?.blocking ?? 0}</div>
        <div className="l warn">blocking · a session cannot continue</div>
      </div>
      <div className="dk-big">
        <div className="v">{counts?.stalled ?? 0}</div>
        <div className="l">stalled · no progress &gt; 30m</div>
      </div>
      <div className="dk-big">
        <div className="v">{counts?.queued ?? 0}</div>
        <div className="l">queued · wants you eventually</div>
      </div>
      <div className="dk-big">
        <div className="v">{counts?.resolved_today ?? 0}</div>
        {/* "average", not "median": SQLite has no median aggregate and a true
            one would mean pulling every resolved row into the sidecar on a
            query this page polls every 30s. The label says which it is. */}
        <div className="l">
          resolved today · average {formatDuration(counts?.resolved_today_avg_seconds ?? null)}
        </div>
      </div>
    </div>
  );

  const tabs = (
    <div className="dk-seg" role="tablist" aria-label="Queue state">
      {STATE_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={state === tab.id}
          className={state === tab.id ? "on" : undefined}
          onClick={() => setState(tab.id)}
        >
          {tab.label.toLowerCase()}
        </button>
      ))}
    </div>
  );

  const launchAction = launchFor === null ? null : primaryAction(launchFor);

  return (
    <DeckShell title="needs you" crumb={`${counts?.open ?? 0} open`} actions={tabs}>
      {tiles}

      {isLoading ? (
        <div className="dk-note">Loading&hellip;</div>
      ) : items.length === 0 ? (
        <div className="dk-note sans">
          <div style={{ color: "var(--fg-2)" }}>
            {state === "open" ? "Nothing is waiting on you" : `No ${state} items`}
          </div>
          {/* The 30-second re-check is the whole of P1's freshness promise, and
              it is named here because it is the only thing that makes an empty
              page trustworthy. Nothing is promised about being told any other
              way: there is no tray and no push behind this queue. */}
          <div>This page re-checks every 30 seconds while it is open.</div>
          <div>
            Stalled sessions, failed scheduled runs, budget thresholds, blocked tasks and
            anything unread in the bell appear here on their own.
          </div>
        </div>
      ) : (
        SEVERITIES.map((sev) => {
          const group = items.filter((it) => it.severity === sev.id);
          if (group.length === 0) return null;
          return (
            <DeckGroup
              key={sev.id}
              label={sev.label.toLowerCase()}
              count={group.length}
              note={sev.note}
              state={SEV_STATE[sev.id]}
            >
              <DeckGrid cols={ATTENTION_COLS} label={sev.label}>
                <DeckHead cells={["what", "where", "r waiting", "r action"]} />
                {group.map((item) => (
                  <DeckLine
                    key={item.id}
                    state={SEV_STATE[item.severity] ?? "idle"}
                    cells={attentionCells(item, handlers)}
                    // Row activation runs the action only when it *goes*
                    // somewhere. "mark all read" is a write, and a write that
                    // fires because Enter was pressed on a focused row is a
                    // write nobody asked for; it stays on its button.
                    onOpen={
                      ROW_ACTIVATES.has(primaryAction(item).kind)
                        ? () => handleActivate(item)
                        : undefined
                    }
                  />
                ))}
              </DeckGrid>
            </DeckGroup>
          );
        })
      )}

      {launchFor !== null && launchAction?.kind === "launch" && (
        <AttentionLaunchDialog
          source={launchAction.source}
          projectId={launchAction.projectId}
          onClose={() => setLaunchFor(null)}
        />
      )}
    </DeckShell>
  );
}
