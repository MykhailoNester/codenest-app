import { memo, type ReactElement, type ReactNode } from "react";

interface TopbarProps {
  /** Page title shown in the left cluster. */
  title?: string;
  /** Breadcrumb prefix, e.g. "Workspace ·". */
  crumbs?: string;
  activeCount?: number;
  /** Optional right-aligned action buttons rendered inside the Topbar. */
  actions?: ReactNode;
}

function TopbarInner({
  title = "Command Center",
  crumbs = "Workspace ·",
  activeCount = 0,
  actions,
}: TopbarProps): ReactElement {
  return (
    <header className="d3-top">
      <div className="d3-top__left">
        <div className="d3-top__crumbs">{crumbs}</div>
        <h1 className="d3-top__title">
          {activeCount > 0 && <span className="d3-pulse-dot" />}
          {title}
        </h1>
      </div>
      {actions != null && <div className="d3-top__actions">{actions}</div>}
    </header>
  );
}

// Memoize so shell-level re-renders from the SSE-driven `command-center` query
// don't force a Topbar repaint unless title, crumbs, or activeCount changes.
export const Topbar = memo(TopbarInner);
