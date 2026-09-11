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
import { Shell } from "../components/layout/shell";
import { Icon } from "../components/icon";
import { relativeTime } from "../lib/format-helpers";
import styles from "./attention.module.css";

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

const SEV_DOT: Record<string, string> = {
  blocking: styles.sevBlocking ?? "",
  stalled: styles.sevStalled ?? "",
  queued: styles.sevQueued ?? "",
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

function AttentionRow({
  item,
  onInspect,
  onJump,
}: {
  item: AttentionItem;
  onInspect: (item: AttentionItem) => void;
  onJump: (paneId: string) => void;
}): ReactElement {
  const target = inspectPath(item);
  const meta = [
    item.project_name,
    item.detail,
    relativeTime(item.first_seen_at),
    item.seen_count > 1 ? `seen ${item.seen_count}×` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={styles.row}>
      <span className={`${styles.sevDot} ${SEV_DOT[item.severity] ?? ""}`} />
      <div className={styles.rowBody}>
        <div className={styles.rowTitle}>{item.title}</div>
        <div className={styles.rowMeta}>{meta}</div>
      </div>
      <div className={styles.rowActions}>
        {target && (
          <button
            type="button"
            className={styles.action}
            onClick={() => onInspect(item)}
          >
            Inspect
          </button>
        )}
        {item.pane_id && (
          <button
            type="button"
            className={styles.action}
            onClick={() => onJump(item.pane_id as string)}
          >
            Jump to pane
          </button>
        )}
      </div>
    </div>
  );
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

  return (
    <Shell>
      <div className={styles.page}>
        <div className={styles.tabs} role="tablist" aria-label="Queue state">
          {STATE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={state === tab.id}
              className={`${styles.tab} ${state === tab.id ? styles.tabOn : ""}`}
              onClick={() => setState(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className={styles.tiles}>
          <div className={styles.tile}>
            <span className={styles.tileLabel}>Blocking</span>
            <span className={styles.tileValue}>{counts?.blocking ?? 0}</span>
            <span className={styles.tileSub}>a session cannot continue</span>
          </div>
          <div className={styles.tile}>
            <span className={styles.tileLabel}>Stalled</span>
            <span className={styles.tileValue}>{counts?.stalled ?? 0}</span>
            <span className={styles.tileSub}>no progress &gt; 30m</span>
          </div>
          <div className={styles.tile}>
            <span className={styles.tileLabel}>Queued</span>
            <span className={styles.tileValue}>{counts?.queued ?? 0}</span>
            <span className={styles.tileSub}>wants you eventually</span>
          </div>
          <div className={styles.tile}>
            <span className={styles.tileLabel}>Resolved today</span>
            <span className={styles.tileValue}>
              {counts?.resolved_today ?? 0}
            </span>
            {/* "average", not "median": SQLite has no median aggregate and
                computing a true one would mean pulling every resolved row
                into the sidecar on a query this page polls every 30s. The
                label says which it is. */}
            <span className={styles.tileSub}>
              average{" "}
              {formatDuration(counts?.resolved_today_avg_seconds ?? null)}
            </span>
          </div>
        </div>

        {isLoading ? (
          <div className={styles.rowMeta}>Loading&hellip;</div>
        ) : items.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyMark}>
              <Icon name="check-circle" size={20} />
            </span>
            <div className={styles.emptyTitle}>
              {state === "open"
                ? "Nothing is waiting on you"
                : `No ${state} items`}
            </div>
            {/* The 30-second re-check is the whole of P1's freshness promise,
                and it is named here because it is the only thing that makes an
                empty page trustworthy. No tray notification is promised: P1
                builds no tray, and this is the last screen that should
                overstate what it can do. */}
            <div className={styles.emptyLine}>
              This page re-checks every 30 seconds while it is open.
            </div>
            <div className={styles.emptyLine}>
              Stalled sessions, failed scheduled runs, budget thresholds and
              blocked tasks appear here on their own.
            </div>
          </div>
        ) : (
          SEVERITIES.map((sev) => {
            const group = items.filter((it) => it.severity === sev.id);
            if (group.length === 0) return null;
            return (
              <section key={sev.id}>
                <h2 className={styles.groupHead}>
                  {sev.label}
                  <span className={styles.groupNote}>
                    · {sev.note} · {group.length}
                  </span>
                </h2>
                {group.map((item) => (
                  <AttentionRow
                    key={item.id}
                    item={item}
                    onInspect={handleInspect}
                    onJump={handleJump}
                  />
                ))}
              </section>
            );
          })
        )}
      </div>
    </Shell>
  );
}
