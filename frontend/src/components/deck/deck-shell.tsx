import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  useActiveSessionCounts,
  useAttention,
  useDailySpend,
  useLookups,
} from "../../lib/api";
import { NAV_ITEMS } from "../../lib/nav-items";
import { formatUSD } from "../../lib/format-helpers";
import { OMNI_EVENT_OPEN_LAUNCH, OMNI_EVENT_OPEN_PALETTE } from "../../lib/omni-commands";
import { LaunchComposerDialog } from "../launch/launch-composer-dialog";
import { NotificationBell } from "../notification-bell";
import type { DeckState } from "./deck-grid";

/**
 * The nine surfaces the supervision pivot keeps (#274 removes the rest). Paths
 * come from NAV_ITEMS so a route rename cannot desync the two rails while both
 * exist.
 */
const KEPT: ReadonlyArray<{
  group: string;
  slug: string;
  label: string;
  state: DeckState;
}> = [
  { group: "now", slug: "mission", label: "deck", state: "run" },
  { group: "now", slug: "attention", label: "needs you", state: "block" },
  { group: "now", slug: "tasks", label: "work", state: "todo" },
  { group: "now", slug: "terminal", label: "sessions", state: "run" },
  { group: "record", slug: "projects", label: "projects", state: "idle" },
  { group: "record", slug: "team", label: "agents", state: "idle" },
  { group: "automate", slug: "schedules", label: "schedules", state: "wait" },
  { group: "system", slug: "budgets", label: "budgets", state: "idle" },
  { group: "system", slug: "hooks", label: "hooks", state: "idle" },
  { group: "system", slug: "settings", label: "settings", state: "idle" },
];

const GROUPS = ["now", "record", "automate", "system"] as const;

function pathFor(slug: string): string {
  return NAV_ITEMS.find((n) => n.slug === slug)?.path ?? "/";
}

/** The line every glance starts with: what is running, stuck, and costing. */
function DeckStatus(): ReactElement {
  const { data: attention } = useAttention("open");
  const { activeCount } = useActiveSessionCounts();
  const { data: spend } = useDailySpend();
  const counts = attention?.counts;

  const clock = useMemo(
    () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    [],
  );

  return (
    <div className="dk-status">
      <span>
        <span className="dk-s" role="img" aria-label="running" data-s="run" /> <b>{activeCount}</b>{" "}
        running
      </span>
      <span className="sep">·</span>
      <span>
        <span className="dk-s" role="img" aria-label="blocking" data-s="block" />{" "}
        <b>{counts?.blocking ?? 0}</b> blocking
      </span>
      <span className="sep">·</span>
      <span>
        <span className="dk-s" role="img" aria-label="stalled" data-s="stall" />{" "}
        <b>{counts?.stalled ?? 0}</b> stalled
      </span>
      <span className="sep">·</span>
      <span>{spend ? formatUSD(spend.cost_usd) : "—"} today</span>
      <span className="sp" />
      <button
        type="button"
        className="dk-btn bare"
        onClick={() => document.dispatchEvent(new CustomEvent(OMNI_EVENT_OPEN_PALETTE))}
        title="Search, commands, jump to a project"
      >
        search <kbd style={{ color: "var(--fg-3)" }}>⌘K</kbd>
      </button>
      <NotificationBell />
      <button
        type="button"
        className="dk-btn"
        onClick={() => document.dispatchEvent(new CustomEvent(OMNI_EVENT_OPEN_LAUNCH))}
      >
        launch
      </button>
      <span>{clock}</span>
    </div>
  );
}

function DeckRail(): ReactElement {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data: attention } = useAttention("open");
  const { data: spend } = useDailySpend();
  const { data: lookups } = useLookups();

  const counts: Record<string, number | undefined> = {
    attention: attention?.counts.open,
  };

  return (
    <aside className="dk-rail">
      <div className="dk-rail__top">
        <span style={{ color: "var(--fg)" }}>codenest</span>
        <span className="dim">deck</span>
      </div>

      <nav className="dk-rail__nav" aria-label="Main navigation">
        {GROUPS.map((g) => {
          const items = KEPT.filter((i) => i.group === g);
          if (items.length === 0) return null;
          return (
            <div className="dk-grp" key={g}>
              <div className="dk-grp__h">{g}</div>
              {items.map((i) => {
                const path = pathFor(i.slug);
                const active = pathname === path;
                const n = counts[i.slug];
                return (
                  <button
                    key={i.slug}
                    type="button"
                    className={`dk-nav${active ? " on" : ""}`}
                    aria-current={active ? "page" : undefined}
                    onClick={() => void navigate(path)}
                  >
                    <span
                      className="dk-s dk-nav__g"
                      role="img"
                      aria-label={i.state}
                      data-s={i.state}
                    />
                    <span className="trunc">{i.label}</span>
                    <span className={`dk-nav__n${i.slug === "attention" && n ? " warn" : ""}`}>
                      {n ?? ""}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>

      <div className="dk-rail__foot">
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--fs-s)", color: "var(--fg-3)" }}>
          <span>today</span>
          <span>{spend ? formatUSD(spend.cost_usd) : "—"}</span>
        </div>
        {spend && (spend.tokens_in > 0 || spend.tokens_out > 0) && (
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--fg-3)", marginTop: 5 }}>
            {((spend.tokens_in + spend.tokens_out) / 1000).toFixed(1)}K tokens
          </div>
        )}
        <div style={{ marginTop: "var(--u3)", fontSize: "var(--fs-s)" }}>
          {lookups?.user_display_name ?? "Operator"}
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--fg-3)" }}>
            {lookups?.user_role ?? "Owner"}
          </div>
        </div>
      </div>
    </aside>
  );
}

interface DeckShellProps {
  title: string;
  crumb?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** Pages owning their own overflow (a session pane) pass false. */
  scrollable?: boolean;
}

/**
 * The Deck frame. Carries `.deck`, which is what scopes the whole design
 * system — nothing inside it inherits the old theme's tokens, and nothing
 * outside it is touched by Deck's.
 */
export function DeckShell({
  title,
  crumb,
  actions,
  children,
  scrollable = true,
}: DeckShellProps): ReactElement {
  const [launchOpen, setLaunchOpen] = useState(false);
  const openLaunch = useCallback(() => setLaunchOpen(true), []);

  // Same contract as the old Shell: the palette's "Launch Project" command
  // dispatches on `document` rather than threading a callback through pages.
  useEffect(() => {
    document.addEventListener(OMNI_EVENT_OPEN_LAUNCH, openLaunch);
    return () => document.removeEventListener(OMNI_EVENT_OPEN_LAUNCH, openLaunch);
  }, [openLaunch]);

  return (
    <div className="deck">
      <div className="dk-app">
        <DeckRail />
        <main className="dk-main">
          <DeckStatus />
          <div className={`dk-page${scrollable ? "" : " flush"}`}>
            <div className="dk-title">
              <h1>{title}</h1>
              {crumb && <span className="sub">{crumb}</span>}
              {actions && (
                <>
                  <span className="sp" />
                  {actions}
                </>
              )}
            </div>
            {children}
          </div>
        </main>
      </div>

      {launchOpen && (
        <LaunchComposerDialog
          open
          onClose={() => setLaunchOpen(false)}
          source={null}
          seed={null}
        />
      )}
    </div>
  );
}
