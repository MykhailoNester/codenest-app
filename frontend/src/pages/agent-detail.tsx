import { useState, type ReactElement } from "react";
import { useParams } from "react-router-dom";
import {
  useAgentInvocations,
  type AgentInvocationRow,
} from "../lib/api";
import { Shell } from "../components/layout/shell";
import { DetailHeader } from "../components/layout/detail-header";

type Range = "7d" | "30d" | "all";

function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
}

function fmtRelativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function InvocationRow({
  inv,
}: {
  inv: AgentInvocationRow;
}): ReactElement {
  const durationDisplay =
    inv.duration_seconds !== null
      ? fmtDuration(inv.duration_seconds)
      : "—";

  const profileDisplay = inv.project_name
    ? `${inv.profile} · ${inv.project_name}`
    : inv.profile;

  return (
    <tr style={{ borderBottom: "1px solid var(--line-1)" }}>
      <td
        style={{
          padding: "9px 10px",
          fontSize: 12,
          color: "var(--fg-3)",
          whiteSpace: "nowrap",
        }}
      >
        {new Date(inv.created_at).toLocaleString()}
      </td>
      <td
        style={{
          padding: "9px 10px",
          fontSize: 12,
          color: "var(--fg-2)",
          maxWidth: 320,
        }}
      >
        {inv.description ?? inv.label ?? "—"}
      </td>
      <td
        style={{
          padding: "9px 10px",
          fontSize: 12,
          color: "var(--fg-3)",
          whiteSpace: "nowrap",
        }}
      >
        {durationDisplay}
      </td>
      <td
        style={{
          padding: "9px 10px",
          fontSize: 12,
          color: "var(--fg-4)",
          whiteSpace: "nowrap",
        }}
      >
        {profileDisplay}
      </td>
    </tr>
  );
}

export function AgentDetailPage(): ReactElement {
  const { name = "" } = useParams<{ name: string }>();
  const [range, setRange] = useState<Range>("30d");
  const [page, setPage] = useState(0);

  const { data, isLoading, isError } = useAgentInvocations(name, range, page);

  const stats = data?.stats;
  const invocations = data?.invocations ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / 50);

  const displayName = name.charAt(0).toUpperCase() + name.slice(1);

  return (
    <Shell>
      <div style={{ padding: "0 24px 24px" }}>
        <DetailHeader
          crumbs={`Team · ${name}`}
          title={displayName}
          fallbackRoute="/team"
          actions={
            <>
              {(["7d", "30d", "all"] as Range[]).map((r) => (
                <button
                  key={r}
                  className={`d3-btn ${range === r ? "d3-btn--primary" : "d3-btn--ghost"}`}
                  type="button"
                  onClick={() => {
                    setRange(r);
                    setPage(0);
                  }}
                >
                  {r}
                </button>
              ))}
            </>
          }
        />

        {isError && (
          <div
            style={{ color: "var(--fg-3)", fontSize: 13, padding: "16px 0" }}
          >
            Failed to load invocation data for &ldquo;{name}&rdquo;.
          </div>
        )}

        {isLoading && (
          <div
            style={{ color: "var(--fg-3)", fontSize: 13, padding: "16px 0" }}
          >
            Loading&hellip;
          </div>
        )}

        {/* Stat tiles */}
        {stats !== undefined && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 12,
              marginBottom: 20,
            }}
          >
            <div className="d3-card" style={{ padding: "14px 16px" }}>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--fg-4)",
                  marginBottom: 4,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Invocations
              </div>
              <div
                style={{ fontSize: 22, fontWeight: 700, color: "var(--fg-0)" }}
              >
                {stats.total_invocations}
              </div>
              {stats.total_invocations > 0 && (
                <div style={{ fontSize: 11, color: "var(--fg-4)", marginTop: 2 }}>
                  {stats.completed} completed
                </div>
              )}
            </div>

            <div className="d3-card" style={{ padding: "14px 16px" }}>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--fg-4)",
                  marginBottom: 4,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Last Invoked
              </div>
              <div
                style={{ fontSize: 22, fontWeight: 700, color: "var(--fg-0)" }}
              >
                {stats.last_invoked_at !== null
                  ? fmtRelativeDate(stats.last_invoked_at)
                  : "—"}
              </div>
              {stats.last_invoked_at !== null && (
                <div style={{ fontSize: 11, color: "var(--fg-4)", marginTop: 2 }}>
                  {new Date(stats.last_invoked_at).toLocaleDateString()}
                </div>
              )}
            </div>

            <div className="d3-card" style={{ padding: "14px 16px" }}>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--fg-4)",
                  marginBottom: 4,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Avg Duration
              </div>
              <div
                style={{ fontSize: 22, fontWeight: 700, color: "var(--fg-0)" }}
              >
                {stats.avg_duration_seconds !== null
                  ? fmtDuration(stats.avg_duration_seconds)
                  : "—"}
              </div>
            </div>
          </div>
        )}

        {/* Invocations table */}
        <div
          className="d3-card"
          style={{ padding: "16px", overflow: "hidden" }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--fg-1)",
              marginBottom: 12,
            }}
          >
            Invocations
          </div>

          {!isLoading && stats !== undefined && stats.total_invocations === 0 && (
            <div style={{ fontSize: 12, color: "var(--fg-4)", padding: "8px 0" }}>
              {displayName} hasn&apos;t been invoked in this period.
              {range !== "all" && (
                <> Try switching to{" "}
                  <button
                    type="button"
                    className="d3-btn d3-btn--ghost"
                    style={{ fontSize: 11 }}
                    onClick={() => setRange("all")}
                  >
                    all time
                  </button>.
                </>
              )}
            </div>
          )}

          {invocations.length > 0 && (
            <>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--line-2)" }}>
                    {["When", "Task", "Duration", "Profile"].map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: "6px 10px",
                          fontSize: 11,
                          color: "var(--fg-3)",
                          textAlign: "left",
                          fontWeight: 600,
                          textTransform: "uppercase",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {invocations.map((inv) => (
                    <InvocationRow key={inv.id} inv={inv} />
                  ))}
                </tbody>
              </table>

              {totalPages > 1 && (
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    marginTop: 12,
                    fontSize: 12,
                    color: "var(--fg-3)",
                  }}
                >
                  <button
                    className="d3-btn d3-btn--ghost"
                    type="button"
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                    style={{ fontSize: 12 }}
                  >
                    &larr; Prev
                  </button>
                  <span>
                    Page {page + 1} of {totalPages}
                  </span>
                  <button
                    className="d3-btn d3-btn--ghost"
                    type="button"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage((p) => p + 1)}
                    style={{ fontSize: 12 }}
                  >
                    Next &rarr;
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Shell>
  );
}
