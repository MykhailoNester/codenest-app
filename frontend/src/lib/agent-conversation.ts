/**
 * Pure frame → conversation reducer for the native agent pane.
 *
 * No React, no zustand, no IPC — every export here is a plain function or
 * type, testable with hand-built `AgentFrame` objects. `stores/agent-session-store.ts`
 * is the only production caller; it wraps `applyFrame` in a zustand `set()`
 * and layers the cross-store side effects (Design decision 12 in the plan).
 *
 * Every read of `frame.raw` (typed `unknown` — see `lib/ipc.ts`) goes through
 * the local `asRecord`/`asString`/`asArray`/`asNumber`/`asBool` narrowing
 * helpers below, never a direct index, so a frame shaped nothing like the
 * captured CLI 2.1.220 wire (a future Claude Code version, a malformed line)
 * degrades the reducer's output instead of throwing.
 */

import type { AgentFrame } from "./ipc";

// ---------------------------------------------------------------------------
// Narrowing helpers — every `raw` read goes through one of these.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Conversation types
// ---------------------------------------------------------------------------

export interface ConvTextBlock {
  type: "text";
  text: string;
}

/** Cap on rendered tool output, matching `MAX_TEXT_CHARS` at `frame.rs:143` —
 * the Rust side already caps stderr/parse-error text at this size, so this
 * only bites `tool_result` output, which is not synthetic. */
export const MAX_TOOL_OUTPUT_CHARS = 4000;

export interface ConvToolBlock {
  type: "tool";
  /** The wire's `tool_use.id`, matched against a later `tool_result.tool_use_id`. */
  id: string;
  name: string;
  argSummary: string;
  input: unknown;
  diffstat: { added: number; removed: number } | null;
  /** `null` while the call is in flight (`endedAt === null`). */
  output: string | null;
  startedAt: number;
  endedAt: number | null;
  isError: boolean;
}

export interface ConvErrorBlock {
  type: "error";
  text: string;
  source: "stderr" | "stdout";
}

export type ConvBlock = ConvTextBlock | ConvToolBlock | ConvErrorBlock;

export interface ConvTurn {
  id: string;
  role: "user" | "assistant";
  at: number;
  blocks: ConvBlock[];
}

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  displayName: string | null;
  input: unknown;
  description: string | null;
  toolUseId: string | null;
  /**
   * `request.decision_reason` — the CLI's own words for why this ask escalated,
   * which it documents as being "for the consent line of the host's dialog".
   * For a compound Bash command (`decision_reason_type: "subcommandResults"`)
   * this is the *nested* check's warning, i.e. the part of the command that
   * actually needs approving.
   */
  decisionReason: string | null;
  /** `request.decision_reason_type` — `"classifier"`, `"mode"`, `"rule"`,
   *  `"asyncAgent"`, or `"subcommandResults"` for a decomposed Bash command. */
  decisionReasonType: string | null;
  /** `request.blocked_path` — set when a path outside the allowed roots is what
   *  triggered the ask. */
  blockedPath: string | null;
  /** See `permissionSessionKey` — what "Allow for this session" auto-answers. */
  sessionKey: string;
}

export interface ConversationState {
  turns: ConvTurn[];
  status: "starting" | "idle" | "running" | "exited";
  streaming: boolean;
  streamText: string;
  thinking: boolean;
  thinkingTokens: number;
  sessionId: string | null;
  model: string | null;
  /**
   * The permission mode the *session* is running, as reported by the CLI —
   * from the `init` frame's `permissionMode`, then from the `control_response`
   * to each `set_permission_mode` request. Authoritative over anything the UI
   * asked for, because the CLI normalises (`manual` is applied as `default`)
   * and can refuse. `null` until `init` arrives.
   */
  permissionMode: string | null;
  /**
   * Why the last mode switch did not take, verbatim from the CLI's error
   * `control_response`; `null` once one succeeds. The reachable case is a mode
   * gated off in this session — `bypassPermissions` without
   * `--dangerously-skip-permissions` at spawn, or `auto` where the CLI gates
   * it — since an unrecognised mode is rejected synchronously in Rust.
   */
  permissionModeError: string | null;
  /** FIFO — `permissions[0]` is the one rendered as a dialog. */
  permissions: PermissionRequest[];
  lastResult: {
    costUsd: number | null;
    durationMs: number | null;
    isError: boolean;
  } | null;
  /**
   * When the CLI's `init` frame arrived, i.e. when this session became usable.
   * Deliberately not "when the pane mounted": the status strip's elapsed cell
   * must count the session's life, and the gap between spawn and `init` belongs
   * to neither. `null` until the session initialises.
   */
  startedAt: number | null;
  /**
   * Token accounting from the newest `result` frame — the only frame that
   * reports it. `contextTokens` is what the turn actually sent (fresh input plus
   * both cache halves, matching how the CLI itself counts context);
   * `contextWindow` comes from `modelUsage[<model>].contextWindow` and is `null`
   * when the frame carries no entry for the running model, in which case the
   * strip shows tokens without a percentage rather than inventing a denominator.
   * `null` overall until the first turn completes.
   */
  usage: {
    contextTokens: number;
    contextWindow: number | null;
    outputTokens: number | null;
  } | null;
  exitCode: number | null;
}

