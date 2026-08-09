/**
 * useTerminalFileDrop
 *
 * Subscribes to Tauri's native file-drop event for the current webview and
 * inserts any dropped file paths into the pane under the cursor — a
 * bracketed paste for a shell pane, an append into the composer draft for an
 * agent pane (see `dispatchPathsToPane`).
 *
 * # Two drop worlds
 * There are two independent ways a path can be dropped on a pane, and this
 * hook is the landing site for both:
 *
 * 1. **A real OS drop** — Finder/Desktop, or the screenshot ring's drag-out
 *    (`components/screenshot/drag-thumbnail.tsx`). Tauri's
 *    `onDragDropEvent` fires with a non-empty `paths` array and a physical
 *    drop position that has to be converted to a CSS point and hit-tested
 *    (`nativeDropPointCandidates`, `paneAtCssPoint`).
 * 2. **An in-window Codenest path drag** — a row dragged out of the
 *    workspace navigator tree or the Changes list
 *    (`lib/explorer/drag-payload.ts`) and dropped on a pane in the same
 *    document. On macOS this is a real AppKit dragging session whose
 *    destination is the same WKWebView, and wry's `WryWebView` overrides
 *    the whole `NSDraggingDestination` protocol — `tauri-runtime-wry`'s
 *    handler always returns `true`, so WKWebView's own drag processing (and
 *    therefore the document's `dragenter`/`dragover`/`drop`) is never
 *    reached. The DOM drop handlers in `agent-composer.tsx`, `agent-pane.tsx`
 *    and `use-pane-path-drop.ts` are correct but unreachable there; they
 *    stay as the path that works on a platform/config that does deliver DOM
 *    drop events.
 *
 *    wry adds no *source*-side AppKit hook, though, so WebKit still
 *    dispatches `dragstart`/`dragend` to the document for the source half of
 *    that same drag, and `collect_paths` (wry's native handler) still reads
 *    `NSFilenamesPboardType`, which an in-page string-only drag never
 *    populates — so the *same* drag also reaches `onDragDropEvent` here, as
 *    a `"drop"` with `paths: []`. Two independent triggers resolve it,
 *    either of which alone completes the drop:
 *      - the drag source's `dragend` (primary — carries CSS client
 *        coordinates directly, no coordinate math);
 *      - that native empty-paths `"drop"` (fallback — used when `dragend`
 *        cannot resolve a target).
 *    Both read `lib/explorer/active-path-drag.ts`'s single-use record via
 *    "peek, resolve, claim": a trigger peeks the record, hit-tests a point,
 *    and only calls `consumePathDrag()` once it has actually resolved a
 *    pane. A trigger that cannot resolve a target leaves the record intact
 *    for the other trigger, and whichever claims it first is the one that
 *    inserts — the record's single-use `consumePathDrag()` is what makes
 *    exactly one insertion happen no matter which trigger wins the race.
 *    Two capture-phase `window` listeners bound the record's lifetime
 *    (`dragstart` and `drop`, both `clearPathDrag()`) — see their own
 *    comments below for why.
 *
 * # Why bracketed paste (shell panes)
 * Claude Code (v2.1.0+) detects a dropped/pasted image path only when it
 * arrives as a bracketed-paste sequence, not as character-by-character typed
 * input.  Its path-image handler fires on the `paste-start` / `paste-end`
 * key-name pair (verified in the claude binary: `case "[200~": key.name =
 * "paste-start"`) and reads the file when the pasted text matches
 * `/\.(png|jpe?g|gif|webp)$/i`.  The regex is end-anchored, so the path must
 * NOT be followed by a trailing newline, space, or any other character.
 *
 * Bracketed-paste sequences also work correctly in bash/zsh: both shells treat
 * ESC[200~ ... ESC[201~ as a paste bracket and insert the text verbatim.
 *
 * # Multi-file drops
 * Each dropped path gets its own independent bracketed-paste sequence,
 * concatenated back-to-back with NO separator.  A bare \r between sequences
 * would submit the first path in most shells and could interrupt Claude Code's
 * input handling.  The independent wrapping keeps each path end-anchored for
 * Claude's image regex.
 *
 * # Paste-escape injection defence
 * File names containing ESC[200~ or ESC[201~ could prematurely close the
 * bracketed-paste window and let subsequent bytes run as live input.  We strip
 * both markers from the path before wrapping.
 *
 * # Position -> pane mapping (real OS drops)
 * Tauri's reported drop position could be either true physical pixels
 * (requiring `/scaleFactor` and a titlebar-height correction) or CSS pixels
 * already relative to the webview (requiring neither) — the two claims
 * cannot both be true, and this cannot be settled by reading TypeScript, so
 * `nativeDropPointCandidates` builds both readings, prunes whichever falls
 * outside the viewport, and the caller hit-tests them in order and takes the
 * first that lands on a pane. `document.elementFromPoint(cssX, cssY)` finds
 * the element at a candidate; `paneAtCssPoint` walks up the DOM looking for
 * `data-terminal-id` (`TerminalPane`) or `data-agent-pane-id` (`AgentPane`,
 * which has no PTY and so stamps its own attribute).
 *
 * # Scope
 * Handles any dropped file path -- not restricted to screenshots.  This is the
 * expected terminal behavior and naturally covers our screenshot drag-out case.
 *
 * # File lifecycle
 * The hook does NOT delete the temp file after insertion.  The 10-minute
 * age-sweep in the Rust capture command handles cleanup; deleting immediately
 * would race with Claude Code reading the file asynchronously after paste.
 *
 * # Usage
 * Call once at the TerminalsLayout level -- covers OS drops (and the in-app
 * drag triggers) for both the embedded terminal page and the detached
 * terminals window without modifying terminal-pane.tsx beyond the single
 * data-terminal-id stamp. `pastePathsIntoTerminal` below is the same wrap +
 * paste, exported so the in-window workspace-navigator drag
 * (`use-pane-path-drop.ts`) can reuse it instead of duplicating the
 * bracketed-paste + marker-strip logic.
 *
 * # Diagnostics
 * Every branch below logs through `logDnd` (`lib/drop-diagnostics.ts`), a
 * no-op outside a dev build with `localStorage["codenest.dndDebug"] === "1"`.
 * Neither of the two drag sources above can be exercised by an automated
 * test in this environment, so this is the channel for a hand-check to
 * report which trigger resolved a drop, and with what coordinates.
 */

