import { type ReactElement } from "react";
import { MissionControlPage } from "./mission-control";

/**
 * DashboardPage — Mission Control, now at `/mission-control`.
 *
 * It held `/` until #282 put the Deck home screen there. The route it keeps is
 * a comparison route, not a second home: the old surface has to stay reachable
 * while Deck is reviewed, the same way `/deck` kept the shell reviewable beside
 * the old one. Both it and `mission-control.tsx` go when the migration is
 * signed off.
 */
export function DashboardPage(): ReactElement {
  return <MissionControlPage />;
}
