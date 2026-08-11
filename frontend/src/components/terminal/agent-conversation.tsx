/**
 * Renders `ConversationState.turns` natively: user turns, assistant text
 * with inline code, collapsible tool-call rows (name, arguments, duration,
 * an inline diffstat), foldable tool output, and a streaming/thinking
 * indicator. `permissions[0]` renders `<AgentPermissionDialog/>` — the
 * clearest thing this surface does better than a redraw-heavy TUI.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  childToolCount,
  delegationElapsedMs,
  formatDuration,
  groupTurnBlocks,
  splitInlineCode,
  summarizeToolRun,
  toolRunElapsedMs,
  toolRunErrorCount,
  toolRunHeadline,
  type ConversationState,
  type ConvBlock,
  type ConvToolBlock,
  type ConvTurn,
} from "../../lib/agent-conversation";
import { subagentDescription, subagentLabel } from "../../lib/agent-views";
import { AgentMarkdown } from "./agent-markdown";
import { AgentPermissionDialog } from "./agent-permission-dialog";
import styles from "./agent-conversation.module.css";

interface AgentConversationProps {
  state: ConversationState;
  isFocusedPane: boolean;
  onAllowPermission: () => void;
  onAllowPermissionSession: () => void;
  onDenyPermission: () => void;
  /** The most recent non-permission `control` frame's synopsis, if any —
   * rendered as one muted informational row (Design decision 14). Kept
   * outside `ConversationState` because the pure reducer deliberately
   * returns the same state object for a `control` frame (pinned by a test),
   * so `<AgentPane/>` tracks this itself from the raw frame stream. */
  lastControlNote?: string | null;
  /** Opens the named `Task`/`Agent` block's own view — the sub-agent id, the
   * same one `viewKey({ kind: "subagent", id })` takes. Required rather than
   * optional (the reason `agent-session-hud.tsx`'s `paneId` gives): a second
   * mount that forgot it would silently lose the delegation card's click
   * target rather than fail to compile. */
  onOpenSubagent: (id: string) => void;
}

/**
 * One text block. The two roles render differently on purpose:
 *
 * * **A user turn is shown exactly as typed** — `splitInlineCode` for backtick
 *   spans and nothing else. Re-interpreting what the user wrote would mangle
 *   the things they most often paste: `**` around a glob, a `|`-heavy shell
 *   pipeline read as a table, `_` inside an identifier read as emphasis.
 * * **An assistant turn is markdown**, because that is what `claude` writes.
 *   Left as plain text, its tables arrived as rows of `|---|---|`.
 */
