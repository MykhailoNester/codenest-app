/**
 * The pane body when the picker is on something other than the main agent:
 * one sub-agent's delegated task and its own live stream, or one
 * orchestration's phases, agents and (when the wire provides one) its own
 * stream.
 *
 * Both render from state the pane already holds — a sub-agent from its
 * `Task`/`Agent` tool block's `childTurns`, an orchestration from
 * `state.orchestrations` plus the `Workflow` block's `childTurns` — so this
 * is a second view of existing data, not a second source of it. The stream
 * itself is rendered by `<ConversationTurns/>`, the same block renderer the
 * main transcript uses, so a sub-agent's assistant text, tool rows and
 * nested delegation cards read identically wherever they appear.
 */

import type { CSSProperties, ReactElement } from "react";
import {
  formatDuration,
  orchestrationPhaseTree,
  type ConvToolBlock,
  type ConvTurn,
  type OrchestrationAgent,
  type OrchestrationRun,
} from "../../lib/agent-conversation";
// The component module, not the lib one imported above for types — same base
// name, different directory, so no import collision, but worth flagging
// since a reader skimming the import list could otherwise mistake the two.
import { ConversationTurns } from "./agent-conversation";
import { subagentLabel } from "../../lib/agent-views";
import type { DeckState } from "../deck/deck-grid";

/* ── Local constants ─────────────────────────────────────────────────────
   The non-main pane body: one sub-agent's task, or one orchestration's
   phases. On Deck — the agent rows carry a state glyph in column one
   (`.dk-s`), the chips are `.dk-tag`, and the returned result is `.dk-out` +
   `.dk-term__b`. What is left is geometry, declared here rather than in
   `components/deck/*` or `design/deck/*`, which #283 does not touch — the
   precedent is the composer's `EDITOR_*` constants.

   Plain content: the pane's single viewport (`VIEWPORT_STYLE`, agent-pane.tsx)
   owns the scroll for every view, this one included, so switching views does
   not shift the surrounding chrome. */

const PANEL_STYLE: CSSProperties = {
  padding: "var(--u3)",
  fontFamily: "var(--mono)",
  fontSize: "var(--fs-s)",
  color: "var(--fg-2)",
};

const HEAD_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--u2)",
  height: "var(--row)",
  paddingBottom: "var(--u2)",
  borderBottom: "1px solid var(--line)",
  marginBottom: "var(--u3)",
};

const TITLE_STYLE: CSSProperties = {
  color: "var(--fg)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

/** The header's right-hand label — "sub-agent", or the run's status. */
const KIND_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  fontSize: "var(--fs-xs)",
  letterSpacing: "1.1px",
  textTransform: "uppercase",
  flex: "none",
};

/** Elapsed, in both the panel header and an agent row. `marginLeft: auto`
 *  pushes it to the right-hand end of the header, where the title does not
 *  grow; in a row it is inert, because `AGENT_LABEL_STYLE` already absorbs the
 *  slack. */
const ELAPSED_LIVE_STYLE: CSSProperties = {
  marginLeft: "auto",
  color: "var(--run)",
  flex: "none",
};

const ELAPSED_IDLE_STYLE: CSSProperties = {
  marginLeft: "auto",
  color: "var(--fg-3)",
  flex: "none",
};

/** A "nothing here" line. Block-level prose, so it takes no part in the
 *  header's flex row. */
const MUTED_STYLE: CSSProperties = { color: "var(--fg-3)" };

/** The delegated task. Sans, because it is the one paragraph of real prose on
 *  this panel and `PANEL_STYLE` sets mono for the chrome around it. `.dk-prose`
 *  is Deck's prose surface and is the wrong one here — it caps at 80ch and
 *  styles descendant markup, where this is one preformatted string in a panel
 *  that can be a third of the window wide. */
const TASK_STYLE: CSSProperties = {
  margin: "0 0 var(--u2)",
  fontFamily: "var(--sans)",
  fontSize: 13,
  lineHeight: 1.65,
  color: "var(--fg-2)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const ACTIVITY_STYLE: CSSProperties = {
  margin: "0 0 var(--u3)",
  color: "var(--run)",
};

const SECTION_STYLE: CSSProperties = { marginBottom: "var(--u4)" };

/** Deck's section-heading idiom, as an `h4` — `.dk-group__h` is an `h2` rule
 *  with its own bottom margin and page padding, which inside a 300px panel is
 *  the wrong geometry for the right type. */
