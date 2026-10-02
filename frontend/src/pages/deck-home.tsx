/**
 * Deck home — the page at `/` (#282), replacing Mission Control's composition
 * of panels with one primitive on one grid.
 *
 * It answers four questions, top to bottom: **what needs me, what is running,
 * what changed while I was away, what is this costing me.** The stat row
 * carries the fourth so the first three can be lists.
 *
 * ## The honesty rule, carried over from Mission Control
 *
 * A tile whose lane does not exist renders an em dash and names the lane. It
 * must **never** render `0`. A zero is a measurement — it says "I looked and
 * there was nothing" — and this app cannot say that about a lane it has not
 * built. That applies to a query that has not answered yet just as much as to
 * an unbuilt receiver: "running" shows a dash until the session stream has
 * actually sent its snapshot, because an empty list before the snapshot is not
 * the same claim as no sessions.
 *
 * Two tiles are dashed permanently for now:
 *
 * - **plan headroom.** The prototype draws "69% · runs out 16:12". There is no
 *   such number. `lib/plan-usage.ts` exists precisely to stop it being
 *   invented: Claude desktop records two counters, says nothing about what they
 *   measure, and documents no ceiling — so there is no denominator, no
 *   percentage and no exhaustion time. The raw counters and the range the file
 *   has actually held are shown honestly by `PlanHeadroom`; a headroom figure
 *   is not something this data can produce.
 * - **tool failures.** Needs the OTLP receiver. No receiver, no denominator.
 *
 * ## "Since you last looked"
 *
 * The concept's one genuinely new piece of state, and it is **per-browser
 * only**: a `localStorage` stamp written when you leave this page. There is no
 * server-side last-seen timestamp, so the mark does not follow you to another
 * machine, another profile or a cleared cache, and two windows will disagree.
 * The page says so out loud rather than letting the divider imply more than it
 * knows. Moving the stamp into the sidecar is its own ticket — no endpoint was
 * invented here.
 *
 * The mark is read **once, on mount**. A stamp that moved while you were
 * reading would erase the divider under your eyes, which is the one thing it
 * exists not to do.
 */

import {
  useCallback,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  useAttention,
  useDailySpend,
  useDashboard,
  useSidecarSSE,
  type ActivityEntry,
  type AgentSession,
  type AttentionItem,
  type Task,
} from "../lib/api";
import {
  sessionFromDelta,
  sessionIdFromDelta,
} from "../lib/sse-session-envelope";
import {
  formatDuration,
  formatUSD,
  parseUtcMs,
  relativeTime,
} from "../lib/format-helpers";
import { DeckShell } from "../components/deck/deck-shell";
import { DECK_COLS } from "../components/deck/deck-cols";
import {
  DeckGrid,
  DeckGroup,
  DeckHead,
  DeckLine,
  type DeckState,
} from "../components/deck/deck-grid";

/** The em dash every unmeasured figure renders. Never a zero. */
const DASH = "—";

/**
 * How many queue items the preview shows before deferring to Needs You. Four,
 * because this group answers "is anything waiting on me, and roughly what kind
 * of thing" — not triage. The full queue owns grouping, muting and jump-to-pane.
 */
const NEEDS_PREVIEW = 4;

/** How many changes the "changed" group shows. The sidecar sends ten. */
const CHANGED_LIMIT = 10;

const SEV_STATE: Record<string, DeckState> = {
  blocking: "block",
  stalled: "stall",
  queued: "wait",
};

const SESSION_STATE: Record<AgentSession["status"], DeckState> = {
  active: "run",
  idle: "idle",
  stopped: "wait",
  ended: "done",
};

/** Where this browser last left the page, epoch millis. */
const LAST_LOOKED_KEY = "codenest.deck.last-looked";

function readLastLooked(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_LOOKED_KEY);
    if (raw === null) return null;
    const ms = Number(raw);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    // Private mode, blocked site data, or a locked-down webview. No mark is a
    // first visit, which the page already renders honestly.
    return null;
  }
}

function writeLastLooked(): void {
  try {
    window.localStorage.setItem(LAST_LOOKED_KEY, String(Date.now()));
  } catch {
    // Nothing to do and nothing worth telling the user: the divider simply
    // stays where it was.
  }
}

/**
 * Read the mark once, stamp a new one on the way out.
 *
 * Reading once is the whole contract: the divider has to stay put for as long
 * as you are looking at it. Writing happens on unmount and on `pagehide`, so
 * closing the window counts as having looked — otherwise the mark would only
 * move when you navigated, and quitting the app would replay yesterday's
 * changes as new.
 */
