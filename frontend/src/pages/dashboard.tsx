import { type ReactElement } from "react";
import { OverviewPage } from "./overview/overview-page";

/**
 * DashboardPage — entry point registered at route "/".
 * Delegates to OverviewPage which renders the three-zone redesigned layout.
 * The old WidgetGrid import has been intentionally removed; the widget-grid
 * file is preserved for now (a parallel agent handles its removal).
 */
export function DashboardPage(): ReactElement {
  return <OverviewPage />;
}
