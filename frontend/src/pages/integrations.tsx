import { useMemo, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  useInstallIntegration,
  useIntegrations,
  useUninstallIntegration,
  type IntegrationEntry,
} from "../lib/api";
import { Shell } from "../components/layout/shell";

const cardStyle: React.CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line-2)",
  borderRadius: 8,
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const inputStyle: React.CSSProperties = {
  padding: "5px 8px",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  color: "var(--fg-0)",
  borderRadius: 4,
  fontSize: 12,
  fontFamily: "monospace",
};

function badge(color: string, text: string): ReactElement {
  return (
    <span
      style={{
        fontSize: 11,
        padding: "1px 6px",
        borderRadius: 3,
        border: `1px solid ${color}55`,
        background: `${color}11`,
        color,
      }}
    >
      {text}
    </span>
  );
}

interface RowProps {
  entry: IntegrationEntry;
  onOpenPane: (url: string) => void;
  onInstall: (slug: string, env: Record<string, string>) => void;
  onUninstall: (slug: string) => void;
  installing: boolean;
}

function IntegrationRow({
  entry,
  onOpenPane,
  onInstall,
  onUninstall,
  installing,
}: RowProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [envValues, setEnvValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(entry.mcp.env_template.map((k) => [k, ""])),
  );
  return (
    <div style={cardStyle}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span
              style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-0)" }}
            >
              {entry.name}
            </span>
            <span style={{ fontSize: 11, color: "var(--fg-4)" }}>
              {entry.slug}
            </span>
            {entry.installed
              ? badge("#22c55e", "installed")
              : badge("#9ca3af", "available")}
          </div>
          <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 2 }}>
            {entry.description}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            onClick={() => onOpenPane(entry.pane_url)}
            style={{
              padding: "5px 10px",
              borderRadius: 4,
              border: "1px solid var(--line-2)",
              background: "transparent",
              color: "var(--fg-2)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Open pane
          </button>
          {entry.installed ? (
            <button
              type="button"
              onClick={() => onUninstall(entry.slug)}
              style={{
                padding: "5px 10px",
                borderRadius: 4,
                border: "1px solid var(--line-2)",
                background: "transparent",
                color: "#ef4444",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Uninstall
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              style={{
                padding: "5px 10px",
                borderRadius: 4,
                border: "1px solid var(--line-2)",
                background: "rgba(59, 130, 246, 0.15)",
                color: "var(--fg-0)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {expanded ? "Hide" : "Install"}
            </button>
          )}
        </div>
      </div>
      {expanded && !entry.installed && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginTop: 4,
          }}
        >
          <div style={{ fontSize: 11, color: "var(--fg-3)" }}>
            Supply the env values this MCP needs. You can leave them blank now
            and edit later under <em>MCP servers</em>.
          </div>
          {entry.mcp.env_template.map((key) => (
            <label
              key={key}
              style={{ display: "flex", flexDirection: "column", gap: 2 }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: "var(--fg-3)",
                  fontFamily: "monospace",
                }}
              >
                {key}
              </span>
              <input
                type="password"
                value={envValues[key] ?? ""}
                onChange={(e) =>
                  setEnvValues((prev) => ({ ...prev, [key]: e.target.value }))
                }
                style={inputStyle}
              />
            </label>
          ))}
          <button
            type="button"
            disabled={installing}
            onClick={() => onInstall(entry.slug, envValues)}
            style={{
              alignSelf: "flex-start",
              padding: "5px 12px",
              borderRadius: 4,
              border: "1px solid var(--line-2)",
              background: installing
                ? "var(--bg-1)"
                : "rgba(34, 197, 94, 0.15)",
              color: "var(--fg-0)",
              cursor: installing ? "not-allowed" : "pointer",
              fontSize: 12,
            }}
          >
            {installing ? "Installing…" : "Install"}
          </button>
        </div>
      )}
    </div>
  );
}

export function IntegrationsPage(): ReactElement {
  const navigate = useNavigate();
  const { data: integrations = [], isPending } = useIntegrations();
  const install = useInstallIntegration();
  const uninstall = useUninstallIntegration();
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    if (!filter.trim()) return integrations;
    const q = filter.trim().toLowerCase();
    return integrations.filter(
      (i) =>
        i.name.toLowerCase().includes(q) || i.slug.toLowerCase().includes(q),
    );
  }, [integrations, filter]);

  return (
    <Shell>
      <div
        style={{
          padding: "16px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          color: "var(--fg-1)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            style={{ ...inputStyle, fontFamily: "inherit", width: 200 }}
          />
        </div>

        {isPending ? (
          <div style={{ fontSize: 12, color: "var(--fg-3)" }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
            No integrations match.
          </div>
        ) : (
          filtered.map((entry) => (
            <IntegrationRow
              key={entry.slug}
              entry={entry}
              installing={install.isPending}
              onOpenPane={(url) =>
                navigate(`/preview?url=${encodeURIComponent(url)}`)
              }
              onInstall={(slug, env) =>
                install.mutate(
                  { slug, env },
                  {
                    onSuccess: () => toast.success(`${entry.name} installed`),
                    onError: (e) => toast.error(`Install failed: ${e.message}`),
                  },
                )
              }
              onUninstall={(slug) => {
                if (window.confirm(`Uninstall ${entry.name}?`)) {
                  uninstall.mutate(slug, {
                    onSuccess: (r) =>
                      toast.success(
                        r.removed
                          ? `${entry.name} uninstalled`
                          : "Nothing to uninstall",
                      ),
                  });
                }
              }}
            />
          ))
        )}
      </div>
    </Shell>
  );
}