function TextBlock({ text, muted }: { text: string; muted?: boolean }): ReactElement {
  if (muted !== true) {
    return (
      <div className={styles.msg}>
        <AgentMarkdown text={text} />
      </div>
    );
  }
  const parts = splitInlineCode(text);
  return (
    <div className={`${styles.msg} ${styles.msgUser}`}>
      {parts.map((part, i) =>
        part.code ? (
          <code key={i} className={styles.code}>
            {part.text}
          </code>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </div>
  );
}

function ToolBlockRow({
  block,
  expanded,
  onToggle,
}: {
  block: Extract<ConvBlock, { type: "tool" }>;
  expanded: boolean;
  onToggle: () => void;
}): ReactElement {
  const running = block.endedAt === null;
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        className={`${styles.tool} ${running ? styles.toolRun : ""}`}
        onClick={onToggle}
      >
        <span className={styles.toolTwisty}>{expanded ? "▾" : "▸"}</span>
        <span className={styles.toolName}>{block.name}</span>
        <span className={styles.toolArgs}>{block.argSummary}</span>
        {block.diffstat ? (
          <span className={styles.diffChip}>
            <span className={styles.diffAdded}>+{block.diffstat.added}</span>{" "}
            <span className={styles.diffRemoved}>−{block.diffstat.removed}</span>
          </span>
        ) : null}
        <span className={styles.toolDur}>
          {block.endedAt === null
            ? "running"
            : formatDuration(block.endedAt - block.startedAt)}
        </span>
      </button>
      {expanded && block.output !== null ? (
        <div
          className={`${styles.toolOut} ${block.isError ? styles.toolOutError : ""}`}
        >
          {!block.isError ? <span className={styles.toolOutOk}>✓ </span> : null}
          {block.output}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A run of consecutive tool calls as one line — "Running 12 commands,
 * reading 3 files" — with the still-running (or last finished) call named
 * underneath, mirroring the CLI's own collapsed summary. Expanding swaps in
 * the individual `ToolBlockRow`s, so nothing is lost, it is just not the
 * default. Twenty separate rows per turn is what made the pane unreadable.
 */
function ToolRunRow({
  blocks,
  expanded,
  onToggle,
  expandedTools,
  onToggleTool,
}: {
  blocks: ConvToolBlock[];
  expanded: boolean;
  onToggle: () => void;
  expandedTools: Set<string>;
  onToggleTool: (id: string) => void;
}): ReactElement {
  const elapsed = toolRunElapsedMs(blocks);
  const running = elapsed === null;
  const headline = toolRunHeadline(blocks);
  const errors = toolRunErrorCount(blocks);
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        className={`${styles.tool} ${styles.toolRunGroup} ${running ? styles.toolRun : ""}`}
        onClick={onToggle}
      >
        <span className={styles.toolTwisty}>{expanded ? "▾" : "▸"}</span>
        <span className={styles.toolName}>{summarizeToolRun(blocks)}</span>
        {errors > 0 ? (
          <span className={styles.toolRunErrors}>
            {errors} failed
          </span>
        ) : null}
        <span className={styles.toolDur}>
          {running ? "running" : formatDuration(elapsed)}
        </span>
      </button>
      {!expanded && headline ? (
        <div className={styles.toolRunHead}>
          <span className={styles.toolRunHeadTick}>└</span>
          <span className={styles.toolName}>{headline.name}</span>
          <span className={styles.toolArgs}>{headline.argSummary}</span>
        </div>
      ) : null}
      {expanded ? (
        <div className={styles.toolRunList}>
          {blocks.map((block) => (
            <ToolBlockRow
              key={block.id}
              block={block}
              expanded={expandedTools.has(block.id)}
              onToggle={() => onToggleTool(block.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The card a `Task`/`Agent` delegation renders instead of the machine-written
 * prompt that used to land in the main transcript as a `YOU` turn: agent
 * name, one-line task, live/ended status, elapsed time, and a tool count once
 * the sub-agent has made a call. Clicking it opens that sub-agent's own view
 * (`onOpen`, wired to `setSelectedView({ kind: "subagent", id })` at the
 * pane).
 *
 * The clock is component-local and gated on `running` (Design decision 5),
 * mirroring `agent-session-hud.tsx`'s own ticker: five parallel delegations
 * mean five small intervals, each re-rendering only its own card, rather than
 * one ticker re-rendering the whole transcript.
 */
function DelegationCard({
  block,
  sessionExited,
  onOpen,
}: {
  block: ConvToolBlock;
  sessionExited: boolean;
  onOpen: (id: string) => void;
}): ReactElement {
  const running = block.endedAt === null && !sessionExited;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const label = subagentLabel(block);
  const description = subagentDescription(block);
  const tools = childToolCount(block);
  const statusWord = running ? "running" : block.isError ? "failed" : "done";

  return (
    <button
      type="button"
      className={styles.delegation}
      onClick={() => onOpen(block.id)}
      aria-label={`Open sub-agent ${label}`}
    >
      <span className={styles.delegationName}>
        → {label}
      </span>
      {description ? <span className={styles.delegationTask}>{description}</span> : null}
      <span className={`${styles.delegationMeta} ${running ? styles.delegationLive : ""}`}>
        {statusWord} · {formatDuration(delegationElapsedMs(block, now))}
        {tools > 0 ? ` · ${tools} tools` : ""}
      </span>
    </button>
  );
}

function Turn({
  turn,
  expandedTools,
  onToggleTool,
  expandedRuns,
  onToggleRun,
  sessionExited,
  onOpenSubagent,
}: {
  turn: ConvTurn;
  expandedTools: Set<string>;
  onToggleTool: (id: string) => void;
  expandedRuns: Set<string>;
  onToggleRun: (key: string) => void;
  sessionExited: boolean;
  onOpenSubagent: (id: string) => void;
}): ReactElement {
  const isUser = turn.role === "user";
  return (
    <div className={styles.turn}>
      <div className={styles.who}>
        <span className={isUser ? styles.whoUser : styles.whoAsst}>
          {isUser ? "You" : "Claude"}
        </span>
        <span className={styles.ln} />
      </div>
      {groupTurnBlocks(turn.blocks).map((group) => {
        if (group.kind === "toolRun") {
          return (
            <ToolRunRow
              key={group.key}
              blocks={group.blocks}
              expanded={expandedRuns.has(group.key)}
              onToggle={() => onToggleRun(group.key)}
              expandedTools={expandedTools}
              onToggleTool={onToggleTool}
            />
          );
        }
        if (group.kind === "delegation") {
          return (
            <DelegationCard
              key={group.key}
              block={group.block}
              sessionExited={sessionExited}
              onOpen={onOpenSubagent}
            />
          );
        }
        const block = group.block;
        if (block.type === "text") {
          return <TextBlock key={group.key} text={block.text} muted={isUser} />;
        }
        if (block.type === "tool") {
          return (
            <ToolBlockRow
              key={group.key}
              block={block}
              expanded={expandedTools.has(block.id)}
              onToggle={() => onToggleTool(block.id)}
            />
          );
        }
        return (
          <div key={group.key} className={styles.errorBlock}>
            {block.text}
          </div>
        );
      })}
    </div>
  );
}

export function AgentConversation({
  state,
  isFocusedPane,
  onAllowPermission,
  onAllowPermissionSession,
  onDenyPermission,
  lastControlNote,
  onOpenSubagent,
}: AgentConversationProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());

  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 40;
  }

  function toggleTool(id: string): void {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleRun(key: string): void {
    setExpandedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [state.turns, state.streamText, state.thinking]);

  const permission = state.permissions[0];
  const extraPending = Math.max(0, state.permissions.length - 1);

  // A pending permission request blocks the session, so it is scrolled into
  // view whether or not the user was stuck to the bottom — unlike ordinary
  // output, which must not yank a scrolled-back reader down. Without this, a
  // request that arrived while reading scrollback left the pane looking hung
  // with the dialog off screen; and when the next request in a queue took the
  // first one's place, the replacement could render below the fold.
  useEffect(() => {
    if (permission === undefined) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
  }, [permission]);

  return (
    <div className={styles.conv} ref={scrollRef} onScroll={handleScroll}>
      {state.turns.map((turn) => (
        <Turn
          key={turn.id}
          turn={turn}
          expandedTools={expandedTools}
          onToggleTool={toggleTool}
          expandedRuns={expandedRuns}
          onToggleRun={toggleRun}
          sessionExited={state.status === "exited"}
          onOpenSubagent={onOpenSubagent}
        />
      ))}

      {state.thinking ? (
        <div className={styles.thinking}>
          <em /> thinking · ~{state.thinkingTokens} tokens
        </div>
      ) : null}

      {state.streaming && state.streamText.length > 0 ? (
        <div className={styles.streaming}>
          <em /> {state.streamText}
        </div>
      ) : null}

      {lastControlNote ? <div className={styles.control}>{lastControlNote}</div> : null}

      {permission ? (
        <>
          <AgentPermissionDialog
            request={permission}
            isFocusedPane={isFocusedPane}
            pendingBehind={extraPending}
            onAllow={onAllowPermission}
            onAllowSession={onAllowPermissionSession}
            onDeny={onDenyPermission}
          />
          {extraPending > 0 ? (
            <div className={styles.morePending}>
              {extraPending} more request{extraPending === 1 ? "" : "s"} waiting
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