const SECTION_TITLE_STYLE: CSSProperties = {
  margin: "0 0 var(--u2)",
  fontWeight: 400,
  fontSize: "var(--fs-xs)",
  letterSpacing: "1.1px",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

/** The drilled-in agent's own stream. `PANEL_STYLE` sets mono for this panel's
 *  chrome; the transcript's own blocks set their family and size for tool rows
 *  and cards, but the message, speaker and error blocks inherit theirs — so the
 *  stream restores the context they are written against rather than rendering
 *  the agent's prose in the panel's chrome font. */
const STREAM_STYLE: CSSProperties = {
  fontFamily: "var(--sans)",
  fontSize: 13,
  marginBottom: "var(--u4)",
};

/** The `<pre>` inside `.dk-out`, which takes `.dk-term__b`'s own scrolling body
 *  treatment. `wordBreak` is what keeps a returned path, stack trace or JSON
 *  blob inside the frame instead of widening the pane. */
const OUTPUT_STYLE: CSSProperties = { margin: 0, wordBreak: "break-word" };

/** Inline, so the error tone wins over `.dk-term__b`'s own colour however the
 *  bundler orders the stylesheets. */
const OUTPUT_ERROR_STYLE: CSSProperties = { ...OUTPUT_STYLE, color: "var(--err)" };

const AGENTS_STYLE: CSSProperties = { listStyle: "none", margin: 0, padding: 0 };

/** One phase agent, on the line grid: glyph, name, marks, elapsed. */
const AGENT_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--u2)",
  height: "var(--row)",
  minWidth: 0,
};

/** One character, never the thing a crowded row shrinks — `.dk-s` sets no width
 *  of its own because on a Deck grid the column does, and this row is a flex
 *  line rather than a grid. */
const AGENT_GLYPH_STYLE: CSSProperties = { flex: "none", width: 10 };

const AGENT_LABEL_STYLE: CSSProperties = {
  color: "var(--fg)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
  flex: "1 1 auto",
};

const AGENT_META_STYLE: CSSProperties = { color: "var(--fg-3)", flex: "none" };

const AGENT_ERROR_STYLE: CSSProperties = { color: "var(--err)", flex: "none" };

/** Elapsed rendered the same way everywhere in this panel, with a live run
 *  saying so rather than showing a number frozen at the last render. */
function Elapsed({ ms, running }: { ms: number | null; running: boolean }): ReactElement {
  if (running) return <span style={ELAPSED_LIVE_STYLE}>running</span>;
  if (ms === null) return <span style={ELAPSED_IDLE_STYLE}>—</span>;
  return <span style={ELAPSED_IDLE_STYLE}>{formatDuration(ms)}</span>;
}

/**
 * Three distinguishable "nothing to show" cases for the Result section, none
 * of them invented:
 *
 * - The call has usable output → a `<pre>`, unchanged from before.
 * - The call ended (`endedAt !== null`) with no usable output → "Reported
 *   nothing back." — the wire's `tool_result` genuinely carried nothing.
 * - The session exited with the call still open → "Session ended before this
 *   sub-agent reported back." — the wire never sent an end for this call at
 *   all, so claiming it "returned nothing" would report something nobody
 *   said (the same case `subagentRowStatus` already calls `ended` rather
 *   than `done`, `agent-dock.ts:194-200`).
 * - Still running → `null`. The section does not render; the stream above
 *   speaks for that case (or, with no stream yet, "Still working").
 */
function subagentResultNote(block: ConvToolBlock, sessionExited: boolean): string | null {
  if (block.endedAt !== null) return "Reported nothing back.";
  if (sessionExited) return "Session ended before this sub-agent reported back.";
  return null;
}

function SubagentView({
  block,
  sessionExited,
  onOpenSubagent,
}: {
  block: ConvToolBlock;
  sessionExited: boolean;
  onOpenSubagent: (id: string) => void;
}): ReactElement {
  const running = block.endedAt === null && !sessionExited;
  const elapsed = block.endedAt === null ? null : block.endedAt - block.startedAt;
  const hasOutput = block.output !== null && block.output.trim() !== "";
  const resultNote = hasOutput ? null : subagentResultNote(block, sessionExited);
  return (
    <div
      style={PANEL_STYLE}
      data-testid="agent-view-panel"
      data-view-kind="subagent"
    >
      <header style={HEAD_STYLE}>
        <span style={TITLE_STYLE}>{subagentLabel(block)}</span>
        <span style={KIND_STYLE}>sub-agent</span>
        <Elapsed ms={elapsed} running={running} />
      </header>

      {block.argSummary ? <p style={TASK_STYLE}>{block.argSummary}</p> : null}

      {block.childTurns.length > 0 ? (
        <section style={STREAM_STYLE} data-testid="subagent-stream">
          <ConversationTurns
            turns={block.childTurns}
            sessionExited={sessionExited}
            onOpenSubagent={onOpenSubagent}
            userLabel="Prompt"
          />
        </section>
      ) : running ? (
        <p style={MUTED_STYLE}>Still working — nothing reported back yet.</p>
      ) : null}

      {/* Always last, per the ticket: the returned result must stay the most
          useful thing in the view once it lands, however much stream sits
          above it. Rendered only when there is something to say — output, or
          the call is over one way or another; nothing at all while it is
          still running with an empty stream, since the line above already
          covers that case. */}
      {hasOutput || resultNote !== null ? (
        <section style={SECTION_STYLE}>
          <h4 style={SECTION_TITLE_STYLE}>Result</h4>
          {hasOutput ? (
            <div className="dk-out">
              <pre
                className="dk-term__b"
                style={block.isError ? OUTPUT_ERROR_STYLE : OUTPUT_STYLE}
              >
                {block.output}
              </pre>
            </div>
          ) : (
            <p style={MUTED_STYLE}>{resultNote}</p>
          )}
        </section>
      ) : null}
    </div>
  );
}

