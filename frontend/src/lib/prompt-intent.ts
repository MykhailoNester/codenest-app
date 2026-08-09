/**
 * Prompt *syntax* — pure parsing, no React, no fetch, zero imports.
 *
 * Shared by the OmniBar (this branch) and, on `feature/composer-slash-commands`,
 * the agent composer. Keeping this module free of imports and side effects is
 * what lets both branches take the same file without a merge conflict — see
 * the "Merge reconciliation" section of the OmniBar plan for the exact
 * reconciliation steps.
 *
 * `classifyIntent` mirrors `app/services/intent_service.classify`
 * (`app/services/intent_service.py`). The two must stay in lockstep: this
 * module is the client-side preview, the Python function is the server-side
 * (currently unused by the bar, but test-covered independently) mirror. Do
 * not edit `classifyIntent`'s body without updating the Python side too.
 */

export type IntentKind =
  | "command-palette"
  | "slash"
  | "reference"
  | "search"
  | "prompt";

export interface IntentResult {
  kind: IntentKind;
  payload: string;
}

export function classifyIntent(query: string): IntentResult {
  // Mirror app/services/intent_service.classify so the bar can render a live
  // preview without a server round-trip. The backend endpoint is still
  // available for tests / future server-side enrichment.
  const s = query.trim();
  if (!s) return { kind: "command-palette", payload: "" };
  if (s.startsWith("/"))
    return { kind: "slash", payload: s.slice(1).trimStart() };
  if (s.startsWith("@"))
    return { kind: "reference", payload: s.slice(1).trimStart() };
  const hasSpace = s.includes(" ");
  const endsQuestion = s.endsWith("?");
  if (s.length >= 4 && (hasSpace || endsQuestion)) {
    return { kind: "prompt", payload: s };
  }
  return { kind: "search", payload: s };
}

// ─── `@library:<slug>` reference parsing ──────────────────────────────────

export const LIBRARY_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export type LibraryRef =
  | { ok: true; slug: string }
  | { ok: false; reason: "empty" | "invalid"; slug: string };

/**
 * Parses the text *after* the leading `@` (i.e. an `IntentResult.payload`
 * for a `"reference"`-kind result) as a `library:<slug>` reference.
 *
 * Returns `null` when `payload` does not start with `library:`
 * (case-insensitive) — i.e. it is not a library reference at all, so the
 * caller should fall through to its ordinary `@` handling (project/member
 * suggestions).
 */
export function parseLibraryRef(payload: string): LibraryRef | null {
  if (!/^library:/i.test(payload)) return null;
  const rest = payload.slice("library:".length);
  const slug = (rest.split(/\s/, 1)[0] ?? "").toLowerCase();
  if (!slug) return { ok: false, reason: "empty", slug: "" };
  if (!LIBRARY_SLUG_RE.test(slug)) {
    return { ok: false, reason: "invalid", slug };
  }
  return { ok: true, slug };
}
