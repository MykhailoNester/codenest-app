import { useMemo, useState, type ReactElement } from "react";
import { toast } from "sonner";
import {
  useBudgetBurn,
  useQuerySourceSpend,
  useCreateBudget,
  useDeleteBudget,
  useProjects,
  useUpdateBudget,
  type BudgetCreateInput,
  type BudgetPeriod,
  type BudgetScope,
  type QuerySourceBucket,
} from "../lib/api";
import { Shell } from "../components/layout/shell";
import { budgetBarColor, budgetBarPct } from "../lib/budget-format";

const SCOPES: readonly BudgetScope[] = ["workspace", "project", "agent"];
const PERIODS: readonly BudgetPeriod[] = ["daily", "weekly", "monthly"];

const cardStyle: React.CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line-2)",
  borderRadius: 8,
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

function scopeLabel(
  scope: BudgetScope,
  scope_id: number | null,
  scope_key: string | null,
  projectName?: string,
): string {
  if (scope === "workspace") return "Workspace";
  if (scope === "project")
    return `Project · ${projectName ?? `#${scope_id ?? "?"}`}`;
  return `Agent · ${scope_key ?? "?"}`;
}

interface CreateFormProps {
  onSubmit: (input: BudgetCreateInput) => void;
  submitting: boolean;
}

function CreateForm({ onSubmit, submitting }: CreateFormProps): ReactElement {
  const { data: projects = [] } = useProjects();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<BudgetScope>("workspace");
  const [projectId, setProjectId] = useState<number | "">("");
  const [profile, setProfile] = useState("");
  const [period, setPeriod] = useState<BudgetPeriod>("monthly");
  const [limit, setLimit] = useState("100");
  const [hardStop, setHardStop] = useState(false);

  const canSubmit = useMemo(() => {
    if (!name.trim()) return false;
    if (!limit || Number(limit) <= 0) return false;
    if (scope === "project" && projectId === "") return false;
    if (scope === "agent" && !profile.trim()) return false;
    return true;
  }, [name, limit, scope, projectId, profile]);

  return (
    <form
      style={{ ...cardStyle, gap: 10 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        const payload: BudgetCreateInput = {
          name: name.trim(),
          scope_type: scope,
          period,
          limit_usd: Number(limit),
          hard_stop: hardStop,
        };
        if (scope === "project")
          payload.scope_id = projectId === "" ? null : Number(projectId);
        if (scope === "agent") payload.scope_key = profile.trim();
        onSubmit(payload);
        setName("");
        setLimit("100");
        setHardStop(false);
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)" }}>
        New budget
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11,
            color: "var(--fg-3)",
          }}
        >
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Sonnet weekly cap"
            style={{
              padding: "6px 8px",
              background: "var(--bg-1)",
              border: "1px solid var(--line-1)",
              color: "var(--fg-0)",
              borderRadius: 4,
            }}
          />
        </label>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11,
            color: "var(--fg-3)",
          }}
        >
          Limit (USD)
          <input
            type="number"
            min="0"
            step="0.01"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            style={{
              padding: "6px 8px",
              background: "var(--bg-1)",
              border: "1px solid var(--line-1)",
              color: "var(--fg-0)",
              borderRadius: 4,
            }}
          />
        </label>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11,
            color: "var(--fg-3)",
          }}
        >
          Scope
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as BudgetScope)}
            style={{
              padding: "6px 8px",
              background: "var(--bg-1)",
              border: "1px solid var(--line-1)",
              color: "var(--fg-0)",
              borderRadius: 4,
            }}
          >
            {SCOPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11,
            color: "var(--fg-3)",
          }}
        >
          Period
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}
            style={{
              padding: "6px 8px",
              background: "var(--bg-1)",
              border: "1px solid var(--line-1)",
              color: "var(--fg-0)",
              borderRadius: 4,
            }}
          >
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        {scope === "project" ? (
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              fontSize: 11,
              color: "var(--fg-3)",
            }}
          >
            Project
            <select
              value={projectId}
              onChange={(e) =>
                setProjectId(
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
              style={{
                padding: "6px 8px",
                background: "var(--bg-1)",
                border: "1px solid var(--line-1)",
                color: "var(--fg-0)",
                borderRadius: 4,
              }}
            >
              <option value="">Select…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {scope === "agent" ? (
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              fontSize: 11,
              color: "var(--fg-3)",
            }}
          >
            Agent profile
            <input
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              placeholder="profile string from agent_sessions.profile"
              style={{
                padding: "6px 8px",
                background: "var(--bg-1)",
                border: "1px solid var(--line-1)",
                color: "var(--fg-0)",
                borderRadius: 4,
              }}
            />
          </label>
        ) : null}
      </div>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          color: "var(--fg-2)",
        }}
      >
        <input
          type="checkbox"
          checked={hardStop}
          onChange={(e) => setHardStop(e.target.checked)}
        />
        Block new sessions when this budget is at 100% (hard-stop)
      </label>
      <button
        type="submit"
        disabled={!canSubmit || submitting}
        style={{
          alignSelf: "flex-start",
          padding: "6px 12px",
          borderRadius: 4,
          border: "1px solid var(--line-2)",
          background: canSubmit ? "rgba(59, 130, 246, 0.15)" : "var(--bg-1)",
          color: canSubmit ? "var(--fg-0)" : "var(--fg-3)",
          cursor: canSubmit ? "pointer" : "not-allowed",
          fontSize: 12,
        }}
      >
        {submitting ? "Creating…" : "Create budget"}
      </button>
    </form>
  );
}

