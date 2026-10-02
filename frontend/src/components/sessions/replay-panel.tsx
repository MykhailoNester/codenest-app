/**
 * The session replay panel (#283), converted from the old `d3-*` shell onto
 * Deck and moved out of `components/command-center/` — the directory the fold
 * in #269 left behind and #283 has since retired entirely. Its two mount
 * points are `sessions/session-detail.tsx` (the `replay` tab) and
 * `task-detail/run-replay.tsx` (inline under the runs card).
 *
 * Same panel, same capabilities: the scrubbable timeline with its activity
 * histogram, the transport controls, the last-actions list, the tools-used
 * chart, the event-detail modal, "inspect lanes" and back. What went is the
 * rounded card, the pill buttons, the bold sans title and the breadcrumb that
 * named the Command Center — a surface #269 deleted.
 */

import {
  memo,
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
  type ReactElement,
} from "react";
import { useNavigate } from "react-router-dom";
import type { AgentSession, AgentEvent, ProfileOut } from "../../lib/api";
import { profileColor } from "../../lib/profile-utils";
import { Icon } from "../icon";
import { DeckGrid, DeckGroup, DeckHead, DeckLine } from "../deck/deck-grid";
import { EventDetailModal } from "./event-detail-modal";
import { eventLabel } from "./status-utils";

interface ReplayPanelProps {
  session: AgentSession;
  events: AgentEvent[];
  profiles: ProfileOut[];
  onClose?: () => void;
}

/**
 * The timeline's own geometry.
 *
 * Deck has no histogram primitive — `.dk-meter` covers the proportional bar in
 * "tools used", but nothing covers a bucketed strip with a cursor dragged over
 * it — and `components/deck/*` is out of scope for this ticket. So the four
 * values the strip needs are declared here, with the only surface that draws
 * one, rather than being added to a shared file by a panel change. This is the
 * call `pages/attention.tsx` makes with `ATTENTION_COLS`.
 */
const TIMELINE_H = 34; // px — tall enough that 20 buckets read as a shape
const TIMELINE_BUCKETS = 20; // trailing minutes the strip samples
const TIMELINE_MIN_TICK = 2; // px floor, so a one-event minute is still drawn
const TIMELINE_STEP = 0.05; // fraction the arrow keys and step buttons move

const COLS_CLOCK = "auto minmax(0, 1fr) auto";
const COLS_ACTION = "14px 56px 140px minmax(0, 1fr)";
const COLS_TOOL = "14px minmax(0, 1fr) 60px 56px";

const SPEEDS = [1, 2, 4] as const;

function fmtTime(iso: string): string {
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  if (isNaN(d.getTime())) return iso;
  return d.toTimeString().slice(0, 8);
}