export function emptyConversation(): ConversationState {
  return {
    turns: [],
    status: "starting",
    streaming: false,
    streamText: "",
    thinking: false,
    thinkingTokens: 0,
    sessionId: null,
    model: null,
    permissionMode: null,
    permissionModeError: null,
    permissions: [],
    lastResult: null,
    startedAt: null,
    usage: null,
    exitCode: null,
  };
}

// ---------------------------------------------------------------------------
// Turn helpers
// ---------------------------------------------------------------------------

function lastTurn(state: ConversationState): ConvTurn | undefined {
  return state.turns[state.turns.length - 1];
}

/**
 * Append `blocks` to the trailing assistant turn, or open a new one — a
 * model's response is often several frames (text, then a tool call, then more
 * text) that all belong in one visual bubble (prototype `.turn`, which mixes
 * `.msg`/`.tool`/`.toolout` freely). The boundary between one assistant turn
 * and the next is always a `user` turn in between, so "the trailing turn is
 * already an assistant turn" is exactly the right test. An empty `blocks`
 * array is a no-op — never adds an empty turn (a `thinking`-only frame, once
 * its non-renderable block is dropped, must not become a blank bubble).
 */
function appendAssistantBlocks(
  state: ConversationState,
  blocks: ConvBlock[],
  now: number,
): ConversationState {
  if (blocks.length === 0) return state;
  const last = lastTurn(state);
  if (last && last.role === "assistant") {
    const updated: ConvTurn = { ...last, blocks: [...last.blocks, ...blocks] };
    return { ...state, turns: [...state.turns.slice(0, -1), updated] };
  }
  const turn: ConvTurn = {
    id: `assistant-${state.turns.length}-${now}`,
    role: "assistant",
    at: now,
    blocks,
  };
  return { ...state, turns: [...state.turns, turn] };
}

/** Appends an error block to the trailing turn (any role) — errors are never
 * dropped, but they also never open their own turn kind. Opens a fresh
 * assistant-role turn only when the conversation has nothing yet. */
function appendErrorBlock(
  state: ConversationState,
  block: ConvErrorBlock,
  now: number,
): ConversationState {
  const last = lastTurn(state);
  if (!last) {
    return {
      ...state,
      turns: [{ id: `error-0-${now}`, role: "assistant", at: now, blocks: [block] }],
    };
  }
  const updated: ConvTurn = { ...last, blocks: [...last.blocks, block] };
  return { ...state, turns: [...state.turns.slice(0, -1), updated] };
}

/** Finds the tool block matching `toolUseId` across every assistant turn and
 * fills in its result. A miss (no matching `tool_use_id`) is ignored — never
 * thrown — since a future CLI could legally emit a result for a call this
 * pane never saw (e.g. reconnecting mid-turn). */
function withToolResult(
  state: ConversationState,
  toolUseId: string,
  output: string,
  isError: boolean,
  now: number,
): ConversationState {
  let found = false;
  const turns = state.turns.map((turn) => {
    if (turn.role !== "assistant") return turn;
    let touched = false;
    const blocks = turn.blocks.map((block): ConvBlock => {
      if (block.type === "tool" && block.id === toolUseId) {
        found = true;
        touched = true;
        return { ...block, output, endedAt: now, isError };
      }
      return block;
    });
    return touched ? { ...turn, blocks } : turn;
  });
  if (!found) return state;
  return { ...state, turns };
}

