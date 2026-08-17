/**
 * Zone B of the native agent pane: the **activity dock**, pinned between
 * Zone A (`.viewport` — the transcript or a drilled-in sub-agent/workflow
 * view, `agent-pane.tsx`) and Zone C (`<AgentComposer/>`). B and C never move
 * when the user switches which agent Zone A shows; only A's own contents
 * change.
 *
 * Rendered as a **sibling of `.viewport` inside `.body`**, never its child —
 * `agent-pane.tsx`'s comment at the mount site states the same rule, because
 * a child would scroll away with the transcript the moment a session got
 * busy, which defeats the entire point of pulling this chrome down to where
 * the user's eyes already are.
 *
 * Contents, top to bottom:
 *
 * 1. **Tools** — the live grouped tool run as one line ("Running 2 ToolSearch
 *    calls, fetching 1 page") with its elapsed and a "what now" row
 *    underneath. Built from `liveToolRun` (`lib/agent-dock.ts`, which reuses
 *    the transcript's own `groupTurnBlocks`) and `summarizeToolRun` /
 *    `toolRunHeadline` / `toolRunElapsedMs` (`lib/agent-conversation.ts`) —
 *    the same three the transcript's `ToolRunRow` uses, so the dock and the
 *    transcript can never disagree about what one run is.
 * 2. **Agents** and **Workflows** — one row per `Task`/`Agent` delegation and
 *    one row per orchestration run, running and finished alike: the most
 *    useful moment to read a sub-agent's or a run's result is right after it
 *    ends, so neither group empties itself the instant its last live entity
 *    finishes (#21). Rows are click targets that drive the pane's single
 *    `selectedView` — the same state the composer's picker drives, passed in
 *    as a prop pair rather than owned here, so the dock and the picker can
 *    never point at two different things. The Workflows group nests each
 *    run's phase tree, one row per phase agent, and keeps the Workflow Stop
 *    button next to its run: it is this app's only way to end one `Workflow`
 *    run without killing the whole session, so the move to named rows
 *    carries it along rather than dropping it.
 * 3. **The metrics line** — `<AgentSessionHud/>`, unchanged in content and
 *    honesty contract (status, ctx, tokens, cost, elapsed, git, thinking,
 *    perm — a cell renders a real value or it does not render at all). That
 *    file renders only this line; the groups above used to be cells on it too.
 *
 * **Why the metrics line is last, not first (#38).** The dock is bottom-
 * anchored: `.viewport` above it takes every spare pixel, so the dock's bottom
 * edge sits against the composer and its *last* child is the one at a fixed
 * distance from the caret. The metrics line is the always-present, fixed-height
 * half of the dock; the groups are the transient half, appearing and vanishing
 * several times within one turn as tool runs start and resolve. With the
 * metrics line first, every one of those appearances shoved it up and down and
 * the ctx figure the user was reading jumped away mid-glance. Last, it holds
 * still and the groups grow upward into the transcript instead.
 *
 * Renders `null` — no element at all, not an empty chrome bar — when
 * `dockHasContent` says the session has reported nothing yet (`lib/agent-dock.ts`).
 * Mounted unconditionally by the pane regardless, so its per-group collapse
 * state (plain `useState`, one `Record` per pane) survives every phase where
 * it currently has nothing to show and every re-render — it is lost only on a
 * genuine remount, the same lifetime `agent-pane.tsx`'s own `selectedView`
 * already has.
 *
 * Sizes to its own content and caps at a max height past which its group
 * stack — not the whole dock — scrolls internally (`agent-activity-dock.module.css`),
 * so a session with a large workflow can never push the composer off screen.
 *
 * **Keyboard surface (#22).** The dock is also a `role="listbox"` (two of
 * them, in fact — see below) that the composer's `Ctrl+↑`/`Ctrl+↓` can hand a
 * cursor and focus to, and that the arrow keys can walk once focus is here.
 * Three things worth knowing before touching any of this:
 *
 * - **Roving tabindex *and* `aria-activedescendant`, deliberately both.**
 *   These are normally alternative ARIA patterns; this dock uses both because
 *   focus genuinely moves to the option (matching `explorer-tree.tsx`'s own
 *   roving-tabindex precedent) *and* the containing listbox names the
 *   highlighted option via `aria-activedescendant`. The redundancy is
 *   harmless — an AT ignores `aria-activedescendant` on a container that
 *   does not hold focus — and is recorded here so a later reader does not
 *   "fix" one of them away. A consequence of there being **two** listboxes
 *   (Agents, Workflows) sharing **one** cursor: `↓` off the last Agents row
 *   moves focus across a listbox boundary into Workflows rather than
 *   wrapping inside the group it left — deliberate (see `nextDockNavKey`'s
 *   own "clamp, never wrap" doc comment in `lib/agent-dock.ts`).
 * - **A group holding the cursor renders expanded, derived, never
 *   `setState`d.** `expanded = !collapsed[g] || cursorIsInGroup(g)`. An
 *   effect that expanded the group instead would be a `setState` from inside
 *   a `useEffect`, which `react-hooks/set-state-in-effect` (error) forbids —
 *   and both groups default collapsed, so without this a fresh pane's first
 *   `Ctrl+↓` would highlight a row that is not in the DOM.
 * - **DOM focus moves into the dock only when `focusRequest` changes, never
 *   because the highlight moved.** A row's `onClick` calls `onHighlightChange`
 *   with no focus option, so a mouse click highlights and selects a row
 *   without ever pulling the caret out of the composer — WKWebView does not
 *   focus a `<button>` on click either, so this matches what already happens
 *   today. The focus-serving effect below depends on `focusRequest` alone
 *   (never on `highlightedKey`) for exactly this reason.
 *
 * "Exactly one `Tab` stop" is true of the dock's **rows** only, deliberately
 * not of the dock as a whole: the `DockGroup` header buttons (the twisties)
 * and the Workflow `Stop` button stay ordinary tab stops outside the roving
 * order, so `Tab` still passes through the dock more than once overall.
 * Folding them in would need a `role="tree"`-shaped redesign of this
 * component — a follow-up, not this one.
 */

