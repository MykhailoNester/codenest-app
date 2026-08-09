/**
 * A dev-gated diagnostic channel for the drag-and-drop paths in
 * `hooks/use-terminal-file-drop.ts`, `components/terminal/agent-composer.tsx`
 * and `components/terminal/agent-pane.tsx`.
 *
 * Neither the planner nor the implementer of this fix can originate a
 * Finder/Desktop drag or observe `WryWebView`'s AppKit-level behaviour from
 * this environment — the user's own machine is the only place these paths
 * can be exercised. Instrumentation that gets deleted before hand-off is
 * instrumentation nobody ever reads, so this ships instead of being added
 * and removed.
 *
 * No-op unless both hold:
 *   - `import.meta.env.DEV` (statically false in a prod build, so every call
 *     site is dead code the bundler drops — zero prod cost, and
 *     `rg "\[dnd\]" dist` after a prod build finds nothing).
 *   - `localStorage.getItem("codenest.dndDebug") === "1"` (unset by default,
 *     and unset in jsdom, so test runs stay silent). Key naming follows
 *     `stores/pending-launch-store.ts`'s `codenest.pendingLaunch`.
 *
 * The `localStorage` read is wrapped in a `try`/`catch` as a feature probe —
 * a browser that throws on `localStorage` access (private mode, a disabled
 * storage permission) must not be able to break a drag over this call — not
 * as a swallowed error path.
 *
 * The `import.meta.env.DEV` check lives directly in `logDnd`'s own body
 * rather than behind a second function call: Vite replaces
 * `import.meta.env.DEV` with the literal `false` in a prod build at every
 * call site, and an `if (!false) return;` as the first statement of a
 * function is dead code the minifier can prove unreachable *within that one
 * function* — no cross-function inlining required. Splitting the check into
 * a separate `dndDebugEnabled()` helper defeated exactly that: the "[dnd]"
 * string literal survived a prod build because the minifier never proved
 * the helper's return value was constant across the call boundary.
 */
function readDndDebugFlag(): boolean {
  try {
    return localStorage.getItem("codenest.dndDebug") === "1";
  } catch {
    return false;
  }
}

/**
 * Logs one `[dnd]` diagnostic line. See the module header for the gate.
 * `console.debug` is used deliberately — no `no-console` rule is configured
 * (`frontend/eslint.config.js`) and `console.error` is already used
 * elsewhere in the drop path (`hooks/use-terminal-file-drop.ts`).
 */
export function logDnd(event: string, detail: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  if (!readDndDebugFlag()) return;
  console.debug("[dnd]", event, detail);
}
