/**
 * The single in-flight record for an in-window Codenest path drag.
 *
 * On macOS, wry's `WryWebView` overrides the whole `NSDraggingDestination`
 * protocol and `tauri-runtime-wry`'s handler always returns `true`, so an
 * in-page HTML5 drag never reaches WKWebView's own drag processing: no
 * `dragenter`/`dragover`/`drop` is ever dispatched to the document for a drag
 * that both starts and ends inside this webview. The DOM `onDrop` handlers in
 * `agent-composer.tsx`, `agent-pane.tsx` and `use-pane-path-drop.ts` are
 * therefore correct but unreachable there — they stay as the path that works
 * on any platform/config that does deliver DOM drop events.
 *
 * wry adds no *source*-side AppKit hook, so WebKit still dispatches
 * `dragstart`/`dragend` to the document for the source half of that same
 * drag. `writePathDragPayload` calls `beginPathDrag` so the paths survive
 * from `dragstart` to whichever of the two triggers in
 * `hooks/use-terminal-file-drop.ts` resolves a drop target first — that
 * source-side `dragend`, or the native `onDragDropEvent` `"drop"` that
 * Tauri delivers for the same in-page drag with `paths: []`.
 *
 * Leaf module, no imports, no DOM, no store — same shape rationale as
 * `lib/composer-focus.ts`.
 *
 * Lifetime contract: **no TTL**, because the record cannot outlive the next
 * `dragstart`. A capture-phase `window` listener in
 * `hooks/use-terminal-file-drop.ts` calls `clearPathDrag()` on every
 * `dragstart`, unconditionally, before that listener's own drag (if any)
 * re-records via `writePathDragPayload`. So a record orphaned by a drag
 * source that unmounted mid-drag (e.g. a Changes-list row re-rendered out
 * from under a `dragend`) is dead the moment any new HTML5 drag begins on
 * this page, and can never be claimed by a drag that did not create it.
 */

let inFlight: string[] | null = null;

/**
 * Records `paths` as the in-flight drag. An empty array clears the record
 * instead of storing it — a malformed drag cannot leave a stale non-empty
 * record behind. Stores a copy, and overwrites any previous record: the
 * platform can only produce one HTML5 drag at a time.
 */
export function beginPathDrag(paths: string[]): void {
  inFlight = paths.length > 0 ? [...paths] : null;
}

/**
 * Returns a copy of the in-flight record without clearing it, or `null` when
 * there is none. Lets a trigger decide whether a drop point is worth
 * resolving before it commits to claiming the record — see `consumePathDrag`.
 */
export function peekPathDrag(): string[] | null {
  return inFlight ? [...inFlight] : null;
}

/**
 * Returns the in-flight record and clears it — the atomic single-use claim.
 * Two triggers racing to resolve the same drag means the second call sees
 * `null`, which is what makes "exactly one insertion per drag" hold no
 * matter which trigger fires first.
 */
export function consumePathDrag(): string[] | null {
  const record = inFlight;
  inFlight = null;
  return record;
}

/** Drops the in-flight record without returning it. */
export function clearPathDrag(): void {
  inFlight = null;
}