import {
  Fragment,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  combinedOrchestrationCounts,
  dockAgentRows,
  dockHasContent,
  dockNavRows,
  dockWorkflowRows,
  liveToolRun,
  nextDockNavKey,
  orchestrationCountsLabel,
  toolRunStartedAt,
  type DockRowStatus,
} from "../../lib/agent-dock";
import {
  activeOrchestrations,
  formatDuration,
  summarizeToolRun,
  toolRunElapsedMs,
  toolRunHeadline,
  type ConversationState,
  type OrchestrationRun,
} from "../../lib/agent-conversation";
import { MAIN_VIEW, sameView, viewKey, type AgentViewId } from "../../lib/agent-views";
import { agentStopTask } from "../../lib/ipc";
import { AgentSessionHud } from "./agent-session-hud";
import { elapsedSecondsSinceMs, formatElapsed, formatTokens } from "./session-hud-format";
import styles from "./agent-activity-dock.module.css";

interface AgentActivityDockProps {
  state: ConversationState;
  cwd: string | undefined;
  /** The pane whose stdin a workflow Stop must reach — the reason this prop is
   *  required, same argument as the metrics strip's old `paneId` doc before
   *  the Stop button moved here with it. */
  paneId: string;
  /** The pane's single selection, already resolved by `resolveView`
   *  (`agent-pane.tsx`) — the same value the composer picker receives.
   *  Required, not optional: a dock that could render without it would need
   *  a second, silently-diverging notion of "current". */
  selectedView: AgentViewId;
  /** `setSelectedView` itself, the same setter the picker and the
   *  transcript's delegation card call. */
  onSelectView: (id: AgentViewId) => void;
  /** The row the keyboard cursor points at, as a `viewKey`. `null` = no
   *  cursor. A key with no matching row (the entity aged out of the
   *  transcript) renders as no highlight — self-healing, no effect required.
   *  Changing *only* this never moves DOM focus. Required for the same
   *  reason `selectedView` is: an optional highlight would let the dock
   *  invent a second, silently diverging cursor. */
  highlightedKey: string | null;
  /** A one-shot request to put DOM focus on a row. `null` — the common case,
   *  including every pointer interaction and every render after the request
   *  was served — means "leave focus exactly where it is". `token`
   *  distinguishes two consecutive requests for the same row (a clamped move
   *  at the end of the list still has to re-focus). */
  focusRequest: { key: string; token: number } | null;
  /** Cursor moves originating inside the dock: arrow keys pass
   *  `{ focus: true }` because focus is already here and must follow the
   *  cursor; a row's `onClick` and a group collapse pass nothing, because a
   *  pointer user's caret must stay in the composer. */
  onHighlightChange: (key: string | null, opts?: { focus?: boolean }) => void;
  /** "I am done here" — the pane returns focus to the composer editor at the
   *  caret offset it was left at. Called on Enter/→/Esc/← from a row, and by
   *  the dock's focus custodian when the row that was to receive (or was
   *  holding) focus is no longer in the DOM. */
  onReturnFocus: () => void;
}

