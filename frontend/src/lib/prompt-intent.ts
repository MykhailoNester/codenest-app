/**
 * Prompt *syntax* — pure string logic, no React, no fetch, zero imports.
 * Shared by the omni-bar and the agent composer, which arrived here from two
 * branches independently; the no-imports rule is what let both take this file
 * without fighting, and it also keeps the module out of any import cycle (the
 * reason `lib/__tests__/module-load-order.test.ts` exists).
 *
 * `composer-commands.ts` owns command *semantics* (the registry, dispatch,
 * argument resolution) and imports from here; this module owns syntax only —
 * "is this text a slash command line", "is this text a library reference",
 * "which sigil menu is the caret inside".
 *
 * `classifyIntent` mirrors `app/services/intent_service.classify`
 * (`app/services/intent_service.py`). The two must stay in lockstep: this
 * module is the client-side preview, the Python function is the server-side
 * (currently unused by the bar, but test-covered independently) mirror. Do
 * not edit `classifyIntent`'s body without updating the Python side too.
 */

// ---------------------------------------------------------------------------
// Omni-Bar Intent Classifier — moved verbatim from `api.ts`.
// ---------------------------------------------------------------------------

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

// The `POST /api/v1/intent/classify` endpoint mirrors `classifyIntent`
// above; it exists for tests and future LLM-backed enrichment but the
// omni-bar uses the client-side mirror for the live preview round-trip
// to stay snappy. Re-add `useClassifyIntent` in `api.ts` here if a caller
// needs it.

// ---------------------------------------------------------------------------
// `@library:<slug>` reference parsing — moved from `omni-bar.tsx`.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Command-line parsing — the single function both the run decision and the
// trigger scanner use, so the two can never drift apart.
// ---------------------------------------------------------------------------

export interface CommandLine {
  /** Index of the `/` — i.e. the count of leading spaces/tabs. */
  start: number;
  /** Text between the `/` and the first space/tab run. May be `""` for a bare `/`. */
  name: string;
  /** Everything after that run, spaces included. `""` when there is none. */
  arg: string;
}

/** The whole draft read as a single-line command line, or null when it is not one.
 *  Newlines are rejected everywhere — a multi-line draft is prose (decision 3). */
export function parseCommandLine(draft: string): CommandLine | null {
  const m = /^([ \t]*)\/(\S*)(?:[ \t]+([^\n]*))?$/.exec(draft);
  if (!m) return null;
  const lead = m[1] ?? "";
  const name = m[2] ?? "";
  const arg = m[3] ?? "";
  return { start: lead.length, name, arg };
}

// ---------------------------------------------------------------------------
// Caret-aware trigger scanner — new. Neither `/` nor `@` menus existed
// before this change, so the omni-bar has no equivalent to lift this from.
// ---------------------------------------------------------------------------

export type PromptTrigger =
  | { kind: "slash"; start: number; query: string }
  | { kind: "mention"; start: number; query: string };

/** Which sigil menu, if any, the caret is currently inside. */
export function detectTrigger(text: string, caret: number): PromptTrigger | null {
  // 1. Mention — caret-local, checked first because it is more specific than
  // the slash rule (draft-global): `/compact @ali` is a mention at the caret.
  let i = caret;
  while (i > 0) {
    const ch = text[i - 1] ?? "";
    if (/\s/.test(ch) || ch === "@") break;
    i -= 1;
  }
  if (i > 0 && text[i - 1] === "@") {
    return { kind: "mention", start: i - 1, query: text.slice(i, caret) };
  }

  // 2. Slash — the caret must be inside the command line `parseCommandLine`
  // recognises, i.e. strictly after the `/`.
  const cl = parseCommandLine(text);
  if (cl !== null && caret > cl.start) {
    return { kind: "slash", start: cl.start, query: text.slice(cl.start + 1, caret) };
  }

  // 3. Neither — including a caret parked at or before the `/` of an
  // otherwise-valid command line (not yet "inside" it).
  return null;
}
