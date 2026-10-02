/**
 * Renders `ConversationState.turns` natively: user turns, assistant text
 * with inline code, collapsible tool-call rows (name, arguments, duration,
 * an inline diffstat), foldable tool output, and a streaming/thinking
 * indicator. `permissions[0]` renders `<AgentPermissionDialog/>` — the
 * clearest thing this surface does better than a redraw-heavy TUI.
 *
 * Scrolling belongs to `<AgentPane/>`, not here: it owns the single
 * `.viewport` element every body view (this one, a sub-agent drill-in, a
 * workflow drill-in) shares, and per-view scroll position/stick-to-bottom, so
 * one component measures and restores it rather than each view keeping its
 * own copy of that logic. See `agent-pane.tsx`'s `scrollMemoryRef` for why.
 */

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import {
  ASK_USER_QUESTION_TOOL,
  childToolCount,
  delegationElapsedMs,
  formatDuration,
  groupTurnBlocks,
  parseAgentQuestions,
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
import { AgentQuestionDialog } from "./agent-question-dialog";
import { StreamingDot } from "./pane-motion";

/* ── Local constants ─────────────────────────────────────────────────────
   The transcript, on Deck. Every colour and size comes from Deck's own tokens
   (`--fg*`, `--bg*`, `--line*`, `--err/--warn/--ok/--run`, `--fs*`, `--u*`).
   Deck draws rows on a grid; a transcript is a stack of mixed-width blocks, so
   the shapes below are declared here rather than in `components/deck/*` or
   `design/deck/*`, which #283 does not touch — the precedent is the composer's
   `EDITOR_*` constants.

   Plain content — filling the pane and scrolling belong to the pane's single
   viewport (`VIEWPORT_STYLE`, agent-pane.tsx), which this renders inside. */

const CONV_STYLE: CSSProperties = { padding: "var(--u3)" };

const TURN_STYLE: CSSProperties = { marginBottom: "var(--u4)" };

/** Who is speaking, as a Deck section label: uppercase, dim, with the rule
 *  running out to the pane edge. */
const WHO_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--u2)",
  marginBottom: "var(--u)",
  fontSize: "var(--fs-xs)",
  letterSpacing: "1.1px",
  textTransform: "uppercase",
};

const WHO_USER_STYLE: CSSProperties = { color: "var(--fg-3)" };
const WHO_ASST_STYLE: CSSProperties = { color: "var(--fg-2)" };
const WHO_RULE_STYLE: CSSProperties = {
  flex: 1,
  height: 1,
  background: "var(--line)",
};

const MSG_STYLE: CSSProperties = {
  fontFamily: "var(--sans)",
  fontSize: 13,
  lineHeight: 1.65,
  color: "var(--fg-2)",
  whiteSpace: "pre-wrap",
};

/** What the user typed, quoted: a rule on the left rather than a fill, which
 *  is the only kind of emphasis Deck draws. */
const MSG_USER_STYLE: CSSProperties = {
  ...MSG_STYLE,
  padding: "var(--u) var(--u3)",
  borderLeft: "2px solid var(--line-2)",
  color: "var(--fg-3)",
};

const CODE_STYLE: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: "var(--fs-s)",
  color: "var(--fg)",
  background: "var(--sel)",
  padding: "0 3px",
  borderRadius: 2,
};

/* ── Tool rows ───────────────────────────────────────────────────────────
   One line each, mono, on the grid's own row height. No fill and no border: a
   tool call is a line in a list, not a card. `.dk-line` is Deck's own row and
   is the wrong primitive — it is a fixed-height CSS grid with a declared column
   template, where these rows are a flex line whose parts size to their own
   content and whose expansion grows the block. */

const TOOL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--u2)",
  width: "100%",
  minHeight: "var(--row)",
  padding: "0 var(--u2)",
  borderRadius: 2,
  fontFamily: "var(--mono)",
  fontSize: "var(--fs-s)",
  color: "var(--fg-2)",
  textAlign: "left",
  cursor: "pointer",
};

/** A call still in flight reads at full strength. */
const TOOL_RUNNING_STYLE: CSSProperties = { ...TOOL_STYLE, color: "var(--fg)" };

const TOOL_HOVER_STYLE: CSSProperties = {
  ...TOOL_STYLE,
  background: "var(--sel)",
  color: "var(--fg)",
};

function toolRowStyle(running: boolean, hover: boolean): CSSProperties {
  if (hover) return TOOL_HOVER_STYLE;
  return running ? TOOL_RUNNING_STYLE : TOOL_STYLE;
}

const TOOL_TWISTY_STYLE: CSSProperties = {
  color: "var(--fg-4)",
  width: 9,
  flex: "none",
};

const TOOL_NAME_STYLE: CSSProperties = { color: "var(--fg)", flex: "none" };