import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { findLeaf, paneKind, type PaneLeaf } from "../lib/layout-tree";
import { sendTerminalInput } from "../lib/ipc";
import { useTerminalStore } from "../stores/terminal-store";
import { useComposerStore } from "../stores/composer-store";
import { focusComposerAt } from "../lib/composer-focus";
import {
  clearPathDrag,
  consumePathDrag,
  peekPathDrag,
} from "../lib/explorer/active-path-drag";
import { logDnd } from "../lib/drop-diagnostics";

// Bracketed-paste markers (ANSI/XTerm bracketed paste mode).
const BP_START = "\x1b[200~";
const BP_END = "\x1b[201~";

// Regex matching either bracketed-paste marker.  The ESC byte is inserted at
// runtime via String.fromCharCode(27) so neither a regex literal nor a
// RegExp(string) with an embedded control character is written in source —
// both forms trigger ESLint's no-control-regex rule.
const ESC = String.fromCharCode(27);
const BP_MARKER_RE = new RegExp(`${ESC}\\[20[01]~`, "g");

/**
 * Wrap `path` in bracketed-paste markers so terminals (and Claude Code) treat
 * it as a paste event rather than typed input.
 *
 * Strips embedded paste markers first to prevent a malicious filename from
 * prematurely closing the paste bracket and running subsequent bytes as live
 * terminal input.
 *
 * No trailing newline -- Claude Code's path regex is end-anchored and any
 * trailing character would break the match.
 */
export function bracketedPaste(path: string): string {
  const safe = path.replace(BP_MARKER_RE, "");
  return `${BP_START}${safe}${BP_END}`;
}

