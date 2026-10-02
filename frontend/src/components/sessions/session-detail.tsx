/**
 * The drill-in for one session on the Sessions surface (#269).
 *
 * Opened by a run row, by the activity feed, or by `?session=` on the page —
 * which is what the notification bell and search results deep-link to.
 */

import { type ReactElement } from "react";
import { useProfiles, useSessionReplay } from "../../lib/api";
import { NO_PROFILES } from "../../lib/profile-utils";
import { ReplayPanel } from "../command-center/replay-panel";

export interface SessionDetailProps {
  sessionId: string;
  onClose: () => void;
}

export function SessionDetail({
  sessionId,
  onClose,
}: SessionDetailProps): ReactElement {
  const { data, isLoading, isError } = useSessionReplay(sessionId);
  const { data: profiles = NO_PROFILES } = useProfiles();

  if (isLoading) return <div className="dk-note">Reading session…</div>;
  if (isError || !data) {
    return (
      <div className="dk-note sans">
        No session events are stored for <code>{sessionId}</code>. They may have
        been pruned by retention, or the hooks were never installed while it ran.{" "}
        <button type="button" className="dk-btn bare" onClick={onClose}>
          back to runs
        </button>
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
