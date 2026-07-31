//! A long-lived, interruptible, bidirectional `claude` session over stdio.
//!
//! ## Why stdin stays open (the inverted decision)
//!
//! `scheduler/mod.rs`'s dispatch path spawns `claude --print` with
//! `stdin(Stdio::null())` **deliberately** (see its comment at
//! `scheduler/mod.rs:389-395`): a scheduled run is one-shot, so the process
//! must see stdin EOF immediately or it never exits. This module spawns the
//! *same binary* for the opposite purpose — a pane the user keeps typing
//! into across many turns — so it inverts that one decision: stdin is
//! `Stdio::piped()` and the `ChildStdin` is held for the session's entire
//! life. Verified against CLI 2.1.220: with `--input-format stream-json`,
//! the process stays alive indefinitely with stdin open and no messages
//! sent, and exits `0` the instant stdin closes.
//!
//! `--print` itself is **not** dropped. The CLI's own argument checks require
//! it alongside `--input-format=stream-json` — `--print` is what *enables*
//! streaming input here, not what forces a one-shot exit. That distinction is
//! the whole point of this module.
//!
//! ## A `result` frame does not end the session
//!
//! After a `result` frame, `claude` waits on stdin for the next user message
//! (verified: the process stays alive >10s idle after `result`). Only the
//! terminal `exit` frame — emitted from this module once the child has
//! actually exited — means the session is over.
//!
//! ## Process spawning lives here, never in `app/`
//!
//! Per the AGENTS.md hard rule, the sidecar owns state and queues; the Rust
//! shell owns child processes. This module never talks to the sidecar at
//! all — no HTTP call, no DB row, no `agent_sessions` bookkeeping. An agent
//! pane uses the user's own `claude` login exactly like a PTY session does.

mod frame;

use std::{
    collections::HashMap,
    io::{Read, Write},
    os::unix::process::CommandExt,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    thread,
    time::Duration,
};

use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use self::frame::{AgentFrame, LineAssembler, LineOut};

// Grace between SIGTERM and SIGKILL when stopping a session — the same value
// and the same two-phase shape as `scheduler::SHUTDOWN_GRACE_MS`
// (`scheduler/mod.rs:84`), not a newly invented number.
const SHUTDOWN_GRACE_MS: u64 = 400;

/// The permission modes CLI 2.1.220's `--help` documents. Validated here so a
/// typo fails before spawn instead of making `claude` exit 1 on its own
/// argparse error.
pub(crate) const PERMISSION_MODES: [&str; 6] =
    ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"];

// ---------------------------------------------------------------------------
// Argument structs (Deserialize side — camelCase on the wire)
// ---------------------------------------------------------------------------

/// Arguments for [`agent_start`]. camelCase on the wire (copies
/// `commands/hooks.rs`'s `HookProbeArgs`), **not** the snake_case
/// `session/mod.rs::OpenProjectSessionArgs` shape — see the plan's Design
/// decision 12 for why the two ipc argument conventions in this codebase
/// diverge and which one a new command must pick.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartArgs {
    pub pane_id: String,
    pub cwd: String,
    /// The provider's `command_template` binary token (e.g. `claude`,
    /// `claude-work`). `None` — and any token this process cannot exec —
    /// resolves to plain `claude`; see [`resolve_binary`]. Never a full
    /// command line: only the first token is meaningful, because this module
    /// spawns directly with no shell in the path.
    #[serde(default)]
    pub command: Option<String>,
    /// Provider env overlay, applied on top of the inherited environment.
    /// This is what reproduces a shell alias's behaviour for a direct spawn:
    /// `claude-work` is `CLAUDE_CONFIG_DIR=~/.claude-work command claude`, and
    /// without the variable the child reads the default `~/.claude` config —
    /// which for a user who only ever authenticated the aliases is
    /// unauthenticated, so every turn fails with `401 OAuth access token is
    /// invalid`. Values are tilde-expanded (a stored `~/.claude-work` must
    /// become an absolute path: there is no shell to expand it).
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub allowed_tools: Option<String>,
}

/// Arguments for [`agent_send`].
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSendArgs {
    pub pane_id: String,
    pub text: String,
}

/// Arguments shared by [`agent_interrupt`] and [`agent_stop`].
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPaneArgs {
    pub pane_id: String,
}

/// Arguments for [`agent_set_model`] — switches the model of a session that is
/// already running, the wire equivalent of `/model` in the TUI.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSetModelArgs {
    pub pane_id: String,
    pub model: String,
}

/// Arguments for [`agent_set_permission_mode`] — switches the permission mode
/// of a session that is already running, the wire equivalent of Shift+Tab in
/// the TUI.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSetPermissionModeArgs {
    pub pane_id: String,
    pub mode: String,
}

/// Arguments for [`agent_respond_permission`] — answers one `can_use_tool`
/// `control_request` (frame kind [`frame::AgentFrameKind::Permission`]) over
/// the same stdin the session already owns. `updated_input` is always the
/// echo of `request.input` for an allow (`None` degrades to `{}` in the
/// encoder, which drives the CLI's "falling back to original tool input"
/// warning path — a caller should always send the echo). `message` is the
/// deny reason.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionArgs {
    pub pane_id: String,
    pub request_id: String,
    pub allow: bool,
    #[serde(default)]
    pub updated_input: Option<serde_json::Value>,
    #[serde(default)]
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------
// Return payload (Serialize side — snake_case, no rename_all)
// ---------------------------------------------------------------------------

/// Returned by [`agent_start`]. Snake_case, **no** `rename_all` — matches
/// `PtyExitedPayload` (`pty/mod.rs:55-59`).
#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentSessionHandle {
    pub pane_id: String,
    pub session_id: String,
    pub pid: u32,
}

// ---------------------------------------------------------------------------
// Argv construction
// ---------------------------------------------------------------------------

/// Resolve a provider's `command_template` binary token to a spawnable
/// executable name.
///
/// Same three rules as `scheduler::resolve_binary`
/// (`scheduler/mod.rs:1049-1067`), and for the same reason: a bare token that
/// is not on PATH is almost certainly a *shell alias* (`claude-work` is
/// `alias claude-work="CLAUDE_CONFIG_DIR=~/.claude-work command claude"`),
/// which a direct, shell-less spawn cannot run. Falling back to the canonical
/// `claude` binary is correct because the alias's only real payload — its
/// `CLAUDE_CONFIG_DIR` — reaches the child through
/// [`AgentStartArgs::env`] instead. An agent pane now *does* have a provider,
/// so unlike the earlier version of this function there is something concrete
/// to fall back from.
fn resolve_binary(token: &str) -> String {
    // A path (absolute or relative) is used verbatim.
    if token.contains('/') {
        return token.to_string();
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            if !dir.is_empty() && Path::new(dir).join(token).is_file() {
                return token.to_string();
            }
        }
    }
    "claude".to_string()
}

/// Expand a leading `~` or `~/` to `$HOME`. Private copy of the same helper
/// in `scheduler/mod.rs:1069-1079` and `pty/mod.rs:85-95` — three call sites
/// now share the idiom, none share the code, because none of the three
/// modules imports from another for a six-line function.
fn expand_tilde(value: &str) -> String {
    if value == "~" {
        return std::env::var("HOME").unwrap_or_else(|_| value.to_string());
    }
    if let Some(rest) = value.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    value.to_string()
}

/// Build the argv for a duplex `claude` session.
///
/// Takes the whole [`AgentStartArgs`] rather than six loose parameters so
/// clippy's `too_many_arguments` cannot fire; `cwd` and `pane_id` are simply
/// unread here — they are consumed by `start_inner`, not by argv shaping.
///
/// Never pushes a positional prompt — the inversion this whole module rests
/// on (contrast `scheduler/mod.rs:891`, which pushes the prompt as the last
/// arg for a one-shot run).
fn build_agent_argv(args: &AgentStartArgs, session_id: &str) -> Result<Vec<String>, String> {
    // Only the first whitespace-separated token of `command` is used: the rest
    // of a provider's `command_template` is placeholder syntax
    // (`{session_id} {mcp_config} {extra_args}`) meant for the PTY path, and
    // this module owns its own flags below.
    let token = args
        .command
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .and_then(|c| c.split_whitespace().next())
        .unwrap_or("claude");
    let mut argv = vec![resolve_binary(token)];

    argv.push("--print".to_string());
    argv.push("--input-format".to_string());
    argv.push("stream-json".to_string());
    argv.push("--output-format".to_string());
    argv.push("stream-json".to_string());
    argv.push("--verbose".to_string());
    argv.push("--include-partial-messages".to_string());
    // Routes the CLI's permission asks to this process's stdout as a
    // `control_request {subtype:"can_use_tool"}` instead of resolving them
    // locally (which, in --print, means auto-deny: "This command requires
    // approval"). `stdio` is special-cased by the CLI ahead of any MCP lookup
    // and is what the official Agent SDK passes when a canUseTool callback
    // exists. Verified against CLI 2.1.220 — see the plan's Wire verification.
    argv.push("--permission-prompt-tool".to_string());
    argv.push("stdio".to_string());
    argv.push("--session-id".to_string());
    argv.push(session_id.to_string());

    if let Some(model) = args.model.as_deref() {
        if !model.is_empty() {
            argv.push("--model".to_string());
            argv.push(model.to_string());
        }
    }

    if let Some(agent) = args.agent.as_deref() {
        if !agent.is_empty() {
            argv.push("--agent".to_string());
            argv.push(agent.to_string());
        }
    }

    // None/empty → no flag at all: the CLI's own configured default applies,
    // which is the parity target for an interactive pane (unlike the
    // scheduler's unattended `dontAsk` default at `scheduler/mod.rs:820`).
    if let Some(mode) = args.permission_mode.as_deref().filter(|m| !m.is_empty()) {
        if mode == "bypassPermissions" {
            argv.push("--dangerously-skip-permissions".to_string());
        } else if PERMISSION_MODES.contains(&mode) {
            argv.push("--permission-mode".to_string());
            argv.push(mode.to_string());
        } else {
            return Err(format!("unsupported permission mode: {mode}"));
        }
    }

    if let Some(tools) = args.allowed_tools.as_deref() {
        if !tools.is_empty() {
            argv.push("--allowedTools".to_string());
            argv.push(tools.to_string());
        }
    }

    Ok(argv)
}