/** A pane hit-tested at a CSS point, tagged with which kind of root stamped it. */
interface HitPane {
  id: string;
  kind: "shell" | "agent";
}

/**
 * Paste absolute paths into `terminalId` as independent bracketed-paste
 * sequences with no separator. Shared by the Tauri OS-drop listener below
 * and the in-window HTML5 drop from the workspace navigator
 * (`hooks/use-pane-path-drop.ts`), so the marker-strip defence and the
 * no-separator rule have exactly one implementation.
 */
export function pastePathsIntoTerminal(
  terminalId: string,
  paths: string[],
): void {
  // Each path gets its own bracketed-paste sequence, concatenated with NO
  // separator.  A bare \r between sequences would submit/execute the first
  // path in most shells and could interrupt Claude Code.
  const input = paths.map(bracketedPaste).join("");
  void sendTerminalInput(terminalId, input).catch((err) => {
    console.error("useTerminalFileDrop: sendTerminalInput failed:", err);
  });
}

/**
 * Given a point in CSS pixels, find the pane under that point.
 *
 * `TerminalPane` stamps `data-terminal-id={terminalId}` on its root div;
 * `AgentPane` stamps `data-agent-pane-id={leafId}` on its own (it has no PTY,
 * so it deliberately does not share the `data-terminal-id` attribute — see
 * `agent-pane.tsx`). We walk up from the hit element until we find one or
 * exhaust the tree.
 */
function paneAtCssPoint(cssX: number, cssY: number): HitPane | null {
  let el = document.elementFromPoint(cssX, cssY);
  while (el && el !== document.documentElement) {
    const dataset = (el as HTMLElement).dataset;
    if (dataset.terminalId) return { id: dataset.terminalId, kind: "shell" };
    if (dataset.agentPaneId) return { id: dataset.agentPaneId, kind: "agent" };
    el = el.parentElement;
  }
  return null;
}

/**
 * Delivers `paths` to an already-resolved pane: an agent pane gets them
 * appended into its composer draft (there is no PTY to paste bytes into), a
 * shell pane gets the existing bracketed-paste behaviour. Shared by every
 * trigger in this hook — the real OS drop, the in-app `dragend` trigger and
 * the in-app native-empty-paths fallback — so the agent/shell branch has
 * exactly one implementation regardless of which trigger resolved the pane.
 */
function dispatchPathsToPane(target: HitPane, paths: string[]): void {
  if (target.kind === "agent") {
    // `insertPathsIntoDraft` with no caret appends and returns end-of-text —
    // the same default `focusComposerAt` falls back to when called with no
    // caret, so this explicit request and the composer's own external-draft
    // effect agree and coalesce into one frame; no suppression is needed
    // here (unlike the in-editor drop in `agent-composer.tsx`, which
    // requests a specific mid-draft caret the effect cannot know).
    const caret = useComposerStore.getState().insertPathsIntoDraft(target.id, paths);
    // Store-level pane focus (which pane is "current") is distinct from the
    // DOM caret/focus restore below: this makes the pane the one the user is
    // typing into, `focusComposerAt` is what actually focuses its textarea
    // and places the caret.
    useTerminalStore.getState().setFocusedLeaf(target.id);
    focusComposerAt(target.id, caret);
    return;
  }
  pastePathsIntoTerminal(target.id, paths);
}

/**
 * Builds the candidate CSS points a reported native drop `position` could
 * mean, pruned to the ones that are actually inside this webview's viewport.
 *
 * The reported position's units are not knowable by reading TypeScript
 * alone: it could be true physical pixels relative to the webview (needing
 * `/scaleFactor` and a titlebar-height correction), or it could already be
 * CSS pixels relative to the webview (needing neither). Both readings are
 * therefore tried, source-verified reading first:
 *   1. `position` as reported, unmodified.
 *   2. `position` divided by `scaleFactor`, with `titlebarHeightCss`
 *      subtracted from `y`.
 * The second is dropped when it is identical to the first (a scale-1 window
 * with no titlebar correction — the common case on a non-Retina display with
 * decorations:false), and either candidate is dropped when it falls outside
 * `[0, viewport.width] x [0, viewport.height]`: a point that lands nowhere
 * in this webview cannot be the right reading, so it is removed before
 * hit-testing rather than risk hitting some unrelated pane. May return an
 * empty array (both readings out of viewport).
 */