const UNATTRIBUTED = "unattributed";

function sourceLabel(bucket: QuerySourceBucket): string {
  return bucket.query_source ?? UNATTRIBUTED;
}

function tokenTotal(bucket: QuerySourceBucket): number {
  return (
    bucket.tokens_input +
    bucket.tokens_output +
    bucket.tokens_cache_read +
    bucket.tokens_cache_creation
  );
}

function QuerySourceSplit(): ReactElement {
  const { data, isPending, isError, error } = useQuerySourceSpend();
  const sources = data?.sources ?? [];
  const total = data?.total_cost_usd ?? 0;
  const attribution = data?.attribution;

  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)" }}>
        Where the spend came from
      </div>
      <div style={{ fontSize: 11, color: "var(--fg-3)" }}>
        Cost and tokens Claude Code reported on its own metrics signal, split by
        the <code>query_source</code> dimension it stamped on each counter. The
        buckets are whatever values have actually arrived — nothing here knows
        the vocabulary in advance, and a series that carried no query source is
        its own <code>{UNATTRIBUTED}</code> row rather than a guess.
      </div>

      {isError ? (
        <div style={{ fontSize: 11, color: "var(--danger, #e5484d)" }}>
          Could not read the split: {error.message}
        </div>
      ) : isPending ? (
        <div style={{ fontSize: 12, color: "var(--fg-3)" }}>Reading…</div>
      ) : sources.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
          No metrics exports have arrived yet. Turn on telemetry and point the
          OTLP metrics exporter at this app to populate this.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {sources.map((bucket) => {
            const share = total > 0 ? (bucket.cost_usd / total) * 100 : 0;
            return (
              <div
                key={sourceLabel(bucket)}
                style={{ display: "flex", flexDirection: "column", gap: 3 }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 12,
                    color: bucket.query_source ? "var(--fg-0)" : "var(--fg-3)",
                  }}
                >
                  <span style={{ fontFamily: "monospace" }}>
                    {sourceLabel(bucket)}
                  </span>
                  <span style={{ fontFamily: "monospace" }}>
                    ${bucket.cost_usd.toFixed(4)} · {share.toFixed(1)}% ·{" "}
                    {tokenTotal(bucket).toLocaleString()} tok ·{" "}
                    {bucket.sessions} session{bucket.sessions === 1 ? "" : "s"}
                  </span>
                </div>
                <div
                  style={{
                    height: 6,
                    background: "var(--bg-1)",
                    borderRadius: 3,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, share)}%`,
                      height: "100%",
                      background: bucket.query_source
                        ? "var(--accent, #4f8cff)"
                        : "var(--line-2)",
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {attribution && attribution.sessions > 0 ? (
        <div
          style={{
            fontSize: 11,
            color: "var(--fg-3)",
            borderTop: "1px solid var(--line-1)",
            paddingTop: 8,
          }}
        >
          Of the {attribution.sessions} session
          {attribution.sessions === 1 ? "" : "s"} these figures cover, Claude
          Code reported ${attribution.lane_b_cost_usd.toFixed(4)} while the
          per-project ledger below adds up to $
          {attribution.attributed_cost_usd.toFixed(4)} — a difference of $
          {attribution.delta_usd.toFixed(4)}. The two disagree on purpose: the
          vendor figure has no project dimension, so project attribution is
          still split from this app&rsquo;s own flat-rate estimate. Budgets
          scoped to a project are measured against that estimate; workspace and
          agent budgets are measured against the session totals.
        </div>
      ) : null}
    </div>
  );
}

export function BudgetsPage(): ReactElement {
  const { data: items = [], isPending } = useBudgetBurn();
  const { data: projects = [] } = useProjects();
  const create = useCreateBudget();
  const update = useUpdateBudget();
  const remove = useDeleteBudget();

  const projectName = (id: number | null): string | undefined =>
    id == null ? undefined : projects.find((p) => p.id === id)?.name;

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
        <QuerySourceSplit />

        <CreateForm
          submitting={create.isPending}
          onSubmit={(input) => {
            create.mutate(input, {
              onSuccess: () => toast.success(`Budget '${input.name}' created`),
              onError: (e) => toast.error(`Create failed: ${e.message}`),
            });
          }}
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {isPending ? (
            <div style={{ fontSize: 12, color: "var(--fg-3)" }}>Loading…</div>
          ) : items.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
              No budgets yet — create one above.
            </div>
          ) : (
            items.map((b) => {
              const percent = b.percent;
              const barPct = budgetBarPct(percent);
              return (
                <div key={b.id} style={cardStyle}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                      alignItems: "baseline",
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 600,
                          color: "var(--fg-0)",
                        }}
                      >
                        {b.name}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--fg-3)" }}>
                        {scopeLabel(
                          b.scope_type,
                          b.scope_id,
                          b.scope_key,
                          projectName(b.scope_id),
                        )}{" "}
                        · {b.period}
                        {b.hard_stop ? " · hard-stop" : ""}
                      </div>
                    </div>
                    <div
                      style={{
                        fontFamily: "monospace",
                        fontSize: 13,
                        color: "var(--fg-0)",
                      }}
                    >
                      ${b.spent_usd.toFixed(2)} / ${b.limit_usd.toFixed(2)}
                    </div>
                  </div>
                  <div
                    style={{
                      height: 8,
                      background: "var(--bg-1)",
                      borderRadius: 4,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${barPct}%`,
                        height: "100%",
                        background: budgetBarColor(percent),
                        transition: "width 200ms ease",
                      }}
                    />
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 11,
                      color: "var(--fg-3)",
                    }}
                  >
                    <span>{percent.toFixed(1)}% used</span>
                    <span>
                      <label style={{ marginRight: 12 }}>
                        <input
                          type="checkbox"
                          checked={b.enabled}
                          onChange={(e) =>
                            update.mutate({
                              id: b.id,
                              patch: { enabled: e.target.checked },
                            })
                          }
                        />{" "}
                        enabled
                      </label>
                      <label style={{ marginRight: 12 }}>
                        <input
                          type="checkbox"
                          checked={b.hard_stop}
                          onChange={(e) =>
                            update.mutate({
                              id: b.id,
                              patch: { hard_stop: e.target.checked },
                            })
                          }
                        />{" "}
                        hard-stop
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`Delete budget '${b.name}'?`)) {
                            remove.mutate(b.id, {
                              onSuccess: () => toast.success("Budget deleted"),
                            });
                          }
                        }}
                        style={{
                          background: "transparent",
                          border: "1px solid var(--line-2)",
                          color: "var(--fg-2)",
                          fontSize: 11,
                          padding: "2px 8px",
                          borderRadius: 4,
                          cursor: "pointer",
                        }}
                      >
                        Delete
                      </button>
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </Shell>
  );
}
