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
  formatDuration,
  splitInlineCode,
  type ConversationState,
  type ConvBlock,
  type ConvTurn,
} from "../../lib/agent-conversation";
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

function Turn({
  turn,
  expandedTools,
  onToggleTool,
}: {
  turn: ConvTurn;
  expandedTools: Set<string>;
  onToggleTool: (id: string) => void;
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
      {turn.blocks.map((block, i) => {
        if (block.type === "text") {
          return <TextBlock key={i} text={block.text} muted={isUser} />;
        }
        if (block.type === "tool") {
          return (
            <ToolBlockRow
              key={block.id}
              block={block}
              expanded={expandedTools.has(block.id)}
              onToggle={() => onToggleTool(block.id)}
            />
          );
        }
        return (
          <div key={i} className={styles.errorBlock}>
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
}: AgentConversationProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

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

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [state.turns, state.streamText, state.thinking]);

  const permission = state.permissions[0];
  const extraPending = Math.max(0, state.permissions.length - 1);

  return (
    <div className={styles.conv} ref={scrollRef} onScroll={handleScroll}>
      {state.turns.map((turn) => (
        <Turn
          key={turn.id}
          turn={turn}
          expandedTools={expandedTools}
          onToggleTool={toggleTool}
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