export function nativeDropPointCandidates(
  position: { x: number; y: number },
  scaleFactor: number,
  titlebarHeightCss: number,
  viewport: { width: number; height: number },
): Array<{ x: number; y: number }> {
  const reported = { x: position.x, y: position.y };
  const converted = {
    x: position.x / scaleFactor,
    y: position.y / scaleFactor - titlebarHeightCss,
  };
  const candidates =
    converted.x === reported.x && converted.y === reported.y
      ? [reported]
      : [reported, converted];
  const inViewport = (p: { x: number; y: number }): boolean =>
    p.x >= 0 && p.x <= viewport.width && p.y >= 0 && p.y <= viewport.height;
  return candidates.filter(inViewport);
}

export function useTerminalFileDrop(): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    /**
     * Capture phase, ahead of React 19's root-container `onDragStart`
     * delegation (bubble phase — `react`/`react-dom` `^19.2.8`). Clears any
     * record left by a drag whose source node unmounted before its
     * `dragend` reached `window` (e.g. a Changes-list row re-rendered out
     * from under the drag by a git poll): the very next HTML5 drag of any
     * kind — including a genuine new Codenest path drag, which immediately
     * re-records via `writePathDragPayload` in the same dispatch — clears
     * the stale record before it can be claimed by a drag that never wrote
     * it. Bubble phase here would run *after* `writePathDragPayload`'s own
     * `dragstart` handler and would erase the record it had just written.
     */
    function onWindowDragStart(): void {
      clearPathDrag();
    }

    /**
     * Capture phase. If a platform or config ever does deliver DOM drop
     * events for an in-page drag, this clears the record before any target
     * handler runs (and before any `stopPropagation`), and a DOM `drop`
     * always precedes `dragend` — so exactly one of "the DOM handler" and
     * "the two triggers below" ever inserts, never both.
     */
    function onWindowDrop(): void {
      clearPathDrag();
    }

    /**
     * The in-app drag's primary trigger. Source-side, so wry's destination
     * override does not apply to it and it fires. Peeks the record first —
     * a trigger may not consume until it has actually resolved a pane, so a
     * `dragend` that lands over nothing leaves the record for the native
     * empty-paths fallback below instead of destroying it.
     */
    function onWindowDragEnd(e: DragEvent): void {
      const pending = peekPathDrag();
      if (!pending) return;
      const target = paneAtCssPoint(e.clientX, e.clientY);
      logDnd("dragend", {
        pathCount: pending.length,
        clientX: e.clientX,
        clientY: e.clientY,
        dropEffect: e.dataTransfer?.dropEffect,
        target,
      });
      if (!target) return; // leave the record for the native empty-paths drop
      const claimed = consumePathDrag();
      if (!claimed) return; // the native empty-paths drop already claimed it
      dispatchPathsToPane(target, claimed);
    }

    window.addEventListener("dragstart", onWindowDragStart, true);
    window.addEventListener("drop", onWindowDrop, true);
    window.addEventListener("dragend", onWindowDragEnd);

    void getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") {
          logDnd(`native.${event.payload.type}`, {
            position: "position" in event.payload ? event.payload.position : undefined,
          });
          return;
        }

        const { paths, position } = event.payload;

        if (paths.length === 0) {
          // The in-app drag's fallback trigger: this same in-page drag
          // reaches Tauri with no filenames (see the module header). Peek —
          // not claim — before the scale-factor round trip: a plain
          // text-selection drag with no record in flight costs nothing more
          // than this check, and the `await` below cannot itself lose the
          // record to a `dragend` that resolves first, because the claim
          // happens only after a pane is actually resolved.
          const pending = peekPathDrag();
          if (!pending) {
            logDnd("native.drop.empty", { position });
            return;
          }

          const scaleFactor = await getCurrentWindow()
            .scaleFactor()
            .catch(() => window.devicePixelRatio || 1);
          const titlebarHeightCss = window.outerHeight - window.innerHeight;
          const candidates = nativeDropPointCandidates(position, scaleFactor, titlebarHeightCss, {
            width: window.innerWidth,
            height: window.innerHeight,
          });

          let target: HitPane | null = null;
          let hitIndex = -1;
          for (let i = 0; i < candidates.length; i += 1) {
            const candidate = candidates[i];
            if (!candidate) continue;
            const hit = paneAtCssPoint(candidate.x, candidate.y);
            if (hit) {
              target = hit;
              hitIndex = i;
              break;
            }
          }

          if (!target) {
            logDnd("native.drop.inapp.miss", {
              pathCount: pending.length,
              position,
              scaleFactor,
              candidates,
            });
            return; // leave the record for `dragend`
          }
          const claimed = consumePathDrag();
          if (!claimed) return; // `dragend` already handled it
          logDnd("native.drop.inapp", { pathCount: claimed.length, hitIndex, target });
          dispatchPathsToPane(target, claimed);
          return;
        }

        // A real OS drop: Finder/Desktop, or the screenshot ring's drag-out.
        // Fetch the window's actual scale factor for the current monitor.
        // More reliable than window.devicePixelRatio for setups where windows
        // span monitors with different scale factors.
        const scaleFactor = await getCurrentWindow()
          .scaleFactor()
          .catch(() => window.devicePixelRatio || 1);
        const titlebarHeightCss = window.outerHeight - window.innerHeight;
        const candidates = nativeDropPointCandidates(position, scaleFactor, titlebarHeightCss, {
          width: window.innerWidth,
          height: window.innerHeight,
        });

        let target: HitPane | null = null;
        let hitIndex = -1;
        for (let i = 0; i < candidates.length; i += 1) {
          const candidate = candidates[i];
          if (!candidate) continue;
          const hit = paneAtCssPoint(candidate.x, candidate.y);
          if (hit) {
            target = hit;
            hitIndex = i;
            break;
          }
        }

        // Fallback: no candidate point landed on a pane (e.g. dropped on the
        // tab bar, or both coordinate readings missed) — use the focused
        // leaf. Read from the store directly to avoid stale-closure issues
        // without re-subscribing. Unlike the in-app triggers above, a real OS
        // drop has no other way to ever resolve, which is why it alone gets
        // this fallback — and it now accepts an agent leaf as well as a
        // shell leaf: an agent leaf has no PTY, but the agent branch below
        // writes into its draft instead of pasting bytes, so there is no
        // longer a reason to refuse it.
        if (!target) {
          const { tabs, focusedLeafId } = useTerminalStore.getState();
          if (focusedLeafId) {
            const leaf: PaneLeaf | undefined = tabs
              .map((tab) => findLeaf(tab.layout, focusedLeafId))
              .find((l): l is PaneLeaf => l !== null);
            if (leaf) {
              target = {
                id: focusedLeafId,
                kind: paneKind(leaf) === "agent" ? "agent" : "shell",
              };
            }
          }
        }

        logDnd("native.drop", {
          pathCount: paths.length,
          position,
          scaleFactor,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          outerHeight: window.outerHeight,
          devicePixelRatio: window.devicePixelRatio,
          candidates,
          hitIndex,
          target,
        });

        if (!target) return;

        dispatchPathsToPane(target, paths);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        console.error("useTerminalFileDrop: onDragDropEvent failed:", err);
      });

    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener("dragstart", onWindowDragStart, true);
      window.removeEventListener("drop", onWindowDrop, true);
      window.removeEventListener("dragend", onWindowDragEnd);
    };
    // Empty deps: the listeners are registered once per mount.  Store state is
    // read via getState() inside the handlers so the closures always see the
    // latest values without re-subscribing on every change.
  }, []);
}
