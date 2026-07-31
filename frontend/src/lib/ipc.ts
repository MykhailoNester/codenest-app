import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type Event, type EventName } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

// ---------------------------------------------------------------------------
// Native filesystem pickers
// ---------------------------------------------------------------------------

/**
 * Open the native macOS directory picker (single selection).
 *
 * Returns the absolute path of the chosen directory, or `null` when the user
 * cancels.  Uses `@tauri-apps/plugin-dialog` with the `dialog:allow-open`
 * capability already granted in `src-tauri/capabilities/default.json`.
 */
export async function pickDirectory(): Promise<string | null> {
  const result = await openDialog({ directory: true, multiple: false });
  if (typeof result === "string") return result;
  return null;
}

// ---------------------------------------------------------------------------
// Sidecar types + commands
// ---------------------------------------------------------------------------

export interface SidecarStatus {
  running: boolean;
  version: string | null;
  pid: number | null;
}

export type SidecarState = "starting" | "ready" | "crashed";

export async function getSidecarStatus(): Promise<SidecarStatus> {
  return invoke<SidecarStatus>("get_sidecar_status");
}

/** How often the readiness poll re-checks `get_sidecar_status`. */
const SIDECAR_POLL_INTERVAL_MS = 600;

/**
 * Expose the sidecar lifecycle as a three-state value: "starting" | "ready" |
 * "crashed".
 *
 * Readiness is driven by a RETRYING POLL of `get_sidecar_status` (the
 * authoritative Rust-side snapshot of the sidecar's running flag), NOT by the
 * fire-and-forget Tauri events. Tauri events are not retained or replayed, so
 * on a fast (warm) reopen `sidecar_ready` can be emitted in the gap before the
 * `listen()` subscription attaches — the event is then lost forever. The old
 * implementation also relied on a single one-shot `get_sidecar_status` call
 * that, if it resolved before the Rust thread flipped `running=true`, left the
 * state on "starting" with no retry — the root cause of the app getting stuck
 * on the "Initializing workspace…" splash on reopen.
 *
 * The poll cannot dead-end: it keeps re-checking until it observes `running`,
 * so a missed event still resolves to "ready" within ~1 poll interval. The
 * `sidecar_ready` / `sidecar_crashed` events are kept purely as an early-exit
 * optimization that short-circuits the poll the instant they're received.
 */