// ---------------------------------------------------------------------------
// Registry + manager
// ---------------------------------------------------------------------------

/// One live session's bookkeeping. Only what `send` / `interrupt` / `stop`
/// need: no `Child` handle here — killing goes through the process-GROUP
/// signal (`kill_group`), not `Child::kill`, so the object that actually
/// waits on the child lives only inside the waiter thread's closure.
struct AgentSession {
    session_id: String,
    /// Process-group leader pid (the child is its own session via `setsid`).
    pid: u32,
    stdin_tx: mpsc::Sender<String>,
    /// Per-session interrupt request-id counter. An `AtomicU64` rather than a
    /// `Mutex<u64>` — clippy's `mutex_atomic` is on by default under
    /// `-D warnings`.
    next_request_id: AtomicU64,
}

/// A registry slot for one `pane_id`. `Reserved(id)` exists only for the
/// synchronous window inside `start_inner` between the duplicate-session
/// check and the point where the real `AgentSession` is known (after
/// `cwd`/argv validation, `Command::spawn`, and the reader/writer/waiter
/// threads are up) — see [`ReservationGuard`]. The `id` is the session id
/// `start_inner` mints for this attempt *before* the reservation (step 1),
/// so a later mutation of this slot can prove it is still talking to the
/// same attempt that created it. Every other accessor treats
/// `Reserved`/`Cancelled` exactly like "no session for this pane": a caller
/// that lands in that window sees the same result it would have seen if it
/// had arrived a moment earlier, before `agent_start` was ever called.
///
/// `Cancelled(id)` is what `stop()` turns a `Reserved(id)` into (F1's second
/// race, review-2.md): the reservation keeps its id, but the in-flight
/// `start_inner` must not publish `Live` on top of it — it must kill the
/// child it just spawned instead. Without this state, `stop()` racing the
/// provisioning window would have nothing to write that the in-flight call
/// could observe, and the eventual publish would silently resurrect the
/// very session the caller just asked to stop.
enum SessionSlot {
    Reserved(String),
    Cancelled(String),
    Live(AgentSession),
}

impl SessionSlot {
    fn live(&self) -> Option<&AgentSession> {
        match self {
            SessionSlot::Live(session) => Some(session),
            SessionSlot::Reserved(_) | SessionSlot::Cancelled(_) => None,
        }
    }

    fn into_live(self) -> Option<AgentSession> {
        match self {
            SessionSlot::Live(session) => Some(session),
            SessionSlot::Reserved(_) | SessionSlot::Cancelled(_) => None,
        }
    }
}

/// Keyed by `pane_id`. `type` alias exists to keep clippy's `type_complexity`
/// quiet, exactly as `scheduler::RunRegistry` does (`scheduler/mod.rs:103`).
type SessionMap = Arc<Mutex<HashMap<String, SessionSlot>>>;

/// Lock a mutex, recovering the guard even if a previous holder panicked
/// while holding it, so one panicking thread cannot brick every later
/// command. Same recovery form as `scheduler/mod.rs:132-134`.
fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Send `SIGTERM` to a process group immediately, then `SIGKILL` after
/// `SHUTDOWN_GRACE_MS` on a detached thread — the two-phase shutdown shared
/// by `stop` and, since F1's second race (review-2.md), the cancellation
/// path in `start_inner`'s own publish step: a `stop()` that lands while the
/// session is still `Reserved` has to be able to kill the child once
/// `start_inner` actually spawns it, using the exact same grace period
/// rather than inventing a second one.
fn terminate_process_group(pid: u32) {
    crate::scheduler::kill_group(pid, libc::SIGTERM);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(SHUTDOWN_GRACE_MS));
        crate::scheduler::kill_group(pid, libc::SIGKILL);
    });
}

/// RAII guard for the reservation `start_inner` places in the registry
/// before doing anything that can fail (cwd check, argv build, spawn). An
/// armed guard's `Drop` removes the reservation, so every early return
/// between "reserve" (step 1) and "replace with the real session" (step 9)
/// cleans up automatically — no early-return path needs its own cleanup
/// line, and none can be missed. `disarm` is called exactly once, right
/// after the real `AgentSession` overwrites the reservation (or, on the
/// cancelled path, right after that path has already cleaned the slot up by
/// hand — see step 9).
///
/// `session_id` is the same id stored in `SessionSlot::Reserved`/`Cancelled`
/// (F1's second race, review-2.md): `Drop` only removes the slot if it still
/// holds *this* reservation's id, mirroring the ownership check the waiter
/// thread's own self-cleanup performs (step 8d below) before it removes a
/// `Live` entry. Nothing else can occupy this key while this call holds the
/// reservation, so this check should never actually fail today — but the
/// guard shouldn't rely on that invariant unchecked, given how narrow the
/// window was that let a bare `remove` here go wrong the first time.
struct ReservationGuard {
    sessions: SessionMap,
    pane_id: String,
    session_id: String,
    armed: bool,
}

impl ReservationGuard {
    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for ReservationGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut sessions = lock_or_recover(&self.sessions);
        let owned_by_us = match sessions.get(&self.pane_id) {
            Some(SessionSlot::Reserved(id)) | Some(SessionSlot::Cancelled(id)) => {
                *id == self.session_id
            }
            _ => false,
        };
        if owned_by_us {
            sessions.remove(&self.pane_id);
        }
    }
}

/// Registry of live duplex `claude` sessions, one per pane. Mirrors the shape
/// of `pty::PtyManager` (`pty/mod.rs:101-105`): a `HashMap` behind a
/// `Mutex`, an `_inner` seam so tests can drive spawn/thread/registry
/// behaviour without a Tauri runtime, and self-cleanup on the child's own
/// exit in addition to the explicit `stop` path.
pub struct AgentManager {
    sessions: SessionMap,
    /// Test-only knob: when set, `start_inner` sleeps for this long right
    /// after placing its reservation, widening the reserve→publish window
    /// enough for a test to reliably race a `stop()` into it (F1's second
    /// race, review-2.md — that window is normally a handful of syscalls,
    /// too narrow to hit deterministically from outside). Always `None`
    /// outside `#[cfg(test)]`; nothing but the test module ever calls
    /// `set_test_publish_delay`.
    #[cfg(test)]
    test_publish_delay: Mutex<Option<Duration>>,
}