/** `dock-opt-${paneId}-${key}` — unique across panes and detached windows.
 *  Never used as a CSS selector, so the `:` inside a `sub:`/`wf:` key needs
 *  no escaping. */
function dockOptionId(paneId: string, key: string): string {
  return `dock-opt-${paneId}-${key}`;
}

/** `${primaryRun.name ?? "orchestration"}` for one run, `"N orchestrations"`
 *  for several — the Workflows group header's single-vs-many idiom, now
 *  retargeted at every run this session has launched (D1), not just the live
 *  ones: a finished run still needs a name in the header when it is the only
 *  one. */
function orchestrationLabel(runs: readonly OrchestrationRun[]): string {
  const primary = runs[0];
  if (runs.length === 1 && primary) return primary.name ?? "orchestration";
  return `${runs.length} orchestrations`;
}

/** `["3 tools", null, "1.2k"]` → `["3 tools", "1.2k"]`. A type predicate, not
 *  a bare `Boolean` filter, because `Array.filter(Boolean)` does not narrow
 *  away the `null` in the result type. */
function present(values: readonly (string | null)[]): string[] {
  return values.filter((v): v is string => v !== null && v !== "");
}

/** The word a `DockRowStatus` reads as, for the dot's `title` and the row's
 *  `aria-label` — colour is never the only signal for status. `warn` reads
 *  "error": it is the wire's own `workflow_agent.state === "error"`, softened
 *  to an amber dot rather than a red one because the run continues past it
 *  (see `DockRowStatus`'s own doc comment), not softened in the word too. */
function statusWord(status: DockRowStatus): string {
  switch (status) {
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "warn":
      return "error";
    case "ended":
      return "ended";
  }
}

/** `styles.dot<Status>` for a `DockRowStatus`. No explicit `string` return
 *  type: a CSS module's classes are typed through an index signature, which
 *  `noUncheckedIndexedAccess` widens to `string | undefined` on every read
 *  (dotted or not) — harmless here, since the only use is inside a template
 *  literal below, but an annotated `string` return would need a fallback
 *  that can never actually trigger. */
function dotClassName(status: DockRowStatus): string | undefined {
  switch (status) {
    case "running":
      return styles.dotRunning;
    case "done":
      return styles.dotDone;
    case "failed":
      return styles.dotFailed;
    case "warn":
      return styles.dotWarn;
    case "ended":
      return styles.dotEnded;
  }
}

/** A 6px dot carrying a row's status. `running` composes the global
 *  `.d3-status__pulse` class (`d3-creative.css`) rather than re-authoring the
 *  pulse ring: that class is already a `currentColor` dot with an animated
 *  `::after` ring, and every other status renders it plain. */
function StatusDot({ status, word }: { status: DockRowStatus; word: string }): ReactElement {
  const pulse = status === "running" ? " d3-status__pulse" : "";
  return <span className={`${styles.dot} ${dotClassName(status)}${pulse}`} title={word} />;
}

/** A row's elapsed column: the literal word `running` in flight, an exact
 *  `formatDuration` once both ends are known, and nothing at all otherwise —
 *  never a number frozen at the render that happened to catch a still-open
 *  call. */
function RowElapsed({
  ms,
  running,
}: {
  ms: number | null;
  running: boolean;
}): ReactElement | null {
  if (running) return <span className={styles.rowLive}>running</span>;
  if (ms === null) return null;
  return <span className={styles.rowElapsed}>{formatDuration(ms)}</span>;
}

