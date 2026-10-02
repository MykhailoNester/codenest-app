/**
 * The drill-in for one session on the Sessions surface (#269, #271).
 *
 * Opened by a run row, by the activity feed, or by `?session=` on the page —
 * which is what the notification bell and search results deep-link to.
 *
 * Two tabs, because they answer different questions and neither subsumes the
 * other: **replay** is the scrubbable timeline of what the session did, and
 * **inspect** is the ingest report — which lane wrote each figure, what the
 * others claimed, where the work happened, what it cost. `?tab=inspect` opens
 * straight on the second, so "Inspect lanes" and a search hit on an event both
 * land where they mean to.
 */

import { useState, type ReactElement } from "react";
import { useSearchParams } from "react-router-dom";
import { useProfiles, useSessionReplay } from "../../lib/api";
import { NO_PROFILES } from "../../lib/profile-utils";
import { ReplayPanel } from "../command-center/replay-panel";
import { SessionInspect } from "./session-inspect";

export interface SessionDetailProps {
  sessionId: string;
  onClose: () => void;
}

type Tab = "replay" | "inspect";

function Replay({
  sessionId,
  onClose,
}: SessionDetailProps): ReactElement {
  const { data, isLoading, isError } = useSessionReplay(sessionId);
  const { data: profiles = NO_PROFILES } = useProfiles();

  if (isLoading) return <div className="dk-note">Reading session&hellip;</div>;
  if (isError || !data) {
    return (
      <div className="dk-note sans">
        No session events are stored for this session. They may have been pruned
        by retention, or the hooks were never installed while it ran.
      </div>
    );
  }

  return (
    <ReplayPanel
      session={data.session}
      events={data.events}
      profiles={profiles}
      onClose={onClose}
    />
  );
}

export function SessionDetail({
  sessionId,
  onClose,
}: SessionDetailProps): ReactElement {
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>(
    params.get("tab") === "inspect" ? "inspect" : "replay",
  );

  return (
    <>
      <div className="dk-tabs" role="tablist" aria-label="Session detail">
        {(["replay", "inspect"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`dk-tab${tab === t ? " on" : ""}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
        <span style={{ marginLeft: "auto" }} />
        <button type="button" className="dk-btn bare" onClick={onClose}>
          close
        </button>
      </div>

      {tab === "replay" ? (
        <Replay sessionId={sessionId} onClose={onClose} />
      ) : (
        <SessionInspect sessionId={sessionId} />
      )}
    </>
  );
}
