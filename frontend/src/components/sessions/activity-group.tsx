/**
 * The live hook-event feed, folded out of `components/command-center/
 * live-activity.tsx` (#269).
 *
 * Same data, same two actions — click a row to inspect the event, click the
 * session cell to open that session's detail — but as lines on the Deck grid
 * rather than a nested card. The old feed grouped consecutive rows under a
 * session header; the session now rides in its own column, which is what makes
 * one flat grid readable at fifty events.
 */

import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";
import type { ProfileOut, RecentEvent } from "../../lib/api";
import { profileColor } from "../../lib/profile-utils";
import { relativeTime } from "../../lib/format-helpers";
import { EventDetailModal } from "./event-detail-modal";
import { eventLabel } from "./status-utils";
import { DeckGrid, DeckGroup, DeckHead, DeckLine } from "../deck/deck-grid";

const COLS_ACTIVITY = "14px 90px minmax(0, 1fr) 150px 92px 62px";

interface SourceAttribution {
  kind: "task" | "inbox";
  id: number;
}

/** Safely parse source attribution from payload_json. Returns null for legacy
 *  events that have no source fields — no pill rendered. */
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

function SourcePill({ source }: { source: SourceAttribution }): ReactElement {
  const to =
    source.kind === "task" ? `/tasks/${source.id}` : `/inbox?focus=${source.id}`;
  return (
    <Link
      to={to}
      onClick={(e) => e.stopPropagation()}
      className="dk-tag"
      style={{ textDecoration: "none" }}
      title={`Launched from ${source.kind} #${source.id}`}
    >
      {source.kind} #{source.id}
    </Link>
  );
}

interface ActivityGroupProps {
  events: RecentEvent[];
  profiles: ProfileOut[];
  onSelectSession: (sessionId: string) => void;
}

function ActivityGroupInner({
  events,
  profiles,
  onSelectSession,
}: ActivityGroupProps): ReactElement {
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
  // finished session that is no longer in the visible list and feels like a
  // random selection. Ended runs are reachable through the "ended" filter.
  const liveEvents = useMemo(
    () => events.filter((e) => e.status !== "ended"),
    [events],
  );

  return (
    <DeckGroup
      label="activity"
      count={liveEvents.length}
      note="hook events, newest first"
      collapsible
      defaultOpen
    >
      {liveEvents.length === 0 ? (
        <div className="dk-note sans">
          No events yet. Start a session, or let a hook-instrumented Claude Code
          run report in.
        </div>
      ) : (
        <DeckGrid cols={COLS_ACTIVITY} label="Live activity">
          <DeckHead cells={["event", "what", "where", "from", "r when"]} />
          {liveEvents.map((ev) => {
            const source = parseSourceAttribution(ev.payload_json);
            const color = profileColor(profiles, ev.profile);
            return (
              <DeckLine
                key={ev.id}
                state={ev.event_type === "SessionEnd" ? "done" : "run"}
                cells={[
                  { v: eventLabel(ev), cls: "sub" },
                  { v: ev.summary ?? "" },
                  {
                    v: (
                      <button
                        type="button"
                        className="dk-btn bare"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectSession(ev.session_id);
                        }}
                        title={`Open ${ev.profile} · ${ev.project_name ?? "session"}`}
                      >
                        <span style={{ color }}>{ev.profile}</span>
                        {ev.project_name ? ` · ${ev.project_name}` : ""}
                      </button>
                    ),
                  },
                  { v: source !== null ? <SourcePill source={source} /> : "" },
                  { v: relativeTime(ev.created_at), cls: "r" },
                ]}
                onOpen={() => setModalEvent(ev)}
              />
            );
          })}
        </DeckGrid>
      )}

      {modalEvent !== null && (
        <EventDetailModal
          event={modalEvent}
          onClose={closeModal}
          onJumpToSession={handleJumpToSession}
        />
      )}
    </DeckGroup>
  );
}

export const ActivityGroup = memo(ActivityGroupInner);
