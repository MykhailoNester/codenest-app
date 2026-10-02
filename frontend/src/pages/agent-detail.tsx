/**
 * Agent detail — `/team/:name`, reached from Agents (#345).
 *
 * Converted off the old `Shell` as the last page on it. Nothing the page did
 * was dropped: the range toggle, the three stats, the invocations table, the
 * "try all time" empty state and the pager are all here, drawn with Deck's
 * primitives instead of inline styles. Two deliberate differences:
 *
 *   - Back is a `Link` to `/team`, not `DetailHeader`'s `navigate(-1)` with a
 *     fallback. `/team` is this page's only parent, and a plain link is the
 *     idiom every converted detail page uses (`task-detail.tsx`).
 *   - The range toggle sits in the shell's `actions` slot as a `.dk-seg`, the
 *     way Needs You carries its state tabs — "where an action goes" puts a
 *     filter in the title bar, not above the content.
 */
import { useState, type ReactElement } from "react";
import { Link, useParams } from "react-router-dom";
import { useAgentInvocations, type AgentInvocationRow } from "../lib/api";
import { DeckShell } from "../components/deck/deck-shell";
import { DeckGrid, DeckGroup, DeckHead, DeckLine } from "../components/deck/deck-grid";

type Range = "7d" | "30d" | "all";

const RANGES: readonly Range[] = ["7d", "30d", "all"];

/** Rows per page — the limit `useAgentInvocations` defaults to. */
const PAGE_SIZE = 50;

/** The em dash every unmeasured figure renders. Never a zero. */
const DASH = "—";

const INVOCATION_COLS = "14px 150px minmax(0, 1fr) 80px 180px";

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

function invocationCells(inv: AgentInvocationRow) {
  const when = new Date(inv.created_at).toLocaleString();
  const what = inv.description ?? inv.label ?? DASH;
  const profile = inv.project_name
    ? `${inv.profile} · ${inv.project_name}`
    : inv.profile;
  return [
    when,
    { v: what, cls: "sub", title: what },
    {
      v: inv.duration_seconds !== null ? fmtDuration(inv.duration_seconds) : DASH,
      cls: "r",
    },
    { v: profile, cls: "r" },
  ];
}

export function AgentDetailPage(): ReactElement {
  const { name = "" } = useParams<{ name: string }>();
  const [range, setRange] = useState<Range>("30d");
  const [page, setPage] = useState(0);

  const { data, isLoading, isError } = useAgentInvocations(name, range, page);

  const stats = data?.stats;
  const invocations = data?.invocations ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const ranges = (
    <div className="dk-seg" role="tablist" aria-label="Range">
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          role="tab"
          aria-selected={range === r}
          className={range === r ? "on" : undefined}
          onClick={() => {
            setRange(r);
            setPage(0);
          }}
        >
          {r}
        </button>
      ))}
    </div>
  );

  return (
    <DeckShell title={name.toLowerCase()} crumb="agent" actions={ranges}>
      <Link className="dk-btn bare" to="/team" style={{ marginBottom: "var(--u3)" }}>
        ← agents
      </Link>

      {isError && (
        <div className="dk-note" style={{ color: "var(--err)" }}>
          Failed to load invocation data for &ldquo;{name}&rdquo;.
        </div>
      )}

      {isLoading && <div className="dk-note">Loading&hellip;</div>}

      {stats !== undefined && (
        <div className="dk-bigs">
          <div className="dk-big">
            <div className="v">{stats.total_invocations}</div>
            <div className="l">
              invocations
              {stats.total_invocations > 0 ? ` · ${stats.completed} completed` : ""}
            </div>
          </div>
          <div className="dk-big">
            <div className={stats.last_invoked_at === null ? "v na" : "v"}>
              {stats.last_invoked_at !== null
                ? fmtRelativeDate(stats.last_invoked_at)
                : DASH}
            </div>
            <div className="l">
              last invoked
              {stats.last_invoked_at !== null
                ? ` · ${new Date(stats.last_invoked_at).toLocaleDateString()}`
                : ""}
            </div>
          </div>
          <div className="dk-big">
            <div className={stats.avg_duration_seconds === null ? "v na" : "v"}>
              {stats.avg_duration_seconds !== null
                ? fmtDuration(stats.avg_duration_seconds)
                : DASH}
            </div>
            <div className="l">avg duration</div>
          </div>
        </div>
      )}

      <DeckGroup label="invocations" count={stats ? stats.total_invocations : DASH}>
        {!isLoading && stats !== undefined && stats.total_invocations === 0 && (
          <div className="dk-note sans">
            <div style={{ color: "var(--fg-2)" }}>
              {name} has not been invoked in this period.
            </div>
            {range !== "all" && (
              <div>
                Try switching to{" "}
                <button
                  type="button"
                  className="dk-btn bare"
                  onClick={() => {
                    setRange("all");
                    setPage(0);
                  }}
                >
                  all time
                </button>
                .
              </div>
            )}
          </div>
        )}

        {invocations.length > 0 && (
          <>
            <DeckGrid cols={INVOCATION_COLS} label="Invocations">
              <DeckHead cells={["when", "task", "r duration", "r profile"]} />
              {invocations.map((inv) => (
                <DeckLine key={inv.id} cells={invocationCells(inv)} />
              ))}
            </DeckGrid>

            {totalPages > 1 && (
              <div className="dk-actions" style={{ marginTop: "var(--u3)" }}>
                <button
                  type="button"
                  className="dk-btn bare"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  ← prev
                </button>
                <span className="dim">
                  page {page + 1} of {totalPages}
                </span>
                <button
                  type="button"
                  className="dk-btn bare"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  next →
                </button>
              </div>
            )}
          </>
        )}
      </DeckGroup>
    </DeckShell>
  );
}
