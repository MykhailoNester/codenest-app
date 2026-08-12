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

import type { ReactElement } from "react";
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
import styles from "./agent-view-panel.module.css";

/** Elapsed rendered the same way everywhere in this panel, with a live run
 *  saying so rather than showing a number frozen at the last render. */
function Elapsed({ ms, running }: { ms: number | null; running: boolean }): ReactElement {
  if (running) return <span className={styles.live}>running</span>;
  if (ms === null) return <span className={styles.muted}>—</span>;
  return <span className={styles.muted}>{formatDuration(ms)}</span>;
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
      className={styles.panel}
      data-testid="agent-view-panel"
      data-view-kind="subagent"
    >
      <header className={styles.head}>
        <span className={styles.title}>{subagentLabel(block)}</span>
        <span className={styles.kind}>sub-agent</span>
        <Elapsed ms={elapsed} running={running} />
      </header>

      {block.argSummary ? <p className={styles.task}>{block.argSummary}</p> : null}

      {block.childTurns.length > 0 ? (
        <section className={styles.stream} data-testid="subagent-stream">
          <ConversationTurns
            turns={block.childTurns}
            sessionExited={sessionExited}
            onOpenSubagent={onOpenSubagent}
            userLabel="Prompt"
          />
        </section>
      ) : running ? (
        <p className={styles.muted}>Still working — nothing reported back yet.</p>
      ) : null}

      {/* Always last, per the ticket: the returned result must stay the most
          useful thing in the view once it lands, however much stream sits
          above it. Rendered only when there is something to say — output, or
          the call is over one way or another; nothing at all while it is
          still running with an empty stream, since the line above already
          covers that case. */}
      {hasOutput || resultNote !== null ? (
        <section className={styles.section}>
          <h4 className={styles.sectionTitle}>Result</h4>
          {hasOutput ? (
            <pre className={block.isError ? styles.outputError : styles.output}>
              {block.output}
            </pre>
          ) : (
            <p className={styles.muted}>{resultNote}</p>
          )}
        </section>
      ) : null}
    </div>
  );
}

function AgentRow({ agent }: { agent: OrchestrationAgent }): ReactElement {
  const running = agent.state === "start" || agent.state === "progress";
  return (
    <li className={styles.agent}>
      <span className={`${styles.dot} ${styles[`dot_${agent.state}`] ?? ""}`} />
      <span className={styles.agentLabel}>{agent.label}</span>
      {agent.agentType ? <span className={styles.chip}>{agent.agentType}</span> : null}
      {agent.cached ? <span className={styles.chip}>cached</span> : null}
      <span className={styles.agentMeta}>
        {agent.toolCalls !== null ? `${agent.toolCalls} tools` : null}
        {agent.tokens !== null ? ` · ${agent.tokens.toLocaleString("en-US")} tok` : null}
      </span>
      <Elapsed ms={agent.durationMs} running={running} />
      {agent.error ? <span className={styles.err}>{agent.error}</span> : null}
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
      className={styles.panel}
      data-testid="agent-view-panel"
      data-view-kind="workflow"
    >
      <header className={styles.head}>
        <span className={styles.title}>{run.name ?? "Workflow"}</span>
        <span className={styles.kind}>{run.status}</span>
        <Elapsed ms={elapsed} running={running} />
      </header>

      {run.description ? <p className={styles.task}>{run.description}</p> : null}
      {run.activity ? <p className={styles.activity}>{run.activity}</p> : null}

      {tree.map((group) => (
        <section key={group.phaseIndex ?? "unphased"} className={styles.section}>
          <h4 className={styles.sectionTitle}>{group.title}</h4>
          {group.agents.length === 0 ? (
            <p className={styles.muted}>Not started.</p>
          ) : (
            <ul className={styles.agents}>
              {group.agents.map((agent) => (
                <AgentRow key={agent.index} agent={agent} />
              ))}
            </ul>
          )}
        </section>
      ))}

      {childTurns.length > 0 ? (
        <section className={styles.stream} data-testid="workflow-stream">
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
