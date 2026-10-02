import type { ReactElement } from "react";
import { useProfiles, useSessionReplay } from "../../lib/api";
import { NO_PROFILES } from "../../lib/profile-utils";
import { ReplayPanel } from "../sessions/replay-panel";

/**
 * The runs card's Replay affordance: reuses the Sessions surface's own
 * `ReplayPanel` (no second replay implementation) rendered inline in
 * `.dk-detail__doc`, directly under `RunsCard`.
 *
 * The only file in this change that fetches for replay — `RunsCard` itself
 * stays prop-only, per `activity-card.tsx`'s precedent.
 */
export interface TaskRunReplayProps {
  sessionId: string;
  onClose: () => void;
}

export function TaskRunReplay({
  sessionId,
  onClose,
}: TaskRunReplayProps): ReactElement {
  const { data, isLoading, isError } = useSessionReplay(sessionId);
  const { data: profiles = NO_PROFILES } = useProfiles();

  if (isLoading) {
    return (
      <div className="dk-note">Loading replay…</div>
    );
  }

  if (isError || !data) {
    return (
      <div className="dk-note">
        This run has no recorded session events.
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
