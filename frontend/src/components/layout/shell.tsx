import {
  useCallback,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { OmniBar } from "../omni-bar";
import { NotificationBell } from "../notification-bell";
import { ScreenshotButton } from "../screenshot/screenshot-button";
import { Icon } from "../icon";
import { LaunchModal } from "../launch/launch-modal";
import { useActiveSessionCounts } from "../../lib/api";
import { NAV_ITEMS } from "../../lib/nav-items";
import { OMNI_EVENT_OPEN_LAUNCH } from "../../lib/omni-commands";

interface ShellProps {
  children: ReactNode;
  /**
   * When `true` (default), wraps `children` in a `d3-page-scroll` div so
   * page content scrolls independently within the flex column. Pass `false`
   * for pages that manage their own overflow (e.g. the terminal page whose
   * `TerminalsLayout` fills the remaining space with `flex: 1 1 auto` and
   * `overflow: hidden`).
   */
  scrollable?: boolean;
  /**
   * Override the Topbar title. When omitted, the title is derived from the
   * current route via NAV_ITEMS.
   */
  topbarTitle?: string;
  /**
   * Override the Topbar breadcrumb prefix. Defaults to "Workspace ·".
   */
  topbarCrumbs?: string;
  /**
   * Optional right-aligned action buttons rendered inside the Topbar header,
   * to the right of the page title. Use this to hoist page-level action
   * buttons (e.g. "+ New Project") out of the scrollable content area so they
   * stay visible when the page scrolls.
   */
  actions?: ReactNode;
}

/** Map a pathname to a nav item label and group for the breadcrumb. */
function routeToTopbar(pathname: string): { title: string; crumbs: string } {
  // Exact match first, then prefix match for detail routes like /tasks/:id.
  const exact = NAV_ITEMS.find((n) => n.path === pathname);
  if (exact) {
    const crumb = exact.group.charAt(0).toUpperCase() + exact.group.slice(1);
    return { title: exact.label, crumbs: `${crumb} ·` };
  }
  // Prefix match — e.g. /tasks/42 → tasks nav item.
  const prefix = NAV_ITEMS.find(
    (n) => n.path !== "/" && pathname.startsWith(n.path),
  );
  if (prefix) {
    const crumb = prefix.group.charAt(0).toUpperCase() + prefix.group.slice(1);
    return { title: prefix.label, crumbs: `${crumb} ·` };
  }
  return { title: "Dashboard", crumbs: "Workspace ·" };
}

export function Shell({
  children,
  scrollable = true,
  topbarTitle,
  topbarCrumbs,
  actions,
}: ShellProps): ReactElement {
  const location = useLocation();
  const { activeCount } = useActiveSessionCounts();
  const [launchOpen, setLaunchOpen] = useState(false);

  const openLaunch = useCallback(() => setLaunchOpen(true), []);
  const closeLaunch = useCallback(() => setLaunchOpen(false), []);

  // The OmniBar's "Launch Project" command dispatches this on `document`
  // (it is mounted on every page, so a shell-level listener always hears
  // it) rather than needing a callback threaded down through every page.
  useEffect(() => {
    document.addEventListener(OMNI_EVENT_OPEN_LAUNCH, openLaunch);
    return () =>
      document.removeEventListener(OMNI_EVENT_OPEN_LAUNCH, openLaunch);
  }, [openLaunch]);

  const derived = routeToTopbar(location.pathname);
  const title = topbarTitle ?? derived.title;
  const crumbs = topbarCrumbs ?? derived.crumbs;

  return (
    <div className="d3-shell">
      <Sidebar activeSessionCount={activeCount} />
      <main className="d3-main">
        <div className="d3-bg-orb d3-bg-orb--1" />
        <div className="d3-bg-orb d3-bg-orb--2" />
        <div className="d3-bg-grid" />
        {/* Top chrome row: OmniBar input expands to fill available width;
            NotificationBell and Launch button are pinned to the right.
            This entire row sits above the Topbar title/crumbs so the two
            never share the same vertical space. */}
        <div className="d3-omni-row">
          <OmniBar />
          <ScreenshotButton />
          <NotificationBell />
          <button
            className="d3-btn d3-btn--primary"
            type="button"
            onClick={openLaunch}
          >
            <Icon name="zap" size={13} /> Launch
          </button>
        </div>
        <Topbar
          title={title}
          crumbs={crumbs}
          activeCount={activeCount}
          actions={actions}
        />
        {scrollable ? (
          <div className="d3-page-scroll">{children}</div>
        ) : (
          children
        )}
      </main>

      {/* Shell-level Launch modal — available on every page. */}
      <LaunchModal open={launchOpen} onClose={closeLaunch} />
    </div>
  );
}
