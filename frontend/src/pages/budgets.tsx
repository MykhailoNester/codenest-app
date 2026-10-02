/**
 * Budgets — "what is this costing me", one of the four questions the app
 * exists to answer. Structure follows `design/deck/prototype.html`
 * (`SCREENS.budgets`): five tiles, spend by project, spend by agent, then the
 * thresholds that the rail's meter and the attention queue read from.
 *
 * Two figures the prototype draws cannot be measured yet and so render an em
 * dash naming the lane they wait on rather than a zero:
 *
 *  * **per task** — ticket #267. Nothing attributes a run to a task.
 *  * **per hour** — there is no hourly bucket: `/api/v1/metrics/cost` groups
 *    by project, agent, profile or day and nothing finer. The tile shows the
 *    7-day daily mean instead, which is real, and says that is what it is.
 */

import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { toast } from "sonner";
import {
  useBudgetBurn,
  useCostMetrics,
  useDailySpend,
  useInvocables,
  useQuerySourceSpend,
  useCreateBudget,
  useDeleteBudget,
  useProjects,
  useUpdateBudget,
  type BudgetBurn,
  type BudgetCreateInput,
  type BudgetPeriod,
  type BudgetScope,
  type CostBucket,
  type QuerySourceBucket,
} from "../lib/api";
import { budgetBarPct } from "../lib/budget-format";
import { UsageLimits } from "../components/budgets/usage-limits";
import { DeckShell } from "../components/deck/deck-shell";
import { DECK_COLS } from "../components/deck/deck-cols";
import {
  DeckGrid,
  DeckGroup,
  DeckHead,
  DeckLine,
  type DeckCell,
  type DeckState,
} from "../components/deck/deck-grid";
import { DeckMenu } from "../components/deck/deck-menu";

const SCOPES: readonly BudgetScope[] = ["workspace", "project", "agent"];
const PERIODS: readonly BudgetPeriod[] = ["daily", "weekly", "monthly"];

const UNATTRIBUTED = "unattributed";

const COLS_SPEND = DECK_COLS.wide;
const COLS_BUDGET = "14px minmax(0, 1fr) 170px 118px 120px auto";
const COLS_SOURCE = "14px minmax(0, 1fr) 118px 96px 80px 90px";

/* ── Small pieces ────────────────────────────────────────────────────── */

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * The share meter. Deck draws one as `.dk-bar`, but that class is defined
 * twice in the generated stylesheet and the later rule — the detail page's
 * toolbar — wins, so the meter is inline here rather than silently rendering
 * as a bordered flex row. Reported with ticket #343.
 */
function Meter({
  pct,
  tone,
}: {
  pct: number;
  tone?: "warn" | "err";
}): ReactElement {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        width: 46,
        height: 3,
        marginRight: 6,
        background: "var(--line)",
        borderRadius: 99,
        overflow: "hidden",
      }}
    >
      <span
        style={{
          display: "block",
          height: "100%",
          width: `${budgetBarPct(pct)}%`,
          background:
            tone === "err"
              ? "var(--err)"
              : tone === "warn"
                ? "var(--warn)"
                : "var(--fg-3)",
        }}
      />
    </span>
  );
}

function Tile({
  value,
  label,
  na,
  warn,
}: {
  value: ReactNode;
  label: ReactNode;
  na?: boolean;
  warn?: boolean;
}): ReactElement {
  return (
    <div className="dk-big">
      <div className={na ? "v na" : "v"}>{value}</div>
      <div className={warn ? "l warn" : "l"}>{label}</div>
    </div>
  );
}