/** The call named on a running row takes the live tone. */
const TOOL_NAME_RUNNING_STYLE: CSSProperties = { color: "var(--run)", flex: "none" };

/** A collapsed run of consecutive tool calls. The summary is prose, not a tool
 *  name, so it takes the ordinary foreground rather than the accent — the run
 *  is a heading for the rows beneath it, not a call in its own right. It also
 *  absorbs the row's slack, which a single call's name does not. */
const TOOL_RUN_SUMMARY_STYLE: CSSProperties = {
  color: "var(--fg)",
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** The one call named under a collapsed run — muted, so it never competes with
 *  the summary above it. */
const TOOL_RUN_HEAD_NAME_STYLE: CSSProperties = {
  color: "var(--fg-2)",
  flex: "none",
};

const TOOL_ARGS_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  flex: "1 1 auto",
  minWidth: 0,
};

const TOOL_DUR_STYLE: CSSProperties = {
  marginLeft: "auto",
  color: "var(--fg-3)",
  flex: "none",
};

/** A call's returned output. `wordBreak` is what keeps a path, a stack trace or
 *  a one-line JSON payload inside the pane instead of widening it. */
const TOOL_OUT_STYLE: CSSProperties = {
  margin: "0 0 var(--u2) var(--u4)",
  padding: "var(--u) var(--u2)",
  borderLeft: "1px solid var(--line-2)",
  fontFamily: "var(--mono)",
  fontSize: "var(--fs-xs)",
  lineHeight: 1.7,
  color: "var(--fg-3)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const TOOL_OUT_ERROR_STYLE: CSSProperties = {
  ...TOOL_OUT_STYLE,
  color: "var(--err)",
  borderLeftColor: "var(--err)",
};

const TOOL_OUT_OK_STYLE: CSSProperties = { color: "var(--ok)" };

const TOOL_RUN_ERRORS_STYLE: CSSProperties = { color: "var(--err)", flex: "none" };

/** Indented under the summary, to read as its child. */
const TOOL_RUN_HEAD_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--u2)",
  padding: "0 var(--u2) 0 var(--u3)",
  fontFamily: "var(--mono)",
  fontSize: "var(--fs-xs)",
  color: "var(--fg-3)",
  minWidth: 0,
};

const TOOL_RUN_HEAD_TICK_STYLE: CSSProperties = { color: "var(--fg-4)", flex: "none" };

/** Expanded: the individual rows, indented so the run they belong to stays
 *  visible as their parent. */
const TOOL_RUN_LIST_STYLE: CSSProperties = {
  marginLeft: "var(--u3)",
  borderLeft: "1px solid var(--line)",
  paddingLeft: "var(--u2)",
};

const DIFF_CHIP_STYLE: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: "var(--fs-xs)",
  flex: "none",
};

const DIFF_ADDED_STYLE: CSSProperties = { color: "var(--ok)" };
const DIFF_REMOVED_STYLE: CSSProperties = { color: "var(--err)" };

/** One delegation card per `Task`/`Agent` call, in place of the machine-written
 *  prompt that used to render as a `YOU` turn. A sibling of the tool row — the
 *  same line, given two extra rows for the task and its status, and the one
 *  left rule in the transcript that carries colour, because it is the one thing
 *  here that opens a different view (`agent-view-panel.tsx`'s `SubagentView`,
 *  rendered through this same set of styles). */
const DELEGATION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 2,
  width: "100%",
  margin: "var(--u) 0",
  padding: "var(--u) var(--u3)",
  borderLeft: "2px solid var(--run)",
  fontFamily: "var(--mono)",
  fontSize: "var(--fs-s)",
  color: "var(--fg-2)",
  textAlign: "left",
  cursor: "pointer",
};

const DELEGATION_HOVER_STYLE: CSSProperties = {
  ...DELEGATION_STYLE,
  background: "var(--sel)",
};

const DELEGATION_NAME_STYLE: CSSProperties = { color: "var(--run)" };
const DELEGATION_TASK_STYLE: CSSProperties = {
  color: "var(--fg)",
  whiteSpace: "normal",
};
const DELEGATION_META_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  fontSize: "var(--fs-xs)",
};
const DELEGATION_META_LIVE_STYLE: CSSProperties = {
  ...DELEGATION_META_STYLE,
  color: "var(--run)",
};

const ERROR_BLOCK_STYLE: CSSProperties = {
  margin: "var(--u) 0",
  padding: "var(--u) var(--u2)",
  background: "var(--err-bg)",
  borderLeft: "2px solid var(--err)",
  borderRadius: "0 2px 2px 0",
  fontFamily: "var(--mono)",
  fontSize: "var(--fs-s)",
  color: "var(--err)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const CONTROL_STYLE: CSSProperties = {
  margin: "var(--u) 0",
  fontFamily: "var(--mono)",
  fontSize: "var(--fs-xs)",
  color: "var(--fg-3)",
};

