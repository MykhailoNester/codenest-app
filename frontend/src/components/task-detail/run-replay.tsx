import type { ReactElement } from "react";
import { useProfiles, useSessionReplay } from "../../lib/api";
import { NO_PROFILES } from "../../lib/profile-utils";
import { ReplayPanel } from "../command-center/replay-panel";

/**
 * The runs card's Replay affordance: reuses the Command Center's own
 * `ReplayPanel` (no second replay implementation) rendered inline in
 * `.td-doc`, directly under `RunsCard`.
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
      <div className="td-card">
        <span className="td-dim td-sm">Loading replay…</span>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="td-card">
        <span className="td-dim td-sm">
          This run has no recorded session events.
        </span>
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
