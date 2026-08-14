/**
 * pending-prompt-store.ts — launch-prompt handoff, keyed by leaf id.
 *
 * A plain module, not a zustand store — exactly like its neighbour
 * `pending-launch-store.ts`, but for a narrower job and a shorter hop: this
 * one never crosses a window boundary.
 *
 * Keyed by leaf id:
 *   The key is the agent leaf's real `terminalId`, the `crypto.randomUUID()`
 *   `applyPaneLayout` mints in `terminal-store.ts` — never a `pending-N`
 *   placeholder, which is not unique across two tabs launched from the same
 *   spec. See `resolvePromptTargets` (`lib/launch.ts`) for which panes in a
 *   `PaneLaunchSpec` get an entry at all.
 *
 * Consume-once:
 *   `consumePendingPrompt` both reads and deletes in one call. A pane's boot
 *   effect calls it exactly once per mount; a `retryToken` restart re-runs
 *   that effect and finds nothing, which is what makes a restart not a
 *   re-send.
 *
 * In-memory by design (Design decision 2, `feature/launch-prompt-seed` plan):
 *   The window that stages a prompt (`applyPaneLayout`) is always the window
 *   that will mount the pane that consumes it — there is no cross-window
 *   handoff to do, unlike `pending-launch-store`'s localStorage slot.
 *   Persisting this would mean a prompt could survive a reload and land in a
 *   pane the user never launched, which is the exact replay this module
 *   forbids.
 *
 * Bounded, not TTL'd (Design decision 5):
 *   A leaf that is staged but never mounts (its tab closed before React gets
 *   to it) leaves an entry behind forever otherwise. Keys are UUIDs, so a
 *   stale entry can never be mis-delivered to an unrelated pane — the only
 *   cost of leaving it is memory, which the cap bounds deterministically.
 *   `MAX_LAUNCH_PANES` (`lib/launch.ts`) is 8, so this cap comfortably holds
 *   two full launches in flight at once.
 *
 * Never persisted: this module never touches `localStorage` and has zero
 * imports, keeping it a leaf in the module graph — `terminal-store.ts` (the
 * producer) and `<AgentPane/>` (the consumer, alongside `composer-store`)
 * both import it, but it imports neither, so it cannot become part of an
 * import cycle between them.
 */

/** Oldest-first eviction cap. `Map` preserves insertion order, so the first
 *  key is always the oldest. */
export const MAX_PENDING_PROMPTS = 16;

const pending = new Map<string, string>();

/**
 * Stage `prompt` for `leafId` to be consumed once its pane boots.
 *
 * A no-op for an empty prompt — nothing is ever staged for "no prompt".
 * Overwrites an existing entry for the same id (last launch wins); an id is
 * a UUID, so two stages for one id are only reachable in tests.
 *
 * After inserting, evicts the oldest entry while the map exceeds the cap.
 */
export function stagePendingPrompt(leafId: string, prompt: string): void {
  if (prompt.length === 0) return;
  pending.set(leafId, prompt);
  while (pending.size > MAX_PENDING_PROMPTS) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }
}

/**
 * Read and remove `leafId`'s staged prompt, if any.
 *
 * Returns `null` when nothing was staged — including on a second call for
 * the same id, which is what makes this consume-once.
 */
export function consumePendingPrompt(leafId: string): string | null {
  const text = pending.get(leafId);
  if (text === undefined) return null;
  pending.delete(leafId);
  return text;
}

/** Number of prompts currently staged and unconsumed. Used by tests and by
 *  the bounded-cap assertion. */
export function pendingPromptCount(): number {
  return pending.size;
}

/** Clears every staged prompt. Test hygiene between cases — never called in
 *  production code. */
export function clearPendingPrompts(): void {
  pending.clear();
}
