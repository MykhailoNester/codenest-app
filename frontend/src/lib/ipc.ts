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