const STREAMING_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--u2)",
  color: "var(--run)",
  fontSize: "var(--fs-s)",
  fontFamily: "var(--mono)",
};

const THINKING_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--u2)",
  color: "var(--fg-3)",
  fontSize: "var(--fs-s)",
  fontFamily: "var(--mono)",
};

const MORE_PENDING_STYLE: CSSProperties = {
  marginTop: "var(--u)",
  fontFamily: "var(--mono)",
  fontSize: "var(--fs-xs)",
  color: "var(--fg-3)",
};

/** `:hover` has no inline form, and both of this file's clickable blocks need
 *  one — a row that does not react to the pointer does not read as openable. */
function useHover(): [boolean, { onMouseEnter: () => void; onMouseLeave: () => void }] {
  const [hover, setHover] = useState(false);
  return [
    hover,
    { onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) },
  ];
}

interface AgentConversationProps {
  state: ConversationState;
  isFocusedPane: boolean;
  onAllowPermission: () => void;
  onAllowPermissionSession: () => void;
  onDenyPermission: () => void;
  /** Answers an `AskUserQuestion` ask: an allow carrying the user's selection
   *  as `updatedInput`, instead of the echo `onAllowPermission` sends. */
  onAnswerQuestion: (updatedInput: Record<string, unknown>) => void;
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
      <div style={MSG_STYLE}>
        <AgentMarkdown text={text} />
      </div>
    );
  }
  const parts = splitInlineCode(text);
  return (
    <div style={MSG_USER_STYLE}>
      {parts.map((part, i) =>
        part.code ? (
          <code key={i} style={CODE_STYLE}>
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
  const [hover, hoverProps] = useHover();
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        style={toolRowStyle(running, hover)}
        onClick={onToggle}
        {...hoverProps}
      >
        <span style={TOOL_TWISTY_STYLE}>{expanded ? "▾" : "▸"}</span>
        <span style={running ? TOOL_NAME_RUNNING_STYLE : TOOL_NAME_STYLE}>
          {block.name}
        </span>
        <span style={TOOL_ARGS_STYLE}>{block.argSummary}</span>
        {block.diffstat ? (
          <span style={DIFF_CHIP_STYLE}>
            <span style={DIFF_ADDED_STYLE}>+{block.diffstat.added}</span>{" "}
            <span style={DIFF_REMOVED_STYLE}>−{block.diffstat.removed}</span>
          </span>
        ) : null}
        <span style={TOOL_DUR_STYLE}>
          {block.endedAt === null
            ? "running"
            : formatDuration(block.endedAt - block.startedAt)}
        </span>
      </button>
      {expanded && block.output !== null ? (
        <div style={block.isError ? TOOL_OUT_ERROR_STYLE : TOOL_OUT_STYLE}>
          {!block.isError ? <span style={TOOL_OUT_OK_STYLE}>✓ </span> : null}
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
  const [hover, hoverProps] = useHover();
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        style={toolRowStyle(running, hover)}
        onClick={onToggle}
        {...hoverProps}
      >
        <span style={TOOL_TWISTY_STYLE}>{expanded ? "▾" : "▸"}</span>
        <span style={TOOL_RUN_SUMMARY_STYLE}>{summarizeToolRun(blocks)}</span>
        {errors > 0 ? (
          <span style={TOOL_RUN_ERRORS_STYLE}>
            {errors} failed
          </span>
        ) : null}
        <span style={TOOL_DUR_STYLE}>
          {running ? "running" : formatDuration(elapsed)}
        </span>
      </button>
      {!expanded && headline ? (
        <div style={TOOL_RUN_HEAD_STYLE}>
          <span style={TOOL_RUN_HEAD_TICK_STYLE}>└</span>
          <span style={TOOL_RUN_HEAD_NAME_STYLE}>{headline.name}</span>
          <span style={TOOL_ARGS_STYLE}>{headline.argSummary}</span>
        </div>
      ) : null}
      {expanded ? (
        <div style={TOOL_RUN_LIST_STYLE}>
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
  const [hover, hoverProps] = useHover();

  return (
    <button
      type="button"
      style={hover ? DELEGATION_HOVER_STYLE : DELEGATION_STYLE}
      onClick={() => onOpen(block.id)}
      aria-label={`Open sub-agent ${label}`}
      {...hoverProps}
    >
      <span style={DELEGATION_NAME_STYLE}>
        → {label}
      </span>
      {description ? <span style={DELEGATION_TASK_STYLE}>{description}</span> : null}
      <span style={running ? DELEGATION_META_LIVE_STYLE : DELEGATION_META_STYLE}>
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
  userLabel,
}: {
  turn: ConvTurn;
  expandedTools: Set<string>;
  onToggleTool: (id: string) => void;
  expandedRuns: Set<string>;
  onToggleRun: (key: string) => void;
  sessionExited: boolean;
  onOpenSubagent: (id: string) => void;
  userLabel: string;
}): ReactElement {
  const isUser = turn.role === "user";
  return (
    <div style={TURN_STYLE}>
      <div style={WHO_STYLE}>
        <span style={isUser ? WHO_USER_STYLE : WHO_ASST_STYLE}>
          {isUser ? userLabel : "Claude"}
        </span>
        <span style={WHO_RULE_STYLE} />
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
          <div key={group.key} style={ERROR_BLOCK_STYLE}>
            {block.text}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The single renderer for *any* `ConvTurn[]` — the main transcript below and
 * every child stream a sub-agent or an orchestration run has of its own
 * (`agent-view-panel.tsx`'s drill-in views). Owns the tool-run/tool-call
 * expansion sets, `Turn` alone is not a reusable unit — a caller would have
 * to reimplement `expandedTools`/`expandedRuns` and both toggles, which is a
 * second copy of state logic that can drift. Existing to prevent exactly
 * that: one implementation of the block rendering in the whole tree.
 *
 * Renders a fragment, not a wrapper element, so `<AgentConversation/>` below
 * keeps its own `.conv`/`data-testid="agent-conversation"` exactly as before,
 * and a drill-in view can supply its own wrapper without nesting `.conv`'s
 * padding or gaining a testid `agent-pane-render.test.tsx` asserts is absent
 * there.
 */
export function ConversationTurns({
  turns,
  sessionExited,
  onOpenSubagent,
  userLabel = "You",
}: {
  turns: readonly ConvTurn[];
  sessionExited: boolean;
  onOpenSubagent: (id: string) => void;
  /** How the user role reads for *these* turns. A child stream's first turn
   *  is the delegated prompt, not something the pane's own user typed —
   *  rendering it as "You" would reintroduce the lie #17 removed from the
   *  main transcript, so the drill-in views pass `"Prompt"`. Defaults to
   *  `"You"`, which is correct for the main transcript's own turns. */
  userLabel?: string;
}): ReactElement {
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());

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

  return (
    <>
      {turns.map((turn) => (
        <Turn
          key={turn.id}
          turn={turn}
          expandedTools={expandedTools}
          onToggleTool={toggleTool}
          expandedRuns={expandedRuns}
          onToggleRun={toggleRun}
          sessionExited={sessionExited}
          onOpenSubagent={onOpenSubagent}
          userLabel={userLabel}
        />
      ))}
    </>
  );
}

export function AgentConversation({
  state,
  isFocusedPane,
  onAllowPermission,
  onAllowPermissionSession,
  onDenyPermission,
  onAnswerQuestion,
  lastControlNote,
  onOpenSubagent,
}: AgentConversationProps): ReactElement {
  const permission = state.permissions[0];
  const extraPending = Math.max(0, state.permissions.length - 1);
  // `null` for anything but a well-formed `AskUserQuestion` — including a
  // malformed one, which keeps the generic dialog rather than rendering an
  // empty question box.
  const questions = useMemo(
    () =>
      permission?.toolName === ASK_USER_QUESTION_TOOL
        ? parseAgentQuestions(permission.input)
        : null,
    [permission],
  );

  return (
    <div style={CONV_STYLE} data-testid="agent-conversation">
      <ConversationTurns
        turns={state.turns}
        sessionExited={state.status === "exited"}
        onOpenSubagent={onOpenSubagent}
      />

      {state.thinking ? (
        <div style={THINKING_STYLE}>
          <em /> thinking · ~{state.thinkingTokens} tokens
        </div>
      ) : null}

      {state.streaming && state.streamText.length > 0 ? (
        <div style={STREAMING_STYLE}>
          <StreamingDot /> {state.streamText}
        </div>
      ) : null}

      {lastControlNote ? <div style={CONTROL_STYLE}>{lastControlNote}</div> : null}

      {permission ? (
        <>
          {questions !== null ? (
            <AgentQuestionDialog
              key={permission.requestId}
              request={permission}
              questions={questions}
              isFocusedPane={isFocusedPane}
              pendingBehind={extraPending}
              onAnswer={onAnswerQuestion}
              onDeny={onDenyPermission}
            />
          ) : (
            <AgentPermissionDialog
              request={permission}
              isFocusedPane={isFocusedPane}
              pendingBehind={extraPending}
              onAllow={onAllowPermission}
              onAllowSession={onAllowPermissionSession}
              onDeny={onDenyPermission}
            />
          )}
          {extraPending > 0 ? (
            <div style={MORE_PENDING_STYLE}>
              {extraPending} more request{extraPending === 1 ? "" : "s"} waiting
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
