/**
 * Pure selectors for the agent pane's activity dock (`agent-activity-dock.tsx`,
 * Zone B of the three-zone pane) — the same "pure, UI-shaped selectors over
 * `ConversationState`, in their own module" idiom `lib/agent-views.ts`
 * establishes for the view picker. No React here: `only-export-components`
 * (`session-hud-format.ts:1-13`) forbids exporting a non-component from a
 * `.tsx`, so anything the dock needs that isn't a component lives here.
 *
 * The dock's Tools group deliberately does not walk the transcript on its
 * own. `liveToolRun` below reuses `groupTurnBlocks` — the exact grouping the
 * transcript renders — so the dock's headline can never disagree with what
 * the transcript shows for the same run, and a `Task`/`Agent` delegation is
 * excluded for free (it is already its own `delegation` group there).
 */

import {
  groupTurnBlocks,
  activeOrchestrations,
  activeSubagents,
  type ConversationState,
  type ConvToolBlock,
} from "./agent-conversation";

/**
 * The run of consecutive tool calls currently in flight, in transcript order —
 * `[]` when nothing is running. Walks `state.turns` newest-first and, within
 * each turn, that turn's own `groupTurnBlocks` groups last-first, so the most
 * recently started activity is found first without needing a second pass or a
 * timestamp comparison across turns.
 *
 * A group qualifies when it is a `toolRun` (or a lone tool `block`) that
 * contains at least one still-open call (`endedAt === null`) — a finished run
 * further back in the same turn is skipped in favour of an open one, and a
 * `delegation` group never qualifies at all: that is the Agents group's
 * entity, not this one's, exactly as the transcript keeps a `Task` card
 * separate from the tool rows around it.
 *
 * `[]` on an exited session — same honesty fold-in as `activeSubagents`
 * (`agent-conversation.ts:481-484`): a dead process cannot have a call in
 * flight, so claiming one would be the same lie the metrics strip already
 * refuses to tell.
 *
 * Returns a mutable `ConvToolBlock[]`, not `readonly`, so the result passes
 * straight into `summarizeToolRun`/`toolRunHeadline`/`toolRunElapsedMs`,
 * whose parameters are all `ConvToolBlock[]`.
 */
export function liveToolRun(state: ConversationState): ConvToolBlock[] {
  if (state.status === "exited") return [];
  for (let i = state.turns.length - 1; i >= 0; i -= 1) {
    const turn = state.turns[i];
    if (turn === undefined) continue;
    const groups = groupTurnBlocks(turn.blocks);
    for (let j = groups.length - 1; j >= 0; j -= 1) {
      const group = groups[j];
      if (group === undefined) continue;
      if (group.kind === "toolRun" && group.blocks.some((b) => b.endedAt === null)) {
        return [...group.blocks];
      }
      if (
        group.kind === "block" &&
        group.block.type === "tool" &&
        group.block.endedAt === null
      ) {
        return [group.block];
      }
    }
  }
  return [];
}

/**
 * The earliest `startedAt` among `blocks`, or `null` for an empty run. The
 * live ticker's origin: `toolRunElapsedMs` is `null` by design while any call
 * in the run is still open (it would otherwise report a span that is wrong
 * the instant it paints), so the dock needs this instead to render a live
 * "Ns" figure for a run that has not finished yet.
 *
 * Written as an explicit loop rather than `Math.min(...blocks.map(...))` or
 * `blocks[0]!` — the former is what `toolRunElapsedMs` itself already does
 * for a *closed* run, but this needs no such spread, and the latter is
 * exactly what `noUncheckedIndexedAccess` forbids.
 */
export function toolRunStartedAt(blocks: ConvToolBlock[]): number | null {
  let earliest: number | null = null;
  for (const block of blocks) {
    if (earliest === null || block.startedAt < earliest) earliest = block.startedAt;
  }
  return earliest;
}

/**
 * Whether the dock has anything at all to show — the honesty contract applied
 * to the dock as a whole, not just to one cell. `false` renders no dock
 * element (no empty chrome bar); `true` renders at least the dimmed metrics
 * strip.
 *
 * Every disjunct is a fact the wire has reported, in the same order the
 * metrics strip itself checks them:
 *
 * - `startedAt !== null` — the session has seen its `init` frame.
 * - `usage !== null` — a `result` frame has reported token accounting.
 * - `lastResult !== null` — a turn has finished (so `cost`/`elapsed` may show).
 * - `permissions.length > 0` — a tool call is waiting on the user.
 * - `thinking` — the model is mid-thought right now.
 * - `liveToolRun(state)` non-empty — a tool call is in flight.
 * - `activeSubagents(state)` non-empty — a `Task`/`Agent` delegation is open.
 * - `activeOrchestrations(state)` non-empty — a `Workflow` run is open.
 *
 * Deliberately **not** a disjunct: the git branch. It is ambient context
 * available from the moment the pane opens (`useGitPaneStatus` needs only
 * `cwd`, not a session frame), so including it would make "renders nothing at
 * all for an idle fresh session" unreachable in any repo — every pane would
 * show a dock the instant it mounted. The accepted, documented consequence:
 * between mount and the `init` frame (sub-second normally; indefinite if the
 * spawn fails, where `agent-pane.tsx`'s `startError` bar carries the news
 * instead) the branch name is not shown anywhere.
 */
export function dockHasContent(state: ConversationState): boolean {
  return (
    state.startedAt !== null ||
    state.usage !== null ||
    state.lastResult !== null ||
    state.permissions.length > 0 ||
    state.thinking ||
    liveToolRun(state).length > 0 ||
    activeSubagents(state).length > 0 ||
    activeOrchestrations(state).length > 0
  );
}