export function useSidecarState(): SidecarState {
  const [state, setState] = useState<SidecarState>("starting");

  // Events are an optimization only — they may be missed. The poll is the
  // authoritative, self-healing signal. A late "ready" via poll always wins
  // over a transient "crashed" (e.g. after a bounded respawn recovers).
  useEvent<SidecarStatus>("sidecar_ready", () => setState("ready"));
  useEvent<null>("sidecar_crashed", () =>
    setState((prev) => (prev === "ready" ? prev : "crashed")),
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      let running = false;
      try {
        running = (await getSidecarStatus()).running;
      } catch {
        // Sidecar not reachable yet (IPC error / shell still wiring up) —
        // treat as "not ready" and keep polling.
      }
      if (cancelled) return;
      if (running) {
        setState("ready");
        return; // Resolved — stop the poll.
      }
      timer = setTimeout(() => void poll(), SIDECAR_POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return state;
}

// ---------------------------------------------------------------------------
// PTY / terminal commands
// ---------------------------------------------------------------------------

export interface TerminalHandle {
  id: string;
}

export interface OpenTerminalArgs {
  cwd?: string;
  /**
   * Optional environment variable overlay.  Each entry is set on the spawned
   * shell's environment WITHOUT clearing the inherited env — only the supplied
   * keys are added or replaced.
   */
  env?: Record<string, string>;
  /**
   * Optional shell binary path (e.g. `/bin/bash`).  Overrides `$SHELL` for
   * this pane only.  The path must exist and be executable; the Rust command
   * returns an error if not.
   */
  shell?: string;
}

export interface TerminalInputArgs {
  id: string;
  /** Base64-encoded bytes. */
  data: string;
}

export interface ResizeTerminalArgs {
  id: string;
  cols: number;
  rows: number;
}

export interface CloseTerminalArgs {
  id: string;
}

export async function openTerminal(
  args: OpenTerminalArgs,
): Promise<TerminalHandle> {
  return invoke<TerminalHandle>("open_terminal", { args });
}

export async function sendTerminalInput(
  id: string,
  data: string,
): Promise<void> {
  // Encode as UTF-8 bytes first, then base64 — `btoa(data)` would throw on
  // any character outside the Latin-1 range (emoji, accented chars, etc.).
  const bytes = new TextEncoder().encode(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  const encoded = btoa(binary);
  return invoke<void>("terminal_input", { args: { id, data: encoded } });
}

export async function resizeTerminal(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke<void>("terminal_resize", { args: { id, cols, rows } });
}

export async function closeTerminal(id: string): Promise<void> {
  return invoke<void>("close_terminal", { args: { id } });
}

// ---------------------------------------------------------------------------
// Popout terminals window
// ---------------------------------------------------------------------------

/**
 * Open the dedicated terminals window, or focus it if already open.
 * The Rust command performs focus-or-create so this is safe to call
 * unconditionally.
 */
export async function openTerminalsWindow(): Promise<void> {
  await invoke<void>("open_terminals_window");
}

/**
 * Close the detached terminals window.
 *
 * Pass `force = true` when the caller has already verified there are no
 * remaining panes (e.g. after the last agent-Stop cleanup).  When `force`
 * is false the command is a no-op on the Rust side.
 */
export async function closeTerminalsWindow(force: boolean): Promise<void> {
  await invoke<void>("close_terminals_window", { force });
}

/**
 * Emit a `focus-pane` event to the `terminals` window so it can activate
 * the tab that contains `paneId`.  No-op when the window does not exist.
 */
export async function emitFocusPaneToTerminals(paneId: string): Promise<void> {
  await invoke<void>("emit_focus_pane_to_terminals", { paneId });
}

/**
 * Emit a `stop-agent-pane` event to the `terminals` window.
 *
 * The terminals window's `TerminalWindowRoot` listens for this event,
 * removes the pane from its layout via `closePane`, and closes itself
 * when no panes remain.  Call AFTER `closeTerminal(paneId)` to kill the PTY.
 * No-op when the terminals window does not exist.
 */
export async function emitStopAgentPaneToTerminals(
  paneId: string,
): Promise<void> {
  await invoke<void>("emit_stop_agent_pane_to_terminals", { paneId });
}

/** Number of currently-active PTY sessions across all windows. */
export async function getActiveTerminalCount(): Promise<number> {
  return invoke<number>("get_active_terminal_count");
}

/**
 * Every pane id the shell still holds a child for — PTYs and agent sessions
 * from both windows, since one manager pair serves the whole app process.
 *
 * The input to run reconciliation: the shell owns the processes, so this is the
 * only authoritative answer to "is this pane still alive?", and comparing it
 * against the `running` rows is what clears sessions whose end was never
 * reported (window torn down mid-report, app quit, crash, sidecar unreachable).
 */
export async function listLivePanes(): Promise<string[]> {
  return invoke<string[]>("list_live_panes");
}

// ---------------------------------------------------------------------------
// PTY lifecycle events
// ---------------------------------------------------------------------------

export interface PtyExitedPayload {
  id: string;
  exit_code: number | null;
}

/**
 * Subscribe to `pty-exited` events for a specific terminal id.
 * The handler fires once when the shell process exits naturally (EOF on the
 * PTY master side).  The unlisten function is called automatically on unmount
 * or when `terminalId` changes.
 */
export function usePtyExited(
  terminalId: string | null,
  handler: (payload: PtyExitedPayload) => void,
): void {
  useEffect(() => {
    if (!terminalId) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listen<PtyExitedPayload>("pty-exited", (raw) => {
      if (raw.payload.id === terminalId) {
        handler(raw.payload);
      }
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);
}

// ---------------------------------------------------------------------------
// Agent pane — duplex `claude` session bindings
//
// Bridges `src-tauri/src/agent/mod.rs`'s four existing commands plus
// `agent_respond_permission` (added alongside this frontend). camelCase args
// throughout — `AgentStartArgs`/`AgentPermissionArgs` are `#[serde(rename_all
// = "camelCase")]` on the Rust side, matching `commands/hooks.rs`'s
// `HookProbeArgs` convention rather than `session/mod.rs`'s snake_case one
// (see the plan's Design decision 12 for why the two conventions diverge).
// ---------------------------------------------------------------------------

/**
 * Routing hint for one stream-json frame — mirrors
 * `agent::frame::AgentFrameKind` exactly (`src-tauri/src/agent/frame.rs`).
 * `raw` on {@link AgentFrame} is always the authoritative payload; `kind`
 * only tells the UI branch which renderer to reach for, so a brand-new
 * Claude Code frame subtype degrades to `"unknown"` rather than being lost.
 */
export type AgentFrameKind =
  | "init"
  | "delta"
  | "assistant"
  | "user"
  | "tool_use"
  | "tool_result"
  | "result"
  | "permission"
  | "control"
  | "system"
  | "unknown"
  | "stderr"
  | "error"
  | "exit";

/**
 * One `agent_frame:{pane_id}` event payload. Snake_case, matching the Rust
 * struct's serialize side verbatim (no `rename_all` there either). `raw` is
 * `unknown` — read it only through the narrowing helpers in
 * `lib/agent-conversation.ts`.
 */
export interface AgentFrame {
  pane_id: string;
  session_id: string;
  kind: AgentFrameKind;
  raw: unknown;
}

export interface AgentStartArgs {
  paneId: string;
  cwd: string;
  /** The selected provider's `command_template`. Only its first token is used,
   * and a token the shell can't exec (an alias like `claude-work`) falls back
   * to `claude` — the alias's real payload travels in `env`. */
  command?: string;
  /** The selected provider's `default_env` — notably `CLAUDE_CONFIG_DIR`,
   * without which the child authenticates against the default `~/.claude`
   * config and every turn fails with a 401. */
  env?: Record<string, string>;
  model?: string;
  agent?: string;
  permissionMode?: string;
  allowedTools?: string;
}

export interface AgentSessionHandle {
  pane_id: string;
  session_id: string;
  pid: number;
}

/** Answers one `can_use_tool` permission request (frame kind `"permission"`). */
export interface AgentRespondPermissionArgs {
  paneId: string;
  requestId: string;
  allow: boolean;
  /** Always the echo of `request.input` for an allow. */
  updatedInput?: unknown;
  /** Deny reason. */
  message?: string;
}

/** Start a duplex `claude` session for `args.paneId`. Errors when a session
 * is already registered for that pane — the caller must `agentStop` first. */
export async function agentStart(
  args: AgentStartArgs,
): Promise<AgentSessionHandle> {
  return invoke<AgentSessionHandle>("agent_start", { args });
}

/** Write one user turn to the session's stdin. */
export async function agentSend(paneId: string, text: string): Promise<void> {
  await invoke<void>("agent_send", { args: { paneId, text } });
}

/** Ask `claude` to interrupt the current turn. The session stays alive for
 * the next turn — interrupt is not stop. */
export async function agentInterrupt(paneId: string): Promise<void> {
  await invoke<void>("agent_interrupt", { args: { paneId } });
}

/** Stop a pane's session (SIGTERM, grace, SIGKILL on the process group).
 * Idempotent — an unknown pane resolves without error. */
export async function agentStop(paneId: string): Promise<void> {
  await invoke<void>("agent_stop", { args: { paneId } });
}

/**
 * Switch the model of a session that is already running — what `/model` does
 * in the TUI. The conversation, the session id and the pane survive; the next
 * assistant message simply carries the new model. Rejects when the pane has no
 * live session, so a caller that changed the model of a dead pane should fall
 * back to starting it with the new model instead.
 */
export async function agentSetModel(
  paneId: string,
  model: string,
): Promise<void> {
  await invoke<void>("agent_set_model", { args: { paneId, model } });
}

/**
 * Switch the permission mode of a session that is already running — what
 * Shift+Tab does in the TUI, which a `--print` child has no way to receive.
 * The conversation, the session id and the pane all survive.
 *
 * Resolving means "the request reached the child's stdin", not "the mode
 * changed": the CLI answers asynchronously with a `control_response` that
 * arrives as a `"control"` frame, and it can still refuse a mode this side
 * considers valid (`bypassPermissions` unless the session was spawned with
 * `--dangerously-skip-permissions`). Read the applied mode from
 * `ConversationState.permissionMode` (`lib/agent-conversation.ts`), which
 * follows that response.
 *
 * Rejects synchronously on an unknown mode or a pane with no live session.
 */
export async function agentSetPermissionMode(
  paneId: string,
  mode: string,
): Promise<void> {
  await invoke<void>("agent_set_permission_mode", { args: { paneId, mode } });
}

/** Answer a `can_use_tool` permission request over the same stdin the
 * session already owns (C2 in the plan). */
export async function agentRespondPermission(
  args: AgentRespondPermissionArgs,
): Promise<void> {
  await invoke<void>("agent_respond_permission", { args });
}

/**
 * Subscribe to `agent_frame:{paneId}` events. A plain `listen()` wrapper —
 * not a hook — so `<AgentPane/>` can `await` the subscription *before*
 * calling `agentStart`, closing the gap where an `init` frame emitted between
 * "session started" and "listener attached" would otherwise be lost.
 */
export async function subscribeAgentFrames(
  paneId: string,
  handler: (frame: AgentFrame) => void,
): Promise<() => void> {
  return listen<AgentFrame>(`agent_frame:${paneId}`, (raw) => {
    handler(raw.payload);
  });
}

export interface EmitNotificationArgs {
  title: string;
  body?: string;
  priority: string;
}

export async function emitNativeNotification(
  args: EmitNotificationArgs,
): Promise<void> {
  await invoke<void>("emit_native_notification", { args });
}

/**
 * Request macOS notification permission.
 *
 * On desktop the OS registers the app as a notification sender on the first
 * `show()` call; calling this command on first launch ensures permission is
 * obtained before the first real notification fires.
 *
 * Returns `"granted"`, `"denied"`, or `"default"`.  The frontend persists
 * this in `localStorage` under `"notif_permission_requested"` and calls the
 * command only once per install.
 */
export async function requestNotificationPermission(): Promise<string> {
  return invoke<string>("request_notification_permission");
}

/**
 * Subscribe to `terminal_output:{id}` events for the lifetime of the component.
 * `handler` receives base64-encoded chunks — decode with `atob()` before writing
 * to xterm.js.
 */
export function useTerminalOutput(
  id: string | null,
  handler: (chunk: string) => void,
): void {
  useEffect(() => {
    if (!id) return;
    const eventName = `terminal_output:${id}`;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listen<string>(eventName, (raw) => {
      handler(raw.payload);
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [id, handler]);
}

// ---------------------------------------------------------------------------
// Document file operations
// ---------------------------------------------------------------------------

export interface OpenPathArgs {
  path: string;
}

export interface RevealInFinderArgs {
  path: string;
}

export interface OpenInEditorArgs {
  path: string;
  editor: "cursor" | "vscode" | "zed" | "system";
}

export interface ReadFileTextArgs {
  path: string;
  maxBytes?: number;
}

export interface ReadFileTextResult {
  contents: string;
  truncated: boolean;
  sizeBytes: number;
}

export async function openPath(path: string): Promise<void> {
  return invoke<void>("open_path", { path } satisfies OpenPathArgs);
}

/**
 * Hand a web or mail URL to the OS default handler — the user's browser.
 *
 * Distinct from {@link openPath}: that one is filesystem-shaped, and the opener
 * plugin draws the same line. A markdown link in an agent reply is not a path,
 * and routing it through the path door is what stopped these links from opening
 * at all. Rejects rather than resolving on a refused scheme, so a caller can
 * report it instead of the click appearing to do nothing.
 */
export async function openExternalUrl(url: string): Promise<void> {
  return invoke<void>("open_external_url", { url });
}

export async function revealInFinder(path: string): Promise<void> {
  return invoke<void>("reveal_in_finder", {
    path,
  } satisfies RevealInFinderArgs);
}

export async function openInEditor(
  path: string,
  editor: OpenInEditorArgs["editor"] = "system",
): Promise<void> {
  return invoke<void>("open_in_editor", {
    path,
    editor,
  } satisfies OpenInEditorArgs);
}

export async function readFileText(
  path: string,
  maxBytes = 1_048_576,
): Promise<ReadFileTextResult> {
  return invoke<ReadFileTextResult>("read_file_text", {
    path,
    maxBytes,
  } satisfies ReadFileTextArgs);
}

// ---------------------------------------------------------------------------
// Preview embedded webview commands (plan-1-fix-preview-tab)
// ---------------------------------------------------------------------------

/**
 * Logical-pixel bounds reported by `getBoundingClientRect()`, plus the
 * current viewport dimensions so Rust can derive the WebKit content inset.
 *
 * `window.innerWidth/Height` measure the *inset* web content area (excluding
 * the title-bar region on full-size-content-view windows), while the main
 * webview's NSView frame covers the full window. The difference is the inset
 * that must be added to the CSS-space origin before writing NSView coordinates.
 */
export interface PreviewBounds {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Width of the CSS viewport (`window.innerWidth`). */
  vw: number;
  /** Height of the CSS viewport (`window.innerHeight`). */
  vh: number;
}

/**
 * Open (or reuse) the embedded preview webview and navigate to `url`.
 * Positions it to cover `bounds` in the main window.
 * Rejects if the URL is invalid.
 */
export async function previewOpen(
  url: string,
  bounds: PreviewBounds,
): Promise<void> {
  return invoke<void>("preview_open", { url, bounds });
}

/**
 * Reposition and resize the preview webview to `bounds`.
 * No-op if the webview has not been created yet.
 */
export async function previewSetBounds(bounds: PreviewBounds): Promise<void> {
  return invoke<void>("preview_set_bounds", { bounds });
}

/**
 * Navigate the existing preview webview to a new URL without changing its bounds.
 */
export async function previewNavigate(url: string): Promise<void> {
  return invoke<void>("preview_navigate", { url });
}

/**
 * Show (`visible = true`) or hide (`visible = false`) the preview webview.
 * Used to reveal the History dropdown and to respond to app backgrounding.
 */
export async function previewShow(visible: boolean): Promise<void> {
  return invoke<void>("preview_show", { visible });
}

/**
 * Close and destroy the preview webview. Idempotent — safe to call even
 * if the webview was never opened (e.g., unmount without a navigate).
 */
export async function previewClose(): Promise<void> {
  return invoke<void>("preview_close");
}

// ---------------------------------------------------------------------------
// Workspace path queries (Phase 1)
// ---------------------------------------------------------------------------

export async function getWorkspacePath(): Promise<string> {
  return invoke<string>("get_workspace_path");
}

export async function getOrgAgentsPath(): Promise<string> {
  return invoke<string>("get_org_agents_path");
}

export async function getAppDataPath(): Promise<string> {
  return invoke<string>("get_app_data_path");
}

// ---------------------------------------------------------------------------
// Command-center session launchers (Phase 3)
// ---------------------------------------------------------------------------

export interface OpenCommandCenterSessionArgs {
  shell?: string;
  env?: Record<string, string>;
  rows?: number;
  cols?: number;
}

/**
 * Open a PTY session scoped to the command-center workspace root.
 * Returns a `TerminalHandle` that can be wired into the terminal store (Phase 4).
 */
export async function openCommandCenterSession(
  args: OpenCommandCenterSessionArgs = {},
): Promise<TerminalHandle> {
  return invoke<TerminalHandle>("open_command_center_session", { args });
}

export interface OpenProjectSessionArgs extends OpenCommandCenterSessionArgs {
  projectId: number;
}

/**
 * Open a PTY session cwd-pinned to the imported project at `projectId`.
 * Returns a `TerminalHandle` (Phase 4 wires it into the grid).
 */
export async function openProjectSession(
  args: OpenProjectSessionArgs,
): Promise<TerminalHandle> {
  return invoke<TerminalHandle>("open_project_session", {
    args: {
      project_id: args.projectId,
      shell: args.shell,
      env: args.env,
      rows: args.rows,
      cols: args.cols,
    },
  });
}

// ---------------------------------------------------------------------------
// Git commands
// ---------------------------------------------------------------------------

export interface CommitEntry {
  shortHash: string;
  subject: string;
  author: string;
  /** ISO-8601 author date with UTC offset. */
  date: string;
  repoPath: string;
  repoName: string;
}

export interface GetRecentCommitsArgs {
  /** Absolute paths to git repositories to query. */
  paths: string[];
  /** Max total commits returned (default 20, max 50). */
  limit?: number;
}

/**
 * Run `git log` across the supplied absolute repo paths.
 *
 * Non-git directories and unreachable paths are skipped silently by the Rust
 * shell.  The frontend polls this every 60 s — enough to feel live for an
 * active coding session without excessive subprocess overhead.
 */
export async function getRecentCommits(
  args: GetRecentCommitsArgs,
): Promise<CommitEntry[]> {
  return invoke<CommitEntry[]>("get_recent_commits", { args });
}

/** Branch/dirty/ahead facts for one pane's working directory (C3). */
export interface GitPaneStatus {
  /** Current branch name, or the literal string `"(detached)"`. */
  branch: string;
  /** `true` when any tracked or untracked change is present. */
  dirty: boolean;
  /** Commits ahead of the upstream branch, `null` when there is no upstream. */
  ahead: number | null;
}

/**
 * Run one `git status --porcelain=v2 --branch` against a terminal pane's live
 * cwd, for the session-state HUD's git cell.
 *
 * `null` means "not a git repo / unreachable path" — never an error toast;
 * the caller omits the git cell rather than surfacing a failure. The
 * session-state HUD store polls this once per distinct cwd every 30 s (not
 * once per pane — `stores/session-hud-store.ts`'s D12 cache), never on a
 * per-render basis.
 */
export async function getGitPaneStatus(
  cwd: string,
): Promise<GitPaneStatus | null> {
  return invoke<GitPaneStatus | null>("get_git_pane_status", { cwd });
}

// ---------------------------------------------------------------------------
// Hook self-test probe
// ---------------------------------------------------------------------------

/**
 * Result of a single live hook probe (a real `curl` POST run by the shell).
 *
 * Camel-case to match the Rust `HookProbeResult`
 * (`#[serde(rename_all = "camelCase")]` in `src-tauri/src/commands/hooks.rs`).
 */
export interface HookProbeResult {
  httpStatus: number | null;
  exitCode: number | null;
  curlMissing: boolean;
  durationMs: number;
  stderr: string;
}

/**
 * Whether the Tauri bridge is available in the current runtime.
 *
 * False in a plain browser (e.g. Vite opened outside the shell) and under
 * vitest, where `invoke` would otherwise throw. Same check as
 * `stores/terminal-store.ts`'s `listen` guard.
 */
export function isTauriAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Run the same `curl` command a pasted Claude Code hook would run, against
 * the sidecar's self-test endpoint (see `useMintHookSelfTest` in `api.ts`).
 *
 * Proves a shell-spawned `curl` can reach the sidecar — not just that the
 * webview can. A plain `fetch()` from here would only prove the latter, and
 * would pass even with `curl` missing from PATH.
 *
 * Rejects (does not swallow) when the Rust shell refuses the URL; the caller
 * decides how to surface that.
 */
export async function runHookProbe(
  url: string,
  maxTimeSeconds: number,
): Promise<HookProbeResult> {
  return invoke<HookProbeResult>("run_hook_probe", {
    args: { url, maxTimeSeconds },
  });
}

// ---------------------------------------------------------------------------
// Path existence checks
// ---------------------------------------------------------------------------

/**
 * Result for one path supplied to `pathsExist`.
 *
 * A valid launch cwd must satisfy `exists && is_dir`.
 * Paths that cannot be stat'd are returned as `{ exists: false, is_dir: false }`.
 */
export interface PathCheck {
  path: string;
  exists: boolean;
  is_dir: boolean;
}

/**
 * Check whether each path in `paths` exists on disk and is a directory.
 *
 * Returns one `PathCheck` per input path (same order).  Never throws —
 * unreachable paths are reported as `{ exists: false, is_dir: false }`.
 */
export async function pathsExist(paths: string[]): Promise<PathCheck[]> {
  return invoke<PathCheck[]>("paths_exist", { paths });
}

// ---------------------------------------------------------------------------
// Screenshot ring overlay
// ---------------------------------------------------------------------------

/**
 * Payload returned by a successful `capture_screenshot` Rust command.
 *
 * The production entry point is the global hotkey → ring window → `ring_capture`
 * flow.  `capture_screenshot` is a pure primitive retained for devtools use
 * (`invoke("capture_screenshot")` in the browser console).
 */
export interface CaptureResult {
  /** Absolute path to the saved PNG in `$TMPDIR/codenest-shots/`. */
  path: string;
  /** Cursor X in Tauri logical points, top-left origin. */
  cursorX: number;
  /** Cursor Y in Tauri logical points, top-left origin. */
  cursorY: number;
}

/**
 * Open the screenshot-ring overlay window at the cursor position.
 * Idempotent: focuses the existing window rather than creating a second one.
 */
export async function openScreenshotRing(): Promise<void> {
  return invoke<void>("open_screenshot_ring");
}

/**
 * Close the screenshot-ring overlay window.  Idempotent.
 */
export async function closeScreenshotRing(): Promise<void> {
  return invoke<void>("close_screenshot_ring");
}

/**
 * Trigger a screen-region capture from within the ring window.
 *
 * The Rust side runs `screencapture -i` and emits `screenshot-ready` (with
 * `CaptureResult`) or `screenshot-cancelled` (with an error string) to the
 * ring window when done.  The ring page drives the ring→thumbnail transition
 * by listening for those events.
 */
export async function ringCapture(): Promise<void> {
  return invoke<void>("ring_capture");
}

// ---------------------------------------------------------------------------
// Scheduled run live-attach
// ---------------------------------------------------------------------------

export interface ScheduleRunPtyInfo {
  pty_id: string | null;
}

/**
 * Ask the Rust scheduler which pty_id is streaming output for the given
 * run_id.  Returns `{ pty_id: null }` when the run is not currently running.
 *
 * Use this to decide whether to render a live xterm (pty_id != null) or fall
 * back to the static transcript fetched from the sidecar.
 */
export async function getScheduleRunPtyId(
  runId: number,
): Promise<ScheduleRunPtyInfo> {
  return invoke<ScheduleRunPtyInfo>("get_schedule_run_pty_id", {
    runId,
  });
}

/**
 * Subscribe to `schedule_run_started` events emitted by the Rust scheduler.
 *
 * Fired as soon as the PTY is open and the run transitions to `running`.
 * For windowed-mode runs the frontend listens and auto-surfaces the live pane.
 */
export interface ScheduleRunStartedPayload {
  run_id: number;
  schedule_id: number;
  schedule_name: string;
  pty_id: string;
  run_mode: string;
}

export function useScheduleRunStarted(
  handler: (payload: ScheduleRunStartedPayload) => void,
): void {
  useEvent<ScheduleRunStartedPayload>("schedule_run_started", handler);
}

/**
 * Subscribe to `schedule_run_finished` events emitted by the Rust scheduler.
 *
 * Fired when the process exits (succeeded, failed, or timed_out).
 */
export interface ScheduleRunFinishedPayload {
  run_id: number;
  schedule_id: number;
  schedule_name: string;
  status: string;
  exit_code: number | null;
  notify_policy: string;
}

export function useScheduleRunFinished(
  handler: (payload: ScheduleRunFinishedPayload) => void,
): void {
  useEvent<ScheduleRunFinishedPayload>("schedule_run_finished", handler);
}

// ---------------------------------------------------------------------------
// Generic event hook
// ---------------------------------------------------------------------------

/**
 * Subscribe to a Tauri event for the lifetime of the calling component.
 *
 * The handler receives the typed event payload. The unlisten function is
 * called automatically on unmount and on dependency change.
 */
export function useEvent<T>(
  event: EventName,
  handler: (payload: T, raw: Event<T>) => void,
): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listen<T>(event, (raw) => {
      handler(raw.payload, raw);
    }).then((dispose) => {
      if (cancelled) {
        dispose();
      } else {
        unlisten = dispose;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);
}

// ---------------------------------------------------------------------------
// Workspace navigator filesystem surface (feature/file-index-ipc)
//
// Typed wrappers for the five Tauri commands + one event that back the
// workspace navigator: `fs_list_dir`, `fs_build_file_index`,
// `git_status_for_roots`, `fs_watch_set_roots`, `fs_watch_status`, and the
// `fs_change_batch` event. Every struct here mirrors its Rust counterpart
// field-for-field; each Rust struct is `#[serde(rename_all = "camelCase")]`
// so the TS fields are camelCase even where the Rust source is snake_case.
// The three commands that take a struct argument take it under the key
// `args` (the Rust command's parameter name) — `fs_list_dir` is the one
// exception, taking `{ path }` directly.
// ---------------------------------------------------------------------------

/** `src-tauri/src/commands/fs_nav.rs:33-43`. */
export interface DirEntryInfo {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  /** Dirs only; `null` for a file, an unreadable dir, or one past the
   *  per-listing budget. */
  childCount: number | null;
}

/** `src-tauri/src/commands/fs_nav.rs:45-54`. */
export interface DirListing {
  /** Canonical absolute path that was listed. */
  path: string;
  /** Dirs first, then case-insensitive name — sorted server-side. */
  entries: DirEntryInfo[];
  /** More than `MAX_DIR_ENTRIES` entries existed; the list was truncated. */
  truncated: boolean;
}

/** `src-tauri/src/commands/fs_nav.rs:63-76`. */
export interface FileIndex {
  /** Canonical absolute. */
  root: string;
  /** Root-relative, `/`-separated, sorted. */
  files: string[];
  count: number;
  /** Hit the `maxFiles` cap. */
  truncated: boolean;
  /** `"git"` (via `git ls-files`) or `"walk"` (depth-bounded fallback). */
  source: string;
  elapsedMs: number;
  skippedNonUtf8: number;
}

/** `src-tauri/src/commands/git.rs:255-266`. */
export interface GitFileStatus {
  /** Relative to `GitRootStatus.repoRoot` — NOT to the requested root. */
  path: string;
  status: string;
  staged: boolean;
  added: number | null;
  removed: number | null;
  origPath: string | null;
}

/** `src-tauri/src/commands/git.rs:269-285`. */
export interface GitRootStatus {
  root: string;
  /** Canonical repo toplevel; the base for every `GitFileStatus.path`.
   *  `null` iff `isRepo` is false. */
  repoRoot: string | null;
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  files: GitFileStatus[];
  truncated: boolean;
  error: string | null;
}

/** `src-tauri/src/fswatch/mod.rs:88-93`. */
export interface RejectedRoot {
  path: string;
  reason: string;
}

/** `src-tauri/src/fswatch/mod.rs:95-113` (incl. the additive `excludedDirs`
 *  field — see C1 in the workspace-navigator plan). */
export interface WatchState {
  backend: string;
  /** Canonical, in the order accepted. */
  watchedRoots: string[];
  rootCount: number;
  maxRoots: number;
  rejected: RejectedRoot[];
  /** `true` => caller MUST refresh on expand, not trust events. */
  degraded: boolean;
  indexedFileCount: number;
  indexedRootCount: number;
  batchesEmitted: number;
  changesEmitted: number;
  changesDropped: number;
  debounceMs: number;
  /** The directory names filtered out of every listing, index and watch
   *  batch — sourced from `fs_scope::EXCLUDED_DIRS`. */
  excludedDirs: string[];
}

/** `src-tauri/src/fswatch/mod.rs:60-72`. */
export interface FsChange {
  kind: "created" | "removed" | "modified" | "moved";
  /** The watched root this path belongs to (absolute, canonical). */
  root: string;
  /** Absolute; for `"moved"` this is the destination. */
  path: string;
  /** Set only for `"moved"`. */
  fromPath: string | null;
  /** `null` when it could not be stat'd (e.g. after removal). */
  isDir: boolean | null;
}

/** `src-tauri/src/fswatch/mod.rs:74-86`. */
export interface FsChangeBatch {
  /** Monotonic, per app run; gaps mean nothing was emitted. */
  seq: number;
  /** Empty when `rescan` is true. */
  changes: FsChange[];
  /** Backend lost events (or the batch was over cap) — refetch the
   *  affected roots. */
  rescan: boolean;
  /** Changes filtered out or over the batch cap. */
  dropped: number;
}

/** One level of a directory tree, per call — never crawls itself. */
export async function fsListDir(path: string): Promise<DirListing> {
  return invoke<DirListing>("fs_list_dir", { path });
}

/**
 * Build (or rebuild) the ⌘P palette's file index for `root`. Records its
 * count into the shell's live watcher state, so calling this AFTER
 * `fsWatchSetRoots` is what keeps `WatchState.indexedFileCount` honest —
 * `set_roots` prunes counts for roots that left the watched set.
 */
export async function fsBuildFileIndex(
  root: string,
  maxFiles?: number,
): Promise<FileIndex> {
  return invoke<FileIndex>("fs_build_file_index", {
    args: { root, maxFiles },
  });
}

/** Git status + diffstat for every requested root, in the same order — never
 *  rejects because one root is broken. Match results back by array index. */
export async function gitStatusForRoots(
  paths: string[],
): Promise<GitRootStatus[]> {
  return invoke<GitRootStatus[]>("git_status_for_roots", { args: { paths } });
}

/**
 * Declarative, idempotent set-swap of the live watcher's roots. `[]` stops
 * watching. Events during the swap are lost, so the contract requires the
 * caller to refresh (re-list every expanded directory) after this resolves.
 */
export async function fsWatchSetRoots(roots: string[]): Promise<WatchState> {
  return invoke<WatchState>("fs_watch_set_roots", { args: { roots } });
}

/** The watcher's current state with no side effect on it. */
export async function fsWatchStatus(): Promise<WatchState> {
  return invoke<WatchState>("fs_watch_status");
}

/** Event name for the debounced watcher batch — see `useEvent`. */
export const FS_CHANGE_BATCH_EVENT = "fs_change_batch";