function useLastLooked(): number | null {
  const [at] = useState(readLastLooked);
  useEffect(() => {
    window.addEventListener("pagehide", writeLastLooked);
    return () => {
      window.removeEventListener("pagehide", writeLastLooked);
      writeLastLooked();
    };
  }, []);
  return at;
}

/**
 * Live sessions off the agent SSE stream, with the one flag that keeps the
 * count honest: `ready` is false until the snapshot has arrived, and an empty
 * list before that is "not asked yet", not "nothing running".
 */
function useLiveSessions(): { sessions: AgentSession[]; ready: boolean } {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [ready, setReady] = useState(false);

  const onEvent = useCallback((data: unknown, eventName: string) => {
    if (eventName === "snapshot") {
      const payload = data as { sessions?: AgentSession[] };
      setSessions(payload.sessions ?? []);
      setReady(true);
      return;
    }
    if (eventName === "session_started" || eventName === "update") {
      const s = sessionFromDelta(data);
      if (!s) return;
      setSessions((prev) => {
        const idx = prev.findIndex((x) => x.session_id === s.session_id);
        if (idx < 0) return [s, ...prev];
        const next = [...prev];
        next[idx] = s;
        return next;
      });
      return;
    }
    if (eventName === "session_ended" || eventName === "session_removed") {
      const id = sessionIdFromDelta(data);
      if (id) setSessions((prev) => prev.filter((x) => x.session_id !== id));
    }
  }, []);

  useSidecarSSE("agents", onEvent);
  return { sessions, ready };
}

/**
 * Mean time-to-resolution. "average", not "median", for the reason Needs You
 * gives: SQLite has no median aggregate and the sidecar sends a mean.
 */
function formatAverage(seconds: number | null | undefined): string {
  if (seconds == null) return DASH;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, "0")}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

function Big({
  value,
  label,
  warn,
}: {
  value: ReactNode;
  label: string;
  warn?: boolean;
}): ReactElement {
  return (
    <div className="dk-big">
      <div className={value === DASH ? "v na" : "v"}>{value}</div>
      <div className={warn ? "l warn" : "l"}>{label}</div>
    </div>
  );
}

function needsCells(item: AttentionItem, onOpen: () => void) {
  const meta = [item.project_name, item.detail].filter(Boolean).join(" · ");
  return [
    { v: item.title, cls: "sub", title: item.title },
    meta,
    { v: relativeTime(item.first_seen_at), cls: "r" },
    {
      v: (
        <button
          type="button"
          className="dk-btn bare"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          open
        </button>
      ),
      cls: "r",
    },
  ];
}

/** The line's headline: what the session was asked to do, else who it is. */
function sessionLabel(s: AgentSession): string {
  const prompt = (s.initial_prompt ?? "").trim().replace(/\s+/g, " ");
  return prompt || s.profile;
}

function sessionCells(s: AgentSession) {
  const elapsed = Math.floor((Date.now() - parseUtcMs(s.started_at)) / 1000);
  const label = sessionLabel(s);
  return [
    { v: label, cls: "sub", title: label },
    s.model ?? DASH,
    s.project_name ?? DASH,
    { v: elapsed >= 0 ? formatDuration(elapsed) : DASH, cls: "r" },
    { v: formatUSD(s.cost_usd), cls: "r" },
  ];
}

/**
 * The state glyph for a change. Derived from the action and the value it moved
 * to, because `activity_log` has no status column of its own — an unrecognised
 * action is `idle` rather than guessed into a colour.
 */
function activityState(e: ActivityEntry): DeckState {
  const v = `${e.action} ${e.new_value ?? ""}`.toLowerCase();
  if (v.includes("fail") || v.includes("error")) return "fail";
  if (v.includes("block")) return "block";
  if (v.includes("done") || v.includes("complete")) return "done";
  if (v.includes("progress") || v.includes("start")) return "run";
  if (v.includes("todo") || v.includes("creat")) return "todo";
  return "idle";
}

function activityCells(e: ActivityEntry) {
  const verb = e.action.replace(/[_-]+/g, " ");
  const moved =
    e.old_value && e.new_value ? `${e.old_value} → ${e.new_value}` : null;
  const state = activityState(e);
  return [
    { v: `#${e.entity_id}`, cls: "id" },
    { v: verb, cls: "sub", title: moved ? `${verb} · ${moved}` : verb },
    e.actor ?? DASH,
    e.entity_type,
    { v: relativeTime(e.created_at), cls: "r" },
    {
      v: e.new_value ? (
        <span className="dk-tag" data-s={state}>
          {e.new_value}
        </span>
      ) : (
        ""
      ),
      cls: "r",
    },
  ];
}

