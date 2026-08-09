/**
 * The pane body when the picker is on something other than the main agent:
 * one sub-agent's delegated task, or one orchestration's phases and agents.
 *
 * Both render from state the pane already holds — a sub-agent from its
 * `Task`/`Agent` tool block, an orchestration from `state.orchestrations` —
 * so this is a second view of existing data, not a second source of it.
 */

import type { ReactElement } from "react";
import {
  formatDuration,
  orchestrationPhaseTree,
  type ConvToolBlock,
  type OrchestrationAgent,
  type OrchestrationRun,
} from "../../lib/agent-conversation";
import { subagentLabel } from "../../lib/agent-views";
import styles from "./agent-view-panel.module.css";

/** Elapsed rendered the same way everywhere in this panel, with a live run
 *  saying so rather than showing a number frozen at the last render. */
function Elapsed({ ms, running }: { ms: number | null; running: boolean }): ReactElement {
  if (running) return <span className={styles.live}>running</span>;
  if (ms === null) return <span className={styles.muted}>—</span>;
  return <span className={styles.muted}>{formatDuration(ms)}</span>;
}

function SubagentView({
  block,
  sessionExited,
}: {
  block: ConvToolBlock;
  sessionExited: boolean;
}): ReactElement {
  const running = block.endedAt === null && !sessionExited;
  const elapsed = block.endedAt === null ? null : block.endedAt - block.startedAt;
  return (
    <div className={styles.panel}>
      <header className={styles.head}>
        <span className={styles.title}>{subagentLabel(block)}</span>
        <span className={styles.kind}>sub-agent</span>
        <Elapsed ms={elapsed} running={running} />
      </header>

      {block.argSummary ? <p className={styles.task}>{block.argSummary}</p> : null}

      <section className={styles.section}>
        <h4 className={styles.sectionTitle}>Result</h4>
        {block.output === null ? (
          <p className={styles.muted}>
            {running ? "Still working — nothing reported back yet." : "Reported nothing back."}
          </p>
        ) : (
          <pre className={block.isError ? styles.outputError : styles.output}>{block.output}</pre>
        )}
      </section>
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

function WorkflowView({ run }: { run: OrchestrationRun }): ReactElement {
  const running = run.status === "running";
  const elapsed = run.endedAt === null ? null : run.endedAt - run.startedAt;
  const tree = orchestrationPhaseTree(run);
  return (
    <div className={styles.panel}>
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
    </div>
  );
}

export function AgentViewPanel(
  props:
    | { kind: "subagent"; block: ConvToolBlock; sessionExited: boolean }
    | { kind: "workflow"; run: OrchestrationRun },
): ReactElement {
  return props.kind === "subagent" ? (
    <SubagentView block={props.block} sessionExited={props.sessionExited} />
  ) : (
    <WorkflowView run={props.run} />
  );
}
