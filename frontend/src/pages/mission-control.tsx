/**
 * Mission Control — surface S1, the page at `/` (epic #153 / #166).
 *
 * Replaces Overview, which predated the attention model: it opened on a chart,
 * and a chart cannot be acted on. This page reads top to bottom as three
 * claims about who has to do something —
 *
 *   1. **Attention.** What is waiting on a human, plus how much plan headroom
 *      is left to spend on it. Nothing above the fold is a chart.
 *   2. **Live.** What is running without one.
 *   3. **Record.** What already happened — the charts, the timeline, the
 *      per-project pulse.
 *
 * Every box below the Needs You panel is an existing component mounted as-is.
 * That is deliberate: the value #166 adds is the framing and the honesty of the
 * tiles, not new renderings of data that already had one.
 *
 * ## Which rows exist, and which only look like they do
 *
 * The design's "Data behind this screen" table grades every element P1, P2 or
 * P3, and this page builds the P1 rows only. The rest render `KPI_UNAVAILABLE`
 * — an em dash — and say which lane they are waiting on.
 *
 * The rule behind that is worth stating once, because it is easy to undo by
 * accident: a P2/P3 tile must **never** render `0`. A zero is a measurement. It
 * says "I looked and there was nothing", and this app cannot say that about a
 * lane it has not built — there is no OTLP receiver to report a tool failure,
 * so a `0` beside "Tool failures" would be a fabricated all-clear on exactly
 * the surface whose worth is that you can trust it. The dash says "nothing
 * looked", which is true.
 *
 * The source chip (entrypoint) and the compaction marker — both P1 in that
 * table, and the doc singles the compaction marker out as "the one element
 * worth arguing for" — are built, in `ActiveSessions`. An earlier draft of this
 * docstring claimed they could not be, on the grounds that no merged dependency
 * put those fields on `AgentSession`. That was wrong about the tree: #163 is
 * merged on this branch, `009_agent_sessions_provenance` adds `source_app` and
 * `cli_version`, `014_transcript_scan_state` adds `compaction_count` and
 * `context_peak_tokens`, `agent_service.list_sessions` selects `s.*`, and the
 * SSE snapshot serialises whole session rows. Only the TypeScript interface was
 * missing the fields.
 *
 * They are typed optional rather than nullable because a sidecar applies
 * migrations once at startup: a process launched before those migrations keeps
 * serving rows that omit the keys entirely. Absent and null both render the
 * dashed "unknown" — the honest answer in both cases.
 *
 * The mockup's "Sessions · 24h" and "Unattributed" tiles are likewise absent:
 * neither is a row in the availability table, and both would need a session
 * aggregate the sidecar does not expose today. Inventing one here would have
 * put an unreviewed number on the landing page. The sessions figure the app can
 * honestly show is already in `KpiStack`'s live-agents tile.
 */

import { useCallback, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { Shell } from "../components/layout/shell";
import { ActivityPulse } from "../components/dashboard/overview/activity-pulse";
import { KpiStack } from "../components/dashboard/overview/kpi-stack";
import { ActiveSessions } from "../components/dashboard/overview/active-sessions";
import { ProjectsPulse } from "../components/dashboard/overview/projects-pulse";
import { MomentumTimeline } from "../components/dashboard/overview/momentum-timeline";
import { KpiTile, KPI_UNAVAILABLE } from "../components/dashboard/kpi-tile";
import { PlanHeadroom } from "../components/dashboard/plan-headroom";
import {
  useAttention,
  useDailySpend,
  useDashboard,
  type AttentionItem,
} from "../lib/api";
import { formatUSD, parseUtcMs, relativeTime } from "../lib/format-helpers";
import styles from "./mission-control.module.css";

/**
 * How many queue items the panel shows before deferring to Needs You.
 *
 * Four, because the panel's job is "is anything waiting on me, and roughly what
 * kind of thing" — not triage. A list long enough to scroll turns the top zone
 * back into a page you read rather than a state you glance at, and the full
 * queue is one click away with its own grouping and actions.
 */
const PREVIEW_LIMIT = 4;

const SEV_DOT: Record<string, string> = {
  blocking: styles.sevBlocking ?? "",
  stalled: styles.sevStalled ?? "",
  queued: styles.sevQueued ?? "",
};

/**
 * Mean time-to-resolution, formatted. "average", not "median", for the same
 * reason the Needs You page says so: SQLite has no median aggregate and the
 * sidecar sends a mean. The design's mockup says "median"; the data says
 * otherwise, and the label follows the data.
 */
function formatAverage(seconds: number | null | undefined): string {
  if (seconds == null) return KPI_UNAVAILABLE;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, "0")}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

function QueueRow({
  item,
  onOpen,
}: {
  item: AttentionItem;
  onOpen: () => void;
}): ReactElement {
  const meta = [
    item.project_name,
    item.detail,
    relativeTime(item.first_seen_at),
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
      <button type="button" className={styles.action} onClick={onOpen}>
        Open
      </button>
    </div>
  );
}

/**
 * The Needs You panel — the top-left box, and the reason this page exists.
 *
 * It is a preview of `attention_items` (#162), not a second implementation of
 * it: every action routes to `/attention`, which owns severity grouping, the
 * muted and resolved states, and jump-to-pane. Deriving those here would give
 * the app two queues to keep in agreement.
 *
 * It never prints a blocking *count*. Blocking items come from the permission
 * and notification hooks, which are P2, so a "0 blocking" tile would read as
 * "no session is blocked right now" — a claim about sessions this app is not
 * yet listening to. The empty state names the lane instead.
 */