// ---------------------------------------------------------------------------
// Tool-call rendering helpers
// ---------------------------------------------------------------------------

const TOOL_ARG_KEY: Record<string, string> = {
  Bash: "command",
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  Glob: "pattern",
  Grep: "pattern",
  Task: "description",
};

/** `Bash`→`command`, `Read|Edit|Write`→`file_path`, `Glob|Grep`→`pattern`,
 * `Task`→`description`, else the first string value in `input`; `""` when
 * nothing matches. */
export function toolArgSummary(name: string, input: unknown): string {
  const rec = asRecord(input);
  if (!rec) return "";
  const key = TOOL_ARG_KEY[name];
  if (key !== undefined) {
    const value = asString(rec[key]);
    if (value !== undefined) return value;
  }
  for (const value of Object.values(rec)) {
    const s = asString(value);
    if (s !== undefined) return s;
  }
  return "";
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

/** `Edit`: line counts of `new_string`/`old_string`. `Write`: lines of
 * `content` added, 0 removed. `MultiEdit`: summed over `edits[]`. Otherwise
 * `null` — no diffstat chip is rendered rather than a fake one. */
export function toolDiffstat(
  name: string,
  input: unknown,
): { added: number; removed: number } | null {
  const rec = asRecord(input);
  if (!rec) return null;
  if (name === "Edit") {
    return {
      added: countLines(asString(rec["new_string"]) ?? ""),
      removed: countLines(asString(rec["old_string"]) ?? ""),
    };
  }
  if (name === "Write") {
    return { added: countLines(asString(rec["content"]) ?? ""), removed: 0 };
  }
  if (name === "MultiEdit") {
    const edits = asArray(rec["edits"]) ?? [];
    let added = 0;
    let removed = 0;
    for (const editRaw of edits) {
      const edit = asRecord(editRaw);
      added += countLines(asString(edit?.["new_string"]) ?? "");
      removed += countLines(asString(edit?.["old_string"]) ?? "");
    }
    return { added, removed };
  }
  return null;
}

/**
 * The two tool names Claude Code launches a sub-agent under. Both spellings are
 * live: the sidecar's own attribution matches
 * `tool_name IN ('Agent','Task')` (`app/services/agent_service.py:1047-1049`).
 */
export const SUBAGENT_TOOL_NAMES: readonly string[] = ["Task", "Agent"];

export function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.includes(name);
}

/** One sub-agent call this pane's session has launched and not yet heard back
 *  from. Every field is a value the wire supplied; absent fields are `null`. */
export interface SubagentCall {
  /** The wire's `tool_use.id` — the same key the transcript row uses. May be
   *  `""` when the wire omitted it (see `blocksFromAssistantContent`, :386). */
  id: string;
  /** `"Task"` or `"Agent"`, verbatim off the wire. */
  toolName: string;
  /** `input.subagent_type` — the sub-agent's name. `null` when the call named
   *  none (never a placeholder, never the string "unknown"). */
  subagentType: string | null;
  /** `input.description` — the one-line task. `null` when absent or empty. */
  description: string | null;
  /** Arrival time of the `tool_use` frame, epoch ms (the block's `startedAt`). */
  startedAt: number;
}

/**
 * Every `Task`/`Agent` call this session has launched and not yet heard back
 * from, oldest first.
 *
 * `[]` on an exited session — a dead process cannot have anything in flight,
 * and claiming otherwise would be the same lie D11 of the session-state-hud
 * plan forbids for the running-tool cell (see `agent-session-hud.tsx`'s doc
 * comment). Folding the check in here, rather than at each call site, means
 * every consumer (the HUD cell, the composer badge, the future orchestration
 * cell) gets it for free.
 *
 * Deliberately returned oldest-first with no sort: blocks are appended in
 * frame-arrival order, so a plain forward walk already yields that order —
 * sorting would only cost cycles to reproduce what iteration order already
 * guarantees.
 */