/**
 * One dock row: `[dot] name · description · meta… · elapsed`, used for every
 * row kind (sub-agent, workflow run, workflow phase-agent) so the three can
 * never drift into three different shapes.
 *
 * `view === null` renders a non-interactive `<div>` — phase-agent rows have
 * no `AgentViewId` to select (`AgentViewId` has no fourth variant for one
 * orchestration agent; the run row above them is the click target for the
 * whole run). Otherwise the row's own body is a `<button>`, and `trailing`
 * (the Workflow Stop button) is its sibling, never its child — a `<button>`
 * nested inside a `<button>` is invalid HTML and breaks click handling.
 *
 * The outer `div.row` carries a role too (#22): `role="presentation"` when it
 * has no `trailing`, or `role="group"` + `aria-label={name}` when it does — a
 * bare `presentation` wrapper would make the Workflow `Stop` `<button>` a
 * direct child of `role="listbox"`, which owns only `option`/`group`
 * children, and a `group` wrapper keeps the tree conformant at no
 * behavioural cost.
 */
function DockRow(props: {
  view: AgentViewId | null;
  selected: boolean;
  onSelect: (id: AgentViewId) => void;
  status: DockRowStatus;
  statusWord: string;
  name: string;
  description: string | null;
  /** Already `present()`-filtered by the caller; joined with " · ". */
  meta: readonly string[];
  elapsedMs: number | null;
  running: boolean;
  indent?: boolean;
  trailing?: ReactNode;
  testId: string;
  /** Whether the keyboard cursor is on this row — orthogonal to `selected`
   *  (plan D12/the ticket's "two different states, both visible"). Omitted
   *  (defaults `false`) for a `view === null` (phase-agent) row: it is never
   *  a cursor target. */
  highlighted?: boolean;
  /** Whether this row is the one `Tab` stop among the dock's rows (roving
   *  tabindex). Omitted (defaults `false`) for a `view === null` row, which
   *  carries no `tabIndex` at all. */
  isTabStop?: boolean;
  /** The DOM id this row's option carries, so `aria-activedescendant` on the
   *  listbox above can name it. Omitted for a `view === null` row. */
  optionId?: string;
  /** Arrow/Enter/Escape handling — see `handleRowKeyDown` in the component
   *  body. Omitted for a `view === null` row, which is not a Tab stop. */
  onKeyDown?: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
  /** Moves the keyboard cursor to this row with **no** focus request (D15) —
   *  a mouse click highlights and selects without ever pulling the caret out
   *  of the composer. Called with `viewKey(view)` — this row's own cursor
   *  key — which the caller does not need to pass separately since `view` is
   *  narrowed non-null wherever this fires. Omitted for a `view === null`
   *  row. */
  onHighlight?: (key: string) => void;
}): ReactElement {
  const {
    view,
    selected,
    onSelect,
    status,
    statusWord: word,
    name,
    description,
    meta,
    elapsedMs,
    running,
    indent,
    trailing,
    testId,
    highlighted = false,
    isTabStop = false,
    optionId,
    onKeyDown,
    onHighlight,
  } = props;
  const metaText = meta.join(" · ");
  const body = (
    <>
      <StatusDot status={status} word={word} />
      <span className={styles.rowName}>{name}</span>
      {description !== null ? <span className={styles.rowDesc}>{description}</span> : null}
      {metaText !== "" ? <span className={styles.rowMeta}>{metaText}</span> : null}
      <RowElapsed ms={elapsedMs} running={running} />
    </>
  );
  return (
    <div
      className={`${styles.row}${indent === true ? ` ${styles.rowIndent}` : ""}`}
      data-testid={testId}
      data-view-key={view === null ? undefined : viewKey(view)}
      role={trailing !== undefined ? "group" : "presentation"}
      aria-label={trailing !== undefined ? name : undefined}
    >
      {view !== null ? (
        <button
          type="button"
          id={optionId}
          role="option"
          className={`${styles.rowMain}${selected ? ` ${styles.rowSelected}` : ""}${highlighted ? ` ${styles.rowHighlighted}` : ""}`}
          aria-selected={selected}
          aria-label={`${name} — ${word}`}
          data-highlighted={highlighted ? "true" : undefined}
          tabIndex={isTabStop ? 0 : -1}
          onKeyDown={onKeyDown}
          onClick={() => {
            onSelect(view);
            onHighlight?.(viewKey(view));
          }}
        >
          {body}
        </button>
      ) : (
        <div className={styles.rowMain} role="option" aria-disabled="true" aria-label={`${name} — ${word}`}>
          {body}
        </div>
      )}
      {trailing ?? null}
    </div>
  );
}

