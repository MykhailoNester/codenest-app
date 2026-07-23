import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";
import type { ProfileOut, RecentEvent } from "../../lib/api";
import { profileColor } from "../../lib/profile-utils";
import { EventDetailModal } from "./event-detail-modal";
import { relativeTime } from "../../lib/format-helpers";
import { eventLabel } from "./status-utils";

interface LiveActivityProps {
  events: RecentEvent[];
  profiles: ProfileOut[];
  onSelectSession: (sessionId: string) => void;
}

function fmtRelative(iso: string): string {
  return relativeTime(iso);
}

function shortSession(sessionId: string): string {
  return sessionId.slice(0, 8);
}

interface SourceAttribution {
  kind: "task" | "inbox";
  id: number;
}

/** Safely parse source attribution from payload_json.  Returns null for
 *  legacy events that have no source fields — no pill rendered. */
function parseSourceAttribution(
  payloadJson: string | null,
): SourceAttribution | null {
  if (!payloadJson) return null;
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("source_kind" in parsed) ||
      !("source_id" in parsed)
    ) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const kind = obj["source_kind"];
    const id = obj["source_id"];
    if ((kind === "task" || kind === "inbox") && typeof id === "number") {
      return { kind, id };
    }
  } catch {
    // malformed JSON — ignore
  }
  return null;
}

interface SourcePillProps {
  source: SourceAttribution;
}

function SourcePill({ source }: SourcePillProps): ReactElement {
  const to =
    source.kind === "task"
      ? `/tasks/${source.id}`
      : `/inbox?focus=${source.id}`;
  return (
    <Link
      to={to}
      onClick={(e) => e.stopPropagation()}
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: "9px",
        fontFamily: "var(--font-mono)",
        color: "var(--accent)",
        background: "color-mix(in srgb, var(--accent) 12%, transparent)",
        border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
        borderRadius: "var(--r-1)",
        padding: "1px 5px",
        textDecoration: "none",
        flexShrink: 0,
        whiteSpace: "nowrap",
      }}
      title={`Launched from ${source.kind} #${source.id}`}
    >
      {source.kind} #{source.id}
    </Link>
  );
}

interface EventGroup {
  sessionId: string;
  profile: string;
  projectName: string | null;
  status: string;
  color: string;
  rows: RecentEvent[];
}

function groupEvents(
  events: RecentEvent[],
  profiles: ProfileOut[],
): EventGroup[] {
  const groups: EventGroup[] = [];
  let current: EventGroup | null = null;

  for (const ev of events) {
    if (current && current.sessionId === ev.session_id) {
      current.rows.push(ev);
    } else {
      current = {
        sessionId: ev.session_id,
        profile: ev.profile,
        projectName: ev.project_name,
        status: ev.status,
        color: profileColor(profiles, ev.profile),
        rows: [ev],
      };
      groups.push(current);
    }
  }
  return groups;
}

function LiveActivityInner({
  events,
  profiles,
  onSelectSession,
}: LiveActivityProps): ReactElement {
  const [modalEvent, setModalEvent] = useState<RecentEvent | null>(null);

  const closeModal = useCallback(() => setModalEvent(null), []);

  const handleJumpToSession = useCallback(
    (sessionId: string) => {
      setModalEvent(null);
      onSelectSession(sessionId);
    },
    [onSelectSession],
  );

  // Drop events from ended sessions — clicking those would jump into a
  // finished session that's no longer in the visible "active" list and
  // feels like a random selection. Ended history is reachable via the
  // dedicated drawer.
  const liveEvents = useMemo(
    () => events.filter((e) => e.status !== "ended"),
    [events],
  );
  const groups = useMemo(
    () => groupEvents(liveEvents, profiles),
    [liveEvents, profiles],
  );

  return (
    <aside className="d3-replay" aria-label="Live activity feed">
      <div className="d3-replay__head">
        <div style={{ minWidth: 0 }}>
          <div className="d3-h">Live activity</div>
          <div className="d3-replay__title">
            All sessions ·{" "}
            <span className="mono" style={{ color: "var(--fg-3)" }}>
              {liveEvents.length} events
            </span>
          </div>
        </div>
      </div>

      {liveEvents.length === 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "32px 0",
            color: "var(--fg-4)",
            fontSize: "12px",
          }}
        >
          No events yet. Start a Claude Code session.
        </div>
      ) : (
        <div
          className="d3-live-feed"
          style={{
            display: "flex",
            flexDirection: "column",
            maxHeight: "560px",
            overflowY: "auto",
            margin: "4px -4px 0",
          }}
        >
          {groups.map((group, gi) => (
            <div
              key={`${group.sessionId}-${group.rows[0]?.id ?? gi}`}
              style={{ minWidth: 0 }}
            >
              {/* Group header — clicking jumps to session replay */}
              <button
                type="button"
                onClick={() => onSelectSession(group.sessionId)}
                title={`Open replay for ${group.profile} · ${group.projectName ?? "session"}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 10px 4px",
                  width: "100%",
                  minWidth: 0,
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  textAlign: "left",
                  borderRadius: 6,
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: group.color,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontSize: "10px",
                    color: group.color,
                    fontFamily: "var(--font-mono)",
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                >
                  {group.profile}
                </span>
                {group.projectName && (
                  <>
                    <span
                      style={{
                        fontSize: "10px",
                        color: "var(--fg-4)",
                        flexShrink: 0,
                      }}
                    >
                      ·
                    </span>
                    <span
                      className="truncate mono"
                      style={{
                        fontSize: "10px",
                        color: "var(--fg-3)",
                        minWidth: 0,
                        flex: "0 1 auto",
                      }}
                    >
                      {group.projectName}
                    </span>
                  </>
                )}
                <span
                  style={{
                    fontSize: "9px",
                    color: "var(--fg-4)",
                    fontFamily: "var(--font-mono)",
                    marginLeft: "auto",
                    flexShrink: 0,
                  }}
                >
                  {shortSession(group.sessionId)}
                </span>
              </button>

              {/* Event rows — clicking opens the detail modal */}
              {group.rows.map((ev) => {
                const source = parseSourceAttribution(ev.payload_json);
                return (
                  <button
                    key={ev.id}
                    type="button"
                    onClick={() => setModalEvent(ev)}
                    title="Click to inspect event details"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "2px 10px 2px 24px",
                      width: "100%",
                      minWidth: 0,
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "10px",
                        color:
                          ev.event_type === "SessionEnd"
                            ? "var(--fg-4)"
                            : ev.event_type === "UserPromptSubmit"
                              ? "var(--accent)"
                              : "var(--fg-2)",
                        fontFamily: "var(--font-mono)",
                        width: 70,
                        flexShrink: 0,
                      }}
                    >
                      {eventLabel(ev)}
                    </span>
                    <span
                      className="truncate mono"
                      style={{
                        fontSize: "10px",
                        color: "var(--fg-4)",
                        minWidth: 0,
                        flex: 1,
                      }}
                    >
                      {ev.summary ?? ""}
                    </span>
                    {source !== null && <SourcePill source={source} />}
                    <span
                      style={{
                        fontSize: "9px",
                        color: "var(--fg-4)",
                        fontFamily: "var(--font-mono)",
                        flexShrink: 0,
                      }}
                    >
                      {fmtRelative(ev.created_at)}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* Event detail modal */}
      {modalEvent !== null && (
        <EventDetailModal
          event={modalEvent}
          onClose={closeModal}
          onJumpToSession={handleJumpToSession}
        />
      )}
    </aside>
  );
}

export const LiveActivity = memo(LiveActivityInner);