export function activeSubagents(state: ConversationState): SubagentCall[] {
  if (state.status === "exited") return [];
  const calls: SubagentCall[] = [];
  for (const turn of state.turns) {
    for (const block of turn.blocks) {
      if (block.type !== "tool" || block.endedAt !== null) continue;
      if (!isSubagentTool(block.name)) continue;
      const input = asRecord(block.input);
      calls.push({
        id: block.id,
        toolName: block.name,
        subagentType: asString(input?.["subagent_type"]) || null,
        description: asString(input?.["description"]) || null,
        startedAt: block.startedAt,
      });
    }
  }
  return calls;
}

/** `"340ms"` under a second, `"1.2s"` at or above it. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Splits `text` on backtick spans for `.msg code` rendering. Always returns
 * at least one segment, even for an empty string. */
export function splitInlineCode(
  text: string,
): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  const regex = /`([^`]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ code: false, text: text.slice(lastIndex, match.index) });
    }
    parts.push({ code: true, text: match[1] ?? "" });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length || parts.length === 0) {
    parts.push({ code: false, text: text.slice(lastIndex) });
  }
  return parts;
}

function blocksFromAssistantContent(
  content: unknown[],
  now: number,
): ConvBlock[] {
  const blocks: ConvBlock[] = [];
  for (const raw of content) {
    const block = asRecord(raw);
    const type = asString(block?.["type"]);
    if (type === "text") {
      blocks.push({ type: "text", text: asString(block?.["text"]) ?? "" });
    } else if (type === "tool_use") {
      const name = asString(block?.["name"]) ?? "";
      const input = block?.["input"];
      blocks.push({
        type: "tool",
        id: asString(block?.["id"]) ?? "",
        name,
        argSummary: toolArgSummary(name, input),
        input,
        diffstat: toolDiffstat(name, input),
        output: null,
        startedAt: now,
        endedAt: null,
        isError: false,
      });
    }
    // "thinking" (redacted text, per Design decision 6) and any other block
    // type are intentionally not rendered as a conversation block.
  }
  return blocks;
}

