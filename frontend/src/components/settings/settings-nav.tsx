/**
 * SettingsNav — left-rail navigation for the Settings page.
 *
 * Groups sections under headings (Workspace / Workflow / Interface / System).
 * A search box above the rail filters sections by label (JetBrains-style); the
 * active section is highlighted and clicking any entry calls `onChange` so the
 * parent updates the URL query param.
 */

import { useMemo, useState, type ReactElement } from "react";
import { Icon } from "../icon";

export type SettingsSectionId =
  | "providers"
  | "profiles"
  | "features"
  | "categories"
  | "workflow-labels"
  | "terminal"
  | "notifications"
  | "telemetry"
  | "general";

interface NavGroup {
  heading: string;
  items: { id: SettingsSectionId; label: string }[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    heading: "Workspace",
    items: [
      { id: "providers", label: "Providers" },
      { id: "profiles", label: "Profiles" },
      { id: "features", label: "Features" },
    ],
  },
  {
    heading: "Workflow",
    items: [
      { id: "workflow-labels", label: "Workflow Labels" },
      { id: "categories", label: "Categories" },
    ],
  },
  {
    heading: "Interface",
    items: [{ id: "terminal", label: "Terminal" }],
  },
  {
    heading: "System",
    items: [
      { id: "notifications", label: "Notifications" },
      // #179. In Settings rather than behind a nav slug on purpose: this is
      // where telemetry is consented to *and* withdrawn, and Settings is the
      // one surface in the app that cannot be switched off in Features. See
      // the header of `telemetry-tab.tsx` for why the Hooks page — which owns
      // the same writer and the same file — was the wrong home for it.
      { id: "telemetry", label: "Telemetry" },
      { id: "general", label: "General" },
    ],
  },
];

interface SettingsNavProps {
  active: SettingsSectionId;
  onChange: (section: SettingsSectionId) => void;
}

export function SettingsNav({
  active,
  onChange,
}: SettingsNavProps): ReactElement {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return NAV_GROUPS;
    return NAV_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((i) => i.label.toLowerCase().includes(q)),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  return (
    <nav
      style={{
        width: 220,
        flexShrink: 0,
        borderRight: "1px solid var(--line-2)",
        paddingRight: 16,
        paddingTop: 4,
      }}
    >
      {/* Search / filter */}
      <div style={{ position: "relative", marginBottom: 16 }}>
        <span
          style={{
            position: "absolute",
            left: 8,
            top: "50%",
            transform: "translateY(-50%)",
            display: "flex",
            color: "var(--fg-4)",
            pointerEvents: "none",
          }}
        >
          <Icon name="search" size={13} />
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings"
          aria-label="Search settings"
          style={{
            width: "100%",
            padding: "5px 8px 5px 28px",
            background: "var(--bg-3)",
            border: "1px solid var(--line-2)",
            borderRadius: 6,
            color: "var(--fg-0)",
            fontSize: 12,
            boxSizing: "border-box",
          }}
        />
      </div>

      {groups.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--fg-4)", paddingLeft: 8 }}>
          No matching settings.
        </div>
      )}

      {groups.map((group) => (
        <div key={group.heading} style={{ marginBottom: 20 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: "var(--fg-4)",
              textTransform: "uppercase",
              letterSpacing: "0.07em",
              marginBottom: 6,
              paddingLeft: 8,
            }}
          >
            {group.heading}
          </div>
          {group.items.map((item) => {
            const isActive = active === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onChange(item.id)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 10px",
                  background: isActive
                    ? "var(--accent-soft, var(--bg-3))"
                    : "none",
                  border: "none",
                  borderRadius: 6,
                  color: isActive ? "var(--accent)" : "var(--fg-2)",
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 400,
                  cursor: "pointer",
                  marginBottom: 2,
                  transition: "background 0.12s, color 0.12s",
                }}
                aria-current={isActive ? "page" : undefined}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