const CHANGED_HEAD = ["", "what", "who", "where", "r when", "r "];

/**
 * What is being worked on right now (#272). `pages/in-progress.tsx` was a whole
 * surface for this one list; the dashboard payload already carries it, so it is
 * a group here and a filter on Work — `/tasks?status=in-progress`, which that
 * page's project and assignee filters are already part of.
 *
 * The started date is the one column Work's task line does not carry, which is
 * why it rides here. The task detail page still shows it too.
 */
const PROGRESS_HEAD = ["", "what", "where", "who", "r started", "r priority"];

function progressCells(t: Task) {
  return [
    { v: `#${t.id}`, cls: "id" },
    { v: t.title, cls: "sub", title: t.title },
    t.project_name ?? "unassigned",
    t.assignee_name ?? "—",
    { v: t.started_date ?? DASH, cls: "r" },
    { v: t.priority, cls: "r" },
  ];
}

export function DeckHomePage(): ReactElement {
  const navigate = useNavigate();
  const lastLooked = useLastLooked();

  const { data: queue, isLoading: queueLoading } = useAttention("open");
  const { data: dash } = useDashboard();
  const { data: spend } = useDailySpend();
  const { sessions, ready: sessionsReady } = useLiveSessions();

  const openQueue = useCallback(() => void navigate("/attention"), [navigate]);
  // The runs view of the Sessions surface — the Command Center's list, on the
  // page that owns sessions (#269).
  const openSessions = useCallback(
    () => void navigate("/terminal?view=runs"),
    [navigate],
  );

  const counts = queue?.counts;
  const items = queue?.items ?? [];
  // The queue is severity-grouped and oldest-first *within* a group, so neither
  // end of the list is the oldest item overall.
  const oldestSeenAt = items.reduce<string | null>(
    (acc, item) =>
      acc === null || parseUtcMs(item.first_seen_at) < parseUtcMs(acc)
        ? item.first_seen_at
        : acc,
    null,
  );

  const live = sessions.filter((s) => s.status !== "ended");
  const running = live.filter((s) => s.status === "active");

  const inProgress = dash?.in_progress_tasks ?? [];
  const activity = (dash?.recent_activity ?? []).slice(0, CHANGED_LIMIT);
  // A first visit has no mark, so nothing is "new" — every row goes below the
  // line and the divider is not drawn. Claiming ten changes happened while you
  // were away, when the page has never been open before, is the same fabricated
  // measurement the dashes exist to prevent.
  const isNew = (e: ActivityEntry): boolean =>
    lastLooked !== null && parseUtcMs(e.created_at) > lastLooked;
  const fresh = activity.filter(isNew);
  const seen = activity.filter((e) => !isNew(e));

  return (
    <DeckShell
      title="deck"
      crumb={
        lastLooked === null
          ? "first visit in this browser"
          : `you were last here ${relativeTime(new Date(lastLooked).toISOString())}`
      }
    >
      <div className="dk-bigs">
        <Big
          value={counts ? counts.open : DASH}
          label="need you"
          warn={!!counts && counts.open > 0}
        />
        {/* A dash until the snapshot lands: an empty list before it is not a
            reading of zero sessions. */}
        <Big
          value={sessionsReady ? running.length : DASH}
          label={sessionsReady ? "running" : "running · waiting for the stream"}
        />
        <Big
          value={spend === undefined ? DASH : formatUSD(spend.cost_usd)}
          label="spend today · estimated"
        />
        <Big
          value={formatAverage(counts?.resolved_today_avg_seconds)}
          label="mean resolution · resolved today"
        />
        {/* Permanently dashed until there is a ceiling to divide by. See the
            module docstring: the prototype's "69% · runs out 16:12" is not a
            number this data can produce. */}
        <Big value={DASH} label="plan headroom · no ceiling in plan usage" />
        <Big value={DASH} label="tool failures · needs the otlp receiver" />
      </div>

      <DeckGroup
        label="needs you"
        count={counts ? counts.open : DASH}
        note={oldestSeenAt ? `oldest ${relativeTime(oldestSeenAt)}` : undefined}
        state="block"
      >
        {queueLoading ? (
          <div className="dk-note">Loading&hellip;</div>
        ) : items.length === 0 ? (
          <div className="dk-note sans">
            <div style={{ color: "var(--fg-2)" }}>Nothing is waiting on you</div>
            {/* The 30-second poll is the whole of the freshness promise, and
                naming it is what makes an empty group trustworthy. No tray
                notification is promised: there is no tray. */}
            <div>This queue re-checks every 30 seconds while the page is open.</div>
            <div>
              Stalled sessions, failed runs, budget thresholds and blocked tasks appear here on
              their own. Blocking permission prompts arrive with the hooks lane.
            </div>
          </div>
        ) : (
          <DeckGrid cols={DECK_COLS.default} label="Needs you">
            <DeckHead cells={["what", "where", "r waiting", "r "]} />
            {items.slice(0, NEEDS_PREVIEW).map((item) => (
              <DeckLine
                key={item.id}
                state={SEV_STATE[item.severity] ?? "idle"}
                cells={needsCells(item, openQueue)}
                onOpen={openQueue}
              />
            ))}
          </DeckGrid>
        )}
      </DeckGroup>

      <DeckGroup
        label="running"
        count={sessionsReady ? running.length : DASH}
        note={
          sessionsReady && live.length > running.length
            ? `${live.length - running.length} idle`
            : undefined
        }
        state="run"
      >
        {!sessionsReady ? (
          <div className="dk-note">Waiting for the session stream&hellip;</div>
        ) : live.length === 0 ? (
          <div className="dk-note sans">No session is running.</div>
        ) : (
          <DeckGrid cols={DECK_COLS.default} label="Running">
            <DeckHead cells={["session", "model", "where", "r elapsed", "r cost"]} />
            {live.map((s) => (
              <DeckLine
                key={s.session_id}
                state={SESSION_STATE[s.status] ?? "idle"}
                cells={sessionCells(s)}
                onOpen={openSessions}
              />
            ))}
          </DeckGrid>
        )}
      </DeckGroup>

      <DeckGroup
        label="in progress"
        count={dash === undefined ? DASH : inProgress.length}
        state="run"
        actions={
          <button
            type="button"
            className="dk-btn bare"
            onClick={() => void navigate("/tasks?status=in-progress")}
          >
            open in work
          </button>
        }
      >
        {dash === undefined ? (
          <div className="dk-note">Loading&hellip;</div>
        ) : inProgress.length === 0 ? (
          <div className="dk-note sans">Nothing is being worked on.</div>
        ) : (
          <DeckGrid cols={DECK_COLS.tasks} label="In progress">
            <DeckHead cells={PROGRESS_HEAD} />
            {inProgress.map((t) => (
              <DeckLine
                key={t.id}
                state="run"
                cells={progressCells(t)}
                onOpen={() => void navigate(`/tasks/${t.id}`)}
              />
            ))}
          </DeckGrid>
        )}
      </DeckGroup>

      <DeckGroup
        label="changed"
        count={activity.length}
        note={lastLooked === null ? "no mark yet" : `${fresh.length} new`}
      >
        {activity.length === 0 ? (
          <div className="dk-note sans">Nothing has changed yet.</div>
        ) : (
          <>
            {fresh.length > 0 && (
              <DeckGrid cols={DECK_COLS.tasks} label="Changed since you last looked">
                <DeckHead cells={CHANGED_HEAD} />
                {fresh.map((e) => (
                  <DeckLine
                    key={e.id}
                    state={activityState(e)}
                    cells={activityCells(e)}
                    fresh
                  />
                ))}
              </DeckGrid>
            )}
            {/* The rule itself. Two grids rather than a stray div inside one:
                a role="grid" may only contain rows, and splitting puts the
                meaning into each grid's own label. Both carry the same --cols,
                so the columns run straight through the divider. */}
            {lastLooked !== null && <div className="dk-since">since you last looked</div>}
            {seen.length > 0 && (
              <DeckGrid cols={DECK_COLS.tasks} label="Changed before you last looked">
                {fresh.length === 0 && <DeckHead cells={CHANGED_HEAD} />}
                {seen.map((e) => (
                  <DeckLine key={e.id} state={activityState(e)} cells={activityCells(e)} />
                ))}
              </DeckGrid>
            )}
          </>
        )}
      </DeckGroup>

      <hr className="dk-rule" />
      <div className="dk-note sans">
        <p>
          <strong>&ldquo;Since you last looked&rdquo; is remembered in this browser only.</strong>{" "}
          The mark is a <code>localStorage</code> stamp written when you leave this page. There is
          no server-side last-seen state yet, so it does not follow you to another machine or
          another profile, it is lost when site data is cleared, and a second window will disagree
          with this one. Moving the stamp into the sidecar is its own ticket.
        </p>
        <p>
          A figure this app cannot measure shows an em dash and names the lane it is waiting on,
          never <code>0</code> — a zero is a measurement, and an unbuilt lane took none. Plan
          headroom is one of those: Claude desktop records two counters with no documented ceiling,
          so there is no percentage to compute and no exhaustion time to predict.
        </p>
      </div>
    </DeckShell>
  );
}