/** Which of the dock's three groups a collapse toggle names. */
type DockGroupKey = "tools" | "agents" | "workflows";

/**
 * One collapsible group row: `[twisty] LABEL · summary · meta? · elapsed?`
 * (D8). `meta` is the Workflows-only counts clause; `elapsed` is omitted
 * (`null`) only when the caller has none to show, which in practice never
 * happens for a rendered group — every group here has a primary entity with a
 * `startedAt`.
 */
function DockGroup({
  id,
  label,
  summary,
  meta,
  elapsed,
  expanded,
  onToggle,
  children,
}: {
  id: DockGroupKey;
  label: string;
  summary: string;
  meta?: string;
  elapsed: string | null;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <section className={styles.group} data-testid={`dock-group-${id}`}>
      <button
        type="button"
        aria-expanded={expanded}
        className={styles.groupHead}
        onClick={onToggle}
      >
        <span className={styles.groupTwisty}>{expanded ? "▾" : "▸"}</span>
        <span className={styles.groupLabel}>{label}</span>
        <span className={styles.groupSummary}>{summary}</span>
        {meta !== undefined ? <span className={styles.groupMeta}>{meta}</span> : null}
        {elapsed !== null ? <span className={styles.groupMeta}>{elapsed}</span> : null}
      </button>
      {expanded ? <div className={styles.groupBody}>{children}</div> : null}
    </section>
  );
}

