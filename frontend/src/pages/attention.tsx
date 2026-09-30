/**
 * Needs You — surface S2 of the v2 design (epic #153 / #162).
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
 *    pre-authorise shape, every row gets **Inspect** and **Jump to pane**,
 *    which is most of the value: knowing within a second is the hard part.
 *
 * 2. **The empty state does not promise a tray notification.** The mockup's
 *    copy says "You'll get a tray notification the moment that changes." P1
 *    builds no tray, so that sentence would be a lie told by the one screen
 *    whose entire worth is that you can trust it when it says nothing is
 *    wrong. It names the 30-second re-check instead, which is real and is
 *    exactly what `useAttention`'s poll interval does.
 *
 * The page starts empty on today's database and that is expected, not a bug:
 * every blocking source is P2, and there are no schedules, no budget alerts
 * and no blocked tasks to derive anything else from.
 */

import { useCallback, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { useAttention, type AttentionItem } from "../lib/api";
import { TERMINAL_ROUTE } from "../lib/nav-items";
import { useTerminalStore } from "../stores/terminal-store";
import { collectLeaves } from "../lib/layout-tree";
import { openTerminalsWindow, emitFocusPaneToTerminals } from "../lib/ipc";
import { relativeTime } from "../lib/format-helpers";
import { DeckShell } from "../components/deck/deck-shell";
import {
  DECK_COLS,
  DeckGrid,
  DeckGroup,
  DeckHead,
  DeckLine,
  type DeckState,
} from "../components/deck/deck-grid";

type QueueState = "open" | "resolved" | "muted";

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

/**
 * Where "Inspect" goes for each producer.
 *
 * Every destination is a page that exists today. The design's Session
 * Inspector — the natural target for a stalled session — is P4, so a session
 * item opens the Command Center, which is where a live session's activity is
 * actually readable right now. Returning `null` (no subject we can route to)
 * hides the button rather than shipping one that does nothing.
 */
function inspectPath(item: AttentionItem): string | null {
  switch (item.kind) {
    case "task_blocked":
      return item.task_id == null ? null : `/tasks/${item.task_id}`;
    case "schedule_failed":
      return "/schedules";
    case "budget_threshold":
      return "/budgets";
    case "inbox_backlog":
      return "/tasks";
    case "session_stalled":
      return "/command";
    default:
      return item.session_id ? "/command" : null;
  }
}

function attentionCells(
  item: AttentionItem,
  onInspect: (item: AttentionItem) => void,
  onJump: (paneId: string) => void,
) {
  const meta = [item.project_name, item.detail, item.seen_count > 1 ? `seen ${item.seen_count}×` : null]
    .filter(Boolean)
    .join(" · ");
  const target = inspectPath(item);
  return [
    { v: item.title, cls: "sub", title: item.title },
    meta,
    relativeTime(item.first_seen_at),
    {
      v: (
        <>
          {target && (
            <button
              type="button"
              className="dk-btn bare"
              onClick={(e) => {
                e.stopPropagation();
                onInspect(item);
              }}
            >
              inspect
            </button>
          )}
          {item.pane_id && (
            <button
              type="button"
              className="dk-btn"
              onClick={(e) => {
                e.stopPropagation();
                onJump(item.pane_id as string);
              }}
            >
              jump to pane
            </button>
          )}
        </>
      ),
      cls: "r",
    },
  ];
}

export function AttentionPage(): ReactElement {
  const [state, setState] = useState<QueueState>("open");
  const { data, isLoading } = useAttention(state);
  const navigate = useNavigate();

  const items = data?.items ?? [];
  const counts = data?.counts;

  const handleInspect = useCallback(
    (item: AttentionItem) => {
      const target = inspectPath(item);
      if (target) void navigate(target);
    },
    [navigate],
  );

  /**
   * Jump to pane. The embedded path first — navigate to Sessions, hydrate the
   * store (a session from a previous app run is not in it until that page has
   * mounted once) and focus the leaf. If no tab owns the pane, it belongs to
   * the detached terminals window, which has its own store in its own JS
   * context and can only be reached by raising it and emitting `focus-pane`.
   * The attention item carries a `pane_id` and no `target`, so rather than
   * guessing which window owns it we try the one we can inspect and fall back
   * to the one we cannot.
   */
  const handleJump = useCallback(
    (paneId: string) => {
      void navigate(TERMINAL_ROUTE);
      void (async () => {
        const store = useTerminalStore.getState();
        await store.hydrateFromStorage();
        const fresh = useTerminalStore.getState();
        const tab = fresh.tabs.find((t) =>
          collectLeaves(t.layout).some((l) => l.terminalId === paneId),
        );
        if (!tab) {
          void openTerminalsWindow().catch(() => undefined);
          void emitFocusPaneToTerminals(paneId).catch(() => undefined);
          return;
        }
        // Order matters: `setActiveTab` focuses the tab's first leaf, so the
        // specific pane has to be focused after it.
        fresh.setActiveTab(tab.id);
        fresh.setFocusedLeaf(paneId);
      })();
    },
    [navigate],
  );

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
              page trustworthy. No tray notification is promised. */}
          <div>This page re-checks every 30 seconds while it is open.</div>
          <div>
            Stalled sessions, failed scheduled runs, budget thresholds and blocked tasks appear
            here on their own.
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
              <DeckGrid cols={DECK_COLS.default} label={sev.label}>
                <DeckHead cells={["what", "where", "r waiting", "r "]} />
                {group.map((item) => (
                  <DeckLine
                    key={item.id}
                    state={SEV_STATE[item.severity] ?? "idle"}
                    cells={attentionCells(item, handleInspect, handleJump)}
                    onOpen={inspectPath(item) ? () => handleInspect(item) : undefined}
                  />
                ))}
              </DeckGrid>
            </DeckGroup>
          );
        })
      )}
    </DeckShell>
  );
}
