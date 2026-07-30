// The workspace navigator's drag payload — contract C2 in the
// workspace-navigator plan, owned by this branch and consumed by
// `feature/agent-pane-composer` (context pills). NEITHER the MIME type NOR
// the payload shape may be renamed; `rg "application/x-codenest-paths"`
// must keep finding exactly this constant, its use here, and this file's
// own round-trip test.
//
// This is a same-window HTML5 drag: it never reaches Tauri's
// `onDragDropEvent` (that path stays exactly as it is for OS/Finder drops —
// see `hooks/use-terminal-file-drop.ts`), so it needs its own MIME type and
// its own read/write helpers.

export const CODENEST_PATHS_MIME = "application/x-codenest-paths";

/**
 * Write `paths` (non-empty, absolute, canonical filesystem paths) onto
 * `dt` under the Codenest MIME type as a JSON array, plus a `text/plain`
 * fallback so dropping into any ordinary text field still yields something
 * usable — newline-joined, so a single path is just that path.
 */
export function writePathDragPayload(dt: DataTransfer, paths: string[]): void {
  dt.setData(CODENEST_PATHS_MIME, JSON.stringify(paths));
  dt.setData("text/plain", paths.join("\n"));
  dt.effectAllowed = "copy";
}

/**
 * Read back a Codenest paths payload from `dt`. Returns `null` — never
 * throws — when the custom type is absent, its JSON does not parse, or it
 * parses to something that is not an array of non-empty strings; any of
 * those means "this is not a Codenest path drag", not "this drag is
 * broken", so the caller should fall through to `text/plain`.
 */
export function readPathDragPayload(dt: DataTransfer): string[] | null {
  const raw = dt.getData(CODENEST_PATHS_MIME);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((p): p is string => typeof p === "string" && p.length > 0)
  ) {
    return null;
  }
  return parsed;
}