function NeedsYouPanel(): ReactElement {
  const { data, isLoading } = useAttention("open");
  const navigate = useNavigate();
  const openQueue = useCallback(() => void navigate("/attention"), [navigate]);

  const items = data?.items ?? [];
  const counts = data?.counts;
  // The queue arrives severity-grouped and oldest-first *within* each group, so
  // neither end of the list is the oldest item overall — a fresh blocking item
  // outranks a week-old queued one. The minimum has to be computed.
  const oldestSeenAt = items.reduce<string | null>(
    (acc, item) =>
      acc === null || parseUtcMs(item.first_seen_at) < parseUtcMs(acc)
        ? item.first_seen_at
        : acc,
    null,
  );

  return (
    <section className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.sectionLabel}>Needs you</span>
        <span className={styles.headMeta}>
          {counts ? `${counts.open} open` : "—"}
          {/* How long the longest-waiting item has waited — the one figure
              that says whether this panel is being ignored. */}
          {oldestSeenAt ? ` · oldest ${relativeTime(oldestSeenAt)}` : ""}
        </span>
      </div>

      {isLoading ? (
        <div className={styles.rowMeta}>Loading&hellip;</div>
      ) : items.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>Nothing is waiting on you</div>
          {/* The 30-second poll is the whole of P1's freshness guarantee, and
              saying so is what makes an empty panel worth trusting. No tray
              notification is promised: P1 builds no tray. */}
          <div className={styles.emptyLine}>
            This queue re-checks every 30 seconds while the page is open.
          </div>
          {/* Said out loud so an empty panel is not mistaken for a promise it
              cannot keep: stalled and queued items are derived here today, and
              a session blocked on a permission prompt reaches this list only
              once the hook lane (P2) is listening. */}
          <div className={styles.emptyLine}>
            Stalled sessions, failed runs, budget thresholds and blocked tasks
            appear here on their own. Blocking permission prompts arrive with
            the hooks lane.
          </div>
        </div>
      ) : (
        items
          .slice(0, PREVIEW_LIMIT)
          .map((item) => (
            <QueueRow key={item.id} item={item} onOpen={openQueue} />
          ))
      )}

      <div className={styles.foot}>
        <span className={styles.footNote}>
          {counts
            ? `${counts.resolved_today} resolved today · average ${formatAverage(
                counts.resolved_today_avg_seconds,
              )}`
            : KPI_UNAVAILABLE}
        </span>
        <button type="button" className={styles.action} onClick={openQueue}>
          Needs You →
        </button>
      </div>
    </section>
  );
}

export function MissionControlPage(): ReactElement {
  const spendQ = useDailySpend();
  const dashQ = useDashboard();

  const spend = spendQ.data?.cost_usd;
  const counts = dashQ.data?.task_counts;
  const todo = counts?.todo ?? 0;
  const backlog = counts?.backlog ?? 0;

  return (
    <Shell>
      <div className={styles.page}>
        {/* ── ATTENTION ─────────────────────────────────────────────────── */}
        <section className={styles.hero}>
          <NeedsYouPanel />
          <div className={styles.aside}>
            <PlanHeadroom />
          </div>
        </section>

        {/* ── LIVE ──────────────────────────────────────────────────────── */}
        <section className={styles.live}>
          <ActiveSessions />
          <div className={styles.aside}>
            {/* P2. `TodoWrite` is visible only inside the app's own panes, so
                there is no todo list to count for a session running anywhere
                else — and a partial count would be worse than none. */}
            <KpiTile
              label="Agent todo lists"
              tag="P2"
              value={KPI_UNAVAILABLE}
              foot="Needs the TaskCreated / TaskCompleted hooks"
            />
            <KpiStack />
          </div>
        </section>

        {/* ── RECORD ────────────────────────────────────────────────────── */}
        <div className={styles.tiles}>
          {/* P1, estimated. Token count × the local price table — real, and
              carrying the `est` chip §2 requires until the cost lane makes it
              authoritative. */}
          <KpiTile
            label="Spend · 24h"
            tag="est"
            glow="rgba(59,130,246,0.14)"
            value={spend === undefined ? KPI_UNAVAILABLE : formatUSD(spend)}
            foot="Sessions started today, all clients"
          />
          {/* Shipped: /api/v1/dashboard. Unavailable until the payload lands —
              a `?? 0` here would render "0 todo · 0 backlog" on first paint and
              whenever the sidecar is unreachable, which is this page's own
              doctrine ("a zero is a measurement") broken on the page that
              states it. An empty board and an unanswered query look nothing
              alike to a reader and must not look alike here. */}
          <KpiTile
            label="Your board"
            value={counts === undefined ? KPI_UNAVAILABLE : todo + backlog}
            foot={
              counts === undefined ? (
                "Waiting for the sidecar"
              ) : (
                <>
                  <strong>{todo}</strong> todo · <strong>{backlog}</strong>{" "}
                  backlog
                </>
              )
            }
          />
          {/* P3. Tool success lives on the OTLP `claude_code.tool.execution`
              attribute; there is no receiver yet, so there is no denominator
              and nothing to report. */}
          <KpiTile
            label="Tool failures"
            tag="P3"
            value={KPI_UNAVAILABLE}
            foot="Needs the OTLP receiver"
          />
          {/* P3. Same lane: `claude_code.cost.usage` is what makes a cost
              figure authoritative rather than estimated. */}
          <KpiTile
            label="Vendor cost"
            tag="P3"
            value={KPI_UNAVAILABLE}
            foot="Needs the OTLP receiver"
          />
        </div>

        <section className={styles.record}>
          <ActivityPulse />
          <ProjectsPulse />
        </section>

        <MomentumTimeline />
      </div>
    </Shell>
  );
}
