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

  const buildOptions = () => ({
    caseSensitive,
    regex: useRegex,
    // Decorate matches: highlight them as the user types.
    decorations: {
      matchBackground: "rgba(59,130,246,0.25)",
      matchBorder: "rgba(59,130,246,0.60)",
      matchOverviewRuler: "#3b82f6",
      activeMatchBackground: "rgba(59,130,246,0.50)",
      activeMatchBorder: "#3b82f6",
      activeMatchColorOverviewRuler: "#3b82f6",
    },
  });

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
      <input
        ref={inputRef}
        className={styles.input}
        type="text"
        value={query}
        onChange={handleQueryChange}
        onKeyDown={handleKeyDown}
        placeholder="Search…"
        spellCheck={false}
        aria-label="Search terminal"
      />
      <span className={styles.counter}>{counterText}</span>
      <button
        type="button"
        className={`${styles.toggleBtn} ${caseSensitive ? styles.toggleBtnActive : ""}`}
        onClick={() => setCaseSensitive((v) => !v)}
        title="Case sensitive"
        aria-pressed={caseSensitive}
      >
        Aa
      </button>
      <button
        type="button"
        className={`${styles.toggleBtn} ${useRegex ? styles.toggleBtnActive : ""}`}
        onClick={() => setUseRegex((v) => !v)}
        title="Regular expression"
        aria-pressed={useRegex}
      >
        .*
      </button>
      <button
        type="button"
        className={styles.navBtn}
        onClick={() => doSearch(query, false)}
        disabled={!query}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
      >
        &#8593;
      </button>
      <button
        type="button"
        className={styles.navBtn}
        onClick={() => doSearch(query, true)}
        disabled={!query}
        title="Next match (Enter)"
        aria-label="Next match"
      >
        &#8595;
      </button>
    </div>
  );
}