function buildToolCounts(
  events: AgentEvent[],
): { tool: string; count: number }[] {
  const map = new Map<string, number>();
  events.forEach((e) => {
    if (e.event_type === "PreToolUse" && e.tool_name) {
      map.set(e.tool_name, (map.get(e.tool_name) ?? 0) + 1);
    }
  });
  return Array.from(map.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

function buildActivityTicks(events: AgentEvent[]): number[] {
  const buckets = new Map<string, number>();
  events.forEach((e) => {
    if (e.event_type === "PreToolUse") {
      const minute = e.created_at.slice(0, 16);
      buckets.set(minute, (buckets.get(minute) ?? 0) + 1);
    }
  });
  const sorted = Array.from(buckets.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return sorted.map(([, n]) => n).slice(-TIMELINE_BUCKETS);
}

function ReplayPanelInner({
  session,
  events,
  profiles,
  onClose,
}: ReplayPanelProps): ReactElement {
  const [speed, setSpeed] = useState<number>(1);
  // 0..1 where 1 = end/live. Active sessions render the panel pinned
  // to "live"; the auto-advance interval is only useful for replaying
  // ended sessions, so we no longer arm it for active ones (the old
  // behaviour spun a 50 ms timer that re-rendered the whole panel
  // 20 times/sec including the O(n) tool-count and activity-tick
  // recomputations below — for no visible benefit on a live session).
  const [scrubPos, setScrubPos] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [modalEvent, setModalEvent] = useState<AgentEvent | null>(null);
  const navigate = useNavigate();
  const trackRef = useRef<HTMLDivElement>(null);
  const color = profileColor(profiles, session.profile);

  // Heavy aggregations memoized on the events array so they only
  // recompute when events actually change, not on every scrub tick.
  const toolCounts = useMemo(() => buildToolCounts(events), [events]);
  const ticks = useMemo(() => buildActivityTicks(events), [events]);
  const maxTick = useMemo(() => Math.max(1, ...ticks), [ticks]);
  const toolTotal = useMemo(
    () => toolCounts.reduce((a, b) => a + b.count, 0),
    [toolCounts],
  );

  // Auto-advance scrubber during playback
  const advance = useCallback(() => {
    setScrubPos((p) => {
      if (p >= 1) {
        setIsPlaying(false);
        return 1;
      }
      const step = 0.005 * speed;
      return Math.min(1, p + step);
    });
  }, [speed]);

  useEffect(() => {
    // Don't run the timer when we're already at the end. setInterval
    // with a settled scrubber would just call `advance` which would
    // immediately call `setIsPlaying(false)` and re-render — wasted
    // work in the common case of a paused or fully-played session.
    if (isPlaying && scrubPos < 1) {
      const id = setInterval(advance, 50);
      return () => clearInterval(id);
    }
    return undefined;
  }, [isPlaying, scrubPos, advance]);

  useEffect(() => {
    if (!onClose) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Drag scrubber
  const startDrag = useCallback((e: React.PointerEvent) => {
    const track = trackRef.current;
    if (!track) return;
    setIsPlaying(false);
    const updatePos = (clientX: number) => {
      const rect = track.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      setScrubPos(pos);
    };
    updatePos(e.clientX);
    const onMove = (me: PointerEvent) => updatePos(me.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  // Keyboard navigation
  const onTrackKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      setIsPlaying(false);
      setScrubPos((p) => Math.min(1, p + TIMELINE_STEP));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setIsPlaying(false);
      setScrubPos((p) => Math.max(0, p - TIMELINE_STEP));
    } else if (e.key === " ") {
      e.preventDefault();
      setIsPlaying((v) => !v);
    }
  }, []);

  // Last actions: derived from `events` and `scrubPos`. Memoized so
  // when only `scrubPos` changes the filter only runs once per change.
  const lastActions = useMemo(() => {
    const visibleCount = Math.round(scrubPos * events.length);
    const visibleEvents = events.slice(0, Math.max(0, visibleCount));
    return visibleEvents
      .filter(
        (e) => e.event_type === "PreToolUse" || e.event_type === "PostToolUse",
      )
      .slice(-6);
  }, [events, scrubPos]);

  const projectLabel =
    session.project_name ??
    (session.cwd
      ? (session.cwd.split("/").filter(Boolean).pop() ?? session.cwd)
      : "unknown");

  const live = session.status === "active" && scrubPos === 1;

  const transport = (
    <>
      <button
        className="dk-btn bare icon"
        type="button"
        aria-label="Step back 5%"
        onClick={() => {
          setIsPlaying(false);
          setScrubPos((p) => Math.max(0, p - TIMELINE_STEP));
        }}
      >
        <Icon name="chevronLeft" size={12} />
      </button>
      <button
        className="dk-btn bare icon"
        type="button"
        aria-label={isPlaying ? "Pause" : "Play"}
        onClick={() => setIsPlaying((v) => !v)}
      >
        <Icon name={isPlaying ? "pause" : "play"} size={12} />
      </button>
      <button
        className="dk-btn bare icon"
        type="button"
        aria-label="Step forward 5%"
        onClick={() => {
          setIsPlaying(false);
          setScrubPos((p) => Math.min(1, p + TIMELINE_STEP));
        }}
      >
        <Icon name="chevronRight" size={12} />
      </button>
      <span className="dk-seg" role="group" aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className={speed === s ? "on" : undefined}
            aria-pressed={speed === s}
            onClick={() => setSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </span>
    </>
  );

  return (
    <section aria-label="Session replay">
      <div className="dk-bar">
        <span className="dk-bar__ref">session replay</span>
        <span style={{ color }}>{session.profile}</span>
        <span className="dim">· {projectLabel}</span>
        <span className="dk-tag" data-s={live ? "run" : "done"}>
          {live ? "live" : session.status}
        </span>
        <span className="sp" />
        <span className="dk-actions">
          <button
            className="dk-btn"
            type="button"
            onClick={() =>
              navigate(
                `/terminal?view=runs&session=${encodeURIComponent(session.session_id)}&tab=inspect`,
              )
            }
          >
            inspect lanes
          </button>
          {onClose && (
            <button className="dk-btn bare" type="button" onClick={onClose}>
              back
            </button>
          )}
        </span>
      </div>

      <DeckGroup
        label="timeline"
        count={events.length}
        note={`${Math.round(scrubPos * 100)}% through`}
        actions={transport}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: COLS_CLOCK,
            gap: "var(--u3)",
            alignItems: "center",
            padding: "0 var(--u3)",
          }}
        >
          <span className="dk-meta">{fmtTime(session.started_at)}</span>
          <div
            ref={trackRef}
            onPointerDown={startDrag}
            onKeyDown={onTrackKeyDown}
            role="slider"
            aria-label="Session timeline scrubber"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(scrubPos * 100)}
            tabIndex={0}
            style={{
              position: "relative",
              height: TIMELINE_H,
              display: "flex",
              alignItems: "flex-end",
              gap: 1,
              padding: "3px 4px",
              background: "var(--bg-1)",
              border: "1px solid var(--line)",
              borderRadius: 2,
              cursor: "ew-resize",
            }}
          >
            {ticks.map((v, i) => (
              <span
                key={i}
                style={{
                  flex: 1,
                  minHeight: TIMELINE_MIN_TICK,
                  height: `${(v / maxTick) * 100}%`,
                  background: color,
                  opacity: 0.7,
                }}
              />
            ))}
            {ticks.length === 0 && (
              <span className="dk-meta" style={{ margin: "auto" }}>
                no activity
              </span>
            )}
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${scrubPos * 100}%`,
                width: 1,
                background: "var(--run)",
              }}
            />
          </div>
          <span className="dk-meta">
            {live ? "live" : fmtTime(session.ended_at ?? session.started_at)}
          </span>
        </div>
      </DeckGroup>

      <DeckGroup label="last actions" count={lastActions.length}>
        {lastActions.length === 0 ? (
          <div className="dk-note">No tool calls yet</div>
        ) : (
          <DeckGrid cols={COLS_ACTION} label="Last actions">
            <DeckHead cells={["when", "tool", "summary"]} />
            {lastActions.map((ev) => (
              <DeckLine
                key={ev.id}
                state={ev.event_type === "PostToolUse" ? "done" : "run"}
                cells={[
                  fmtTime(ev.created_at).slice(-5),
                  { v: ev.tool_name ?? eventLabel(ev), cls: "sub" },
                  { v: ev.summary ?? "", title: ev.summary ?? undefined },
                ]}
                onOpen={() => {
                  setIsPlaying(false);
                  setModalEvent(ev);
                }}
              />
            ))}
          </DeckGrid>
        )}
      </DeckGroup>

      <DeckGroup label="tools used" count={toolCounts.length}>
        {toolCounts.length === 0 ? (
          <div className="dk-note">No tool calls yet</div>
        ) : (
          <DeckGrid cols={COLS_TOOL} label="Tools used">
            <DeckHead cells={["tool", "share", "r calls"]} />
            {toolCounts.map(({ tool, count }) => {
              const pct = (count / Math.max(toolTotal, 1)) * 100;
              return (
                <DeckLine
                  key={tool}
                  state="done"
                  cells={[
                    { v: tool, cls: "sub" },
                    {
                      v: (
                        <span
                          className="dk-meter"
                          role="progressbar"
                          aria-label={`${tool} share of tool calls`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(pct)}
                        >
                          <i style={{ width: `${pct}%`, background: color }} />
                        </span>
                      ),
                    },
                    { v: String(count), cls: "r" },
                  ]}
                />
              );
            })}
          </DeckGrid>
        )}
      </DeckGroup>

      {modalEvent !== null && (
        <EventDetailModal
          event={modalEvent}
          onClose={() => setModalEvent(null)}
        />
      )}
    </section>
  );
}

// Memoize the panel: when a parent re-renders because of unrelated state
// (filters, palette, launch modal), we don't want to re-walk the events
// array. Identity-compare props — react-query returns a stable reference
// for `events` while the data is unchanged, so this skips reliably.
export const ReplayPanel = memo(ReplayPanelInner);
