/**
 * attention-launch-dialog.tsx — "start session" from a Needs You row (#265).
 *
 * `LaunchFromSourceButton` already pairs a seed fetch with the composer, but it
 * owns a `d3-btn` of its own and the deck page owns its row buttons. This is
 * the same pairing with no button: the page decides *when* a launch is being
 * composed, this decides *what the composer is seeded with*.
 *
 * Two seeds, in order of how much they know:
 *   * `source` — a ticket. `GET /api/v1/launch/seed` resolves project, provider,
 *     model and a prompt from the ticket and the assignee's agent override, so
 *     the composer opens with the right everything already chosen.
 *   * `projectId` — an item that names a project and no ticket. The composer
 *     opens on that project and falls back to its own defaults for the rest.
 *
 * Mounted only while a launch is being composed, so the seed query is not in
 * flight for every row on the page.
 */

import { type ReactElement } from "react";
import { useLaunchSeed, type LaunchSource } from "../../lib/launch-seed";
import { LaunchComposerDialog } from "./launch-composer-dialog";

export interface AttentionLaunchDialogProps {
  /** The ticket to seed from, or null to seed from `projectId` alone. */
  source: LaunchSource | null;
  projectId: number | null;
  onClose: () => void;
}

export function AttentionLaunchDialog({
  source,
  projectId,
  onClose,
}: AttentionLaunchDialogProps): ReactElement | null {
  const seedQuery = useLaunchSeed(source);

  // Hold rather than open an unseeded composer that would then jump under the
  // user as the seed lands — the same reason `LaunchFromSourceButton` gates on
  // `isLoading`.
  if (source !== null && seedQuery.isLoading) return null;

  return (
    <LaunchComposerDialog
      open
      onClose={onClose}
      source={source}
      // `?? null` (not `undefined`): the dialog's "Source no longer exists"
      // panel is gated on `seed === null`, so an errored fetch must land there
      // rather than silently opening an unattributed composer.
      seed={source === null ? null : (seedQuery.data ?? null)}
      initialProjectId={projectId}
    />
  );
}
