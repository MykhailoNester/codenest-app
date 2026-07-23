import { type ReactElement } from "react";
import { toast } from "sonner";
import {
  usePlugins,
  useRefreshPlugins,
  useSetPluginEnabled,
  useSetPluginTrustMode,
  useTrustPlugin,
  type Plugin,
  type PluginTrustMode,
} from "../lib/api";
import { Shell } from "../components/layout/shell";

const cardStyle: React.CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line-2)",
  borderRadius: 8,
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

function badgeStyle(color: string): React.CSSProperties {
  return {
    fontSize: 11,
    padding: "1px 6px",
    borderRadius: 3,
    border: `1px solid ${color}55`,
    background: `${color}11`,
    color,
  };
}

function loadBadge(status: Plugin["load_status"]): ReactElement {
  if (status === "loaded")
    return <span style={badgeStyle("#22c55e")}>loaded</span>;
  if (status === "skipped")
    return <span style={badgeStyle("#9ca3af")}>skipped</span>;
  return <span style={badgeStyle("#ef4444")}>error</span>;
}

function sigBadge(status: Plugin["signature_status"]): ReactElement {
  return status === "trusted" ? (
    <span
      style={badgeStyle("#3b82f6")}
      title={`Manifest hash is on the trust list`}
    >
      trusted
    </span>
  ) : (
    <span
      style={badgeStyle("#f59e0b")}
      title="Manifest hash is NOT on the trust list — click Trust to allow under strict mode"
    >
      untrusted
    </span>
  );
}

export function PluginsPage(): ReactElement {
  const { data, isPending } = usePlugins();
  const refresh = useRefreshPlugins();
  const trust = useTrustPlugin();
  const setMode = useSetPluginTrustMode();
  const setEnabled = useSetPluginEnabled();

  const plugins = data?.plugins ?? [];
  const trustMode: PluginTrustMode = data?.trust_mode ?? "permissive";
  const root = data?.plugins_root ?? "~/.codenest/plugins";

  return (
    <Shell
      actions={
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 11, color: "var(--fg-3)" }}>
            Trust mode{" "}
            <select
              value={trustMode}
              onChange={(e) =>
                setMode.mutate(e.target.value as PluginTrustMode)
              }
              style={{
                marginLeft: 4,
                padding: "4px 8px",
                background: "var(--bg-1)",
                border: "1px solid var(--line-1)",
                color: "var(--fg-0)",
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              <option value="permissive">permissive</option>
              <option value="strict">strict</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() =>
              refresh.mutate(undefined, {
                onSuccess: (r) =>
                  toast.success(
                    `Refresh: ${r.discovered} discovered, ${r.loaded} loaded, ${r.skipped} skipped, ${r.error} error`,
                  ),
              })
            }
            disabled={refresh.isPending}
            style={{
              padding: "6px 12px",
              borderRadius: 4,
              border: "1px solid var(--line-2)",
              background: "rgba(59, 130, 246, 0.15)",
              color: "var(--fg-0)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {refresh.isPending ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      }
    >
      <div
        style={{
          padding: "16px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          color: "var(--fg-1)",
        }}
      >
        {isPending ? (
          <div style={{ fontSize: 12, color: "var(--fg-3)" }}>Loading…</div>
        ) : plugins.length === 0 ? (
          <div style={cardStyle}>
            <div style={{ fontSize: 13, color: "var(--fg-2)" }}>
              No plugins discovered.
            </div>
            <div style={{ fontSize: 12, color: "var(--fg-4)" }}>
              Drop a plugin directory containing <code>manifest.json</code>{" "}
              under <code>{root}</code> and click Refresh.
            </div>
          </div>
        ) : (
          plugins.map((p) => (
            <div key={p.id} style={cardStyle}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                }}
              >
                <div
                  style={{ display: "flex", gap: 8, alignItems: "baseline" }}
                >
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: "var(--fg-0)",
                    }}
                  >
                    {p.name}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--fg-3)" }}>
                    v{p.version}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--fg-4)" }}>
                    {p.slug}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {sigBadge(p.signature_status)}
                  {loadBadge(p.load_status)}
                </div>
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--fg-3)",
                  fontFamily: "monospace",
                }}
              >
                {p.dir_path}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--fg-3)",
                  fontFamily: "monospace",
                }}
                title="Canonical manifest SHA-256"
              >
                {p.manifest_sha256 || "(no hash)"}
              </div>
              {p.load_error && (
                <div style={{ fontSize: 12, color: "#ef4444" }}>
                  {p.load_error}
                </div>
              )}
              {(p.manifest.contributions ?? []).length > 0 && (
                <div style={{ fontSize: 12, color: "var(--fg-2)" }}>
                  Contributes:{" "}
                  {(p.manifest.contributions ?? []).map((c, i) => (
                    <span
                      key={i}
                      style={{ ...badgeStyle("#a855f7"), marginRight: 4 }}
                    >
                      {c.type}
                    </span>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <label style={{ fontSize: 12, color: "var(--fg-2)" }}>
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={(e) =>
                      setEnabled.mutate({ id: p.id, enabled: e.target.checked })
                    }
                  />{" "}
                  enabled
                </label>
                {p.manifest_sha256 && (
                  <button
                    type="button"
                    onClick={() =>
                      trust.mutate(
                        {
                          sha256: p.manifest_sha256,
                          trust: p.signature_status !== "trusted",
                        },
                        {
                          onSuccess: () =>
                            toast.success(
                              p.signature_status === "trusted"
                                ? "Hash removed from trust list"
                                : "Hash added to trust list",
                            ),
                        },
                      )
                    }
                    style={{
                      padding: "2px 10px",
                      borderRadius: 4,
                      border: "1px solid var(--line-2)",
                      background: "transparent",
                      color: "var(--fg-2)",
                      cursor: "pointer",
                      fontSize: 11,
                    }}
                  >
                    {p.signature_status === "trusted" ? "Untrust" : "Trust"}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </Shell>
  );
}