function flattenToolResultContent(content: unknown): string {
  const asPlainString = asString(content);
  if (asPlainString !== undefined) return asPlainString;
  const arr = asArray(content);
  if (!arr) return "";
  return arr
    .map((entry) => {
      const rec = asRecord(entry);
      return asString(rec?.["type"]) === "text" ? (asString(rec?.["text"]) ?? "") : "";
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Permission session key (Design decision 7)
// ---------------------------------------------------------------------------

/**
 * Derives the "Allow for this session" auto-answer key from a captured
 * `can_use_tool` `request` object (the frame's `raw.request`, not the whole
 * envelope): `` `${toolName} ${firstRuleContent ?? "*"}` ``. Captured data,
 * so allowing one `curl …` does not silently allow every future `Bash` call
 * — a request with no suggestions falls back to the bare tool name plus
 * `"*"`.
 */
export function permissionSessionKey(request: unknown): string {
  const rec = asRecord(request);
  const toolName = asString(rec?.["tool_name"]) ?? "";
  const suggestions = asArray(rec?.["permission_suggestions"]);
  const first = suggestions && suggestions.length > 0 ? asRecord(suggestions[0]) : undefined;
  const rules = first ? asArray(first["rules"]) : undefined;
  const firstRule = rules && rules.length > 0 ? asRecord(rules[0]) : undefined;
  const ruleContent = firstRule ? asString(firstRule["ruleContent"]) : undefined;
  return `${toolName} ${ruleContent ?? "*"}`;
}

// ---------------------------------------------------------------------------
// User-turn / wire-line helpers (composer side)
// ---------------------------------------------------------------------------

/**
 * Structural subset of `stores/composer-store.ts`'s `ContextPill` needed to
 * render the composed message. Declared locally rather than imported so this
 * leaf module and the composer store — which imports `buildUserMessageText`
 * from here — cannot form a cycle; TypeScript's structural typing makes the
 * real `ContextPill[]` assignable here without either file importing the
 * other (Design decision 11: the store dependency graph is a DAG).
 */
export type UserMessagePill =
  | { kind: "file"; path: string }
  | { kind: "task"; taskId: number; title: string; description: string | null }
  | { kind: "template"; slug: string; title: string; body: string };

/**
 * One attached pill as the text the agent receives.
 *
 * The body matters as much as the title. A task's description is the actual
 * instruction — "Get the weather in Lviv" titled a task whose description asked
 * for *the same day last year*, and sending the title alone got an answer about
 * today. A template is entirely its body; its title is just the label the user
 * picked it by. Sending only titles made both attachments decorative.
 *
 * A file pill stays a path: the agent reads the file itself, and inlining
 * contents here would duplicate what its own Read gives it, at the cost of the
 * user's context window.
 */
function pillBlock(pill: UserMessagePill): string {
  switch (pill.kind) {
    case "file":
      return `@file: ${pill.path}`;
    case "task": {
      const header = `@task #${pill.taskId}: ${pill.title}`;
      const body = pill.description?.trim();
      return body ? `${header}\n${body}` : header;
    }
    case "template": {
      const header = `@template: ${pill.title}`;
      const body = pill.body.trim();
      return body ? `${header}\n${body}` : header;
    }
  }
}

/**
 * The exact text a send transmits: one block per pill, then a blank line, then
 * the draft. With no pills, the draft is sent verbatim.
 *
 * Blocks are separated by a blank line rather than a newline because a block can
 * now be several lines — without it, one pill's description would read as part of
 * the next pill's header.
 */
export function buildUserMessageText(
  pills: UserMessagePill[],
  draft: string,
): string {
  if (pills.length === 0) return draft;
  const header = pills.map(pillBlock).join("\n\n");
  return `${header}\n\n${draft}`;
}

/**
 * The literal stdin line `agent::frame::encode_user_message` writes for
 * `text` (see the plan's step 13 and the paired Rust test
 * `encode_user_message_line_is_byte_exact`). `serde_json` on that side has no
 * `preserve_order` feature (verified with `cargo tree -e features -i
 * serde_json`), so its output keys are alphabetical — this object literal's
 * keys are written in that same alphabetical order (JS preserves insertion
 * order for string keys) so `JSON.stringify` produces an identical string
 * without a manual sort step.
 */
export function previewUserMessageLine(text: string): string {
  return JSON.stringify({
    message: { content: [{ text, type: "text" }], role: "user" },
    type: "user",
  });
}

/** Appends an optimistic user turn and marks the conversation running — the
 * CLI never echoes a plain user turn back (Design decision 5, verified
 * against all three captured sessions), so this is the only place a user
 * turn is added for a message this pane itself sent. */
export function appendUserTurn(
  state: ConversationState,
  text: string,
  now: number,
): ConversationState {
  const turn: ConvTurn = {
    id: `user-${state.turns.length}-${now}`,
    role: "user",
    at: now,
    blocks: [{ type: "text", text }],
  };
  return { ...state, turns: [...state.turns, turn], status: "running" };
}

// ---------------------------------------------------------------------------
// Per-kind frame application
// ---------------------------------------------------------------------------

function applyInit(
  state: ConversationState,
  frame: AgentFrame,
  now: number,
): ConversationState {
  const rec = asRecord(frame.raw);
  const model = asString(rec?.["model"]);
  // `init` is the only frame that states the mode the session actually booted
  // with, which is the CLI's own configured default whenever the spawn passed
  // no `--permission-mode` flag — so the composer can show the truth instead
  // of guessing at a default it does not own.
  const permissionMode = asString(rec?.["permissionMode"]);
  return {
    ...state,
    sessionId: frame.session_id,
    model: model ?? state.model,
    permissionMode: permissionMode ?? state.permissionMode,
    permissionModeError: null,
    status: "idle",
    // A restart re-inits the same pane, so the clock restarts with the new
    // session rather than carrying the dead one's start time forward.
    startedAt: now,
  };
}

function applyDelta(state: ConversationState, raw: unknown): ConversationState {
  const rec = asRecord(raw);
  const event = asRecord(rec?.["event"]);
  const delta = asRecord(event?.["delta"]);
  const deltaType = asString(delta?.["type"]);
  if (deltaType === "text_delta") {
    const text = asString(delta?.["text"]) ?? "";
    return { ...state, streaming: true, streamText: state.streamText + text };
  }
  if (deltaType === "thinking_delta") {
    const tokens = asNumber(delta?.["estimated_tokens"]);
    return {
      ...state,
      thinking: true,
      thinkingTokens: tokens ?? state.thinkingTokens,
    };
  }
  // "input_json_delta" and any other event/delta shape: the final
  // `assistant`/`tool_use` frame carries the parsed input, so streamed tool
  // argument JSON is intentionally not rendered.
  return state;
}

function applyAssistantOrToolUse(
  state: ConversationState,
  raw: unknown,
  now: number,
): ConversationState {
  const rec = asRecord(raw);
  const content = asArray(asRecord(rec?.["message"])?.["content"]) ?? [];
  const blocks = blocksFromAssistantContent(content, now);
  // The assistant frame always replaces the streaming scratch buffer with
  // its real text (Design decision 6) — closing it here, before appending,
  // means a following frame never doubles up on already-rendered text.
  const closed: ConversationState = { ...state, streaming: false, streamText: "" };
  return appendAssistantBlocks(closed, blocks, now);
}

function applyToolResult(
  state: ConversationState,
  raw: unknown,
  now: number,
): ConversationState {
  const rec = asRecord(raw);
  const content0 = asArray(asRecord(rec?.["message"])?.["content"])?.[0];
  const block = asRecord(content0);
  const toolUseId = asString(block?.["tool_use_id"]);
  if (!toolUseId) return state;
  const output = flattenToolResultContent(block?.["content"]).slice(
    0,
    MAX_TOOL_OUTPUT_CHARS,
  );
  const isError = asBool(block?.["is_error"]) ?? false;
  return withToolResult(state, toolUseId, output, isError, now);
}

/** A plain user turn, deduped against the last user turn's concatenated text
 * (Design decision 5) — defensive against a future CLI that starts echoing. */
function applyUserFrame(
  state: ConversationState,
  raw: unknown,
  now: number,
): ConversationState {
  const rec = asRecord(raw);
  const content = asArray(asRecord(rec?.["message"])?.["content"]);
  if (!content) return state;
  const text = content
    .map((b) => {
      const rec2 = asRecord(b);
      return asString(rec2?.["type"]) === "text" ? (asString(rec2?.["text"]) ?? "") : "";
    })
    .join("");

  const last = lastTurn(state);
  if (last && last.role === "user") {
    const lastText = last.blocks
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    if (lastText === text) return state;
  }

  const turn: ConvTurn = {
    id: `user-echo-${state.turns.length}-${now}`,
    role: "user",
    at: now,
    blocks: [{ type: "text", text }],
  };
  return { ...state, turns: [...state.turns, turn] };
}

function applyResult(state: ConversationState, raw: unknown): ConversationState {
  const rec = asRecord(raw);
  return {
    ...state,
    status: "idle",
    streaming: false,
    thinking: false,
    streamText: "",
    lastResult: {
      costUsd: asNumber(rec?.["total_cost_usd"]) ?? null,
      durationMs: asNumber(rec?.["duration_ms"]) ?? null,
      isError: asBool(rec?.["is_error"]) ?? false,
    },
    usage: readResultUsage(rec, state.model) ?? state.usage,
  };
}

/**
 * Token accounting out of a `result` frame, or `undefined` when the frame
 * carries none (in which case the caller keeps the previous figures rather than
 * blanking the strip mid-session).
 *
 * Shape verified against CLI 2.1.220:
 * `usage: {input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
 * output_tokens}` and `modelUsage: {"<model>": {contextWindow, …}}`.
 */
function readResultUsage(
  rec: Record<string, unknown> | undefined,
  model: string | null,
): ConversationState["usage"] | undefined {
  const usage = asRecord(rec?.["usage"]);
  if (!usage) return undefined;
  const input = asNumber(usage["input_tokens"]);
  const cacheRead = asNumber(usage["cache_read_input_tokens"]);
  const cacheCreate = asNumber(usage["cache_creation_input_tokens"]);
  if (input === undefined && cacheRead === undefined && cacheCreate === undefined) {
    return undefined;
  }
  const contextTokens = (input ?? 0) + (cacheRead ?? 0) + (cacheCreate ?? 0);

  // Prefer the entry for the model actually running; fall back to the sole
  // entry when there is exactly one, and to no window at all otherwise — a
  // multi-model turn has no single context window to report.
  const modelUsage = asRecord(rec?.["modelUsage"]);
  let window: number | null = null;
  if (modelUsage) {
    const named = model !== null ? asRecord(modelUsage[model]) : undefined;
    const entries = Object.values(modelUsage);
    const only = entries.length === 1 ? asRecord(entries[0]) : undefined;
    window = asNumber((named ?? only)?.["contextWindow"]) ?? null;
  }

  return {
    contextTokens,
    contextWindow: window,
    outputTokens: asNumber(usage["output_tokens"]) ?? null,
  };
}

function applyPermission(state: ConversationState, raw: unknown): ConversationState {
  const rec = asRecord(raw);
  const req = asRecord(rec?.["request"]);
  const request: PermissionRequest = {
    requestId: asString(rec?.["request_id"]) ?? "",
    toolName: asString(req?.["tool_name"]) ?? "",
    displayName: asString(req?.["display_name"]) ?? null,
    input: req?.["input"],
    description: asString(req?.["description"]) ?? null,
    toolUseId: asString(req?.["tool_use_id"]) ?? null,
    decisionReason: asString(req?.["decision_reason"]) ?? null,
    decisionReasonType: asString(req?.["decision_reason_type"]) ?? null,
    blockedPath: asString(req?.["blocked_path"]) ?? null,
    sessionKey: permissionSessionKey(req),
  };
  return { ...state, permissions: [...state.permissions, request] };
}

/**
 * The one line of `request.input` worth showing above the Allow/Deny buttons:
 * the command for `Bash`, the path for a file tool, the pattern for a search,
 * the URL for a fetch — falling back to compact JSON for a tool this does not
 * know (including MCP tools, whose input shapes are arbitrary).
 *
 * This exists because the dialog used to render `description` alone, and for
 * many asks the CLI sends no `description` at all — so every request read
 * "This tool call requires approval", identically. Two different asks in a row
 * were then indistinguishable from one click having been dropped, which is
 * exactly how a Bash command that decomposes into several subcommand checks
 * (`decision_reason_type: "subcommandResults"`) presents itself.
 */
export function permissionInputSummary(toolName: string, input: unknown): string | null {
  const rec = asRecord(input);
  if (!rec) return null;
  const command = asString(rec["command"]);
  // `$` prefix so a shell command reads as one at a glance — the single most
  // common ask, and the one where seeing the exact string matters most.
  if (command !== undefined && command.length > 0) {
    return toolName === "Bash" ? `$ ${command}` : command;
  }
  const preferred = ["file_path", "path", "url", "pattern", "notebook_path"];
  for (const key of preferred) {
    const value = asString(rec[key]);
    if (value !== undefined && value.length > 0) return value;
  }
  // Unknown shape (an MCP tool, or a tool whose salient field is not a string):
  // compact JSON is still an honest answer, and truncating keeps a giant
  // `Write` body from pushing the buttons off screen.
  try {
    const json = JSON.stringify(rec);
    if (json === undefined || json === "{}") return null;
    return json.length > 300 ? `${json.slice(0, 300)}…` : json;
  } catch {
    return null;
  }
}

function applySystem(
  state: ConversationState,
  raw: unknown,
  now: number,
): ConversationState {
  const rec = asRecord(raw);
  const subtype = asString(rec?.["subtype"]);
  if (subtype === "status" && asString(rec?.["status"]) === "requesting") {
    return { ...state, status: "running" };
  }
  // `{"type":"system","subtype":"permission_denied", tool_name, tool_use_id,
  //   decision_reason_type?, decision_reason?, message}` — a tool call the CLI
  // refused *without* asking us: a deny rule, the auto-mode classifier, or
  // `dontAsk` mode, which denies anything not already pre-approved.
  //
  // The CLI emits this event for exactly this reason ("so SDK hosts can render
  // the denial instead of only seeing an is_error tool_result"). Dropping it is
  // what made a `dontAsk` session look broken rather than strict: no dialog
  // appeared, nothing was logged, and the only trace was the model narrating
  // "Bash is denied in this mode" a turn later.
  if (subtype === "permission_denied") {
    const tool = asString(rec?.["tool_name"]) ?? "tool";
    const message = asString(rec?.["message"]);
    const reason = asString(rec?.["decision_reason"]);
    const reasonType = asString(rec?.["decision_reason_type"]);
    // `mode` is the case a user can act on — it means the pane's own permission
    // mode refused the call — so name it rather than leaving a bare "denied".
    const cause = reason ?? (reasonType === "mode" ? "denied by this pane's permission mode" : null);
    const detail = [cause, message].filter((p): p is string => Boolean(p)).join(" — ");
    return appendErrorBlock(
      state,
      {
        type: "error",
        text: `⊘ ${tool} denied without asking${detail ? `: ${detail}` : ""}`,
        source: "stdout",
      },
      now,
    );
  }
  // `{"type":"system","subtype":"thinking_tokens","estimated_tokens":N}` — the
  // CLI's own running estimate, emitted as a system frame rather than only as a
  // `thinking_delta` (both shapes captured from 2.1.220). Without this branch
  // the status strip's thinking cell stays dark through an entire extended-
  // thinking turn, since the delta form only appears in some streams.
  if (subtype === "thinking_tokens") {
    const tokens = asNumber(rec?.["estimated_tokens"]);
    return {
      ...state,
      thinking: true,
      thinkingTokens: tokens ?? state.thinkingTokens,
    };
  }
  return state;
}

function applyErrorFrame(
  state: ConversationState,
  raw: unknown,
  now: number,
): ConversationState {
  const rec = asRecord(raw);
  const text = asString(rec?.["text"]) ?? asString(rec?.["error"]) ?? "";
  const source: ConvErrorBlock["source"] =
    asString(rec?.["source"]) === "stderr" ? "stderr" : "stdout";
  return appendErrorBlock(state, { type: "error", text, source }, now);
}

function applyExit(state: ConversationState, raw: unknown): ConversationState {
  const rec = asRecord(raw);
  const exitCodeRaw = rec?.["exit_code"];
  return {
    ...state,
    status: "exited",
    exitCode: typeof exitCodeRaw === "number" ? exitCodeRaw : null,
  };
}

/**
 * Fold a `control_response` into the state. One `control` frame kind carries
 * the answer to every control request the app sends — `interrupt`, `set_model`,
 * `set_permission_mode` — and the responses are not correlated back to their
 * request here, so this reads only fields that identify themselves:
 *
 * * `response.response.mode` — a `set_permission_mode` success. The value is
 *   the *applied* mode, which differs from the requested one for the `manual`
 *   alias (applied as `default`), so it is what the UI must display.
 * * `response.error` mentioning the permission mode — a refusal. Matching on
 *   the CLI's own message ("Cannot set permission mode…" / "Cannot set
 *   permission mode to bypassPermissions because…", both verified against CLI
 *   2.1.220) is what keeps a `set_model` failure from being blamed on the mode
 *   switcher. Any other error stays a `lastControlNote` breadcrumb.
 */
function applyControl(
  state: ConversationState,
  raw: unknown,
): ConversationState {
  const response = asRecord(asRecord(raw)?.["response"]);
  if (!response) return state;
  const applied = asString(asRecord(response["response"])?.["mode"]);
  if (applied !== undefined) {
    return { ...state, permissionMode: applied, permissionModeError: null };
  }
  const error = asString(response["error"]);
  if (error !== undefined && error.toLowerCase().includes("permission mode")) {
    return { ...state, permissionModeError: error };
  }
  return state;
}

/**
 * Reduces one `AgentFrame` into the next `ConversationState`. `now` (browser
 * `Date.now()` in production) is injected rather than read internally so
 * tests are deterministic (Design decision 10 — every clock in this task is
 * frontend-only; nothing here touches SQLite or a Python datetime).
 */
export function applyFrame(
  state: ConversationState,
  frame: AgentFrame,
  now: number,
): ConversationState {
  switch (frame.kind) {
    case "init":
      return applyInit(state, frame, now);
    case "delta":
      return applyDelta(state, frame.raw);
    case "assistant":
    case "tool_use":
      return applyAssistantOrToolUse(state, frame.raw, now);
    case "tool_result":
      return applyToolResult(state, frame.raw, now);
    case "user":
      return applyUserFrame(state, frame.raw, now);
    case "result":
      return applyResult(state, frame.raw);
    case "permission":
      return applyPermission(state, frame.raw);
    case "system":
      return applySystem(state, frame.raw, now);
    case "stderr":
    case "error":
      return applyErrorFrame(state, frame.raw, now);
    case "exit":
      return applyExit(state, frame.raw);
    case "control":
      return applyControl(state, frame.raw);
    case "unknown":
      return state;
    default:
      return state;
  }
}