/** The four Deck states a phase agent can be in, and the word each reads as
 *  — colour is never the only carrier, so the glyph needs a text alternative
 *  as much as it needs its character. */
type AgentDeckState = Extract<DeckState, "run" | "done" | "fail" | "idle">;

const AGENT_STATE_WORD: Record<AgentDeckState, string> = {
  run: "running",
  done: "done",
  fail: "failed",
  idle: "not started",
};

function agentDeckState(state: OrchestrationAgent["state"]): AgentDeckState {
  switch (state) {
    case "start":
    case "progress":
      return "run";
    case "done":
      return "done";
    case "error":
      return "fail";
    default:
      return "idle";
  }
}

function AgentRow({ agent }: { agent: OrchestrationAgent }): ReactElement {
  const running = agent.state === "start" || agent.state === "progress";
  const deckState = agentDeckState(agent.state);
  return (
    <li style={AGENT_STYLE}>
      <span
        className="dk-s"
        style={AGENT_GLYPH_STYLE}
        role="img"
        data-s={deckState}
        aria-label={AGENT_STATE_WORD[deckState]}
      />
      <span style={AGENT_LABEL_STYLE}>{agent.label}</span>
      {agent.agentType ? <span className="dk-tag">{agent.agentType}</span> : null}
      {agent.cached ? <span className="dk-tag">cached</span> : null}
      <span style={AGENT_META_STYLE}>
        {agent.toolCalls !== null ? `${agent.toolCalls} tools` : null}
        {agent.tokens !== null ? ` · ${agent.tokens.toLocaleString("en-US")} tok` : null}
      </span>
      <Elapsed ms={agent.durationMs} running={running} />
      {agent.error ? <span style={AGENT_ERROR_STYLE}>{agent.error}</span> : null}
    </li>
  );
}

function WorkflowView({
  run,
  childTurns,
  sessionExited,
  onOpenSubagent,
}: {
  run: OrchestrationRun;
  /** `findToolBlock(state, run.toolUseId)?.childTurns` — the run's own
   *  stream, frames parented to the `Workflow` block itself. `[]` when the
   *  wire parented nothing to it (an unverified case; see the plan's Design
   *  decision 5), in which case no stream section renders at all — the phase
   *  tree above is the whole story, same as today. */
  childTurns: readonly ConvTurn[];
  sessionExited: boolean;
  onOpenSubagent: (id: string) => void;
}): ReactElement {
  const running = run.status === "running";
  const elapsed = run.endedAt === null ? null : run.endedAt - run.startedAt;
  const tree = orchestrationPhaseTree(run);
  return (
    <div
      style={PANEL_STYLE}
      data-testid="agent-view-panel"
      data-view-kind="workflow"
    >
      <header style={HEAD_STYLE}>
        <span style={TITLE_STYLE}>{run.name ?? "Workflow"}</span>
        <span style={KIND_STYLE}>{run.status}</span>
        <Elapsed ms={elapsed} running={running} />
      </header>

      {run.description ? <p style={TASK_STYLE}>{run.description}</p> : null}
      {run.activity ? <p style={ACTIVITY_STYLE}>{run.activity}</p> : null}

      {tree.map((group) => (
        <section key={group.phaseIndex ?? "unphased"} style={SECTION_STYLE}>
          <h4 style={SECTION_TITLE_STYLE}>{group.title}</h4>
          {group.agents.length === 0 ? (
            <p style={MUTED_STYLE}>Not started.</p>
          ) : (
            <ul style={AGENTS_STYLE}>
              {group.agents.map((agent) => (
                <AgentRow key={agent.index} agent={agent} />
              ))}
            </ul>
          )}
        </section>
      ))}

      {childTurns.length > 0 ? (
        <section style={STREAM_STYLE} data-testid="workflow-stream">
          <ConversationTurns
            turns={childTurns}
            sessionExited={sessionExited}
            onOpenSubagent={onOpenSubagent}
            userLabel="Prompt"
          />
        </section>
      ) : null}
    </div>
  );
}

export function AgentViewPanel(
  props:
    | {
        kind: "subagent";
        block: ConvToolBlock;
        sessionExited: boolean;
        onOpenSubagent: (id: string) => void;
      }
    | {
        kind: "workflow";
        run: OrchestrationRun;
        childTurns: readonly ConvTurn[];
        sessionExited: boolean;
        onOpenSubagent: (id: string) => void;
      },
): ReactElement {
  return props.kind === "subagent" ? (
    <SubagentView
      block={props.block}
      sessionExited={props.sessionExited}
      onOpenSubagent={props.onOpenSubagent}
    />
  ) : (
    <WorkflowView
      run={props.run}
      childTurns={props.childTurns}
      sessionExited={props.sessionExited}
      onOpenSubagent={props.onOpenSubagent}
    />
  );
}