impl Default for AgentManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(test)]
            test_publish_delay: Mutex::new(None),
        }
    }

    /// Production entry point. Builds the emit closure that turns every
    /// parsed/synthetic frame into an `agent_frame:{pane_id}` event reaching
    /// every webview (main window and the detached `terminals` window alike,
    /// exactly like PTY output).
    pub fn start(&self, args: AgentStartArgs, app: AppHandle) -> Result<AgentSessionHandle, String> {
        let emit = move |frame: AgentFrame| {
            let _ = app.emit(&format!("agent_frame:{}", frame.pane_id), frame);
        };
        self.start_inner(args, None, emit)
    }

    /// The testable seam, mirroring `pty::PtyManager::open_terminal_inner`
    /// (`pty/mod.rs:138-146`).
    ///
    /// `argv_override` replaces the **entire** argv, not just `argv[0]`:
    /// `Some(v)` bypasses `build_agent_argv` completely and is used only by
    /// tests (a `cat` or `sh -c '…'` fixture that needs no `claude` binary,
    /// no login and no API call); `None` — the only production path — builds
    /// the real duplex argv. Argv construction itself is pinned exclusively
    /// by the pure `build_agent_argv` tests below; the lifecycle tests that
    /// use this override pin registry, threading, framing and signalling —
    /// orthogonal properties — and deliberately do not re-assert argv.
    fn start_inner<F>(
        &self,
        args: AgentStartArgs,
        argv_override: Option<Vec<String>>,
        emit: F,
    ) -> Result<AgentSessionHandle, String>
    where
        F: Fn(AgentFrame) + Send + Clone + 'static,
    {
        // 1. Mint this attempt's session id first — always a fresh session,
        // this branch never `--resume`s — and reserve `pane_id` under that
        // id in the same critical section as the duplicate check. A replace
        // would orphan the first child's three threads and interleave two
        // sessions on one event name, so the caller must `agent_stop` first
        // (Design decision 10). The check and the reservation must share one
        // lock acquisition: checking `contains_key` and then releasing the
        // lock before inserting (as a plain two-step check-then-act would)
        // leaves a window where two concurrent `agent_start` calls for the
        // same pane both pass the check, both spawn a real `claude` child,
        // and the later of the two final inserts silently overwrites the
        // earlier one's registry entry — orphaning that child beyond even
        // `close_all`'s reach, since it is then in no registry at all (F1,
        // review-1.md). Reserving here — and removing the reservation on any
        // early return via `ReservationGuard` — closes that window without
        // holding the lock across `Command::spawn()` itself.
        //
        // The id is minted *before* the reservation (rather than after cwd
        // validation, where it used to live) specifically so the reservation
        // can carry it: `stop()` racing this call's provisioning window
        // turns `Reserved(id)` into `Cancelled(id)` instead of just deleting
        // the entry, and the publish step below checks that same id before
        // going live — closing a second, narrower race where a `stop()`
        // landing mid-spawn was silently undone a moment later (F1's second
        // race, review-2.md).
        let session_id = Uuid::new_v4().to_string();
        {
            let mut sessions = lock_or_recover(&self.sessions);
            if sessions.contains_key(&args.pane_id) {
                return Err(format!(
                    "agent session already running for pane {}",
                    args.pane_id
                ));
            }
            sessions.insert(args.pane_id.clone(), SessionSlot::Reserved(session_id.clone()));
        }
        let reservation = ReservationGuard {
            sessions: Arc::clone(&self.sessions),
            pane_id: args.pane_id.clone(),
            session_id: session_id.clone(),
            armed: true,
        };

        // Test-only hook (F1 regression test, review-2.md): widen the
        // reserve→publish window on demand so a test can deterministically
        // land a `stop()` on the `Reserved` slot instead of racing a
        // handful of syscalls that are too fast to hit reliably from
        // outside. Always a no-op in production — nothing outside
        // `#[cfg(test)]` ever calls `set_test_publish_delay`.
        #[cfg(test)]
        if let Some(delay) = lock_or_recover(&self.test_publish_delay).take() {
            thread::sleep(delay);
        }

        // 2. Fail before spawning anything — the discipline of
        // `pty/mod.rs:175-178`, not the scheduler's warn-and-continue
        // (`scheduler/mod.rs:401-408`). For an interactive pane, silently
        // running in the wrong directory is worse than failing.
        let expanded_cwd = expand_tilde(&args.cwd);
        let cwd_path = Path::new(&expanded_cwd);
        if !cwd_path.exists() {
            return Err(format!("cwd does not exist: {expanded_cwd}"));
        }
        if !cwd_path.is_dir() {
            return Err(format!("cwd is not a directory: {expanded_cwd}"));
        }

        // 3. Build (or, in tests, override) the argv.
        let argv = match argv_override {
            Some(v) => v,
            None => build_agent_argv(&args, &session_id)?,
        };
        if argv.is_empty() {
            return Err("argv override must not be empty".to_string());
        }

        // 4. Spawn with stdin PIPED and held open — the inversion this
        // module exists for (see module docs).
        let mut command = Command::new(&argv[0]);
        command.args(&argv[1..]);
        command.current_dir(&expanded_cwd);
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        // Mirrors `session/mod.rs:95-96` and `scheduler/mod.rs:884-888`'s env
        // overlay convention (Design decision 11) — costs nothing here and is
        // what lets the sidecar's hook ingest bind a session to a pane later.
        command.env("CODENEST_SESSION_MODE", "agent-pane");
        command.env("CODENEST_PANE_ID", &args.pane_id);
        // Provider env overlay — applied after the two markers above so a
        // provider can never shadow them, and tilde-expanded because there is
        // no shell in this path to do it (a stored `~/.claude-work` reaching
        // the child verbatim would make the CLI create a literal `~` directory
        // and then fail to authenticate against it).
        if let Some(env) = args.env.as_ref() {
            for (key, value) in env {
                if key.is_empty() {
                    continue;
                }
                command.env(key, expand_tilde(value));
            }
        }

        // 5. Own session/process group, so `stop` / `close_all` can signal
        // the child plus anything it forks as a single unit.
        // SAFETY: setsid is async-signal-safe and is the only call made in
        // the forked child before exec.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        // 6. Spawn. No registry entry and no frames on failure — nothing to
        // leak.
        let mut child = match command.spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(
                    "claude not found on PATH — install Claude Code or add it to PATH".to_string(),
                );
            }
            Err(e) => {
                return Err(format!("spawn claude: {e}"));
            }
        };

        let pid = child.id();
        let stdin = child.stdin.take().ok_or("agent stdin pipe missing")?;
        let stdout = child.stdout.take().ok_or("agent stdout pipe missing")?;
        let stderr = child.stderr.take().ok_or("agent stderr pipe missing")?;

        // 7. Held only by the waiter thread's try_wait loop below — never
        // stored in the registry, since killing goes through the
        // process-group signal, not `Child::kill`.
        let child_arc: Arc<Mutex<Child>> = Arc::new(Mutex::new(child));

        let (stdin_tx, stdin_rx) = mpsc::channel::<String>();

        // 8a. Writer thread: owns the ChildStdin and the receiving half of
        // the channel. `agent_send` / `agent_interrupt` never touch stdin
        // directly — they hand one encoded line to this thread and return,
        // so a full pipe can never block a Tauri command, and two
        // concurrent sends can never interleave half a line (fatal to the
        // CLI — verified). Dropping every `Sender` (via `stop` / `close_all`
        // removing the registry entry, the cancellation path in step 9
        // below dropping it directly, or the manager itself being dropped)
        // ends this loop and drops `stdin`, which is the CLI's documented
        // clean-exit path.
        thread::spawn(move || {
            let mut stdin = stdin;
            for line in stdin_rx {
                if stdin.write_all(line.as_bytes()).is_err() {
                    break;
                }
                let _ = stdin.flush();
            }
        });

        let pane_id = args.pane_id.clone();

        // 8b. stdout reader: parses each assembled line as one stream-json
        // frame. A line that fails to parse is emitted as an `error` frame,
        // never silently dropped, and the reader keeps going — one bad line
        // does not end the stream.
        let emit_stdout = emit.clone();
        let pane_stdout = pane_id.clone();
        let session_stdout = session_id.clone();
        let stdout_handle = thread::spawn(move || {
            let mut reader = stdout;
            let mut assembler = LineAssembler::new();
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        for out in assembler.push(&buf[..n]) {
                            match out {
                                LineOut::Line(line) => {
                                    match serde_json::from_str::<serde_json::Value>(&line) {
                                        Ok(value) => emit_stdout(AgentFrame::parsed(
                                            &pane_stdout,
                                            &session_stdout,
                                            value,
                                        )),
                                        Err(e) => emit_stdout(AgentFrame::parse_error(
                                            &pane_stdout,
                                            &session_stdout,
                                            &line,
                                            &e.to_string(),
                                        )),
                                    }
                                }
                                LineOut::Overflow(dropped) => {
                                    emit_stdout(AgentFrame::parse_error(
                                        &pane_stdout,
                                        &session_stdout,
                                        "",
                                        &format!("dropped an over-long line of {dropped} bytes"),
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        });

        // 8c. stderr reader: the behaviour change vs `scheduler/mod.rs:497-513`,
        // which writes stderr to a transcript file and shows the user
        // nothing. Here every line reaches the frontend as a `stderr` frame.
        let emit_stderr = emit.clone();
        let pane_stderr = pane_id.clone();
        let session_stderr = session_id.clone();
        let stderr_handle = thread::spawn(move || {
            let mut reader = stderr;
            let mut assembler = LineAssembler::new();
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        for out in assembler.push(&buf[..n]) {
                            match out {
                                LineOut::Line(line) => {
                                    emit_stderr(AgentFrame::stderr(&pane_stderr, &session_stderr, &line));
                                }
                                LineOut::Overflow(dropped) => {
                                    emit_stderr(AgentFrame::stderr(
                                        &pane_stderr,
                                        &session_stderr,
                                        &format!("<dropped an over-long stderr line of {dropped} bytes>"),
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        });

        // 8d. Waiter thread: observes exit, joins the readers first so the
        // terminal `exit` frame is genuinely last (the ordering discipline
        // of `scheduler/mod.rs:609-610`), then self-cleans the registry —
        // guarded on `session_id` still matching, so a restart on the same
        // pane can never have its new entry evicted by the old session's
        // delayed cleanup. Step 9 below mirrors this same "am I still the
        // owner of this slot" check before its own publish (F1's second
        // race, review-2.md).
        let sessions_for_wait = Arc::clone(&self.sessions);
        let pane_wait = pane_id.clone();
        let session_wait = session_id.clone();
        let emit_wait = emit;
        thread::spawn(move || {
            let exit_code = loop {
                {
                    let mut child = lock_or_recover(&child_arc);
                    match child.try_wait() {
                        Ok(Some(status)) => break status.code(),
                        Ok(None) => {}
                        Err(_) => break None,
                    }
                }
                thread::sleep(Duration::from_millis(100));
            };

            let _ = stdout_handle.join();
            let _ = stderr_handle.join();

            {
                let mut sessions = lock_or_recover(&sessions_for_wait);
                let still_current = sessions
                    .get(&pane_wait)
                    .and_then(SessionSlot::live)
                    .is_some_and(|s| s.session_id == session_wait);
                if still_current {
                    sessions.remove(&pane_wait);
                }
            }

            emit_wait(AgentFrame::exit(&pane_wait, &session_wait, exit_code));
        });

        // 9. Only now — after every failure path above has had its chance
        // to bail without a trace — does the session become visible to
        // `send` / `interrupt` / `stop`. But the reservation planted in
        // step 1 might not be ours to publish over any more: a `stop()`
        // racing this exact provisioning window (the duration of
        // `Command::spawn` plus the four `thread::spawn` calls above) turns
        // `Reserved(session_id)` into `Cancelled(session_id)` instead of
        // deleting it (see `stop`'s comment), precisely so this check can
        // tell the difference. Publish `Live` only if the slot is still
        // `Reserved` under *this* attempt's `session_id`; anything else —
        // cancelled by a racing `stop()`, or (should the single-owner
        // reservation invariant ever be violated elsewhere) replaced or
        // absent — means leave the registry alone unless it's still our own
        // `Cancelled` entry to clear, and kill the child already spawned
        // instead of letting it become a session nobody can reach (F1's
        // second race, review-2.md) — mirrors the ownership check the
        // waiter thread's own self-cleanup performs at step 8d.
        let mut sessions = lock_or_recover(&self.sessions);
        let still_reserved_by_us = matches!(
            sessions.get(&args.pane_id),
            Some(SessionSlot::Reserved(id)) if *id == session_id
        );
        if !still_reserved_by_us {
            let still_cancelled_by_us = matches!(
                sessions.get(&args.pane_id),
                Some(SessionSlot::Cancelled(id)) if *id == session_id
            );
            if still_cancelled_by_us {
                sessions.remove(&args.pane_id);
            }
            drop(sessions);
            reservation.disarm();
            // Same clean-exit path `stop` uses: drop the sender first so
            // the writer thread's loop ends and it drops `stdin`, then
            // signal the process group as a robust fallback.
            drop(stdin_tx);
            terminate_process_group(pid);
            return Err(format!(
                "agent session for pane {} was stopped before it finished starting",
                args.pane_id
            ));
        }

        // This overwrites the step-1 reservation in place (same key, same
        // lock), then disarms the guard so its `Drop` does not undo the
        // insert it just made.
        let handle = AgentSessionHandle {
            pane_id: args.pane_id.clone(),
            session_id: session_id.clone(),
            pid,
        };
        sessions.insert(
            args.pane_id,
            SessionSlot::Live(AgentSession {
                session_id,
                pid,
                stdin_tx,
                next_request_id: AtomicU64::new(0),
            }),
        );
        drop(sessions);
        reservation.disarm();

        Ok(handle)
    }

    /// Write exactly one JSON line to the child's stdin. One channel send,
    /// one line, no blocking. `Ok(())` only means the writer thread accepted
    /// the line for delivery, not that `claude` received it — if the child
    /// has already exited between a caller's last poll and this call, the
    /// writer thread's `write_all` gets `EPIPE`, breaks, and the caller
    /// learns via the terminal `exit` frame, not via this return value.
    pub fn send(&self, args: AgentSendArgs) -> Result<(), String> {
        let line = frame::encode_user_message(&args.text)?;
        let sessions = lock_or_recover(&self.sessions);
        let session = sessions
            .get(&args.pane_id)
            .and_then(SessionSlot::live)
            .ok_or_else(|| format!("no live agent session for pane {}", args.pane_id))?;
        session
            .stdin_tx
            .send(line)
            .map_err(|_| format!("agent session stdin closed for pane {}", args.pane_id))
    }

    /// Answer a `can_use_tool` permission request. Structurally identical to
    /// [`Self::send`] — encode, lock, look up the live session, hand one
    /// line to the writer thread — because a permission answer is, on the
    /// wire, just another control message written to the same stdin.
    pub fn respond_permission(&self, args: AgentPermissionArgs) -> Result<(), String> {
        let line = frame::encode_permission_response(
            &args.request_id,
            args.allow,
            args.updated_input.as_ref(),
            args.message.as_deref(),
        )?;
        let sessions = lock_or_recover(&self.sessions);
        let session = sessions
            .get(&args.pane_id)
            .and_then(SessionSlot::live)
            .ok_or_else(|| format!("no live agent session for pane {}", args.pane_id))?;
        session
            .stdin_tx
            .send(line)
            .map_err(|_| format!("agent session stdin closed for pane {}", args.pane_id))
    }

    /// Ask `claude` to interrupt the current turn via the stdin control
    /// channel (Design decision 7) — not a signal, which is untested against
    /// a `--print` child and risks ending the session outright. The session
    /// stays alive for the next turn either way.
    pub fn interrupt(&self, args: AgentPaneArgs) -> Result<(), String> {
        let sessions = lock_or_recover(&self.sessions);
        let session = sessions
            .get(&args.pane_id)
            .and_then(SessionSlot::live)
            .ok_or_else(|| format!("no live agent session for pane {}", args.pane_id))?;
        let n = session.next_request_id.fetch_add(1, Ordering::SeqCst);
        let line = frame::encode_interrupt(&format!("codenest-{n}"))?;
        session
            .stdin_tx
            .send(line)
            .map_err(|_| format!("agent session stdin closed for pane {}", args.pane_id))
    }

    /// Switch the model of a live session over the stdin control channel —
    /// what `/model` does in the TUI. Structurally identical to
    /// [`Self::interrupt`] (mint a request id, encode one line, hand it to the
    /// writer thread); the CLI answers with a `control_response` that arrives
    /// as an ordinary [`frame::AgentFrameKind::Control`] frame.
    ///
    /// Deliberately *not* a restart: the conversation, the session id and the
    /// pane's scrollback all survive, and the next assistant message simply
    /// carries the new `message.model`. A caller that changes something argv
    /// cannot express mid-flight — the binary or the env, i.e. the provider —
    /// must stop and start instead.
    pub fn set_model(&self, args: AgentSetModelArgs) -> Result<(), String> {
        let model = args.model.trim();
        if model.is_empty() {
            return Err("model must not be empty".to_string());
        }
        let sessions = lock_or_recover(&self.sessions);
        let session = sessions
            .get(&args.pane_id)
            .and_then(SessionSlot::live)
            .ok_or_else(|| format!("no live agent session for pane {}", args.pane_id))?;
        let n = session.next_request_id.fetch_add(1, Ordering::SeqCst);
        let line = frame::encode_set_model(&format!("codenest-{n}"), model)?;
        session
            .stdin_tx
            .send(line)
            .map_err(|_| format!("agent session stdin closed for pane {}", args.pane_id))
    }

    /// Switch the permission mode of a live session over the stdin control
    /// channel — what Shift+Tab does in the TUI, which a `--print` child cannot
    /// receive. Structurally identical to [`Self::set_model`].
    ///
    /// The mode is validated against [`PERMISSION_MODES`] before the registry is
    /// touched, so a typo is a synchronous error here rather than an
    /// asynchronous `control_response` the caller has to correlate. The CLI can
    /// still refuse a *valid* mode — `bypassPermissions` unless the session was
    /// spawned with `--dangerously-skip-permissions`, or `auto` where that mode
    /// is gated off — and that arrives as a [`frame::AgentFrameKind::Control`]
    /// error frame, which is why the frontend treats the mode echoed by the
    /// success response as authoritative rather than its own optimistic value.
    pub fn set_permission_mode(&self, args: AgentSetPermissionModeArgs) -> Result<(), String> {
        let mode = args.mode.trim();
        if mode.is_empty() {
            return Err("permission mode must not be empty".to_string());
        }
        if !PERMISSION_MODES.contains(&mode) {
            return Err(format!("unsupported permission mode: {mode}"));
        }
        let sessions = lock_or_recover(&self.sessions);
        let session = sessions
            .get(&args.pane_id)
            .and_then(SessionSlot::live)
            .ok_or_else(|| format!("no live agent session for pane {}", args.pane_id))?;
        let n = session.next_request_id.fetch_add(1, Ordering::SeqCst);
        let line = frame::encode_set_permission_mode(&format!("codenest-{n}"), mode)?;
        session
            .stdin_tx
            .send(line)
            .map_err(|_| format!("agent session stdin closed for pane {}", args.pane_id))
    }

    /// Stop a pane's session. Idempotent — an unknown pane is `Ok(())`,
    /// mirroring `pty::close_terminal` (`pty/mod.rs:309-316`).
    ///
    /// Must return immediately to the caller, so the SIGTERM→grace→SIGKILL
    /// sequence runs on a detached thread (Design decision 9) rather than
    /// blocking here. The waiter thread spawned in `start_inner` still
    /// observes the exit and emits the terminal `exit` frame — stop and a
    /// natural exit share one cleanup path.
    pub fn stop(&self, args: AgentPaneArgs) -> Result<(), String> {
        let mut sessions = lock_or_recover(&self.sessions);
        let live_session = match sessions.remove(&args.pane_id) {
            None => return Ok(()),
            Some(SessionSlot::Live(session)) => session,
            // Mid-spawn in some other `start_inner` call for this pane —
            // there is no pid yet, so there is nothing to signal directly.
            // Put the reservation back as `Cancelled`, still carrying its
            // own id, instead of just discarding it (F1's second race,
            // review-2.md): a bare `remove` here would let the in-flight
            // `start_inner` see an empty slot at its own publish step and
            // unconditionally publish `Live`, silently undoing this `stop`
            // a moment later. Recording the cancellation under the
            // reservation's own id lets that publish check refuse to
            // publish and kill the child it just spawned instead of
            // registering it.
            Some(SessionSlot::Reserved(id)) => {
                sessions.insert(args.pane_id, SessionSlot::Cancelled(id));
                return Ok(());
            }
            // A second `stop()` racing the same window as a first one —
            // already cancelled, so put it back untouched rather than
            // dropping the id the in-flight `start_inner` still needs.
            Some(SessionSlot::Cancelled(id)) => {
                sessions.insert(args.pane_id, SessionSlot::Cancelled(id));
                return Ok(());
            }
        };
        drop(sessions);
        // Dropping `live_session` drops `stdin_tx`, which ends the writer
        // thread's loop and closes stdin — the CLI's own clean-exit path,
        // in addition to the signal below.
        let pid = live_session.pid;
        drop(live_session);

        terminate_process_group(pid);
        Ok(())
    }

    /// Stop every live session. Called from the main window's
    /// `CloseRequested` handler, where the app is about to exit and a
    /// detached grace-period thread would be killed mid-grace — so unlike
    /// `stop`, this runs the SIGTERM→grace→SIGKILL sequence inline. Same
    /// shape and the same `SHUTDOWN_GRACE_MS` as
    /// `scheduler::shutdown_running_jobs` (`scheduler/mod.rs:130-154`),
    /// including the early return when nothing is live.
    pub fn close_all(&self) {
        // `Reserved`/`Cancelled` slots (mid-spawn in some concurrent
        // `start_inner` call, no pid yet either way) are dropped along with
        // everything else here but not signalled — there is nothing to
        // signal yet. The in-flight `start_inner` call still owns killing
        // whatever it eventually spawns, via its own publish-step ownership
        // check (F1's second race, review-2.md).
        let sessions: Vec<AgentSession> = lock_or_recover(&self.sessions)
            .drain()
            .filter_map(|(_, slot)| slot.into_live())
            .collect();
        if sessions.is_empty() {
            return;
        }
        let pids: Vec<u32> = sessions.iter().map(|s| s.pid).collect();
        // Drop every `stdin_tx` before signalling, closing each stdin.
        drop(sessions);

        for pid in &pids {
            crate::scheduler::kill_group(*pid, libc::SIGTERM);
        }
        thread::sleep(Duration::from_millis(SHUTDOWN_GRACE_MS));
        for pid in &pids {
            crate::scheduler::kill_group(*pid, libc::SIGKILL);
        }
    }

    /// The pane ids of every session this process currently holds.
    ///
    /// Reserved and cancelled slots are excluded — a reservation is a start
    /// still in flight, and its `agent_runs` row does not exist yet (the row is
    /// written after `agent_start` resolves), so it has nothing to reconcile
    /// against. See `list_live_panes` (`lib.rs`) for why the shell answers this
    /// rather than the sidecar.
    pub fn live_pane_ids(&self) -> Vec<String> {
        lock_or_recover(&self.sessions)
            .iter()
            .filter(|(_, slot)| slot.live().is_some())
            .map(|(pane_id, _)| pane_id.clone())
            .collect()
    }

    /// Number of currently-live sessions.
    ///
    /// `cfg(test)`-only: unlike `pty::PtyManager::active_count`
    /// (`pty/mod.rs:267-274`), which a real command
    /// (`get_active_terminal_count`) exposes to the frontend, this branch
    /// adds no frontend and no such command — the UI branch that follows can
    /// promote this to a production-reachable `pub fn` if it needs one.
    /// Left non-gated here it would be flagged as dead code under
    /// `cargo clippy --all-targets -- -D warnings`, since nothing outside
    /// the test module calls it.
    #[cfg(test)]
    pub(crate) fn active_count(&self) -> usize {
        lock_or_recover(&self.sessions)
            .values()
            .filter(|slot| slot.live().is_some())
            .count()
    }

    #[cfg(test)]
    pub(crate) fn contains(&self, pane_id: &str) -> bool {
        lock_or_recover(&self.sessions)
            .get(pane_id)
            .is_some_and(|slot| slot.live().is_some())
    }

    /// Whether `pane_id` currently holds a `Reserved` (not yet published,
    /// not cancelled) slot. `cfg(test)`-only, used to detect the
    /// reserve→publish window from outside for the F1 regression test
    /// below (review-2.md), together with `set_test_publish_delay`.
    #[cfg(test)]
    pub(crate) fn is_reserved(&self, pane_id: &str) -> bool {
        matches!(
            lock_or_recover(&self.sessions).get(pane_id),
            Some(SessionSlot::Reserved(_))
        )
    }

    /// Set (one-shot) the delay `start_inner` sleeps right after placing its
    /// reservation — see the field doc on `AgentManager::test_publish_delay`.
    #[cfg(test)]
    pub(crate) fn set_test_publish_delay(&self, delay: Duration) {
        *lock_or_recover(&self.test_publish_delay) = Some(delay);
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------
//
// All of them are sync (not async): `start`'s own work is a `spawn` plus four
// `thread::spawn`s, and the rest are a channel `send` or a signal —
// none blocks, so none needs the `spawn_blocking` wrapper
// `commands/hooks.rs:201` uses for a genuinely blocking probe. Sync commands
// also take `State<'_, …>` without the async-lifetime dance.

#[tauri::command]
pub fn agent_start(
    args: AgentStartArgs,
    state: State<'_, Arc<AgentManager>>,
    app: AppHandle,
) -> Result<AgentSessionHandle, String> {
    state.start(args, app)
}

#[tauri::command]
pub fn agent_send(args: AgentSendArgs, state: State<'_, Arc<AgentManager>>) -> Result<(), String> {
    state.send(args)
}

#[tauri::command]
pub fn agent_interrupt(args: AgentPaneArgs, state: State<'_, Arc<AgentManager>>) -> Result<(), String> {
    state.interrupt(args)
}

#[tauri::command]
pub fn agent_stop(args: AgentPaneArgs, state: State<'_, Arc<AgentManager>>) -> Result<(), String> {
    state.stop(args)
}

#[tauri::command]
pub fn agent_set_model(
    args: AgentSetModelArgs,
    state: State<'_, Arc<AgentManager>>,
) -> Result<(), String> {
    state.set_model(args)
}

#[tauri::command]
pub fn agent_set_permission_mode(
    args: AgentSetPermissionModeArgs,
    state: State<'_, Arc<AgentManager>>,
) -> Result<(), String> {
    state.set_permission_mode(args)
}

#[tauri::command]
pub fn agent_respond_permission(
    args: AgentPermissionArgs,
    state: State<'_, Arc<AgentManager>>,
) -> Result<(), String> {
    state.respond_permission(args)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use super::frame::AgentFrameKind;

    // -- Argv construction (pure, no process) --------------------------------

    /// `cwd` must exist — `start_inner` step 2 rejects a missing dir before
    /// spawning anything.
    fn start_args(pane_id: &str) -> AgentStartArgs {
        AgentStartArgs {
            pane_id: pane_id.into(),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            command: None,
            env: None,
            model: None,
            agent: None,
            permission_mode: None,
            allowed_tools: None,
        }
    }

    fn contains_pair(argv: &[String], flag: &str, value: &str) -> bool {
        argv.windows(2).any(|w| w[0] == flag && w[1] == value)
    }

    #[test]
    fn build_agent_argv_emits_the_duplex_flag_set() {
        let args = start_args("argv-a");
        let uuid = "11111111-1111-1111-1111-111111111111";
        let argv = build_agent_argv(&args, uuid).expect("build_agent_argv should succeed");

        let flags: Vec<&str> = argv[1..].iter().map(String::as_str).collect();
        assert_eq!(
            flags,
            vec![
                "--print",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--permission-prompt-tool",
                "stdio",
                "--session-id",
                uuid,
            ]
        );
    }

    #[test]
    fn build_agent_argv_has_no_positional_prompt() {
        let args = start_args("argv-b");
        let uuid = "22222222-2222-2222-2222-222222222222";
        let argv = build_agent_argv(&args, uuid).expect("build_agent_argv should succeed");
        assert_eq!(argv.last().map(String::as_str), Some(uuid));
    }

    #[test]
    fn build_agent_argv_passes_model_agent_and_tools() {
        let mut args = start_args("argv-c");
        args.model = Some("claude-sonnet-4-5".to_string());
        args.agent = Some("code-reviewer".to_string());
        args.allowed_tools = Some("Read,Write".to_string());
        let argv = build_agent_argv(&args, "sess").expect("build_agent_argv should succeed");

        assert!(contains_pair(&argv, "--model", "claude-sonnet-4-5"));
        assert!(contains_pair(&argv, "--agent", "code-reviewer"));
        assert!(contains_pair(&argv, "--allowedTools", "Read,Write"));
    }

    /// A provider whose `command_template` names a shell alias must still
    /// spawn: the alias is not exec-able, so argv[0] falls back to `claude`
    /// and the alias's `CLAUDE_CONFIG_DIR` reaches the child via
    /// `AgentStartArgs::env` instead. This is the 401-OAuth fix — a pane that
    /// spawned bare `claude` read the default `~/.claude` config.
    #[test]
    fn build_agent_argv_falls_back_to_claude_for_a_shell_alias() {
        let mut args = start_args("argv-alias");
        args.command = Some("claude-work {session_id} {mcp_config}".to_string());
        let argv = build_agent_argv(&args, "sess").expect("build_agent_argv should succeed");

        assert_eq!(argv[0], "claude");
        // The template's placeholders belong to the PTY path — none of them
        // may leak into a duplex argv.
        assert!(!argv.iter().any(|a| a.contains('{')));
    }

    /// An absolute path is a real executable, not an alias, so it is used
    /// verbatim — same rule as `scheduler::resolve_binary`.
    #[test]
    fn build_agent_argv_uses_an_absolute_command_verbatim() {
        let mut args = start_args("argv-abs");
        args.command = Some("/opt/homebrew/bin/claude".to_string());
        let argv = build_agent_argv(&args, "sess").expect("build_agent_argv should succeed");
        assert_eq!(argv[0], "/opt/homebrew/bin/claude");
    }

    #[test]
    fn build_agent_argv_omits_empty_optionals() {
        let mut args = start_args("argv-d");
        args.model = Some(String::new());
        args.agent = Some(String::new());
        args.allowed_tools = Some(String::new());
        args.permission_mode = None;
        let argv = build_agent_argv(&args, "sess").expect("build_agent_argv should succeed");

        assert!(!argv.iter().any(|a| a == "--model"));
        assert!(!argv.iter().any(|a| a == "--agent"));
        assert!(!argv.iter().any(|a| a == "--allowedTools"));
        assert!(!argv.iter().any(|a| a == "--permission-mode"));
        assert!(!argv.iter().any(|a| a == "--dangerously-skip-permissions"));
    }

    #[test]
    fn build_agent_argv_maps_bypass_to_skip_permissions() {
        let mut args = start_args("argv-e");
        args.permission_mode = Some("bypassPermissions".to_string());
        let argv = build_agent_argv(&args, "sess").expect("build_agent_argv should succeed");

        assert!(argv.iter().any(|a| a == "--dangerously-skip-permissions"));
        assert!(!argv.iter().any(|a| a == "--permission-mode"));
    }

    #[test]
    fn build_agent_argv_accepts_every_documented_permission_mode() {
        for mode in PERMISSION_MODES {
            let mut args = start_args("argv-f");
            args.permission_mode = Some(mode.to_string());
            let result = build_agent_argv(&args, "sess");
            assert!(result.is_ok(), "mode {mode} should be accepted, got {result:?}");
        }
    }

    #[test]
    fn build_agent_argv_rejects_an_unknown_permission_mode() {
        let mut args = start_args("argv-g");
        args.permission_mode = Some("not-a-real-mode".to_string());
        let err = build_agent_argv(&args, "sess").expect_err("unknown mode must be rejected");
        assert!(err.contains("unsupported permission mode"));
    }

    // -- Lifecycle, driven through the whole-argv test override --------------

    fn echoer() -> Vec<String> {
        vec!["cat".to_string()]
    }

    fn instant() -> Vec<String> {
        vec!["sh".to_string(), "-c".to_string(), "exit 0".to_string()]
    }

    fn noisy() -> Vec<String> {
        vec![
            "sh".to_string(),
            "-c".to_string(),
            "echo boom >&2; sleep 5".to_string(),
        ]
    }

    type Collector = Arc<Mutex<Vec<AgentFrame>>>;

    fn collector_emit(collector: &Collector) -> impl Fn(AgentFrame) + Send + Clone + 'static {
        let collector = Arc::clone(collector);
        move |frame: AgentFrame| {
            collector.lock().unwrap().push(frame);
        }
    }

    /// Poll a condition for up to ~2s (20ms * 100), the same bounded-poll
    /// shape as `scheduler/mod.rs:1114-1125`.
    fn poll_until(mut check: impl FnMut() -> bool) -> bool {
        for _ in 0..100 {
            if check() {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn start_registers_the_pane_and_stop_removes_it() {
        let mgr = AgentManager::new();
        let collector: Collector = Arc::new(Mutex::new(Vec::new()));
        let handle = mgr
            .start_inner(start_args("pane-a"), Some(echoer()), collector_emit(&collector))
            .expect("start_inner should succeed with the echoer fixture");

        assert!(mgr.contains("pane-a"));
        assert_eq!(mgr.active_count(), 1);
        assert_eq!(handle.pane_id, "pane-a");

        mgr.stop(AgentPaneArgs {
            pane_id: "pane-a".to_string(),
        })
        .expect("stop should succeed");
        assert!(poll_until(|| mgr.active_count() == 0));
    }

    #[test]
    fn start_twice_on_one_pane_is_rejected() {
        let mgr = AgentManager::new();
        let collector: Collector = Arc::new(Mutex::new(Vec::new()));
        mgr.start_inner(start_args("pane-b"), Some(echoer()), collector_emit(&collector))
            .expect("first start_inner should succeed");

        let err = mgr
            .start_inner(start_args("pane-b"), Some(echoer()), collector_emit(&collector))
            .expect_err("second start on the same pane must fail");
        assert!(err.contains("agent session already running"));
        assert_eq!(mgr.active_count(), 1, "no orphaned child from the rejected start");

        mgr.stop(AgentPaneArgs {
            pane_id: "pane-b".to_string(),
        })
        .expect("stop should succeed");
        assert!(poll_until(|| mgr.active_count() == 0));
    }

    /// Regression test for F1 (review-1.md): two `agent_start` calls for the
    /// *same* pane_id dispatched at the same instant must not both win. A
    /// `std::sync::Barrier` lines up two threads to call `start_inner`
    /// together rather than relying on incidental scheduling to expose the
    /// race — with the check-and-reserve now atomic, exactly one call can
    /// ever observe an empty slot for this pane_id, so this holds
    /// deterministically rather than only "usually".
    #[test]
    fn concurrent_start_calls_for_one_pane_only_register_once() {
        let mgr = Arc::new(AgentManager::new());
        let collector: Collector = Arc::new(Mutex::new(Vec::new()));
        let barrier = Arc::new(std::sync::Barrier::new(2));

        let handles: Vec<_> = (0..2)
            .map(|_| {
                let mgr = Arc::clone(&mgr);
                let collector = Arc::clone(&collector);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    mgr.start_inner(start_args("pane-race"), Some(echoer()), collector_emit(&collector))
                })
            })
            .collect();

        let results: Vec<Result<AgentSessionHandle, String>> =
            handles.into_iter().map(|h| h.join().expect("thread should not panic")).collect();
        let ok_count = results.iter().filter(|r| r.is_ok()).count();
        assert_eq!(
            ok_count, 1,
            "exactly one of two concurrent start_inner calls for one pane must win, got {results:?}"
        );

        assert_eq!(
            mgr.active_count(),
            1,
            "the losing call's spawn (if any) must never overwrite the winner's registry entry"
        );

        mgr.stop(AgentPaneArgs {
            pane_id: "pane-race".to_string(),
        })
        .expect("stop should succeed");
        assert!(poll_until(|| mgr.active_count() == 0));
    }

    // -- F1's second race: `stop()` landing while `start_inner` is still
    // `Reserved` (review-2.md) ------------------------------------------

    #[test]
    fn stop_on_a_reserved_slot_marks_it_cancelled_instead_of_discarding_it() {
        let mgr = AgentManager::new();
        let pane_id = "pane-stop-reserved";
        mgr.sessions
            .lock()
            .unwrap()
            .insert(pane_id.to_string(), SessionSlot::Reserved("resv-id".to_string()));

        mgr.stop(AgentPaneArgs {
            pane_id: pane_id.to_string(),
        })
        .expect("stop on a Reserved slot must still succeed");

        let sessions = mgr.sessions.lock().unwrap();
        let cancelled_id = match sessions.get(pane_id) {
            Some(SessionSlot::Cancelled(id)) => id.clone(),
            _ => panic!("expected the slot to become Cancelled, carrying the reservation's id"),
        };
        assert_eq!(cancelled_id, "resv-id");
    }

    #[test]
    fn stop_on_an_already_cancelled_slot_is_idempotent() {
        let mgr = AgentManager::new();
        let pane_id = "pane-stop-cancelled-twice";
        mgr.sessions
            .lock()
            .unwrap()
            .insert(pane_id.to_string(), SessionSlot::Cancelled("resv-id".to_string()));

        mgr.stop(AgentPaneArgs {
            pane_id: pane_id.to_string(),
        })
        .expect("stop on an already-Cancelled slot must still succeed");

        let sessions = mgr.sessions.lock().unwrap();
        let id = match sessions.get(pane_id) {
            Some(SessionSlot::Cancelled(id)) => id.clone(),
            _ => panic!("a second stop() must not drop the cancellation's id"),
        };
        assert_eq!(id, "resv-id");
    }

    /// A `Cancelled` slot still occupies `pane_id`: a fresh `agent_start`
    /// for the same pane while a stopped reservation is still being
    /// unwound must be rejected exactly like a live session would be, not
    /// treated as free. This is what closes the three-call variant of F1's
    /// original race (review-1.md) — `stop()` no longer vacates the key at
    /// all, so a third `start` can never see a genuinely-empty slot during
    /// this window.
    #[test]
    fn start_is_rejected_while_a_cancelled_reservation_still_occupies_the_pane() {
        let mgr = AgentManager::new();
        let pane_id = "pane-cancelled-blocks-restart";
        mgr.sessions
            .lock()
            .unwrap()
            .insert(pane_id.to_string(), SessionSlot::Cancelled("resv-id".to_string()));

        let collector: Collector = Arc::new(Mutex::new(Vec::new()));
        let err = mgr
            .start_inner(start_args(pane_id), Some(echoer()), collector_emit(&collector))
            .expect_err("a pane with a Cancelled reservation must still read as occupied");
        assert!(err.contains("agent session already running"));
    }

    #[test]
    fn reservation_guard_cleans_up_a_cancelled_slot_on_an_early_failure() {
        let mgr = AgentManager::new();
        let sessions = Arc::clone(&mgr.sessions);
        let pane_id = "pane-cancel-early-fail".to_string();
        let session_id = "fixed-session-id".to_string();

        // Simulate the state a racing `stop()` would have produced: a
        // reservation already cancelled under its own id.
        sessions
            .lock()
            .unwrap()
            .insert(pane_id.clone(), SessionSlot::Cancelled(session_id.clone()));

        let guard = ReservationGuard {
            sessions: Arc::clone(&sessions),
            pane_id: pane_id.clone(),
            session_id,
            armed: true,
        };
        drop(guard);

        assert!(
            !sessions.lock().unwrap().contains_key(&pane_id),
            "the guard must remove its own cancelled reservation rather than leave it dangling"
        );
    }

    #[test]
    fn reservation_guard_does_not_remove_a_slot_it_no_longer_owns() {
        let mgr = AgentManager::new();
        let sessions = Arc::clone(&mgr.sessions);
        let pane_id = "pane-guard-mismatch".to_string();

        sessions.lock().unwrap().insert(
            pane_id.clone(),
            SessionSlot::Reserved("someone-elses-id".to_string()),
        );

        let guard = ReservationGuard {
            sessions: Arc::clone(&sessions),
            pane_id: pane_id.clone(),
            session_id: "my-id".to_string(),
            armed: true,
        };
        drop(guard);

        assert!(
            sessions.lock().unwrap().contains_key(&pane_id),
            "the guard must not remove a reservation belonging to a different session_id"
        );
    }

    /// End-to-end regression test for F1's second race (review-2.md): a
    /// `stop()` landing while `start_inner` is still `Reserved` — between
    /// the reservation (step 1) and the publish (step 9) — must not be
    /// silently undone by that same `start_inner` call re-publishing `Live`
    /// afterward. `set_test_publish_delay` widens that window (otherwise a
    /// handful of syscalls, too narrow to race reliably from a test) so
    /// `stop()` deterministically lands on the `Reserved` slot instead of
    /// racing before the reservation exists or after `Live` is published.
    #[test]
    fn stop_racing_the_reservation_window_kills_the_child_instead_of_publishing_it() {
        let mgr = Arc::new(AgentManager::new());
        mgr.set_test_publish_delay(Duration::from_millis(150));
        let collector: Collector = Arc::new(Mutex::new(Vec::new()));

        let start_mgr = Arc::clone(&mgr);
        let start_collector = Arc::clone(&collector);
        let start_handle = thread::spawn(move || {
            start_mgr.start_inner(
                start_args("pane-race-stop"),
                Some(echoer()),
                collector_emit(&start_collector),
            )
        });

        assert!(
            poll_until(|| mgr.is_reserved("pane-race-stop")),
            "the reservation should become visible well within the delay window"
        );
        mgr.stop(AgentPaneArgs {
            pane_id: "pane-race-stop".to_string(),
        })
        .expect("stop should succeed even while the pane is only reserved");

        let result = start_handle.join().expect("start_inner thread should not panic");
        let err = result.expect_err(
            "start_inner racing a stop() during its own provisioning window must not publish Live",
        );
        assert!(err.contains("was stopped before it finished starting"));

        assert_eq!(
            mgr.active_count(),
            0,
            "the cancelled session must never become visible as Live"
        );
        assert!(
            !mgr.contains("pane-race-stop"),
            "the registry must not retain the cancelled entry"
        );
        assert!(poll_until(|| collector
            .lock()
            .unwrap()
            .iter()
            .any(|f| f.kind == AgentFrameKind::Exit)));
    }

    #[test]
    fn send_round_trips_one_line_through_the_child() {
        let mgr = AgentManager::new();
        let collector: Collector = Arc::new(Mutex::new(Vec::new()));
        mgr.start_inner(start_args("pane-c"), Some(echoer()), collector_emit(&collector))
            .expect("start_inner should succeed with the echoer fixture");

        mgr.send(AgentSendArgs {
            pane_id: "pane-c".to_string(),
            text: "hello duplex".to_string(),
        })
        .expect("send should succeed");

        assert!(poll_until(|| collector
            .lock()
            .unwrap()
            .iter()
            .any(|f| f.kind == AgentFrameKind::User)));

        let frames = collector.lock().unwrap();
        let user_frames: Vec<&AgentFrame> =
            frames.iter().filter(|f| f.kind == AgentFrameKind::User).collect();
        assert_eq!(user_frames.len(), 1, "expected exactly one echoed User frame");
        assert_eq!(
            user_frames[0].raw["message"]["content"][0]["text"].as_str(),
            Some("hello duplex")
        );
        drop(frames);

        mgr.stop(AgentPaneArgs {
            pane_id: "pane-c".to_string(),
        })
        .expect("stop should succeed");
        assert!(poll_until(|| mgr.active_count() == 0));
    }

    #[test]
    fn interrupt_round_trips_a_control_request_through_the_child() {
        let mgr = AgentManager::new();
        let collector: Collector = Arc::new(Mutex::new(Vec::new()));
        mgr.start_inner(start_args("pane-k"), Some(echoer()), collector_emit(&collector))
            .expect("start_inner should succeed with the echoer fixture");

        mgr.interrupt(AgentPaneArgs {
            pane_id: "pane-k".to_string(),
        })
        .expect("interrupt should succeed");

        assert!(poll_until(|| collector
            .lock()
            .unwrap()
            .iter()
            .any(|f| f.kind == AgentFrameKind::Control)));

        let frames = collector.lock().unwrap();
        let control_frames: Vec<&AgentFrame> =
            frames.iter().filter(|f| f.kind == AgentFrameKind::Control).collect();
        assert_eq!(control_frames.len(), 1, "expected exactly one echoed control_request frame");
        assert_eq!(control_frames[0].raw["request_id"].as_str(), Some("codenest-0"));
        assert_eq!(control_frames[0].raw["request"]["subtype"].as_str(), Some("interrupt"));
        drop(frames);

        mgr.stop(AgentPaneArgs {
            pane_id: "pane-k".to_string(),
        })
        .expect("stop should succeed");
        assert!(poll_until(|| mgr.active_count() == 0));
    }

    /// A live model switch must reach the child as one `control_request` on
    /// the same stdin the session already owns — no restart, no second
    /// process. The `echoer` fixture reflects stdin back as stdout, so the
    /// frame the collector sees *is* the line the writer thread sent.
    #[test]
    fn set_model_round_trips_a_control_request_through_the_child() {
        let mgr = AgentManager::new();
        let collector: Collector = Arc::new(Mutex::new(Vec::new()));
        mgr.start_inner(start_args("pane-model"), Some(echoer()), collector_emit(&collector))
            .expect("start_inner should succeed with the echoer fixture");

        mgr.set_model(AgentSetModelArgs {
            pane_id: "pane-model".to_string(),
            model: "claude-opus-5".to_string(),
        })
        .expect("set_model should succeed");

        assert!(poll_until(|| collector
            .lock()
            .unwrap()
            .iter()
            .any(|f| f.kind == AgentFrameKind::Control)));

        let frames = collector.lock().unwrap();
        let control_frames: Vec<&AgentFrame> =
            frames.iter().filter(|f| f.kind == AgentFrameKind::Control).collect();
        assert_eq!(control_frames.len(), 1);
        assert_eq!(control_frames[0].raw["request"]["subtype"].as_str(), Some("set_model"));
        assert_eq!(control_frames[0].raw["request"]["model"].as_str(), Some("claude-opus-5"));
        drop(frames);

        assert_eq!(
            mgr.active_count(),
            1,
            "a model switch must leave the session running — it is not a restart"
        );

        mgr.stop(AgentPaneArgs {
            pane_id: "pane-model".to_string(),
        })
        .expect("stop should succeed");
        assert!(poll_until(|| mgr.active_count() == 0));
    }

    #[test]
    fn set_model_rejects_an_empty_model_before_touching_the_registry() {
        let mgr = AgentManager::new();
        let err = mgr
            .set_model(AgentSetModelArgs {
                pane_id: "no-such-pane".to_string(),
                model: "   ".to_string(),
            })
            .expect_err("an empty model must be rejected");
        assert!(err.contains("model must not be empty"));
    }

    #[test]
    fn set_model_unknown_pane_is_an_error() {
        let mgr = AgentManager::new();
        let err = mgr
            .set_model(AgentSetModelArgs {
                pane_id: "no-such-pane".to_string(),
                model: "claude-opus-5".to_string(),
            })
            .expect_err("an unknown pane must be an error, not a panic");
        assert!(err.contains("no live agent session"));
    }

    /// A live permission-mode switch must reach the child as one
    /// `control_request` on the session's existing stdin — the whole point of
    /// the control channel over a restart, since a restart loses the
    /// conversation the mode is being changed for.
    #[test]
    fn set_permission_mode_round_trips_a_control_request_through_the_child() {
        let mgr = AgentManager::new();
        let collector: Collector = Arc::new(Mutex::new(Vec::new()));
        mgr.start_inner(start_args("pane-mode"), Some(echoer()), collector_emit(&collector))
            .expect("start_inner should succeed with the echoer fixture");

        mgr.set_permission_mode(AgentSetPermissionModeArgs {
            pane_id: "pane-mode".to_string(),
            mode: "acceptEdits".to_string(),
        })
        .expect("set_permission_mode should succeed");

        assert!(poll_until(|| collector
            .lock()
            .unwrap()
            .iter()
            .any(|f| f.kind == AgentFrameKind::Control)));

        let frames = collector.lock().unwrap();
        let control_frames: Vec<&AgentFrame> =
            frames.iter().filter(|f| f.kind == AgentFrameKind::Control).collect();
        assert_eq!(control_frames.len(), 1);
        assert_eq!(
            control_frames[0].raw["request"]["subtype"].as_str(),
            Some("set_permission_mode")
        );
        assert_eq!(control_frames[0].raw["request"]["mode"].as_str(), Some("acceptEdits"));
        drop(frames);

        assert_eq!(
            mgr.active_count(),
            1,
            "a mode switch must leave the session running — it is not a restart"
        );

        mgr.stop(AgentPaneArgs {
            pane_id: "pane-mode".to_string(),
        })
        .expect("stop should succeed");
        assert!(poll_until(|| mgr.active_count() == 0));
    }

    /// Validated locally so a typo is a synchronous error, not an async
    /// `control_response` error the caller would have to correlate by id.
    #[test]
    fn set_permission_mode_rejects_an_unknown_mode_before_touching_the_registry() {
        let mgr = AgentManager::new();
        let err = mgr
            .set_permission_mode(AgentSetPermissionModeArgs {
                pane_id: "no-such-pane".to_string(),
                mode: "yolo".to_string(),
            })
            .expect_err("an unknown mode must be rejected");
        assert!(err.contains("unsupported permission mode"));

        let empty = mgr
            .set_permission_mode(AgentSetPermissionModeArgs {
                pane_id: "no-such-pane".to_string(),
                mode: "   ".to_string(),
            })
            .expect_err("an empty mode must be rejected");
        assert!(empty.contains("permission mode must not be empty"));
    }

    /// Every mode the spawn-time flag accepts must also be accepted here: the
    /// composer offers one list, and `manual` in particular is the `--help`
    /// spelling the CLI aliases to `default` on the control path.
    #[test]
    fn set_permission_mode_accepts_every_documented_mode() {
        let mgr = AgentManager::new();
        for mode in PERMISSION_MODES {
            let err = mgr
                .set_permission_mode(AgentSetPermissionModeArgs {
                    pane_id: "no-such-pane".to_string(),
                    mode: mode.to_string(),
                })
                .expect_err("no session is registered, so this must fail on the lookup");
            assert!(
                err.contains("no live agent session"),
                "{mode} must pass validation and fail on the registry lookup instead, got: {err}"
            );
        }
    }

    /// The agent half of the reconciliation input. A session that has exited
    /// must drop out, because "still listed" is what keeps its run row at
    /// `running` — the whole point of the sweep is that an unreported death
    /// leaves a row claiming a session is alive.
    #[test]
    fn live_pane_ids_tracks_running_sessions() {
        let mgr = AgentManager::new();
        assert!(mgr.live_pane_ids().is_empty());

        let collector: Collector = Arc::new(Mutex::new(Vec::new()));
        mgr.start_inner(start_args("pane-live"), Some(echoer()), collector_emit(&collector))
            .expect("start_inner should succeed with the echoer fixture");
        assert_eq!(mgr.live_pane_ids(), vec!["pane-live".to_string()]);

        mgr.stop(AgentPaneArgs {
            pane_id: "pane-live".to_string(),
        })
        .expect("stop should succeed");
        assert!(poll_until(|| mgr.live_pane_ids().is_empty()));
    }

    #[test]
    fn respond_permission_unknown_pane_is_an_error() {
        let mgr = AgentManager::new();
        let err = mgr
            .respond_permission(AgentPermissionArgs {
                pane_id: "no-such-pane".to_string(),
                request_id: "req_1".to_string(),
                allow: true,
                updated_input: None,
                message: None,
            })
            .expect_err("an unknown pane must be an error, not a panic");
        assert!(err.contains("no live agent session"));
    }

    #[test]
    fn respond_permission_writes_one_line_through_the_child() {
        let mgr = AgentManager::new();
        let collector: Collector = Arc::new(Mutex::new(Vec::new()));
        mgr.start_inner(start_args("pane-perm"), Some(echoer()), collector_emit(&collector))
            .expect("start_inner should succeed with the echoer fixture");

        mgr.respond_permission(AgentPermissionArgs {
            pane_id: "pane-perm".to_string(),
            request_id: "req_perm_1".to_string(),
            allow: true,
            updated_input: Some(serde_json::json!({"command": "curl -s https://example.com"})),
            message: None,
        })
        .expect("respond_permission should succeed");

        assert!(poll_until(|| collector
            .lock()
            .unwrap()
            .iter()
            .any(|f| f.kind == AgentFrameKind::Control)));

        let frames = collector.lock().unwrap();
        let control_frames: Vec<&AgentFrame> =
            frames.iter().filter(|f| f.kind == AgentFrameKind::Control).collect();
        assert_eq!(control_frames.len(), 1, "expected exactly one echoed control_response frame");
        assert_eq!(
            control_frames[0].raw["response"]["request_id"].as_str(),
            Some("req_perm_1")
        );
        drop(frames);

        mgr.stop(AgentPaneArgs {
            pane_id: "pane-perm".to_string(),
        })
        .expect("stop should succeed");
        assert!(poll_until(|| mgr.active_count() == 0));
    }

    #[test]
    fn interrupt_after_exit_is_an_error_not_a_panic() {
        let mgr = AgentManager::new();
        let collector: Collector = Arc::new(Mutex::new(Vec::new()));
        mgr.start_inner(start_args("pane-l"), Some(instant()), collector_emit(&collector))
            .expect("start_inner should succeed with the instant-exit fixture");

        assert!(poll_until(|| mgr.active_count() == 0));

        let err = mgr
            .interrupt(AgentPaneArgs {
                pane_id: "pane-l".to_string(),
            })
            .expect_err("interrupt after the registry self-cleaned must be an error");
        assert!(err.contains("no live agent session for pane pane-l"));
    }

    #[test]
    fn stop_kills_the_process_group_and_emits_a_terminal_exit_frame() {
        let mgr = AgentManager::new();
        let collector: Collector = Arc::new(Mutex::new(Vec::new()));
        let handle = mgr
            .start_inner(start_args("pane-d"), Some(noisy()), collector_emit(&collector))
            .expect("start_inner should succeed with the noisy fixture");

        mgr.stop(AgentPaneArgs {
            pane_id: "pane-d".to_string(),
        })
        .expect("stop should succeed");

        assert!(poll_until(|| mgr.active_count() == 0));
        assert!(poll_until(|| collector.lock().unwrap().last().map(|f| f.kind)
            == Some(AgentFrameKind::Exit)));
        // The whole process group must actually be gone: kill(pid, 0) probes
        // for existence without sending a real signal and returns -1/ESRCH
        // once the group is reaped.
        assert!(poll_until(|| unsafe { libc::kill(-(handle.pid as i32), 0) } == -1));
    }

    #[test]
    fn child_exit_self_cleans_the_registry() {
        let mgr = AgentManager::new();
        let collector: Collector = Arc::new(Mutex::new(Vec::new()));
        mgr.start_inner(start_args("pane-e"), Some(instant()), collector_emit(&collector))
            .expect("start_inner should succeed with the instant-exit fixture");

        assert!(poll_until(|| mgr.active_count() == 0));
        assert!(poll_until(|| collector
            .lock()
            .unwrap()
            .iter()
            .any(|f| f.kind == AgentFrameKind::Exit)));
    }

    #[test]
    fn send_after_exit_is_an_error_not_a_panic() {
        let mgr = AgentManager::new();
        let collector: Collector = Arc::new(Mutex::new(Vec::new()));
        mgr.start_inner(start_args("pane-f"), Some(instant()), collector_emit(&collector))
            .expect("start_inner should succeed with the instant-exit fixture");

        assert!(poll_until(|| mgr.active_count() == 0));

        let err = mgr
            .send(AgentSendArgs {
                pane_id: "pane-f".to_string(),
                text: "too late".to_string(),
            })
            .expect_err("send after the registry self-cleaned must be an error");
        assert!(err.contains("no live agent session"));
    }

    #[test]
    fn stop_unknown_pane_is_idempotent_ok() {
        let mgr = AgentManager::new();
        mgr.stop(AgentPaneArgs {
            pane_id: "does-not-exist".to_string(),
        })
        .expect("stopping an unknown pane must succeed (idempotent)");
    }

    #[test]
    fn close_all_drains_multiple_panes() {
        let mgr = AgentManager::new();
        let collector: Collector = Arc::new(Mutex::new(Vec::new()));
        mgr.start_inner(start_args("pane-g"), Some(echoer()), collector_emit(&collector))
            .expect("first start_inner should succeed");
        mgr.start_inner(start_args("pane-h"), Some(echoer()), collector_emit(&collector))
            .expect("second start_inner should succeed");
        assert_eq!(mgr.active_count(), 2);

        mgr.close_all();

        assert!(poll_until(|| mgr.active_count() == 0));
    }

    #[test]
    fn start_rejects_an_empty_argv_override() {
        let mgr = AgentManager::new();
        let collector: Collector = Arc::new(Mutex::new(Vec::new()));
        let err = mgr
            .start_inner(start_args("pane-i"), Some(vec![]), collector_emit(&collector))
            .expect_err("an empty argv override must be rejected");
        assert!(err.contains("argv override must not be empty"));
        assert_eq!(mgr.active_count(), 0, "nothing should be spawned or registered");
    }

    #[test]
    fn stderr_lines_are_surfaced_as_frames() {
        let mgr = AgentManager::new();
        let collector: Collector = Arc::new(Mutex::new(Vec::new()));
        mgr.start_inner(start_args("pane-j"), Some(noisy()), collector_emit(&collector))
            .expect("start_inner should succeed with the noisy fixture");

        assert!(poll_until(|| collector.lock().unwrap().iter().any(|f| {
            f.kind == AgentFrameKind::Stderr && f.raw["text"].as_str() == Some("boom")
        })));

        mgr.stop(AgentPaneArgs {
            pane_id: "pane-j".to_string(),
        })
        .expect("stop should succeed");
        assert!(poll_until(|| mgr.active_count() == 0));
    }
}
