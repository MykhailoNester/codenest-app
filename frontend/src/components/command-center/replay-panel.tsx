import {
  memo,
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
  type ReactElement,
} from "react";
import type { AgentSession, AgentEvent, ProfileOut } from "../../lib/api";
import { profileColor } from "../../lib/profile-utils";
import { Icon } from "../icon";
import { DetailHeader } from "../layout/detail-header";
import { EventDetailModal } from "./event-detail-modal";
import { eventLabel } from "./status-utils";

interface ReplayPanelProps {
  session: AgentSession;
  events: AgentEvent[];
  profiles: ProfileOut[];
  onClose?: () => void;
}

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
  return sorted.map(([, n]) => n).slice(-20);
}

function ReplayPanelInner({
  session,
  events,
  profiles,
  onClose,
}: ReplayPanelProps): ReactElement {
  const [speed, setSpeed] = useState(1);
  // 0..1 where 1 = end/live. Active sessions render the panel pinned
  // to "live"; the auto-advance interval is only useful for replaying
  // ended sessions, so we no longer arm it for active ones (the old
  // behaviour spun a 50 ms timer that re-rendered the whole panel
  // 20 times/sec including the O(n) tool-count and activity-tick
  // recomputations below — for no visible benefit on a live session).
  const [scrubPos, setScrubPos] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [modalEvent, setModalEvent] = useState<AgentEvent | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const color = profileColor(profiles, session.profile);

  // Heavy aggregations memoized on the events array so they only
  // recompute when events actually change, not on every scrub tick.
  const toolCounts = useMemo(() => buildToolCounts(events), [events]);
  const ticks = useMemo(() => buildActivityTicks(events), [events]);
  const maxTick = useMemo(() => Math.max(1, ...ticks), [ticks]);

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
      setScrubPos((p) => Math.min(1, p + 0.05));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setIsPlaying(false);
      setScrubPos((p) => Math.max(0, p - 0.05));
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

  return (
    <aside className="d3-replay">
      <DetailHeader
        crumbs="Command Center · Session Replay"
        title="Session replay"
        subtitle={`${session.profile} · ${projectLabel}`}
        onBack={onClose}
      />

      {/* Scrubber */}
      <div className="d3-scrub">
        <div className="d3-scrub__time mono">{fmtTime(session.started_at)}</div>
        <div
          ref={trackRef}
          className="d3-scrub__track"
          onPointerDown={startDrag}
          onKeyDown={onTrackKeyDown}
          role="slider"
          aria-label="Session timeline scrubber"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(scrubPos * 100)}
          tabIndex={0}
          style={{ cursor: "ew-resize" }}
        >
          {ticks.map((v, i) => (
            <span
              key={i}
              className="d3-scrub__tick"
              style={{ height: `${(v / maxTick) * 100}%`, background: color }}
            />
          ))}
          {ticks.length === 0 && (
            <span
              style={{ fontSize: "9px", color: "var(--fg-4)", margin: "auto" }}
            >
              no activity
            </span>
          )}
          <div
            className="d3-scrub__cursor"
            style={{ left: `${scrubPos * 100}%` }}
          />
        </div>
        <div className="d3-scrub__time mono">
          {session.status === "active" && scrubPos === 1
            ? "live"
            : fmtTime(session.ended_at ?? session.started_at)}
        </div>
      </div>
      <div className="d3-scrub__controls">
        <button
          className="d3-btn d3-btn--ghost"
          type="button"
          aria-label="Step back 5%"
          onClick={() => {
            setIsPlaying(false);
            setScrubPos((p) => Math.max(0, p - 0.05));
          }}
        >
          <Icon name="chevronLeft" size={12} />
        </button>
        <button
          className="d3-btn d3-btn--ghost"
          type="button"
          aria-label={isPlaying ? "Pause" : "Play"}
          onClick={() => setIsPlaying((v) => !v)}
        >
          <Icon name={isPlaying ? "pause" : "play"} size={12} />
        </button>
        <button
          className="d3-btn d3-btn--ghost"
          type="button"
          aria-label="Step forward 5%"
          onClick={() => {
            setIsPlaying(false);
            setScrubPos((p) => Math.min(1, p + 0.05));
          }}
        >
          <Icon name="chevronRight" size={12} />
        </button>
        <button
          className="d3-scrub__speed mono"
          style={{ background: "none", border: "none", cursor: "pointer" }}
          type="button"
          aria-label={`Playback speed: ${speed}x`}
          onClick={() => setSpeed((s) => (s === 1 ? 2 : s === 2 ? 4 : 1))}
        >
          {speed}×
        </button>
      </div>

      {/* Last actions */}
      <div className="d3-h" style={{ marginTop: 14 }}>
        Last actions
      </div>
      <div className="d3-replay__log">
        {lastActions.length === 0 ? (
          <div style={{ color: "var(--fg-4)", fontSize: "11px" }}>
            No tool calls yet
          </div>
        ) : (
          lastActions.map((ev) => (
            <button
              key={ev.id}
              type="button"
              className="d3-replay__row d3-replay__row--clickable"
              onClick={() => {
                setIsPlaying(false);
                setModalEvent(ev);
              }}
              title="Click to inspect event details"
            >
              <span className="d3-replay__time mono">
                {fmtTime(ev.created_at).slice(-5)}
              </span>
              <span
                className="d3-replay__tool"
                style={{ background: color + "22", color }}
              >
                {ev.tool_name ?? eventLabel(ev)}
              </span>
              <span className="d3-replay__msg mono truncate">
                {ev.summary ?? ""}
              </span>
            </button>
          ))
        )}
      </div>

      {/* Tools used */}
      <div className="d3-h" style={{ marginTop: 14 }}>
        Tools used
      </div>
      <div className="d3-radial">
        {toolCounts.length === 0 ? (
          <div style={{ color: "var(--fg-4)", fontSize: "11px" }}>
            No tool calls yet
          </div>
        ) : (
          toolCounts.map(({ tool, count }) => {
            const total = toolCounts.reduce((a, b) => a + b.count, 0);
            const pct = (count / Math.max(total, 1)) * 100;
            return (
              <div key={tool} className="d3-radial__row">
                <span className="d3-radial__name mono">{tool}</span>
                <div className="d3-radial__track">
                  <div
                    className="d3-radial__fill"
                    style={{
                      width: `${pct}%`,
                      background: `linear-gradient(90deg, ${color}, ${color}aa)`,
                    }}
                  />
                </div>
                <span className="d3-radial__n tabular">{count}</span>
              </div>
            );
          })
        )}
      </div>

      {modalEvent !== null && (
        <EventDetailModal
          event={modalEvent}
          onClose={() => setModalEvent(null)}
        />
      )}
    </aside>
  );
}

// Memoize the panel: when the parent CommandCenter page re-renders
// because of unrelated state (filters, palette, launch modal), we
// don't want to re-walk the events array. Identity-compare props —
// react-query returns a stable reference for `events` while the data
// is unchanged, so this skips reliably.
export const ReplayPanel = memo(ReplayPanelInner);