/** A labelled control in the create form. Deck has no form primitive. */
function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="dim" style={{ fontSize: "var(--fs-xs)" }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function ShareCell({ pct }: { pct: number }): ReactElement {
  return (
    <>
      <Meter pct={pct} />
      {pct.toFixed(0)}%
    </>
  );
}

/* ── Create form ─────────────────────────────────────────────────────── */

function CreateForm({
  onSubmit,
  onCancel,
  submitting,
}: {
  onSubmit: (input: BudgetCreateInput) => void;
  onCancel: () => void;
  submitting: boolean;
}): ReactElement {
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
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--u3)",
        padding: "var(--u3)",
        marginBottom: "var(--u6)",
        border: "1px solid var(--line)",
        borderRadius: 3,
      }}
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
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
          gap: "var(--u3)",
        }}
      >
        <Field label="name">
          <span className="dk-field">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="sonnet weekly cap"
              aria-label="Budget name"
            />
          </span>
        </Field>
        <Field label="limit usd">
          <span className="dk-field">
            <input
              type="number"
              min="0"
              step="0.01"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              aria-label="Budget limit in USD"
            />
          </span>
        </Field>
        <Field label="scope">
          <select
            className="dk-rowsel"
            value={scope}
            onChange={(e) => setScope(e.target.value as BudgetScope)}
            aria-label="Budget scope"
          >
            {SCOPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="period">
          <select
            className="dk-rowsel"
            value={period}
            onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}
            aria-label="Budget period"
          >
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        {scope === "project" && (
          <Field label="project">
            <select
              className="dk-rowsel"
              value={projectId}
              onChange={(e) =>
                setProjectId(e.target.value === "" ? "" : Number(e.target.value))
              }
              aria-label="Budget project"
            >
              <option value="">select…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {scope === "agent" && (
          <Field label="agent profile">
            <span className="dk-field">
              <input
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
                placeholder="agent_sessions.profile"
                aria-label="Agent profile"
              />
            </span>
          </Field>
        )}
      </div>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: "var(--fs-s)",
          color: "var(--fg-2)",
        }}
      >
        <input
          type="checkbox"
          checked={hardStop}
          onChange={(e) => setHardStop(e.target.checked)}
        />
        block new sessions at 100% (hard-stop)
      </label>

      <span className="dk-actions">
        <button
          type="submit"
          className="dk-btn pri"
          disabled={!canSubmit || submitting}
        >
          {submitting ? "creating…" : "create budget"}
        </button>
        <button type="button" className="dk-btn" onClick={onCancel}>
          cancel
        </button>
      </span>
    </form>
  );
}

/* ── Spend ledgers ───────────────────────────────────────────────────── */

/** The five cells every spend row has; `second` is what the ledger groups by. */
function ledgerCells(bucket: CostBucket, second: ReactNode): DeckCell[] {
  const name = bucket.label || bucket.key;
  return [
    { v: name, cls: "sub", title: name },
    second,
    { v: String(bucket.run_count), cls: "r" },
    { v: tokens(bucket.total_tokens_in + bucket.total_tokens_out), cls: "r" },
    { v: usd(bucket.total_cost_usd), cls: "r" },
  ];
}

/* ── Where the spend came from (lane B, #177) ────────────────────────── */

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
    <DeckGroup
      label="where the spend came from"
      count={sources.length > 0 ? sources.length : undefined}
      note="what claude code reported on its own metrics signal"
    >
      <div className="dk-note sans">
        Split by the <code>query_source</code> dimension Claude Code stamped on
        each counter. The buckets are whatever values have actually arrived —
        nothing here knows the vocabulary in advance, and a series that carried
        no query source is its own <code>{UNATTRIBUTED}</code> row rather than a
        guess.
      </div>

      {isError ? (
        <div className="dk-note" style={{ color: "var(--err)" }}>
          Could not read the split: {error.message}
        </div>
      ) : isPending ? (
        <div className="dk-note">Reading&hellip;</div>
      ) : sources.length === 0 ? (
        <div className="dk-note sans">
          No metrics exports have arrived yet. Turn on telemetry and point the
          OTLP metrics exporter at this app to populate this.
        </div>
      ) : (
        <DeckGrid cols={COLS_SOURCE} label="Spend by query source">
          <DeckHead
            cells={["source", "share", "r tokens", "r sessions", "r cost"]}
          />
          {sources.map((bucket) => {
            const share = total > 0 ? (bucket.cost_usd / total) * 100 : 0;
            return (
              <DeckLine
                key={sourceLabel(bucket)}
                state={bucket.query_source ? "done" : "wait"}
                cells={[
                  {
                    v: sourceLabel(bucket),
                    cls: "sub",
                    title: sourceLabel(bucket),
                  },
                  <ShareCell key="share" pct={share} />,
                  { v: tokenTotal(bucket).toLocaleString(), cls: "r" },
                  { v: String(bucket.sessions), cls: "r" },
                  { v: `$${bucket.cost_usd.toFixed(4)}`, cls: "r" },
                ]}
              />
            );
          })}
        </DeckGrid>
      )}

      {attribution && attribution.sessions > 0 && (
        <div className="dk-note sans">
          Of the {attribution.sessions} session
          {attribution.sessions === 1 ? "" : "s"} these figures cover, Claude
          Code reported ${attribution.lane_b_cost_usd.toFixed(4)} while the
          per-project ledger above adds up to $
          {attribution.attributed_cost_usd.toFixed(4)} — a difference of $
          {attribution.delta_usd.toFixed(4)}. The two disagree on purpose: the
          vendor figure has no project dimension, so project attribution is
          still split from this app&rsquo;s own flat-rate estimate. Budgets
          scoped to a project are measured against that estimate; workspace and
          agent budgets are measured against the session totals.
        </div>
      )}
    </DeckGroup>
  );
}

