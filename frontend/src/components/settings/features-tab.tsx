/**
 * Settings → Features tab.
 *
 * Presents on/off toggles for each gated feature module.  Writes go through
 * `upsertSetting("enabled_features", …)` and then invalidate `["lookups"]`
 * so the sidebar and FeatureRoute guard react immediately without a reload.
 *
 * To avoid `setState` inside `useEffect` (lint rule `react-hooks/set-state-in-effect`),
 * we never mirror server state into local state.  Instead:
 * - The displayed value is derived directly from `lookups.enabled_features`.
 * - An `optimistic` overlay (Record<slug, bool>) is applied on top while a
 *   save is in-flight, then cleared once the invalidation settles.
 * This gives instant toggle feedback without the forbidden effect→setState cycle.
 */

import { useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useLookups, upsertSetting } from "../../lib/api";
import { KNOWN_FEATURES_ORDERED } from "../../lib/nav-items";

// Human-readable labels + descriptions for each feature slug.
const FEATURE_META: Record<string, { label: string; description: string }> = {
  work: {
    label: "Work (Tasks, Inbox)",
    description: "Task tracking and inbox triage pipeline.",
  },
  notifications: {
    label: "Notifications",
    description: "Notifications center and activity event feed.",
  },
  schedules: {
    label: "Schedules",
    description: "Cron and event-triggered agent schedules.",
  },
  parallel: {
    label: "Parallel Runs",
    description:
      "Launch multiple agent attempts in parallel and compare results.",
  },
  preview: {
    label: "Preview",
    description: "Embedded dev-server preview pane with browser-like controls.",
  },
  feed: {
    label: "Feed",
    description: "Live activity feed of agent events and system notifications.",
  },
  explorer: {
    label: "Explorer",
    description:
      "Workspace file navigator panel on the Terminal page, with ⌘P file search.",
  },
  budgets: {
    label: "Budgets",
    description: "Cost budget tracking by workspace, project, or agent.",
  },
  composer: {
    label: "Composer (native agent panes)",
    description:
      "Native agent conversation panes with a composer, in place of a terminal. Experimental.",
  },
  sync: {
    label: "Sync",
    description: "External sync targets and snapshot management.",
  },
  snippets: {
    label: "Snippets",
    description: "Reusable prompt and command snippet library.",
  },
  gallery: {
    label: "Gallery",
    description: "Marketplace of templates, agents, and skills.",
  },
  mcp: {
    label: "MCP",
    description: "Model Context Protocol server management.",
  },
  integrations: {
    label: "Integrations",
    description: "External service integrations and webhooks.",
  },
  plugins: {
    label: "Plugins",
    description: "Custom plugins and extensions.",
  },
};

export function FeaturesTab(): ReactElement {
  const qc = useQueryClient();
  const { data: lookups } = useLookups();
  const [saving, setSaving] = useState(false);
  // Optimistic overlay: contains only the slug(s) currently being saved.
  // Applied on top of the server value so the toggle feels instant.
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});

  // Derive displayed value: server state (all-true default for missing keys)
  // with the optimistic overlay applied on top.
  function isEnabled(slug: string): boolean {
    if (slug in optimistic) return optimistic[slug] ?? true;
    return lookups?.enabled_features[slug] !== false;
  }

  async function toggle(slug: string, value: boolean): Promise<void> {
    // Compute the full new map from current server state + this change.
    const serverFeatures = lookups?.enabled_features ?? {};
    const next: Record<string, boolean> = {};
    for (const s of KNOWN_FEATURES_ORDERED) {
      next[s] =
        s in optimistic ? (optimistic[s] ?? true) : serverFeatures[s] !== false;
    }
    next[slug] = value;

    // Apply optimistic overlay immediately.
    setOptimistic((prev) => ({ ...prev, [slug]: value }));
    setSaving(true);
    try {
      await upsertSetting("enabled_features", next);
      await qc.invalidateQueries({ queryKey: ["lookups"] });
      // Clear the overlay once the server confirms and lookups is fresh.
      setOptimistic((prev) => {
        const copy = { ...prev };
        delete copy[slug];
        return copy;
      });
    } catch (err) {
      // Roll back optimistic overlay.
      setOptimistic((prev) => {
        const copy = { ...prev };
        delete copy[slug];
        return copy;
      });
      toast.error(`Failed to update feature toggle: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: "var(--fg-0)",
          marginBottom: 4,
          marginTop: 0,
        }}
      >
        Feature Modules
      </h2>
      <p
        style={{
          fontSize: 13,
          color: "var(--fg-3)",
          marginBottom: 24,
          marginTop: 0,
        }}
      >
        Enable or disable entire feature modules. Disabled modules are removed
        from the sidebar and their routes become unreachable. This is a global
        per-install setting and overrides workspace templates.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {KNOWN_FEATURES_ORDERED.map((slug) => {
          const enabled = isEnabled(slug);
          const meta = FEATURE_META[slug];
          return (
            <div
              key={slug}
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 16,
                padding: "14px 16px",
                background: "var(--bg-2)",
                border: "1px solid var(--line-2)",
                borderRadius: 8,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: 13,
                    color: "var(--fg-0)",
                    marginBottom: 4,
                  }}
                >
                  {meta?.label ?? slug}
                </div>
                <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
                  {meta?.description ?? ""}
                </div>
              </div>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: saving ? "not-allowed" : "pointer",
                  flexShrink: 0,
                }}
              >
                <span style={{ fontSize: 11, color: "var(--fg-3)" }}>
                  {enabled ? "On" : "Off"}
                </span>
                <ToggleSwitch
                  checked={enabled}
                  disabled={saving}
                  onChange={(v) => void toggle(slug, v)}
                />
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Minimal toggle-switch widget
// ---------------------------------------------------------------------------

function ToggleSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        border: "none",
        padding: 0,
        cursor: disabled ? "not-allowed" : "pointer",
        background: checked ? "var(--accent, #6366f1)" : "var(--bg-4, #444)",
        position: "relative",
        transition: "background 0.15s",
        opacity: disabled ? 0.6 : 1,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          display: "block",
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: "white",
          position: "absolute",
          top: 3,
          left: checked ? 19 : 3,
          transition: "left 0.15s",
        }}
      />
    </button>
  );
}
