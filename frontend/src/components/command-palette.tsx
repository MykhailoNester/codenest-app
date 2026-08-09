import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  type ReactElement,
} from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { Task, Project, SearchResult, SearchResultType } from "../lib/api";
import { useSearch } from "../lib/api";
import { useDebounce } from "../hooks/use-debounce";
import {
  flattenGrouped,
  groupResults,
  GROUP_LABELS,
  GROUP_ORDER,
  projectRoute,
  routeForResult,
  typeColor,
  typeIcon,
} from "../lib/search-results";
import { Icon } from "./icon";
import styles from "./command-palette.module.css";

// ─── Static fallback types (used when query < 2 chars) ───────────────────────

interface PaletteItem {
  type: "task" | "project" | "member";
  id: number;
  title: string;
  sub: string;
  path: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Safely highlight FTS snippets in dangerouslySetInnerHTML output.
//
// Strategy: HTML-escape the entire string first (so nothing in the raw text
// can become an HTML attribute or tag), then re-introduce only bare <mark>/
// </mark> tags by replacing the escaped forms of the FTS boundary markers.
// This guarantees that the only tags in the output are attributeless <mark>
// elements — no event handlers, no injected attributes are possible.
function sanitizeSnippet(raw: string): string {
  const escaped = raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  // SQLite FTS snippet() wraps matches in literal <mark>…</mark>.  After
  // escaping those become &lt;mark&gt; / &lt;/mark&gt;; re-introduce them as
  // real, attributeless tags.
  return escaped
    .replace(/&lt;mark&gt;/gi, "<mark>")
    .replace(/&lt;\/mark&gt;/gi, "</mark>");
}

// Hover handler debounce window
const HOVER_DEBOUNCE_MS = 30;

// ─── Component ───────────────────────────────────────────────────────────────

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

function PaletteInner({ onClose }: { onClose: () => void }): ReactElement {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastHoverAtRef = useRef(0);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const debouncedQuery = useDebounce(query, 200);
  const { data: searchData, isFetching } = useSearch(debouncedQuery);

  // Focus input on mount
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 16);
    return () => clearTimeout(t);
  }, []);

  // ── Static fallback (query < 2 chars) ────────────────────────────────────

  const fallbackItems = useMemo<PaletteItem[]>(() => {
    const tasks = (qc.getQueryData(["tasks"]) as Task[] | undefined) ?? [];
    const projects =
      (qc.getQueryData(["projects"]) as Project[] | undefined) ?? [];
    return [
      ...tasks.map((t) => ({
        type: "task" as const,
        id: t.id,
        title: t.title,
        sub: t.project_name ?? t.status,
        path: `/tasks/${t.id}`,
      })),
      ...projects.map((p) => ({
        type: "project" as const,
        id: p.id,
        title: p.name,
        sub: p.tech_stack ?? p.description ?? "",
        path: projectRoute(p.id),
      })),
    ].slice(0, 9);
  }, [qc]);

  // ── Grouped backend results ───────────────────────────────────────────────

  const grouped = useMemo<Record<SearchResultType, SearchResult[]>>(
    () => groupResults(searchData?.results),
    [searchData],
  );

  const flatResults = useMemo<SearchResult[]>(
    () => flattenGrouped(grouped),
    [grouped],
  );

  // ── Common flat list for keyboard nav ────────────────────────────────────

  const isBackend = debouncedQuery.trim().length >= 2;
  const flatCount = isBackend ? flatResults.length : fallbackItems.length;
  const clampedIdx = Math.min(selectedIdx, Math.max(0, flatCount - 1));

  const handleRowMouseEnter = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      const now = performance.now();
      if (now - lastHoverAtRef.current < HOVER_DEBOUNCE_MS) return;
      lastHoverAtRef.current = now;
      const raw = e.currentTarget.dataset.rowIdx;
      if (raw === undefined) return;
      const idx = Number(raw);
      if (Number.isFinite(idx)) setSelectedIdx(idx);
    },
    [],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, flatCount - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        if (isBackend) {
          const item = flatResults[clampedIdx];
          if (item) {
            void navigate(routeForResult(item));
            onClose();
          }
        } else {
          const item = fallbackItems[clampedIdx];
          if (item) {
            void navigate(item.path);
            onClose();
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    flatResults,
    fallbackItems,
    clampedIdx,
    isBackend,
    flatCount,
    navigate,
    onClose,
  ]);

  // ── Row renderers ─────────────────────────────────────────────────────────

  function renderFallbackItem(item: PaletteItem, i: number): ReactElement {
    const selected = i === clampedIdx;
    return (
      <button
        key={`${item.type}-${item.id}`}
        role="option"
        aria-selected={selected}
        type="button"
        data-row-idx={i}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          width: "100%",
          padding: "9px 16px",
          background: selected ? "rgba(59,130,246,0.10)" : "transparent",
          border: "none",
          borderLeft: selected
            ? "2px solid var(--accent)"
            : "2px solid transparent",
          color: "var(--fg-1)",
          textAlign: "left",
          cursor: "pointer",
        }}
        onMouseEnter={handleRowMouseEnter}
        onClick={() => {
          void navigate(item.path);
          onClose();
        }}
      >
        <span
          style={{
            display: "grid",
            placeItems: "center",
            width: 26,
            height: 26,
            borderRadius: 6,
            background: typeColor(item.type) + "22",
            color: typeColor(item.type),
            flex: "0 0 26px",
          }}
        >
          <Icon name={typeIcon(item.type)} size={12} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontSize: "13px",
              fontWeight: 500,
              color: "var(--fg-0)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.title}
          </span>
          {item.sub && (
            <span
              style={{
                display: "block",
                fontSize: "11px",
                color: "var(--fg-3)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontFamily: "var(--font-mono)",
              }}
            >
              {item.sub}
            </span>
          )}
        </span>
        <span
          style={{
            fontSize: "10px",
            color: typeColor(item.type),
            background: typeColor(item.type) + "18",
            padding: "1px 6px",
            borderRadius: 3,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          {item.type}
        </span>
      </button>
    );
  }

  function renderSearchResult(
    result: SearchResult,
    flatIdx: number,
  ): ReactElement {
    const selected = flatIdx === clampedIdx;
    const color = typeColor(result.type);
    return (
      <button
        key={`${result.type}-${result.id}`}
        role="option"
        aria-selected={selected}
        type="button"
        data-row-idx={flatIdx}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          width: "100%",
          padding: "9px 16px",
          background: selected ? "rgba(59,130,246,0.10)" : "transparent",
          border: "none",
          borderLeft: selected
            ? "2px solid var(--accent)"
            : "2px solid transparent",
          color: "var(--fg-1)",
          textAlign: "left",
          cursor: "pointer",
        }}
        onMouseEnter={handleRowMouseEnter}
        onClick={() => {
          void navigate(routeForResult(result));
          onClose();
        }}
      >
        <span
          style={{
            display: "grid",
            placeItems: "center",
            width: 26,
            height: 26,
            borderRadius: 6,
            background: color + "22",
            color,
            flex: "0 0 26px",
          }}
        >
          <Icon name={typeIcon(result.type)} size={12} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontSize: "13px",
              fontWeight: 500,
              color: "var(--fg-0)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {result.title}
          </span>
          {result.snippet && (
            <span
              className={styles.snippet}
              style={{
                display: "block",
                fontSize: "11px",
                color: "var(--fg-3)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontFamily: "var(--font-mono)",
              }}
              dangerouslySetInnerHTML={{
                __html: sanitizeSnippet(result.snippet),
              }}
            />
          )}
        </span>
        <span
          style={{
            fontSize: "10px",
            color,
            background: color + "18",
            padding: "1px 6px",
            borderRadius: 3,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          {result.type}
        </span>
      </button>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────

  let flatIndex = 0;

  function renderBackendResults(): ReactElement {
    if (isFetching && !searchData) {
      return (
        <div
          style={{
            padding: "24px 16px",
            textAlign: "center",
            color: "var(--fg-4)",
            fontSize: "13px",
          }}
        >
          Searching…
        </div>
      );
    }

    const hasResults = flatResults.length > 0;
    if (!hasResults) {
      return (
        <div
          style={{
            padding: "24px 16px",
            textAlign: "center",
            color: "var(--fg-4)",
            fontSize: "13px",
          }}
        >
          No results
        </div>
      );
    }

    return (
      <>
        {GROUP_ORDER.map((type) => {
          const items = grouped[type];
          if (!items.length) return null;
          return (
            <div key={type}>
              <div
                role="separator"
                style={{
                  padding: "4px 16px",
                  fontSize: "10px",
                  fontFamily: "var(--font-mono)",
                  color: "var(--fg-4)",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  background: "rgba(255,255,255,0.02)",
                  borderBottom: "1px solid var(--line-1)",
                }}
              >
                {GROUP_LABELS[type]}
              </div>
              {items.map((result) => {
                const row = renderSearchResult(result, flatIndex);
                flatIndex++;
                return row;
              })}
            </div>
          );
        })}
      </>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "15vh",
        zIndex: 200,
        backdropFilter: "blur(4px)",
      }}
      onClick={onClose}
      role="presentation"
    >
      <div
        style={{
          background: "var(--bg-2)",
          border: "1px solid var(--line-3)",
          borderRadius: 14,
          width: "min(600px, 90vw)",
          boxShadow: "var(--shadow-3)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
        aria-modal="true"
      >
        {/* Search input row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 16px",
            borderBottom: "1px solid var(--line-2)",
          }}
        >
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIdx(0);
            }}
            placeholder="Search everything — tasks, docs, sessions…"
            aria-label="Command palette search"
            style={{
              flex: 1,
              background: "none",
              border: "none",
              outline: "none",
              color: "var(--fg-0)",
              fontSize: "14px",
              fontFamily: "var(--font-sans)",
            }}
          />
          <kbd
            style={{
              fontFamily: "var(--font-mono)",
              background: "rgba(255,255,255,0.06)",
              border: "1px solid var(--line-2)",
              padding: "2px 6px",
              borderRadius: 4,
              fontSize: "10.5px",
              color: "var(--fg-2)",
            }}
          >
            esc
          </kbd>
        </div>

        {/* Results */}
        <div
          role="listbox"
          aria-label="Search results"
          style={{ maxHeight: "min(360px, 55vh)", overflowY: "auto" }}
        >
          {isBackend ? (
            renderBackendResults()
          ) : fallbackItems.length === 0 ? (
            <div
              style={{
                padding: "24px 16px",
                textAlign: "center",
                color: "var(--fg-4)",
                fontSize: "13px",
              }}
            >
              No results
            </div>
          ) : (
            fallbackItems.map((item, i) => renderFallbackItem(item, i))
          )}
        </div>

        {/* Footer hints */}
        <div
          style={{
            display: "flex",
            gap: 16,
            padding: "8px 16px",
            borderTop: "1px solid var(--line-1)",
            color: "var(--fg-4)",
            fontSize: "10.5px",
            fontFamily: "var(--font-mono)",
          }}
        >
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}

export function CommandPalette({
  open,
  onClose,
}: CommandPaletteProps): ReactElement | null {
  if (!open) return null;
  return <PaletteInner key="palette" onClose={onClose} />;
}
