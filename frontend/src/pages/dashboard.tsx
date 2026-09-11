import { type ReactElement } from "react";
import { MissionControlPage } from "./mission-control";

/**
 * DashboardPage — entry point registered at route "/".
 *
 * Delegates to Mission Control (#166), which replaced the Overview page this
 * file used to forward to. The indirection is kept rather than pointing the
 * route straight at `MissionControlPage`: `/` is the app's launch route and its
 * component name is referenced from `App.tsx`, so a page swap stays a one-line
 * change here instead of a route edit — which is exactly what made this swap
 * cheap.
 */
export function DashboardPage(): ReactElement {
  return <MissionControlPage />;
}
