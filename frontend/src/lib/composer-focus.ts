/**
 * The single restore sequence for a programmatic write to an agent composer's
 * draft: `focus()` -> `setSelectionRange(caret, caret)` -> re-measure the
 * auto-grow height, deferred to a `requestAnimationFrame`.
 *
 * Every draft mutator that is not the textarea's own `onChange` — `recall`,
 * an OS file drop, an in-editor file drop, or any future store writer that
 * inserts text — leaves focus, the caret and the auto-grow box exactly where
 * they were before the write: the DOM does not know the store changed under
 * it. Before this module existed, that sequence was inlined once (the
 * in-editor drop, formerly `agent-composer.tsx:661-683`) and every other
 * writer skipped it entirely, which is the reported "cursor position is
 * broken, cannot add new text at the end" bug. `AgentComposer` also wires a
 * `useEffect` over its draft (see `agent-composer.tsx`) that calls
 * `focusComposerAt` by default whenever the draft changes for a reason other
 * than local typing, so a future writer gets this restore for free instead of
 * having to remember to call it.
 *
 * The frame is required, not decorative: the store's `set` and the DOM are
 * two different clocks. A `setState` schedules a React render; the textarea's
 * `value` (and therefore `el.value.length`, what "end of text" means) is
 * still the *old* string until that render commits. Reading it one frame
 * later is what makes "default to end-of-text" correct instead of racy.
 *
 * `findComposerEditor` resolves a pane's textarea from outside React via a
 * `data-*` attribute rather than a mount/unmount ref registry, following the
 * precedent already in this codebase: `paneAtCssPoint`
 * (`hooks/use-terminal-file-drop.ts:129-138`) hit-tests `data-terminal-id` /
 * `data-agent-pane-id` the same way. This is the first production
 * `document.querySelectorAll` in `frontend/src`, and it is deliberate, not
 * drift — an attribute the DOM already maintains costs nothing to look up and
 * needs no lifecycle wiring.
 *
 * This module imports nothing from `stores/` or `lib/api`/`lib/ipc`: it is a
 * DOM-only leaf so it cannot add an edge to the module graph that could form
 * an import cycle.
 */

/** Mirrors `.editorTextarea { max-height: 240px }`
 * (`agent-composer.module.css:207`) — the auto-grow clamp. Kept as a literal
 * here (moved from `agent-composer.tsx`) rather than read from CSS; the two
 * must be kept in sync by hand. */
export const COMPOSER_EDITOR_MAX_HEIGHT_PX = 240;

/** The attribute `AgentComposer` stamps on its own textarea, distinct from
 * the valueless `data-agent-composer` presence guard two `closest()` calls
 * already depend on (`use-terminal-shortcuts.ts`, `agent-permission-dialog.tsx`).
 * Kept as its own attribute rather than a value on that guard so neither
 * existing `closest("[data-agent-composer]")` call can silently start
 * matching only one of the two elements that carry the guard today. */
export const COMPOSER_PANE_ATTR = "data-composer-pane-id";

/** Finds the mounted `AgentComposer` textarea for `paneId`, or `null` if none
 * is mounted (pane closed, detached window, or a stale/unknown id). */
export function findComposerEditor(paneId: string): HTMLTextAreaElement | null {
  const editors = document.querySelectorAll<HTMLTextAreaElement>(
    `textarea[${COMPOSER_PANE_ATTR}]`,
  );
  for (const el of editors) {
    if (el.dataset.composerPaneId === paneId) return el;
  }
  return null;
}

/** The auto-grow measurement: collapse to content height, then reveal, so a
 * shrink is reflected and not just a growth. Shared by every write path — the
 * user's own typing does this synchronously, and a programmatic write does it
 * inside the frame below. */
export function resizeComposerEditor(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, COMPOSER_EDITOR_MAX_HEIGHT_PX)}px`;
}

/** One pending request per pane: an explicit caret set by a call that knows
 * one, `undefined` for "default to end-of-text once the frame runs". Cleared
 * before the frame body can return early, so a pane whose composer has
 * unmounted between the request and the frame cannot leave a stale entry
 * that mutes every later request for that pane (see the no-op branch below). */
const pending = new Map<string, number | undefined>();

/**
 * Request the reference restore sequence for `paneId`'s composer editor:
 * `focus()` -> `setSelectionRange(caret, caret)` -> `resizeComposerEditor()`,
 * deferred to the next animation frame so the DOM has caught up with
 * whatever store write triggered the call.
 *
 * `caret` is a character offset into the draft. Omit it to place the caret at
 * end-of-text (the default `recall` and an OS/pane drop want) rather than a
 * specific offset (what an in-editor drop wants — just past the insertion).
 *
 * Requests for the same pane within one frame coalesce into a single
 * `requestAnimationFrame` call, and an explicit caret always wins over an
 * already-queued default (`??`, not `||`, so an explicit `0` is preserved).
 * Fire-and-forget: never throws, and no-ops quietly if no composer is mounted
 * for `paneId` by the time the frame runs.
 */
export function focusComposerAt(paneId: string, caret?: number): void {
  const scheduled = pending.has(paneId);
  pending.set(paneId, caret ?? pending.get(paneId));
  if (scheduled) return;

  requestAnimationFrame(() => {
    const requested = pending.get(paneId);
    // Cleared before any early return below, so a request for a pane whose
    // composer is (still, or again) unmounted does not permanently mute
    // future requests for that same pane id.
    pending.delete(paneId);

    const el = findComposerEditor(paneId);
    if (!el) return;

    // Read inside the frame, after the DOM has caught up, so this is the
    // post-write length — the whole reason "default to end-of-text" is
    // correct here rather than racy.
    const at =
      requested === undefined
        ? el.value.length
        : Math.max(0, Math.min(requested, el.value.length));

    el.focus();
    el.setSelectionRange(at, at);
    resizeComposerEditor(el);
  });
}