/* ── Page ────────────────────────────────────────────────────────────── */

function scopeLine(
  b: BudgetBurn,
  projectName: (id: number | null) => string | undefined,
): string {
  const where =
    b.scope_type === "workspace"
      ? "workspace"
      : b.scope_type === "project"
        ? `project · ${projectName(b.scope_id) ?? `#${b.scope_id ?? "?"}`}`
        : `agent · ${b.scope_key ?? "?"}`;
  return [
    where,
    b.period,
    b.hard_stop ? "hard-stop" : null,
    b.enabled ? null : "off",
  ]
    .filter(Boolean)
    .join(" · ");
}

function budgetState(b: BudgetBurn): DeckState {
  if (!b.enabled) return "idle";
  if (b.percent >= 100) return "block";
  if (b.percent >= 80) return "stall";
  return "done";
}

export function BudgetsPage(): ReactElement {
  const { data: items = [], isPending } = useBudgetBurn();
  const { data: projects = [] } = useProjects();
  const { data: today } = useDailySpend();
  const { data: catalog } = useInvocables();
  const byProject = useCostMetrics({ group_by: "project", range: "7d" });
  const byAgent = useCostMetrics({ group_by: "agent", range: "7d" });
  const create = useCreateBudget();
  const update = useUpdateBudget();
  const remove = useDeleteBudget();

  const [showForm, setShowForm] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const projectName = (id: number | null): string | undefined =>
    id == null ? undefined : projects.find((p) => p.id === id)?.name;

  /** The agent's declared default model, when the catalog knows the name. */
  const modelOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of catalog?.agents ?? []) if (a.model) map.set(a.name, a.model);
    return map;
  }, [catalog]);

  // The cap the rail's meter and the attention queue read from: the enabled
  // workspace-wide daily budget. If the user keeps several, the first is the
  // one the tiles describe.
  const cap = items.find(
    (b) => b.enabled && b.scope_type === "workspace" && b.period === "daily",
  );

  const week = byProject.data?.grand_total.total_cost_usd ?? null;
  const headroom = cap ? Math.max(0, 100 - cap.percent) : null;

  const projectGroups = byProject.data?.groups ?? [];
  const projectTotal = byProject.data?.grand_total.total_cost_usd ?? 0;
  const agentGroups = byAgent.data?.groups ?? [];

  return (
    <DeckShell
      title="budgets"
      crumb="what this is costing me"
      actions={
        <button
          type="button"
          className="dk-btn pri"
          onClick={() => setShowForm((v) => !v)}
        >
          + budget
        </button>
      }
    >
      <div className="dk-bigs">
        <Tile
          value={today ? usd(today.cost_usd) : "—"}
          na={!today}
          label={cap ? `today · of ${usd(cap.limit_usd)}` : "today · no daily cap set"}
        />
        <Tile
          value={headroom == null ? "—" : `${headroom.toFixed(0)}%`}
          na={headroom == null}
          warn={headroom != null && headroom <= 20}
          label={
            headroom == null
              ? "headroom · no daily cap set"
              : "headroom · of the daily cap"
          }
        />
        <Tile
          value={week == null ? "—" : usd(week / 7)}
          na={week == null}
          label="per day · 7-day mean"
        />
        <Tile
          value={week == null ? "—" : usd(week)}
          na={week == null}
          label="7 days"
        />
        {/* #267: nothing attributes a run to a task, so this is an em dash
            naming the lane it waits on and never a zero. */}
        <Tile value="—" na warn label="per task · ticket #267" />
      </div>

      {showForm && (
        <CreateForm
          submitting={create.isPending}
          onCancel={() => setShowForm(false)}
          onSubmit={(input) => {
            create.mutate(input, {
              onSuccess: () => {
                toast.success(`Budget '${input.name}' created`);
                setShowForm(false);
              },
              onError: (e) => toast.error(`Create failed: ${e.message}`),
            });
          }}
        />
      )}

      <DeckGroup label="by project" count={projectGroups.length} note="7 days">
        {byProject.isError ? (
          <div className="dk-note" style={{ color: "var(--err)" }}>
            Could not read project spend.
          </div>
        ) : projectGroups.length === 0 ? (
          <div className="dk-note sans">
            No runs in the last 7 days carry a project.
          </div>
        ) : (
          <DeckGrid cols={COLS_SPEND} label="Spend by project">
            <DeckHead
              cells={["project", "share", "r runs", "r tokens", "r spend"]}
            />
            {projectGroups.map((g) => (
              <DeckLine
                key={g.key}
                // A ledger row is a record, not a live thing: it stays inert
                // rather than borrowing a state it cannot observe.
                state="idle"
                cells={ledgerCells(
                  g,
                  <ShareCell
                    key="share"
                    pct={
                      projectTotal > 0
                        ? (g.total_cost_usd / projectTotal) * 100
                        : 0
                    }
                  />,
                )}
              />
            ))}
          </DeckGrid>
        )}
      </DeckGroup>

      <DeckGroup label="by agent" count={agentGroups.length} note="7 days">
        {byAgent.isError ? (
          <div className="dk-note" style={{ color: "var(--err)" }}>
            Could not read agent spend.
          </div>
        ) : agentGroups.length === 0 ? (
          <div className="dk-note sans">
            No runs in the last 7 days carry an agent profile.
          </div>
        ) : (
          <DeckGrid cols={COLS_SPEND} label="Spend by agent">
            <DeckHead
              cells={["agent", "default model", "r runs", "r tokens", "r spend"]}
            />
            {agentGroups.map((g) => (
              <DeckLine
                key={g.key}
                state="idle"
                // The catalog is the only place a declared default model
                // lives; an agent it does not know gets an em dash.
                cells={ledgerCells(g, modelOf.get(g.key) ?? "—")}
              />
            ))}
          </DeckGrid>
        )}
      </DeckGroup>

      <DeckGroup
        label="thresholds"
        count={items.length}
        note="what the rail's meter and needs you read from"
      >
        {isPending ? (
          <div className="dk-note">Loading&hellip;</div>
        ) : items.length === 0 ? (
          <div className="dk-note sans">
            No budgets yet. Without one the tiles above have no cap to measure
            headroom against, and no threshold can reach the attention queue.
          </div>
        ) : (
          <DeckGrid cols={COLS_BUDGET} label="Budgets">
            <DeckHead
              cells={["budget", "scope", "r used", "r of limit", "r "]}
            />
            {items.map((b) => (
              <DeckLine
                key={b.id}
                state={budgetState(b)}
                cells={[
                  { v: b.name, cls: "sub", title: b.name },
                  scopeLine(b, projectName),
                  {
                    v: (
                      <>
                        <Meter
                          pct={b.percent}
                          tone={
                            b.percent >= 100
                              ? "err"
                              : b.percent >= 80
                                ? "warn"
                                : undefined
                          }
                        />
                        {b.percent.toFixed(0)}%
                      </>
                    ),
                    cls: "r",
                  },
                  { v: `${usd(b.spent_usd)} / ${usd(b.limit_usd)}`, cls: "r" },
                  {
                    v: (
                      <span
                        className="dk-actions end"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <DeckMenu
                          label={`Actions for ${b.name}`}
                          items={[
                            {
                              label: b.enabled
                                ? "Disable budget"
                                : "Enable budget",
                              onSelect: () =>
                                update.mutate({
                                  id: b.id,
                                  patch: { enabled: !b.enabled },
                                }),
                            },
                            {
                              label: b.hard_stop
                                ? "Stop blocking at 100%"
                                : "Block new sessions at 100%",
                              onSelect: () =>
                                update.mutate({
                                  id: b.id,
                                  patch: { hard_stop: !b.hard_stop },
                                }),
                            },
                            {
                              label:
                                confirmDeleteId === b.id
                                  ? "Confirm delete"
                                  : "Delete budget",
                              danger: true,
                              separated: true,
                              disabled:
                                remove.isPending && confirmDeleteId === b.id,
                              onSelect: () => {
                                if (confirmDeleteId !== b.id) {
                                  setConfirmDeleteId(b.id);
                                  return;
                                }
                                remove.mutate(b.id, {
                                  onSuccess: () => {
                                    setConfirmDeleteId(null);
                                    toast.success("Budget deleted");
                                  },
                                  onError: (e) =>
                                    toast.error(`Delete failed: ${e.message}`),
                                });
                              },
                            },
                          ]}
                        />
                      </span>
                    ),
                    cls: "r",
                  },
                ]}
              />
            ))}
          </DeckGrid>
        )}
      </DeckGroup>

      <QuerySourceSplit />

      <hr className="dk-rule" />
      {/* Not yet Deck: `components/budgets/usage-limits.tsx` is outside this
          ticket's file scope and keeps its own stylesheet. It reads the two
          measurement lanes against each other, which no list here does. */}
      <UsageLimits />
    </DeckShell>
  );
}
