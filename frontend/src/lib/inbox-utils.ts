const URL_RE = /https?:\/\/[^\s)>\]]+/;
const FILE_RE = /^(\/|~\/)[^\s]*/;

export interface SourceResult {
  kind: "url" | "path" | null;
  value: string;
}

export function detectSource(text: string): SourceResult {
  const urlMatch = URL_RE.exec(text);
  if (urlMatch) return { kind: "url", value: urlMatch[0] };
  const fileMatch = FILE_RE.exec(text.trim());
  if (fileMatch) return { kind: "path", value: fileMatch[0] };
  return { kind: null, value: "" };
}

export function detectItemSource(
  source: string | null,
  description: string | null,
): SourceResult {
  if (source) {
    const result = detectSource(source);
    if (result.kind !== null) return result;
    const inDesc = description
      ? detectSource(description)
      : { kind: null as null, value: "" };
    if (inDesc.kind !== null) return inDesc;
    return result;
  }
  if (description) return detectSource(description);
  return { kind: null, value: "" };
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

export function normalizeTitle(title: string): string {
  return title.toLowerCase().trim();
}
