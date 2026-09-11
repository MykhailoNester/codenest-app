import { memo, useEffect, type ReactElement } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  useAttention,
  useDailySpend,
  useLookups,
  useProviderStats,
  useEnabledFeatures,
} from "../../lib/api";
import { useProviderStore } from "../../stores/provider-store";
import { openTerminalsWindow } from "../../lib/ipc";
import { formatCount } from "../../lib/format-helpers";
import { NAV_ITEMS, NAV_GROUPS, FEATURES } from "../../lib/nav-items";
import { useNavGroups } from "../../stores/nav-group-store";
import { Icon } from "../icon";
import { NavCountBadge } from "./nav-count-badge";

// v1 integrates the Anthropic / Claude family end-to-end (matches onboarding).
// Other seeded providers (OpenAI, Google, Local) are shown as "coming soon"
// rather than as active, configured providers.
const SUPPORTED_PROVIDER = (name: string): boolean =>
  name === "anthropic" || name.startsWith("claude");

interface SidebarProps {
  activeSessionCount?: number;
  budgetTotal?: number;
}

function SidebarInner({
  activeSessionCount: _activeSessionCount = 0,
  budgetTotal = 40,
}: SidebarProps): ReactElement {
  void _activeSessionCount;
  // Per-slug rail counts (#162 supplies the first one). The same 30-second
  // poll as the Needs You page itself, and react-query dedupes the two
  // subscribers onto one request, so having the rail read the queue costs no
  // extra fetch while the page is open.
  //
  // Only OPEN items are counted. Muted ones are excluded by definition and
  // resolved ones are history; and because `NavCountBadge` renders nothing for
  // a zero, the rail is silent exactly when the queue is empty, which is what
  // makes a badge that *is* showing worth walking over to.
  const { data: attention } = useAttention("open");
  const navCounts: Partial<Record<string, number>> = {
    attention: attention?.counts.open,
  };
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data: spend } = useDailySpend();
  const { data: lookups } = useLookups();
  const {
    data: providerStats = [],
    isSuccess: providersLoaded,
  } = useProviderStats("today");
  const { activeProviderId, setActiveProvider } = useProviderStore();
  const navGroups = useNavGroups();
  const resolvedFeatures = useEnabledFeatures();

  // Active = the synthetic "unknown" bucket (provider_id null) + supported
  // providers; everything else is surfaced as "coming soon".
  const activeProviders = providerStats.filter(
    (p) => p.provider_id === null || SUPPORTED_PROVIDER(p.name),
  );
  const comingSoonProviders = providerStats.filter(
    (p) => p.provider_id !== null && !SUPPORTED_PROVIDER(p.name),
  );

  // Nav visibility is governed solely by the Features settings (the
  // feature-toggle hard gate below). Workspace-template-driven sidebar
  // reshaping was removed — Features are the single source of truth for
  // which pages appear.
  //
  // `resolvedFeatures` is always complete (live > cache > FEATURE_DEFAULTS),
  // so disabledSlugs is deterministic from the very first paint.
  const disabledSlugs: ReadonlySet<string> = (() => {
    const out = new Set<string>();
    for (const [feature, slugs] of Object.entries(FEATURES)) {
      if (resolvedFeatures[feature] === false) {
        for (const slug of slugs) {
          out.add(slug);
        }
      }
    }
    return out;
  })();
  const spendToday = spend?.cost_usd.toFixed(2) ?? "0.00";
  const budgetPct = Math.min(100, ((spend?.cost_usd ?? 0) / budgetTotal) * 100);

  // Self-heal: if the persisted activeProviderId no longer matches any live
  // provider row (e.g., the provider was deleted from Settings), reset to All.
  // Otherwise the user is stranded looking at an empty filter view.
  useEffect(() => {
    if (activeProviderId == null) return;
    if (providerStats.length === 0) return; // not loaded yet
    const stillExists = providerStats.some(
      (p) => p.provider_id === activeProviderId,
    );
    if (!stillExists) setActiveProvider(null);
  }, [activeProviderId, providerStats, setActiveProvider]);

  return (
    <aside className="d3-side">
      <div className="d3-brand">
        <div className="d3-brand__mark">
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
            <defs>
              <linearGradient id="d3-brand-g" x1="0" x2="1" y1="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" />
                <stop offset="100%" stopColor="#a855f7" />
              </linearGradient>
            </defs>
            {/* hexagonal nest cell */}
            <path
              d="M16 3.5 26 9.2 26 22.8 16 28.5 6 22.8 6 9.2Z"
              fill="none"
              stroke="url(#d3-brand-g)"
              strokeWidth="2.2"
              strokeLinejoin="round"
            />
            {/* terminal prompt: chevron + cursor */}
            <path
              d="M11.4 12 15 16 11.4 20"
              fill="none"
              stroke="#eaf1ff"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <rect x="17" y="14.9" width="3.6" height="2" rx="1" fill="#7dd3fc" />
          </svg>
        </div>
        <div>
          <div className="d3-brand__name">Codenest</div>
          <div className="d3-brand__sub">Command Center</div>
        </div>
      </div>

      <div className="d3-side__provider">
        <div className="d3-side__h">Providers</div>
        {!providersLoaded ? (
          <div style={{ fontSize: 11, color: "var(--fg-4)", padding: "4px 0" }}>
            Loading&hellip;
          </div>
        ) : activeProviders.length === 0 && comingSoonProviders.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--fg-4)", padding: "4px 0" }}>
            No providers configured
          </div>
        ) : (
          <>
            {activeProviders.map((p) => {
              const isOn = activeProviderId === p.provider_id;
              const clickable = p.provider_id !== null;
              return (
                <button
                  key={p.provider_id ?? "unknown"}
                  type="button"
                  className={`d3-prov${isOn ? " is-on" : ""}`}
                  aria-pressed={isOn}
                  disabled={!clickable}
                  onClick={() => {
                    if (!clickable) return;
                    setActiveProvider(isOn ? null : p.provider_id);
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    textAlign: "left",
                    padding: 0,
                    cursor: clickable ? "pointer" : "default",
                    width: "100%",
                  }}
                >
                  <span
                    className="d3-prov__dot"
                    style={{ background: p.color ?? "#7a8290" }}
                  />
                  <div className="d3-prov__stack">
                    <div className="d3-prov__n">{p.display_name}</div>
                    <div className="d3-prov__m">
                      {p.default_model ??
                        (p.provider_id === null ? "unregistered models" : "—")}
                    </div>
                  </div>
                  <div className="d3-prov__count tabular">
                    {p.sessions_today}
                  </div>
                </button>
              );
            })}
            {comingSoonProviders.length > 0 && (
              <div
                style={{
                  fontSize: 10,
                  color: "var(--fg-4)",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  margin: "8px 0 2px",
                }}
              >
                Coming soon
              </div>
            )}
            {comingSoonProviders.map((p) => (
              <div
                key={p.provider_id ?? p.name}
                className="d3-prov"
                aria-disabled="true"
                style={{ opacity: 0.45, cursor: "default", width: "100%" }}
              >
                <span
                  className="d3-prov__dot"
                  style={{ background: p.color ?? "#7a8290" }}
                />
                <div className="d3-prov__stack">
                  <div className="d3-prov__n">{p.display_name}</div>
                  <div className="d3-prov__m">Coming soon</div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      <nav className="d3-side__nav" aria-label="Main navigation">
        {NAV_GROUPS.map((group) => {
          const items = NAV_ITEMS.filter(
            (it) => it.group === group.id && !disabledSlugs.has(it.slug),
          );
          if (items.length === 0) return null;

          const containsActive = items.some((it) => it.path === pathname);
          // A collapsed group is force-opened when it contains the active
          // route, so the current page is always visible in the sidebar.
          const open =
            navGroups.isOpen(group.id, group.defaultOpen) || containsActive;

          return (
            <div className="d3-side__group" key={group.id}>
              <button
                type="button"
                className={`d3-side__grouphead${open ? " is-open" : ""}`}
                aria-expanded={open}
                onClick={() => navGroups.toggle(group.id, group.defaultOpen)}
              >
                <Icon name="chevronRight" size={12} />
                <span>{group.label}</span>
              </button>
              {/*
                The items stay mounted in both states and the wrapper animates
                its own height, because a group that unmounted its children on
                collapse (`{open && …}`) could not animate at all — there was
                nothing to transition from. `aria-hidden` + `inert` keep a
                collapsed group out of the accessibility tree and out of tab
                order, so "invisible but present" never becomes focusable.
              */}
              <div
                className={`d3-side__items${open ? " is-open" : ""}`}
                aria-hidden={!open}
                inert={!open}
              >
                <div className="d3-side__itemsinner">
                {items.map((it) => {
                  const isActive = pathname === it.path;
                  if (it.slug === "terminal") {
                    return (
                      <div
                        key={it.slug}
                        style={{
                          display: "flex",
                          alignItems: "stretch",
                          gap: 4,
                        }}
                      >
                        <button
                          className={`d3-nav${isActive ? " is-active" : ""}`}
                          onClick={() => void navigate(it.path)}
                          type="button"
                          aria-current={isActive ? "page" : undefined}
                          style={{ flex: "1 1 auto", minWidth: 0 }}
                        >
                          <Icon name={it.icon} size={14} />
                          <span>{it.label}</span>
                        </button>
                        <button
                          type="button"
                          className="d3-nav"
                          onClick={() => {
                            void openTerminalsWindow();
                          }}
                          title="Open terminals in a separate window"
                          aria-label="Open terminals in a separate window"
                          style={{
                            flex: "0 0 auto",
                            padding: "6px 8px",
                          }}
                        >
                          <Icon name="popout" size={13} />
                        </button>
                      </div>
                    );
                  }

                  return (
                    <button
                      key={it.slug}
                      className={`d3-nav${isActive ? " is-active" : ""}`}
                      onClick={() => void navigate(it.path)}
                      type="button"
                      aria-current={isActive ? "page" : undefined}
                    >
                      <Icon name={it.icon} size={14} />
                      <span>{it.label}</span>
                      {/* `NavCountBadge` renders nothing for a null or zero
                          count, so a slug with no count source stays inert. */}
                      <NavCountBadge
                        count={navCounts[it.slug]}
                        tone={it.slug === "attention" ? "warn" : "neutral"}
                        label={
                          it.slug === "attention" && navCounts.attention
                            ? `${navCounts.attention} item${
                                navCounts.attention === 1 ? "" : "s"
                              } need you`
                            : undefined
                        }
                      />
                    </button>
                  );
                })}
                </div>
              </div>
            </div>
          );
        })}
      </nav>

      <div className="d3-side__foot">
        <div
          className="d3-budget"
          aria-label={`Daily budget: $${spendToday} of $${budgetTotal} used`}
        >
          <div className="d3-budget__row">
            <span>Today</span>
            <span className="tabular">
              ${spendToday} / ${budgetTotal}
            </span>
          </div>
          <div
            className="d3-budget__bar"
            role="progressbar"
            aria-valuenow={Math.round(budgetPct)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div style={{ width: `${budgetPct}%` }} />
          </div>
          {spend && (spend.tokens_in > 0 || spend.tokens_out > 0) && (
            <div
              className="d3-budget__row"
              style={{ marginTop: 4, marginBottom: 0 }}
            >
              <span style={{ fontSize: "9.5px" }}>
                {((spend.tokens_in + spend.tokens_out) / 1000).toFixed(1)}K
                tokens
              </span>
              <span style={{ fontSize: "9.5px" }}>
                {formatCount(spend.tokens_in)} in /{" "}
                {formatCount(spend.tokens_out)} out
              </span>
            </div>
          )}
        </div>
        <div className="d3-side__user">
          <div
            className="d3-avatar"
            style={{ background: "linear-gradient(135deg,#3b82f6,#a855f7)" }}
          >
            {(lookups?.user_display_name ?? "Operator").charAt(0).toUpperCase()}
          </div>
          <div className="d3-side__userstack">
            <div className="d3-side__username">
              {lookups?.user_display_name ?? "Operator"}
            </div>
            <div className="d3-side__usersub">
              {lookups?.user_role ?? "Owner"}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

// Memoize so a busy parent (e.g. Command Center receiving SSE-driven
// session updates) does not re-render the nav tree on every cycle —
// that was the source of the perceptible hover/click delay over the
// left navigation.
export const Sidebar = memo(SidebarInner);
