import { useMemo, useState, type ReactElement } from "react";
import {
  feedCsvUrl,
  useFeed,
  useProjects,
  type FeedCursor,
  type FeedFilters,
  type FeedRow,
  type FeedSource,
} from "../lib/api";
import { Shell } from "../components/layout/shell";

const SOURCES: readonly FeedSource[] = ["activity", "agent_session"];

const cardStyle: React.CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line-2)",
  borderRadius: 8,
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const inputStyle: React.CSSProperties = {
  padding: "6px 8px",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  color: "var(--fg-0)",
  borderRadius: 4,
  fontSize: 12,
};

function FeedRowCard({
  row,
  projectName,
}: {
  row: FeedRow;
  projectName?: string;
}): ReactElement {
  const left = `${row.entity_type} #${row.entity_id}`;
  return (
    <div style={cardStyle}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          alignItems: "baseline",
        }}
      >
        <div style={{ fontSize: 13, color: "var(--fg-0)" }}>
          <span style={{ fontWeight: 600 }}>{row.action}</span>
          <span style={{ color: "var(--fg-3)" }}> · {left}</span>
          {row.actor ? (
            <span style={{ color: "var(--fg-3)" }}> · by {row.actor}</span>
          ) : null}
          {projectName ? (
            <span style={{ color: "var(--fg-3)" }}> · {projectName}</span>
          ) : null}
        </div>
        <div
          style={{
            fontFamily: "monospace",
            fontSize: 11,
            color: "var(--fg-3)",
          }}
        >
          {row.created_at.slice(0, 19)}
        </div>
      </div>
      {row.summary ? (
        <div
          style={{ fontSize: 12, color: "var(--fg-2)", whiteSpace: "pre-wrap" }}
        >
          {row.summary}
        </div>
      ) : null}
      <div style={{ fontSize: 10, color: "var(--fg-4)" }}>{row.source}</div>
    </div>
  );
}

/** Append `items` to `prev`, skipping IDs already present. */
function mergePage(prev: FeedRow[], items: FeedRow[]): FeedRow[] {
  const seen = new Set(prev.map((r) => r.id));
  return [...prev, ...items.filter((r) => !seen.has(r.id))];
}

export function FeedPage(): ReactElement {
  const { data: projects = [] } = useProjects();
  const [source, setSource] = useState<FeedSource | "">("");
  const [actor, setActor] = useState("");
  const [projectId, setProjectId] = useState<number | "">("");
  const [q, setQ] = useState("");

  // `cursor` tracks the active page request.  `prevItems` holds all items
  // committed from pages *before* the current cursor — updated only in
  // explicit event handlers (Load more, Refresh, filter change), never in
  // effects, satisfying the react-hooks/set-state-in-effect rule.
  const [cursor, setCursor] = useState<FeedCursor | null>(null);
  const [prevItems, setPrevItems] = useState<FeedRow[]>([]);

  const filters: FeedFilters = useMemo(() => {
    const f: FeedFilters = {};
    if (source) f.source = source;
    if (actor.trim()) f.actor = actor.trim();
    if (projectId !== "") f.project_id = projectId;
    if (q.trim()) f.q = q.trim();
    return f;
  }, [source, actor, projectId, q]);

  const { data, isPending, isFetching, refetch } = useFeed(filters, cursor);

  // Derive the flat visible list: all committed previous pages plus the
  // current page (if loaded).  Pure derivation — no state mutation.
  const pages = useMemo(
    () => (data ? mergePage(prevItems, data.items) : prevItems),
    [prevItems, data],
  );

  // Reset accumulated pages whenever a filter changes.  Called directly
  // from the filter onChange handlers below rather than from an effect.
  function resetPagination(): void {
    setCursor(null);
    setPrevItems([]);
  }

  // Advance to the next cursor, committing the current page first.
  function loadMore(nextCursor: FeedCursor): void {
    if (data) {
      setPrevItems(mergePage(prevItems, data.items));
    }
    setCursor(nextCursor);
  }

  const projectName = (id: number | null): string | undefined =>
    id == null ? undefined : projects.find((p) => p.id === id)?.name;

  return (
    <Shell
      actions={
        <a
          href={feedCsvUrl(filters)}
          download="activity-feed.csv"
          style={{
            padding: "6px 12px",
            borderRadius: 4,
            border: "1px solid var(--line-2)",
            background: "rgba(59, 130, 246, 0.15)",
            color: "var(--fg-0)",
            fontSize: 12,
            textDecoration: "none",
          }}
        >
          Download CSV
        </a>
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
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 8,
          }}
        >
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              fontSize: 11,
              color: "var(--fg-3)",
            }}
          >
            Source
            <select
              value={source}
              onChange={(e) => {
                setSource(e.target.value as FeedSource | "");
                resetPagination();
              }}
              style={inputStyle}
            >
              <option value="">All</option>
              {SOURCES.map((s) => (
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
            Project
            <select
              value={projectId}
              onChange={(e) => {
                setProjectId(
                  e.target.value === "" ? "" : Number(e.target.value),
                );
                resetPagination();
              }}
              style={inputStyle}
            >
              <option value="">All</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
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
            Actor / agent
            <input
              value={actor}
              onChange={(e) => {
                setActor(e.target.value);
                resetPagination();
              }}
              placeholder="e.g. system, default"
              style={inputStyle}
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
            Search
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                resetPagination();
              }}
              placeholder="title / summary / action"
              style={inputStyle}
            />
          </label>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {isPending && pages.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--fg-3)" }}>Loading…</div>
          ) : pages.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
              No events match these filters.
            </div>
          ) : (
            pages.map((row) => (
              <FeedRowCard
                key={row.id}
                row={row}
                projectName={projectName(row.project_id)}
              />
            ))
          )}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {data?.next_cursor ? (
            <button
              type="button"
              onClick={() => {
                if (data.next_cursor) loadMore(data.next_cursor);
              }}
              disabled={isFetching}
              style={{
                padding: "6px 12px",
                borderRadius: 4,
                border: "1px solid var(--line-2)",
                background: "var(--bg-2)",
                color: "var(--fg-0)",
                cursor: isFetching ? "not-allowed" : "pointer",
                fontSize: 12,
              }}
            >
              {isFetching ? "Loading…" : "Load more"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              resetPagination();
              void refetch();
            }}
            style={{
              padding: "6px 12px",
              borderRadius: 4,
              border: "1px solid var(--line-2)",
              background: "transparent",
              color: "var(--fg-2)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Refresh
          </button>
        </div>
      </div>
    </Shell>
  );
}
