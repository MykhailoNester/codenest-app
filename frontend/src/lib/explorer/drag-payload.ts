// The workspace navigator's drag payload — contract C2 in the
// workspace-navigator plan, owned by this branch and consumed by
// `feature/agent-pane-composer` (context pills). NEITHER the MIME type NOR
// the payload shape may be renamed; `rg "application/x-codenest-paths"`
// must keep finding exactly this constant, its use here, and this file's
// own round-trip test.
//
// This drag *does* reach Tauri's `onDragDropEvent` for an in-window
// HTML5 drag — with an empty `paths` array, because wry's native drop
// handler only ever reads `NSFilenamesPboardType`, which a same-window
// string-only drag never populates. On macOS the destination-side DOM
// events (`dragenter`/`dragover`/`drop`) never fire at all for such a
// drag — wry's `WryWebView` overrides the whole `NSDraggingDestination`
// protocol and `tauri-runtime-wry`'s handler always returns `true`, so
// WKWebView's own drag processing, and therefore the document's DOM drop
// events, are never reached. The drop is instead resolved from the
// source-side `dragend` (which wry does not intercept) or from that
// same empty-paths native event — see `hooks/use-terminal-file-drop.ts`
// and `lib/explorer/active-path-drag.ts`.

import { beginPathDrag } from "./active-path-drag";

export const CODENEST_PATHS_MIME = "application/x-codenest-paths";

/**
 * Write `paths` (non-empty, absolute, canonical filesystem paths) onto
 * `dt` under the Codenest MIME type as a JSON array, plus a `text/plain`
 * fallback so dropping into any ordinary text field still yields something
 * usable — newline-joined, so a single path is just that path.
 *
 * Also records `paths` as the in-flight path drag (`beginPathDrag`): this is
 * the one function every Codenest path drag source calls, so recording here
 * rather than at each of the three call sites (`explorer-tree.tsx`,
 * `changed-list.tsx`) makes a future fourth source unable to forget it.
 */
export function writePathDragPayload(dt: DataTransfer, paths: string[]): void {
  dt.setData(CODENEST_PATHS_MIME, JSON.stringify(paths));
  dt.setData("text/plain", paths.join("\n"));
  dt.effectAllowed = "copy";
  beginPathDrag(paths);
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