export function AgentActivityDock({
  state,
  cwd,
  paneId,
  selectedView,
  onSelectView,
  highlightedKey,
  focusRequest,
  onHighlightChange,
  onReturnFocus,
}: AgentActivityDockProps): ReactElement | null {
  // One interval for the sub-agent/orchestration groups' elapsed figures,
  // rather than a second interval per group. Gated on the session being alive
  // rather than on a turn being in flight — deliberately looser than the
  // metrics strip's own ticker, which times the turn (#40): an orchestration
  // outlives the turn that launched it (see `activeOrchestrations`), so its row
  // still has to count while the pane reads `idle`.
  const ticking = state.startedAt !== null && state.status !== "exited";
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  // Per-pane, per-group collapse state (D5/D6): one `Record`, not a per-entity
  // id. "Expanded" used to mean "expanded *this* sub-agent/run" and derived
  // itself closed the moment that entity ended; the ticket asks for state
  // that survives re-render regardless of which entity is currently primary,
  // which per-entity keying cannot give by construction. Plain `useState`
  // rather than a module map or localStorage: the dock is mounted
  // unconditionally and returns `null` internally, so React keeps this state
  // through every empty phase and view switch; it resets only on a genuine
  // remount (a sibling pane closing), matching `selectedView`'s own lifetime.
  const [collapsed, setCollapsed] = useState<Record<DockGroupKey, boolean>>({
    tools: false,
    agents: true,
    workflows: true,
  });

  // Task ids with a Stop request in flight — disables the button and blocks a
  // double-send without an optimistic status change: the wire, not this set,
  // decides when the run actually stops.
  const [stoppingTaskIds, setStoppingTaskIds] = useState<readonly string[]>([]);

  // --- Keyboard-cursor derivations (#22) — hoisted above the early return
  // below because the two effects that follow need them, and every one of
  // these is a pure read of props/state (no hook rules to keep straight). ---
  const navRows = dockNavRows(state);
  const cursorGroup = navRows.find((r) => r.key === highlightedKey)?.group ?? null;
  const selectedKey = viewKey(selectedView);
  // D5: a group holding the cursor renders expanded, derived — never
  // `setState`d from an effect (`react-hooks/set-state-in-effect` forbids
  // it), and both groups default collapsed, so without this a fresh pane's
  // first `Ctrl+↓` would highlight a row that never mounts.
  const agentsExpanded = !collapsed.agents || cursorGroup === "agents";
  const workflowsExpanded = !collapsed.workflows || cursorGroup === "workflows";
  const renderedKeys = navRows
    .filter((r) => (r.group === "agents" ? agentsExpanded : workflowsExpanded))
    .map((r) => r.key);
  // The single Tab stop among the dock's rows (roving tabindex): the cursor
  // if it names a rendered row, else the selected row if rendered, else the
  // first rendered row. `null` when nothing is on screen (both groups
  // collapsed with no cursor) — correct, since there is nothing to tab to.
  const tabStopKey =
    (highlightedKey !== null && renderedKeys.includes(highlightedKey) ? highlightedKey : null) ??
    (renderedKeys.includes(selectedKey) ? selectedKey : null) ??
    (renderedKeys[0] ?? null);
  /** The cursor points at a row that is not on screen — the entity aged out
   *  (`/clear`, a restart) between two renders. */
  const cursorLost = highlightedKey !== null && !renderedKeys.includes(highlightedKey);

  function toggle(id: DockGroupKey): void {
    // A click that is about to *collapse* a group holding the cursor would
    // otherwise appear to do nothing — D5's derived expansion would keep the
    // group open because the cursor is still inside it. Clearing the cursor
    // first (no focus option: this is a pointer path) lets the click land.
    if (!collapsed[id] && cursorGroup === id) {
      // Review round 1, F1: if the cursor's own row is also the element
      // holding *real* DOM focus right now (reached via Ctrl+↓/arrow keys,
      // then the mouse took the twisty), clearing the cursor and collapsing
      // the group land in this one commit — `cursorLost` never edges
      // false→true (it was false before the click, since the row was
      // rendered, and stays false after, since `highlightedKey` itself just
      // became `null`), so the focus custodian effect below never fires. Left
      // uncorrected, the browser's own "focused element removed from the DOM"
      // behaviour would strand focus on `<body>`. Hand it back explicitly
      // here instead of relying on that effect to also catch this case.
      if (
        highlightedKey !== null &&
        document.activeElement?.id === dockOptionId(paneId, highlightedKey)
      ) {
        onReturnFocus();
      }
      onHighlightChange(null);
    }
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  }

  /** Arrow/Enter/Escape on a focused dock option (plan step 2's keyboard
   *  handler). Closes over `navRows`/`onHighlightChange`/`onSelectView`/
   *  `onReturnFocus`, so it is defined here rather than hoisted to module
   *  scope. Never fires with a modifier held — that is always a system or
   *  future chord, never this dock's business. */
  function handleRowKeyDown(
    e: ReactKeyboardEvent<HTMLButtonElement>,
    view: AgentViewId,
    key: string,
  ): void {
    if (e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault(); // no page scroll
        // `{ focus: true }`: focus is already in the dock and must follow
        // the cursor. This and the composer's Ctrl+arrow are the only two
        // callers that ask for focus (plan D15).
        onHighlightChange(nextDockNavKey(navRows, key, e.key === "ArrowDown" ? 1 : -1), {
          focus: true,
        });
        return;
      case "ArrowRight":
      case "Enter":
        e.preventDefault(); // suppresses the button's synthesized click in a real browser
        onSelectView(view);
        onReturnFocus();
        return;
      case "ArrowLeft":
      case "Escape":
        e.preventDefault();
        onSelectView(MAIN_VIEW);
        onReturnFocus();
        return;
      default:
        return;
    }
  }

  // Serves a focus request. Depends on `focusRequest` alone (plus its own
  // constants) — deliberately NOT on `highlightedKey`: a pointer click moves
  // the cursor without asking for focus, and an effect that also watched the
  // cursor would yank the caret out of the composer on every click (plan
  // D15). `focusRequest === null` — every render after a request was served,
  // and every render of a pane whose user has never asked for the dock — is
  // the "leave focus alone" case.
  useEffect(() => {
    if (focusRequest === null) return;
    const el = document.getElementById(dockOptionId(paneId, focusRequest.key));
    if (el === null) {
      // The row went away between the request and this frame. Focus would be
      // stranded on <body>, where no key does anything — hand it back.
      onReturnFocus();
      return;
    }
    el.focus();
  }, [focusRequest, paneId, onReturnFocus]);

  // Focus custodian for the other direction: the row that HELD focus was
  // removed (its sub-agent aged out) and the browser dropped focus to <body>.
  // Fires on the false->true edge of `cursorLost` only, and the
  // `document.body` guard means it never touches focus that is legitimately
  // somewhere else (the composer, another pane). A mouse-driven group
  // collapse never reaches this edge — clearing the cursor and collapsing
  // land in one commit, so `cursorLost` stays `false` throughout — which is
  // why `toggle()` above hands focus back itself instead of relying on this
  // effect to catch it too (review round 1, F1).
  useEffect(() => {
    if (!cursorLost) return;
    if (document.activeElement !== document.body) return;
    onReturnFocus();
  }, [cursorLost, onReturnFocus]);

  // Every hook above runs unconditionally, before this early return — the
  // rule that makes it safe for the dock to render `null` on some renders and
  // an element on others without breaking React's hook-order contract.
  if (!dockHasContent(state)) return null;

  // Hoisted here (rather than computed inline where each group used to build
  // itself) because the derivations above already need them — moved, not
  // duplicated.
  const agentRows = dockAgentRows(state);
  const workflowRows = dockWorkflowRows(state);

  const groups: ReactElement[] = [];

  // Tools — the live grouped run, exactly as the transcript would group it
  // (`liveToolRun` already folds in the exited-session honesty rule).
  const toolRun = liveToolRun(state);
  if (toolRun.length > 0) {
    const runElapsedMs = toolRunElapsedMs(toolRun);
    const elapsed =
      runElapsedMs === null
        ? formatElapsed(elapsedSecondsSinceMs(toolRunStartedAt(toolRun) ?? 0))
        : formatDuration(runElapsedMs);
    const headline = toolRunHeadline(toolRun);
    groups.push(
      <DockGroup
        key="tools"
        id="tools"
        label="Tools"
        summary={summarizeToolRun(toolRun)}
        elapsed={elapsed}
        expanded={!collapsed.tools}
        onToggle={() => toggle("tools")}
      >
        {headline !== null ? (
          <div className={styles.toolHead} data-testid="dock-tool-run">
            <span className={styles.toolHeadTick}>└</span>
            <span>{headline.name}</span>
            <span>{headline.argSummary}</span>
          </div>
        ) : null}
      </DockGroup>,
    );
  }

  // Agents — one row per Task/Agent delegation this session has made,
  // running and finished, oldest first (D1/D2). The header's own running
  // count and ticker origin stay live-only, which is the only place "counts
  // degrade to nothing as agents finish" applies — the rows themselves never
  // disappear.
  const runningAgents = agentRows.filter((r) => r.running);
  const oldestRunningAgent = runningAgents[0] ?? null;
  if (agentRows.length > 0) {
    const single = agentRows.length === 1 ? agentRows[0] ?? null : null;
    groups.push(
      <DockGroup
        key="agents"
        id="agents"
        label="Agents"
        summary={single !== null ? single.label : `${agentRows.length} sub-agents`}
        meta={runningAgents.length > 0 ? `${runningAgents.length} running` : undefined}
        elapsed={
          oldestRunningAgent === null
            ? null
            : formatElapsed(elapsedSecondsSinceMs(oldestRunningAgent.startedAt))
        }
        expanded={agentsExpanded}
        onToggle={() => toggle("agents")}
      >
        <div
          className={styles.rows}
          data-testid="dock-agent-rows"
          role="listbox"
          aria-label="Sub-agents"
          aria-activedescendant={
            cursorGroup === "agents" && highlightedKey !== null
              ? dockOptionId(paneId, highlightedKey)
              : undefined
          }
        >
          {agentRows.map((row) => (
            <DockRow
              key={row.key}
              testId="dock-agent-row"
              view={row.view}
              selected={sameView(selectedView, row.view)}
              onSelect={onSelectView}
              status={row.status}
              statusWord={statusWord(row.status)}
              name={row.label}
              description={row.description}
              meta={present([row.toolCount > 0 ? `${row.toolCount} tools` : null])}
              elapsedMs={row.elapsedMs}
              running={row.running}
              highlighted={row.key === highlightedKey}
              isTabStop={row.key === tabStopKey}
              optionId={dockOptionId(paneId, row.key)}
              onKeyDown={(e) => handleRowKeyDown(e, row.view, row.key)}
              onHighlight={onHighlightChange}
            />
          ))}
        </div>
      </DockGroup>,
    );
  }

  // Workflows — one row per orchestration run this session has launched,
  // terminal or not, oldest first, phases nested underneath with one row per
  // phase agent (D1/D2). Not gated on `state.status === "running"`: an
  // orchestration outlives its turn, so the pane sits `idle` for most of a
  // run. The header's counts sum *every* run (D1 — a finished run's tally
  // still belongs in the total), while its elapsed origin stays the oldest
  // *live* run, same reasoning as the Agents header above.
  const liveRuns = activeOrchestrations(state);
  const oldestLiveRun = liveRuns[0] ?? null;
  if (workflowRows.length > 0) {
    const single = workflowRows.length === 1 ? workflowRows[0] ?? null : null;
    const countsLabel = orchestrationCountsLabel(combinedOrchestrationCounts(state.orchestrations));
    groups.push(
      <DockGroup
        key="workflows"
        id="workflows"
        label="Workflows"
        summary={single !== null ? single.label : orchestrationLabel(state.orchestrations)}
        meta={countsLabel !== "" ? countsLabel : undefined}
        elapsed={
          oldestLiveRun === null
            ? null
            : formatElapsed(elapsedSecondsSinceMs(oldestLiveRun.startedAt))
        }
        expanded={workflowsExpanded}
        onToggle={() => toggle("workflows")}
      >
        <div
          className={styles.rows}
          data-testid="dock-workflow-rows"
          role="listbox"
          aria-label="Workflow runs"
          aria-activedescendant={
            cursorGroup === "workflows" && highlightedKey !== null
              ? dockOptionId(paneId, highlightedKey)
              : undefined
          }
        >
          {workflowRows.map((row) => {
            const stopping = stoppingTaskIds.includes(row.taskId);
            return (
              <Fragment key={row.key}>
                <DockRow
                  testId="dock-workflow-row"
                  view={row.view}
                  selected={sameView(selectedView, row.view)}
                  onSelect={onSelectView}
                  status={row.status}
                  statusWord={statusWord(row.status)}
                  name={row.label}
                  description={row.description}
                  meta={present([
                    row.counts,
                    row.totalTokens !== null ? formatTokens(row.totalTokens) : null,
                    row.running ? null : row.wireStatus,
                  ])}
                  elapsedMs={row.elapsedMs}
                  running={row.running}
                  highlighted={row.key === highlightedKey}
                  isTabStop={row.key === tabStopKey}
                  optionId={dockOptionId(paneId, row.key)}
                  onKeyDown={(e) => handleRowKeyDown(e, row.view, row.key)}
                  onHighlight={onHighlightChange}
                  trailing={
                    row.running ? (
                      <button
                        type="button"
                        className={`d3-btn d3-btn--sm ${styles.rowStop}`}
                        style={{ borderColor: "rgba(239,68,68,0.30)", color: "var(--err)" }}
                        disabled={stopping}
                        onClick={() => {
                          setStoppingTaskIds((ids) =>
                            ids.includes(row.taskId) ? ids : [...ids, row.taskId],
                          );
                          // Not optimistic: the wire's own task_updated /
                          // task_notification decides when the run's status
                          // actually flips to "stopped".
                          void agentStopTask(paneId, row.taskId).catch((err: unknown) => {
                            console.error("agentStopTask failed", err);
                          });
                        }}
                      >
                        Stop
                      </button>
                    ) : null
                  }
                />
                {row.phases.map((phase) => (
                  <div
                    className={styles.phase}
                    key={phase.key}
                    role="group"
                    aria-label={phase.title}
                  >
                    <span className={styles.phaseTitle}>{phase.title}</span>
                    {phase.agents.map((agent) => (
                      <DockRow
                        key={agent.key}
                        testId="dock-workflow-agent-row"
                        view={null}
                        indent
                        selected={false}
                        onSelect={onSelectView}
                        status={agent.status}
                        statusWord={statusWord(agent.status)}
                        name={agent.label}
                        description={agent.detail}
                        meta={present([
                          agent.agentType,
                          agent.cached ? "cached" : null,
                          agent.model,
                          agent.toolCalls !== null ? `${agent.toolCalls} calls` : null,
                          agent.tokens !== null ? formatTokens(agent.tokens) : null,
                        ])}
                        elapsedMs={agent.durationMs}
                        running={agent.running}
                      />
                    ))}
                  </div>
                ))}
              </Fragment>
            );
          })}
        </div>
      </DockGroup>,
    );
  }

  return (
    <div className={styles.dock} data-testid="agent-activity-dock" data-agent-dock>
      {groups.length > 0 ? <div className={styles.groups}>{groups}</div> : null}
      <AgentSessionHud state={state} cwd={cwd} />
    </div>
  );
}
