import { useEffect, useRef, useState, type ReactElement } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import styles from "./search-bar.module.css";

interface SearchBarProps {
  searchAddon: SearchAddon | null;
  onClose: () => void;
}

interface MatchCount {
  current: number;
  total: number;
}

/** Deck's dark `--run`, for when the token cannot be computed (jsdom). */
const DEFAULT_RUN = "#6fa3c4";

/** `#6fa3c4` + 0.28 → `rgba(111, 163, 196, 0.28)`. Anything that is not a
 *  six-digit hex is handed back untouched — xterm then parses it itself,
 *  which is the right outcome for an `rgb()`/named colour. */
function alpha(colour: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(colour);
  if (m?.[1] === undefined) return colour;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function SearchBar({
  searchAddon,
  onClose,
}: SearchBarProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [matchCount, setMatchCount] = useState<MatchCount | null>(null);

  // Focus input on mount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const buildOptions = () => {
    // xterm paints decorations on a canvas and parses these strings with its
    // own colour parser, so Deck's `--run` has to be read out as a value and
    // mixed by hand — a `var()` or a `color-mix()` would reach the addon as
    // an unparseable string and the highlight would simply not draw. Read
    // from the live input so the light theme's own value is picked up; the
    // fallback is Deck's dark `--run`, for when there is no layout to compute
    // from (jsdom).
    const run =
      (inputRef.current
        ? getComputedStyle(inputRef.current).getPropertyValue("--run").trim()
        : "") || DEFAULT_RUN;
    return {
      caseSensitive,
      regex: useRegex,
      // Decorate matches: highlight them as the user types.
      decorations: {
        matchBackground: alpha(run, 0.28),
        matchBorder: alpha(run, 0.6),
        matchOverviewRuler: run,
        activeMatchBackground: alpha(run, 0.55),
        activeMatchBorder: run,
        activeMatchColorOverviewRuler: run,
      },
    };
  };

  /**
   * Run a search against the addon. This function only calls addon APIs and
   * never calls setState directly — count updates come via the
   * onDidChangeResults subscription.
   */
  const runSearch = (q: string, forward: boolean) => {
    if (!searchAddon || !q) return;
    const opts = buildOptions();
    if (forward) {
      searchAddon.findNext(q, opts);
    } else {
      searchAddon.findPrevious(q, opts);
    }
  };

  /** UI-level search: also handles the empty-query reset. */
  const doSearch = (q: string, forward: boolean) => {
    if (!q) {
      setMatchCount(null);
      return;
    }
    runSearch(q, forward);
  };

  // Subscribe to addon result-count updates (addon-search 0.16 has onDidChangeResults typed).
  useEffect(() => {
    if (!searchAddon) return;
    const disposable = searchAddon.onDidChangeResults((results) => {
      if (results === undefined) {
        setMatchCount(null);
        return;
      }
      setMatchCount({
        current: results.resultIndex + 1,
        total: results.resultCount,
      });
    });
    return () => {
      disposable.dispose();
    };
  }, [searchAddon]);

  // Re-run search when query or options change.
  // Only calls addon APIs here — count updates come via onDidChangeResults.
  useEffect(() => {
    if (!query) {
      searchAddon?.clearDecorations?.();
      return;
    }
    runSearch(query, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, useRegex, searchAddon]);

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newQuery = e.target.value;
    if (!newQuery) {
      // Clear match count immediately when query is emptied.
      setMatchCount(null);
      searchAddon?.clearDecorations?.();
    }
    setQuery(newQuery);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "Enter") {
      if (e.shiftKey) {
        doSearch(query, false);
      } else {
        doSearch(query, true);
      }
    }
  };

  const counterText = matchCount
    ? `${matchCount.current} of ${matchCount.total}`
    : query
      ? "0 of 0"
      : "";

  return (
    <div className={styles.overlay}>
      <span className={`dk-field ${styles.field}`}>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleQueryChange}
          onKeyDown={handleKeyDown}
          placeholder="Search…"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          aria-label="Search terminal"
        />
      </span>
      <span className={styles.counter}>{counterText}</span>
      <span className="dk-actions">
        <button
          type="button"
          className={`dk-btn bare icon${caseSensitive ? ` ${styles.on}` : ""}`}
          onClick={() => setCaseSensitive((v) => !v)}
          title="Case sensitive"
          aria-pressed={caseSensitive}
        >
          Aa
        </button>
        <button
          type="button"
          className={`dk-btn bare icon${useRegex ? ` ${styles.on}` : ""}`}
          onClick={() => setUseRegex((v) => !v)}
          title="Regular expression"
          aria-pressed={useRegex}
        >
          .*
        </button>
        <button
          type="button"
          className="dk-btn bare icon"
          onClick={() => doSearch(query, false)}
          disabled={!query}
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
        >
          &#8593;
        </button>
        <button
          type="button"
          className="dk-btn bare icon"
          onClick={() => doSearch(query, true)}
          disabled={!query}
          title="Next match (Enter)"
          aria-label="Next match"
        >
          &#8595;
        </button>
      </span>
    </div>
  );
}
