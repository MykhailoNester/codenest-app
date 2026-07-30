// Subsequence fuzzy matcher for the ⌘P find palette. No dependency — the
// index is at most `DEFAULT_MAX_INDEX_FILES` (50,000, `fs_nav.rs:30`) and
// the palette only ever renders the top `limit` results, so a small
// hand-rolled scorer is enough; pulling in a matching library would be a
// dependency for something this contained.
//
// Scoring favours (highest weight first): a contiguous run of matched
// characters, a match starting right after a path-segment boundary
// (`/`, `-`, `_`, `.`), and a match inside the basename rather than the
// directory portion of the path. Case-insensitive unless the query itself
// contains an uppercase character ("smart case", the same convention as
// ripgrep's `--smart-case`).

export interface FuzzyMatch {
  /** Index of the first matched character in `candidate`. */
  index: number;
  score: number;
  /** Half-open `[start, end)` ranges over `candidate`, in order, that
   *  together cover every matched character — used to render the
   *  highlighted substring the prototype shows in `<b>`. */
  ranges: [number, number][];
}

const CONTIGUOUS_BONUS = 8;
const ISOLATED_BONUS = 2;
const SEGMENT_BOUNDARY_BONUS = 5;
const BASENAME_BONUS = 3;
const SEGMENT_BOUNDARY_CHARS = new Set(["/", "-", "_", "."]);

/**
 * Subsequence match `query` against `candidate`. Returns `null` when
 * `query` is not a subsequence of `candidate`. An empty query matches
 * everything with a zero score and no ranges.
 */
export function fuzzyMatch(
  query: string,
  candidate: string,
): FuzzyMatch | null {
  if (query.length === 0) {
    return { index: 0, score: 0, ranges: [] };
  }

  const smartCase = /[A-Z]/.test(query);
  const q = smartCase ? query : query.toLowerCase();
  const c = smartCase ? candidate : candidate.toLowerCase();

  // Greedy leftmost subsequence match. This is not guaranteed to be the
  // globally best-scoring alignment for a pathological candidate, but for
  // filenames — short, few repeated characters — leftmost-greedy already
  // finds the natural, expected alignment (verified by the ranked tests
  // below), and a full alignment search is not worth its cost here.
  const matchedIndices: number[] = [];
  let qi = 0;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c.charAt(ci) === q.charAt(qi)) {
      matchedIndices.push(ci);
      qi++;
    }
  }
  if (qi < q.length) return null;

  const basenameStart = candidate.lastIndexOf("/") + 1;

  let score = 0;
  let prevMatched = -2; // never adjacent to index 0
  for (const ci of matchedIndices) {
    score += ci === prevMatched + 1 ? CONTIGUOUS_BONUS : ISOLATED_BONUS;
    const prevChar = candidate.charAt(ci - 1);
    if (ci === 0 || SEGMENT_BOUNDARY_CHARS.has(prevChar)) {
      score += SEGMENT_BOUNDARY_BONUS;
    }
    if (ci >= basenameStart) {
      score += BASENAME_BONUS;
    }
    prevMatched = ci;
  }

  const ranges: [number, number][] = [];
  let rangeStart = -1;
  let rangeEnd = -1;
  for (const ci of matchedIndices) {
    if (rangeStart === -1) {
      rangeStart = ci;
      rangeEnd = ci + 1;
    } else if (ci === rangeEnd) {
      rangeEnd = ci + 1;
    } else {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = ci;
      rangeEnd = ci + 1;
    }
  }
  if (rangeStart !== -1) ranges.push([rangeStart, rangeEnd]);

  const firstMatch = matchedIndices[0];
  return { index: firstMatch ?? 0, score, ranges };
}

/**
 * Rank `items` by `fuzzyMatch` score (descending), tie-broken by shorter
 * `key(item)` (design decision 12), and return the top `limit`. Items that
 * do not match at all are excluded rather than sorted to the bottom.
 */
export function fuzzyRank<T>(
  query: string,
  items: T[],
  key: (item: T) => string,
  limit: number,
): { item: T; match: FuzzyMatch }[] {
  const scored: { item: T; match: FuzzyMatch }[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, key(item));
    if (match) scored.push({ item, match });
  }
  scored.sort((a, b) => {
    if (b.match.score !== a.match.score) return b.match.score - a.match.score;
    return key(a.item).length - key(b.item).length;
  });
  return scored.slice(0, limit);
}
