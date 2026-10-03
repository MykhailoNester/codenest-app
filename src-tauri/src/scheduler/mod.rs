//! Scheduled-session dispatch loop — Phase 1 execution bridge.
//!
//! ## Architecture
//!
//! The FastAPI sidecar owns schedule definitions and the run-lifecycle DB.
//! The Rust shell owns process spawning (the hard boundary from the project
//! rules). The bridge connects them via a **poll-dispatch** pattern:
//!
//! 1. The sidecar's tick loop inserts `queued` rows in `schedule_runs`
//!    whenever a cron schedule comes due.
//! 2. This module polls `GET /api/v1/schedules/dispatch/pending` every
//!    `POLL_INTERVAL_SECS` seconds on a dedicated background thread.
//! 3. For each pending run the shell:
//!    - Calls `POST /schedules/runs/{id}/start` (transitions to `running`).
//!    - Optionally resolves the provider's credentials from the sidecar.
//!    - Builds the `claude` command with prompt/model/permission_mode/tools/budget.
//!    - Spawns it headless with piped stdio (stdin = /dev/null — never a PTY,
//!      so `claude --print` gets stdin EOF and exits cleanly), streaming output
//!      to a per-run transcript file under `<APP_DATA_DIR>/schedule-runs/<run_id>.log`.
//!    - Enforces `max_runtime_sec` via a watchdog thread.
//!    - On process exit, parses the stream-json result for tokens/cost/summary
//!      and calls `POST /schedules/runs/{id}/finish`.
//!
//! ## Why poll, not SSE?
//!
//! The Rust shell already has a synchronous reqwest pattern (session/mod.rs
//! uses `reqwest::get` which resolves asynchronously, but here we use blocking
//! reqwest from a `std::thread` so there's no async runtime needed). A 5-second
//! poll introduces at most 5 s of dispatch latency — acceptable for scheduled
//! jobs that already have 30 s tick latency on the sidecar side.

use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Deserialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::pty::{PtyExitedPayload, PtyManager};

// ---------------------------------------------------------------------------
// Public payload types emitted to the frontend
// ---------------------------------------------------------------------------

/// Emitted on `schedule_run_started` when a run begins.
/// The frontend listens and auto-surfaces the pane for windowed runs.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScheduleRunStartedPayload {
    pub run_id: i64,
    pub schedule_id: i64,
    pub schedule_name: String,
    pub pty_id: String,
    pub run_mode: String,
}

/// Emitted on `schedule_run_finished` when a run completes/times out.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScheduleRunFinishedPayload {
    pub run_id: i64,
    pub schedule_id: i64,
    pub schedule_name: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub notify_policy: String,
}

const SIDECAR_BASE: &str = "http://127.0.0.1:8002";
const POLL_INTERVAL_SECS: u64 = 5;

// Grace between SIGTERM and SIGKILL when stopping in-flight runs on app close.
const SHUTDOWN_GRACE_MS: u64 = 400;

/// `result_kind` value that triggers artifact handling (save-path injection +
/// produced-file capture). A single constant so the call sites can't drift via
/// a typo; tests deliberately pin the literal "artifact" to catch a changed value.
const RESULT_KIND_ARTIFACT: &str = "artifact";

// ---------------------------------------------------------------------------
// In-flight run registry
// ---------------------------------------------------------------------------

/// Maps `run_id` → the spawned `claude` child's **process-group leader PID**.
///
/// Each scheduled run is spawned in its own session (`setsid`), so the PID is
/// also a process-group id we can signal as a unit. The registry lets the app
/// stop every in-flight run when the window closes (`shutdown_running_jobs`),
/// rather than orphaning `claude` processes that would keep burning tokens and
/// then fail their `/finish` POST against an already-dead sidecar. Entries are
/// removed when a run finishes or times out.
pub type RunRegistry = Arc<Mutex<HashMap<i64, u32>>>;

/// Create an empty run registry. Held by `lib.rs` and passed to `start`.
pub fn new_registry() -> RunRegistry {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Signal an entire process group (negative pid targets the group).
///
/// `pub(crate)` (not private) so `agent::AgentManager` — the duplex-session
/// module's `stop` / `close_all` — can reuse the same negative-pid signalling
/// convention rather than duplicating this `unsafe` block. No behaviour
/// change for the scheduler itself.
pub(crate) fn kill_group(pid: u32, sig: i32) {
    // SAFETY: a bare libc::kill on a (possibly already-exited) pid is safe; the
    // worst case is ESRCH which we ignore.
    unsafe {
        libc::kill(-(pid as i32), sig);
    }
}

/// Stop every in-flight scheduled run. Called from the main window's
/// `CloseRequested` handler before the sidecar is shut down.
///
/// SIGTERM each run's process group (giving `claude` a moment to flush its
/// transcript + report finish), then SIGKILL any survivor after a short grace.
/// Clears the registry so a subsequent call is a no-op.
pub fn shutdown_running_jobs(registry: &RunRegistry) {
    let pids: Vec<u32> = {
        let mut guard = match registry.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let pids = guard.values().copied().collect::<Vec<_>>();
        guard.clear();
        pids
    };
    if pids.is_empty() {
        return;
    }
    log::info!(
        "[scheduler] stopping {} in-flight scheduled run(s) on app close",
        pids.len()
    );
    for pid in &pids {
        kill_group(*pid, libc::SIGTERM);
    }
    thread::sleep(Duration::from_millis(SHUTDOWN_GRACE_MS));
    for pid in &pids {
        kill_group(*pid, libc::SIGKILL);
    }
}

// ---------------------------------------------------------------------------
// Sidecar API response types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct PendingRun {
    run_id: i64,
    schedule_id: i64,
    session_id: String,
    trigger: String,
    #[allow(dead_code)]
    agent_name: Option<String>,
    prompt: Option<String>,
    project_id: Option<i64>,
    provider_id: Option<i64>,
    model: Option<String>,
    run_mode: Option<String>,
    permission_mode: Option<String>,
    allowed_tools: Option<String>,
    max_budget_usd: Option<f64>,
    max_runtime_sec: Option<i64>,
    notify_policy: Option<String>,
    /// Human-readable schedule name carried along for notification titles.
    schedule_name: Option<String>,
    result_kind: Option<String>,
    artifact_target_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PendingResponse {
    pending: Vec<PendingRun>,
}

#[derive(Debug, Clone, Deserialize)]
struct ProviderInfo {
    command_template: Option<String>,
    default_env: Option<HashMap<String, String>>,
    api_key: Option<String>,
    base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProjectInfo {
    root_path: Option<String>,
    path: Option<String>,
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Start the scheduler dispatch background thread.
///
/// Called from `lib.rs` `setup` after the sidecar has been started.
/// `app_data_dir` is used to locate/create the `schedule-runs/` transcript dir.
pub fn start(app: AppHandle, pty: Arc<PtyManager>, app_data_dir: PathBuf, registry: RunRegistry) {
    thread::spawn(move || run_loop(app, pty, app_data_dir, registry));
}

// ---------------------------------------------------------------------------
// Main poll loop
// ---------------------------------------------------------------------------

fn run_loop(app: AppHandle, pty: Arc<PtyManager>, app_data_dir: PathBuf, registry: RunRegistry) {
    let runs_dir = app_data_dir.join("schedule-runs");
    if let Err(e) = fs::create_dir_all(&runs_dir) {
        log::error!("[scheduler] failed to create schedule-runs dir: {e}");
    }

    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::error!("[scheduler] failed to build reqwest client: {e}");
            return;
        }
    };

    loop {
        match fetch_pending(&client) {
            Ok(runs) => {
                for run in runs {
                    if let Err(e) = dispatch_run(&client, &app, &pty, &runs_dir, &registry, run) {
                        log::error!("[scheduler] dispatch error: {e}");
                    }
                }
            }
            Err(e) => {
                log::debug!("[scheduler] poll failed (sidecar may be starting): {e}");
            }
        }
        thread::sleep(Duration::from_secs(POLL_INTERVAL_SECS));
    }
}

// ---------------------------------------------------------------------------
// Fetch pending runs from the sidecar dispatch queue
// ---------------------------------------------------------------------------

fn fetch_pending(client: &reqwest::blocking::Client) -> Result<Vec<PendingRun>, String> {
    let resp = client
        .get(format!("{SIDECAR_BASE}/api/v1/schedules/dispatch/pending"))
        .send()
        .map_err(|e| format!("fetch_pending: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("fetch_pending status {}", resp.status()));
    }
    let body: PendingResponse = resp
        .json()
        .map_err(|e| format!("fetch_pending json: {e}"))?;
    Ok(body.pending)
}

// ---------------------------------------------------------------------------
// Dispatch one run
// ---------------------------------------------------------------------------

fn dispatch_run(
    client: &reqwest::blocking::Client,
    app: &AppHandle,
    _pty: &Arc<PtyManager>,
    runs_dir: &Path,
    registry: &RunRegistry,
    run: PendingRun,
) -> Result<(), String> {
    let run_id = run.run_id;
    let schedule_id = run.schedule_id;
    let schedule_name = run
        .schedule_name
        .clone()
        .unwrap_or_else(|| format!("schedule#{schedule_id}"));
    // Carried into the started event and the log, but deliberately NOT branched
    // on: every run below spawns headless. A `windowed` run would need an
    // interactive process, which never exits on its own, so the watchdog, the
    // finish path and the stream-json token/cost source would all need
    // replacing — a feature with its own ticket, not a branch here. The
    // schedules form no longer offers the mode (see `lib/run-modes.ts`); a
    // legacy `windowed` row reaching this point runs headless, as it always did.
    let run_mode = run
        .run_mode
        .clone()
        .unwrap_or_else(|| "background".to_string());
    let notify_policy = run
        .notify_policy
        .clone()
        .unwrap_or_else(|| "on_failure".to_string());

    log::info!(
        "[scheduler] dispatching run_id={run_id} schedule_id={schedule_id} trigger={} run_mode={run_mode}",
        run.trigger
    );

    // Defensive provider guard: provider_id is required since create-time
    // validation, but legacy rows or direct DB edits may have it as NULL.
    // Rather than spawning headless claude with no credentials (silent 401),
    // fail fast with an actionable message.
    if run.provider_id.is_none() {
        let body = serde_json::json!({
            "exit_code": 1,
            "summary_text": "No provider configured for this schedule — scheduled runs need a credential provider. Edit the schedule and select a Provider.",
        });
        let _ = call_run_endpoint_impl(client, run_id, "finish", Some(body));
        return Ok(());
    }

    // Transition run to `running` before opening the PTY.
    call_run_endpoint(client, run_id, "start", None)?;

    // Resolve provider credentials (optional).
    let provider_info = run
        .provider_id
        .and_then(|pid| match fetch_provider(client, pid) {
            Ok(p) => Some(p),
            Err(e) => {
                log::warn!("[scheduler] run {run_id}: provider {pid} fetch failed: {e}");
                None
            }
        });

    // Resolve project root for cwd (optional).
    let cwd = run
        .project_id
        .and_then(|pid| match fetch_project_root(client, pid) {
            Ok(root) => Some(root),
            Err(e) => {
                log::warn!("[scheduler] run {run_id}: project {pid} root failed: {e}");
                None
            }
        });

    // Build command argv and env overlay.
    let (cmd_args, env) = build_claude_command(&run, provider_info.as_ref(), &run.session_id)?;
    if cmd_args.is_empty() {
        return Err("build_claude_command returned empty argv".to_string());
    }

    // Verify the credential actually resolves *in this run's environment*
    // before spending a dispatch on it. `claude auth status` is local, makes no
    // API call and costs nothing, so this is free insurance against the failure
    // mode where a provider is configured but the spawned CLI still cannot
    // authenticate. An inconclusive probe dispatches as before.
    if preflight_auth(&cmd_args[0], &env, cwd.as_deref()) == AuthPreflight::NotLoggedIn {
        let config_dir = env.get("CLAUDE_CONFIG_DIR").map(String::as_str);
        let summary = no_credential_message(config_dir);
        log::warn!("[scheduler] run {run_id}: {summary}");
        let body = serde_json::json!({
            "exit_code": 1,
            "summary_text": summary,
        });
        let _ = call_run_endpoint_impl(client, run_id, "finish", Some(body));
        return Ok(());
    }

    // Ensure the artifact output directory exists before spawning so the agent
    // can write its file without needing to create directories itself.
    if run.result_kind.as_deref() == Some(RESULT_KIND_ARTIFACT) {
        if let Some(parent) = run
            .artifact_target_path
            .as_deref()
            .filter(|t| !t.is_empty())
            .map(std::path::Path::new)
            .and_then(std::path::Path::parent)
        {
            if let Err(e) = fs::create_dir_all(parent) {
                log::warn!(
                    "[scheduler] run {run_id}: failed to create artifact dir {}: {e}",
                    parent.display()
                );
            }
        }
    }

    // Transcript path.
    let transcript_path = runs_dir.join(format!("{run_id}.log"));
    let transcript_path_str = transcript_path.to_string_lossy().to_string();

    // Truncate on open so each run_id owns a FRESH transcript. Opening in
    // append mode was a latent bug: after a DB reseed the schedule_runs
    // autoincrement restarts at 1 while old `<run_id>.log` files linger on
    // disk, so a new run would write *below* a previous era's transcript.
    // `parse_transcript` then read the STALE run's `result` event (e.g. an old
    // 401) and reported it as this run's outcome — a healthy run surfaced in the
    // UI as "Failed to authenticate". A given run_id is unique within a DB and
    // the overlap guard prevents two live dispatches sharing one, so truncating
    // is always safe.
    let transcript_file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&transcript_path)
        .map_err(|e| format!("open transcript: {e}"))?;
    let transcript_file = Arc::new(std::sync::Mutex::new(transcript_file));

    // ── Spawn the headless `claude` process with PIPED stdio ─────────────
    //
    // CRITICAL (fixes runs stuck at `running`): scheduled jobs are NOT
    // interactive, so we must NOT allocate a PTY for them. A PTY leaves the
    // child's stdin as an open TTY that never reaches EOF; `claude --print`
    // then never exits (it waits for stdin to close), so the run sits at
    // `running` until the watchdog kills it ~max_runtime later. Piping stdio
    // with `stdin = /dev/null` guarantees an immediate stdin EOF, so the
    // process runs and exits cleanly the moment it finishes.
    let mut command = Command::new(&cmd_args[0]);
    command.args(&cmd_args[1..]);
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    if let Some(ref dir) = cwd {
        let expanded = expand_tilde(dir);
        if Path::new(&expanded).exists() {
            command.current_dir(expanded);
        } else {
            log::warn!("[scheduler] run {run_id}: cwd {expanded} does not exist; ignoring");
        }
    }
    for (k, v) in &env {
        command.env(k, expand_tilde(v));
    }

    // Start the child in its own session/process group so the app can stop the
    // entire job (claude + anything it forks) as a unit on window close. The
    // child's PID then doubles as its PGID for `kill(-pid, …)`.
    // SAFETY: setsid is async-signal-safe and is the only call made in the
    // forked child before exec.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            // Report failure immediately so the run doesn't sit `running` forever.
            let body = serde_json::json!({
                "exit_code": -1,
                "transcript_path": transcript_path_str,
                "summary_text": format!("failed to spawn claude: {e}"),
            });
            let _ = call_run_endpoint_impl(client, run_id, "finish", Some(body));
            return Err(format!("spawn claude: {e}"));
        }
    };

    // Register the run's process-group leader PID so a window close can stop it.
    let run_pid = child.id();
    if let Ok(mut reg) = registry.lock() {
        reg.insert(run_id, run_pid);
    }

    let stdout = child.stdout.take().ok_or("claude stdout pipe missing")?;
    let stderr = child.stderr.take().ok_or("claude stderr pipe missing")?;

    let child_arc: Arc<std::sync::Mutex<std::process::Child>> =
        Arc::new(std::sync::Mutex::new(child));
    let child_arc_wdog = Arc::clone(&child_arc);
    let reg_wdog = Arc::clone(registry);
    let reg_finish = Arc::clone(registry);

    // Stable id so the frontend can subscribe via terminal_output:{pty_id}.
    // No real PTY is allocated — this is purely an event-channel key, kept so
    // the existing useTerminalOutput hook / AdaptiveRunPane work unchanged.
    let pty_id = Uuid::new_v4().to_string();
    let output_event = format!("terminal_output:{pty_id}");
    let schedule_event = format!("schedule_run_output:{run_id}");

    // Emit schedule_run_started so the Schedules page can attach live output.
    let _ = app.emit(
        "schedule_run_started",
        ScheduleRunStartedPayload {
            run_id,
            schedule_id,
            schedule_name: schedule_name.clone(),
            pty_id: pty_id.clone(),
            run_mode: run_mode.clone(),
        },
    );

    // stdout reader: append raw bytes to the transcript + forward base64 chunks
    // to the frontend (both the per-pty and per-run-id events).
    let app_out = app.clone();
    let tf_out = Arc::clone(&transcript_file);
    let out_handle = thread::spawn(move || {
        let mut reader = stdout;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut f) = tf_out.lock() {
                        let _ = f.write_all(&buf[..n]);
                    }
                    let chunk = B64.encode(&buf[..n]);
                    let _ = app_out.emit(&output_event, chunk.clone());
                    let _ = app_out.emit(&schedule_event, chunk);
                }
            }
        }
    });

    // stderr reader: capture diagnostics into the transcript (claude writes
    // stream-json to stdout; stderr carries startup/errors useful on failure).
    let tf_err = Arc::clone(&transcript_file);
    let err_handle = thread::spawn(move || {
        let mut reader = stderr;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut f) = tf_err.lock() {
                        let _ = f.write_all(&buf[..n]);
                    }
                }
            }
        }
    });

    let max_secs = run.max_runtime_sec.unwrap_or(900).max(30) as u64;

    // Guarantees exactly one of {finish, timeout} reports the terminal status.
    let handled = Arc::new(AtomicBool::new(false));
    let handled_wdog = Arc::clone(&handled);

    // Watchdog thread: kill + report timeout if max_runtime_sec exceeded.
    let client_wdog = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_default();
    let app_wdog = app.clone();
    let schedule_name_wdog = schedule_name.clone();
    let notify_policy_wdog = notify_policy.clone();
    let pty_id_wdog = pty_id.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(max_secs));
        if handled_wdog.swap(true, Ordering::SeqCst) {
            return; // run already finished normally
        }
        log::warn!("[scheduler] run {run_id}: timed out after {max_secs}s; killing");
        if let Ok(mut child) = child_arc_wdog.lock() {
            let _ = child.kill();
        }
        // Also reap anything claude forked (the child is a setsid group leader).
        kill_group(run_pid, libc::SIGKILL);
        let _ = call_run_endpoint_impl(&client_wdog, run_id, "timeout", None);
        let _ = app_wdog.emit(
            "pty-exited",
            PtyExitedPayload {
                id: pty_id_wdog,
                exit_code: Some(-1),
            },
        );
        let _ = app_wdog.emit(
            "schedule_run_finished",
            ScheduleRunFinishedPayload {
                run_id,
                schedule_id,
                schedule_name: schedule_name_wdog.clone(),
                status: "timed_out".to_string(),
                exit_code: Some(-1),
                notify_policy: notify_policy_wdog.clone(),
            },
        );
        maybe_notify(
            &app_wdog,
            &notify_policy_wdog,
            "timed_out",
            &schedule_name_wdog,
            None,
        );
        if let Ok(mut reg) = reg_wdog.lock() {
            reg.remove(&run_id);
        }
    });

    // Finish thread: wait for exit, parse transcript, report to sidecar.
    let client_finish = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("build finish client: {e}"))?;

    // Clone artifact metadata into the finish closure.
    let result_kind_finish = run.result_kind.clone();
    let artifact_target_path_finish = run.artifact_target_path.clone();
    // Record start time so we can find the newest file written during this run.
    let run_start_time = std::time::SystemTime::now();

    let app_finish = app.clone();
    thread::spawn(move || {
        // Poll for exit, releasing the lock between polls so the watchdog can
        // still kill on timeout. stdin is closed, so a healthy process exits
        // promptly; this loop therefore terminates quickly in the normal case.
        let exit_code = loop {
            {
                let mut child = match child_arc.lock() {
                    Ok(c) => c,
                    Err(_) => break -1,
                };
                match child.try_wait() {
                    Ok(Some(status)) => break status.code().unwrap_or(-1),
                    Ok(None) => {}
                    Err(_) => break -1,
                }
            }
            thread::sleep(Duration::from_millis(100));
        };

        if handled.swap(true, Ordering::SeqCst) {
            return; // watchdog already reported a timeout
        }

        // Drain readers so the transcript is complete before parsing.
        let _ = out_handle.join();
        let _ = err_handle.join();
        drop(transcript_file);

        let parsed = parse_transcript(&transcript_path_str);

        // claude can hit a fatal API error (e.g. a 401) yet still exit 0 with a
        // synthetic assistant message and `result.is_error = true`. Treat that
        // as a failure so the run isn't recorded as "succeeded" with 0 tokens.
        let effective_exit = if exit_code == 0 && parsed.is_error {
            1
        } else {
            exit_code
        };

        // Capture artifact_path for artifact-kind runs.
        let artifact_path: Option<String> =
            if result_kind_finish.as_deref() == Some(RESULT_KIND_ARTIFACT) {
                // Prefer the deterministic target if it exists and is non-empty.
                let explicit = artifact_target_path_finish.as_deref().unwrap_or("");
                if !explicit.is_empty() {
                    let p = std::path::Path::new(explicit);
                    if p.is_file() && p.metadata().map(|m| m.len() != 0).unwrap_or(false) {
                        Some(explicit.to_string())
                    } else {
                        // Fall back: scan the parent dir for the most-recently-modified
                        // regular file whose mtime is >= run_start_time.
                        p.parent().and_then(|parent| {
                            std::fs::read_dir(parent).ok().and_then(|entries| {
                                entries
                                    .filter_map(|e| e.ok())
                                    .filter(|e| e.path().is_file())
                                    .filter_map(|e| {
                                        let meta = e.path().metadata().ok()?;
                                        let mtime = meta.modified().ok()?;
                                        if mtime >= run_start_time {
                                            Some((e.path(), mtime))
                                        } else {
                                            None
                                        }
                                    })
                                    .max_by_key(|(_, mtime)| *mtime)
                                    .map(|(path, _)| path.to_string_lossy().to_string())
                            })
                        })
                    }
                } else {
                    None
                }
            } else {
                None
            };

        let mut finish_map = serde_json::json!({
            "exit_code": effective_exit,
            "transcript_path": transcript_path_str,
            "tokens_in": parsed.tokens_in,
            "tokens_out": parsed.tokens_out,
            "cost_usd": parsed.cost_usd,
            "summary_text": parsed.summary,
        });
        if let Some(ref ap) = artifact_path {
            finish_map["artifact_path"] = serde_json::Value::String(ap.clone());
        }
        let finish_body = finish_map;

        let status = if effective_exit == 0 {
            "succeeded"
        } else {
            "failed"
        };

        let _ = app_finish.emit(
            "pty-exited",
            PtyExitedPayload {
                id: pty_id,
                exit_code: Some(exit_code),
            },
        );

        if let Err(e) = call_run_endpoint_impl(&client_finish, run_id, "finish", Some(finish_body))
        {
            log::error!("[scheduler] run {run_id}: finish failed: {e}");
        } else {
            log::info!("[scheduler] run {run_id}: finished (exit={exit_code})");
        }

        // Emit schedule_run_finished event to the frontend.
        let _ = app_finish.emit(
            "schedule_run_finished",
            ScheduleRunFinishedPayload {
                run_id,
                schedule_id,
                schedule_name: schedule_name.clone(),
                status: status.to_string(),
                exit_code: Some(effective_exit),
                notify_policy: notify_policy.clone(),
            },
        );

        // Fire macOS notification based on notify_policy.
        maybe_notify(
            &app_finish,
            &notify_policy,
            status,
            &schedule_name,
            Some(effective_exit),
        );
        if let Ok(mut reg) = reg_finish.lock() {
            reg.remove(&run_id);
        }
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Native notification helper
// ---------------------------------------------------------------------------

/// Fire a macOS notification if the policy warrants it.
///
/// `status` is one of: `succeeded`, `failed`, `timed_out`, `missed`.
fn maybe_notify(app: &AppHandle, policy: &str, status: &str, name: &str, exit_code: Option<i32>) {
    use tauri_plugin_notification::NotificationExt;

    let should_notify = match policy {
        "never" => false,
        "every_run" => true,
        // on_failure (default): notify for any non-success outcome.
        _ => !matches!(status, "succeeded"),
    };

    if !should_notify {
        return;
    }

    let title = format!("Schedule '{}' {}", name, status.replace('_', " "));
    let body = match exit_code {
        Some(code) if code != 0 => format!("Exit code {code}"),
        Some(_) => "Completed successfully".to_string(),
        None => status.replace('_', " "),
    };

    let n = app.notification().builder().title(&title).body(&body);
    if let Err(e) = n.show() {
        log::warn!("[scheduler] notification failed: {e}");
    }
}

// ---------------------------------------------------------------------------
// Build `claude` command argv + env
// ---------------------------------------------------------------------------

fn build_claude_command(
    run: &PendingRun,
    provider: Option<&ProviderInfo>,
    session_id: &str,
) -> Result<(Vec<String>, HashMap<String, String>), String> {
    let mut args: Vec<String> = Vec::new();

    // Binary: extract base command from the provider's command_template.
    let base_cmd = provider
        .and_then(|p| p.command_template.as_deref())
        .unwrap_or("claude");
    // Strip `{placeholder}` tokens from the template — take the first bare token.
    let token = base_cmd
        .split_whitespace()
        .find(|t| !t.starts_with('{'))
        .unwrap_or("claude");
    // The token may be a shell ALIAS that only exists in an interactive shell
    // (e.g. `claude-alt` = `CLAUDE_CONFIG_DIR=~/.claude-alt command claude`).
    // We spawn directly (no shell), so an alias can't be exec'd. Fall back to the
    // real `claude` binary when the token isn't a resolvable executable — the
    // provider's CLAUDE_CONFIG_DIR / env (applied below) reproduces the alias.
    let binary = resolve_binary(token);
    args.push(binary);

    // Non-interactive print mode.
    args.push("--print".to_string());

    // Deterministic session ID.
    args.push("--session-id".to_string());
    args.push(session_id.to_string());

    // Structured output for token/cost parsing.
    args.push("--output-format".to_string());
    args.push("stream-json".to_string());
    // claude requires --verbose when combining --print with stream-json output.
    args.push("--verbose".to_string());

    // Model.
    if let Some(model) = &run.model {
        if !model.is_empty() {
            args.push("--model".to_string());
            args.push(model.clone());
        }
    }

    // Agent persona (optional — empty / None means no specific agent).
    if let Some(agent) = &run.agent_name {
        if !agent.is_empty() {
            args.push("--agent".to_string());
            args.push(agent.clone());
        }
    }

    // Permission mode (default: dontAsk for unattended safety). "Full access"
    // is expressed as --dangerously-skip-permissions, the canonical headless
    // flag (equivalent to --permission-mode bypassPermissions but accepted
    // outside a sandbox); every other mode is passed through verbatim.
    let perm = run.permission_mode.as_deref().unwrap_or("dontAsk");
    if perm == "bypassPermissions" {
        args.push("--dangerously-skip-permissions".to_string());
    } else {
        args.push("--permission-mode".to_string());
        args.push(perm.to_string());
    }

    // Allowed tools.
    if let Some(tools) = &run.allowed_tools {
        if !tools.is_empty() {
            args.push("--allowedTools".to_string());
            args.push(tools.clone());
        }
    }

    // Budget cap.
    if let Some(budget) = run.max_budget_usd {
        if budget > 0.0 {
            args.push("--max-budget-usd".to_string());
            args.push(format!("{budget:.4}"));
        }
    }

    // Prompt validation.
    let base_prompt = run.prompt.as_deref().unwrap_or("").trim().to_string();
    if base_prompt.is_empty() {
        return Err(format!(
            "schedule run {} has no prompt — cannot launch",
            run.run_id
        ));
    }

    // For artifact runs with a deterministic target path, append the save
    // instruction so the agent writes to the exact expected location.
    let is_artifact = run.result_kind.as_deref() == Some(RESULT_KIND_ARTIFACT);
    let prompt = match run.artifact_target_path.as_deref() {
        Some(path) if is_artifact && !path.is_empty() => format!(
            "{base_prompt}\n\n---\nDELIVERABLE: Write your final output to this exact file path:\n{path}\nCreate parent directories if needed. Save the complete deliverable to that file; do not rely on stdout for the result."
        ),
        _ => base_prompt,
    };

    // Build env overlay.
    let mut env: HashMap<String, String> = HashMap::new();

    if let Some(p) = provider {
        if let Some(ref key) = p.api_key {
            if !key.is_empty() {
                env.insert("ANTHROPIC_API_KEY".to_string(), key.clone());
            }
        }
        if let Some(ref url) = p.base_url {
            if !url.is_empty() {
                env.insert("ANTHROPIC_BASE_URL".to_string(), url.clone());
            }
        }
        if let Some(ref denv) = p.default_env {
            for (k, v) in denv {
                env.insert(k.clone(), v.clone());
            }
        }
    }

    env.insert("CODENEST_SESSION_MODE".to_string(), "scheduled".to_string());
    env.insert(
        "CODENEST_SCHEDULE_RUN_ID".to_string(),
        run.run_id.to_string(),
    );

    // Identity fallback. The CLI resolves a `claude.ai` login out of the macOS
    // login keychain by *account name*, and it takes that name from `$USER`.
    // A packaged app launched from Finder/Dock inherits the launchd GUI session
    // environment, which carries no `USER` (`launchctl getenv USER` is empty),
    // so the lookup misses and the run dies with `apiKeySource: "none"` /
    // "Not logged in". Running `pnpm tauri:dev` from a terminal happens to
    // supply `USER`, which is why this never reproduced in dev. Seed it from
    // the password database (never from the parent environment) when the
    // process did not inherit one; an inherited or provider-supplied value
    // always wins.
    let inherited_user = std::env::var("USER").ok();
    let inherited_logname = std::env::var("LOGNAME").ok();
    let login = os_login_name();
    for (key, value) in identity_overlay(
        inherited_user.as_deref(),
        inherited_logname.as_deref(),
        login.as_deref(),
    ) {
        env.entry(key.to_string()).or_insert(value);
    }

    // Prompt is the last positional arg.
    args.push(prompt);

    Ok((args, env))
}

// ---------------------------------------------------------------------------
// Transcript parser — extract tokens/cost from stream-json result event
// ---------------------------------------------------------------------------

/// Parsed outcome of a scheduled `claude` run's stream-json transcript.
#[derive(Debug, Default, PartialEq)]
struct ParsedTranscript {
    tokens_in: Option<i64>,
    tokens_out: Option<i64>,
    cost_usd: Option<f64>,
    summary: Option<String>,
    /// `true` when the terminal `result` event carries `is_error: true` — claude
    /// hit a fatal error (e.g. an auth 401) and may have exited 0 anyway.
    is_error: bool,
}

fn parse_transcript(path: &str) -> ParsedTranscript {
    let mut out = ParsedTranscript::default();
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return out,
    };

    // Keep the LAST `result` event. With truncate-on-open the file holds exactly
    // one run (which emits a single terminal result), but taking the last result
    // is robust even if stale content somehow precedes it.
    for line in content.lines() {
        let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if val.get("type").and_then(|t| t.as_str()) != Some("result") {
            continue;
        }
        if let Some(usage) = val.get("usage") {
            out.tokens_in = usage
                .get("input_tokens")
                .and_then(|v| v.as_i64())
                .or(out.tokens_in);
            out.tokens_out = usage
                .get("output_tokens")
                .and_then(|v| v.as_i64())
                .or(out.tokens_out);
        }
        // claude emits `total_cost_usd`; fall back to the legacy `cost_usd` key.
        if let Some(cost) = val
            .get("total_cost_usd")
            .or_else(|| val.get("cost_usd"))
            .and_then(|v| v.as_f64())
        {
            out.cost_usd = Some(cost);
        }
        if let Some(text) = val.get("result").and_then(|v| v.as_str()) {
            out.summary = Some(text.chars().take(500).collect());
        }
        out.is_error = val
            .get("is_error")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
    }

    out
}

// ---------------------------------------------------------------------------
// Provider + project resolution
// ---------------------------------------------------------------------------

fn fetch_provider(client: &reqwest::blocking::Client, pid: i64) -> Result<ProviderInfo, String> {
    let resp = client
        .get(format!(
            "{SIDECAR_BASE}/api/v1/providers/{pid}/launch-config"
        ))
        .send()
        .map_err(|e| format!("fetch provider: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("provider {pid} → {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().map_err(|e| format!("provider json: {e}"))?;
    Ok(ProviderInfo {
        command_template: body
            .get("command_template")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        default_env: body
            .get("default_env")
            .and_then(|v| serde_json::from_value::<HashMap<String, String>>(v.clone()).ok()),
        api_key: body
            .get("api_key")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        base_url: body
            .get("base_url")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    })
}

fn fetch_project_root(client: &reqwest::blocking::Client, pid: i64) -> Result<String, String> {
    let resp = client
        .get(format!("{SIDECAR_BASE}/api/v1/projects/{pid}"))
        .send()
        .map_err(|e| format!("fetch project: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("project {pid} → {}", resp.status()));
    }
    let body: ProjectInfo = resp.json().map_err(|e| format!("project json: {e}"))?;
    body.root_path
        .or(body.path)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("project {pid} has no root_path"))
}

// ---------------------------------------------------------------------------
// Sidecar run-lifecycle helpers
// ---------------------------------------------------------------------------

fn call_run_endpoint(
    client: &reqwest::blocking::Client,
    run_id: i64,
    action: &str,
    body: Option<serde_json::Value>,
) -> Result<(), String> {
    call_run_endpoint_impl(client, run_id, action, body)
}

fn call_run_endpoint_impl(
    client: &reqwest::blocking::Client,
    run_id: i64,
    action: &str,
    body: Option<serde_json::Value>,
) -> Result<(), String> {
    let url = format!("{SIDECAR_BASE}/api/v1/schedules/runs/{run_id}/{action}");
    let mut req = client.post(&url);
    if let Some(b) = body {
        req = req
            .header("Content-Type", "application/json")
            .body(b.to_string());
    }
    let resp = req.send().map_err(|e| format!("{action} send: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{action} status {}", resp.status()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Credential preflight
// ---------------------------------------------------------------------------

/// Outcome of asking the CLI whether the run's environment can authenticate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthPreflight {
    /// The CLI reports a usable credential (keychain login, API key or token).
    Ok,
    /// The CLI explicitly reports no credential — the run would fail in ~2s.
    NotLoggedIn,
    /// The probe could not be run or produced output we don't understand.
    /// Treated as "proceed": a probe we cannot interpret must never be the
    /// reason a schedule stops firing.
    Unknown,
}

/// How long the probe may take before we give up and dispatch anyway.
const AUTH_PREFLIGHT_TIMEOUT_SECS: u64 = 20;

/// Read `loggedIn` out of `claude auth status --json`.
///
/// Split out from the spawn so the decision table is unit-testable without a
/// CLI on PATH. Anything that isn't an explicit boolean is [`AuthPreflight::Unknown`]
/// so a future output change degrades to "dispatch anyway" rather than to
/// "refuse every run".
fn parse_auth_status(stdout: &str) -> AuthPreflight {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(stdout.trim()) else {
        return AuthPreflight::Unknown;
    };
    match value.get("loggedIn").and_then(serde_json::Value::as_bool) {
        Some(true) => AuthPreflight::Ok,
        Some(false) => AuthPreflight::NotLoggedIn,
        None => AuthPreflight::Unknown,
    }
}

/// Ask the CLI whether *this run's* environment can authenticate, before
/// spending a dispatch on it.
///
/// `claude auth status --json` is a local credential-resolution report: it
/// makes no API call, costs nothing and returns in ~0.2s. Crucially it is run
/// with the same binary, cwd and env overlay the real run will get, so it sees
/// the same `CLAUDE_CONFIG_DIR` / `ANTHROPIC_API_KEY` the run would see.
fn preflight_auth(binary: &str, env: &HashMap<String, String>, cwd: Option<&str>) -> AuthPreflight {
    let mut command = Command::new(binary);
    command.args(["auth", "status", "--json"]);
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::null());
    if let Some(dir) = cwd {
        let expanded = expand_tilde(dir);
        if Path::new(&expanded).exists() {
            command.current_dir(expanded);
        }
    }
    for (k, v) in env {
        command.env(k, expand_tilde(v));
    }
    // Same session isolation as the real run, so the probe cannot be stopped by
    // a signal aimed at the app's own process group.
    // SAFETY: setsid is async-signal-safe and is the only call made in the
    // forked child before exec.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            log::debug!("[scheduler] auth preflight spawn failed: {e}");
            return AuthPreflight::Unknown;
        }
    };
    let pid = child.id();

    let deadline = std::time::Instant::now() + Duration::from_secs(AUTH_PREFLIGHT_TIMEOUT_SECS);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    kill_group(pid, libc::SIGKILL);
                    let _ = child.wait();
                    log::warn!("[scheduler] auth preflight timed out; dispatching anyway");
                    return AuthPreflight::Unknown;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return AuthPreflight::Unknown,
        }
    }

    // The report is a few hundred bytes, far under the pipe buffer, so it is
    // fully buffered by the time the child exits — reading after the wait
    // cannot deadlock, and an oversized write would have hit the deadline above.
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    parse_auth_status(&out)
}

/// The operator-facing explanation recorded on a run we refused to spend.
///
/// Names the two environment causes that actually produce this, in the order
/// they are worth checking, rather than echoing the CLI's bare "run /login" —
/// which is misleading here, because the user generally *is* logged in
/// interactively and the scheduled environment is what differs.
fn no_credential_message(config_dir: Option<&str>) -> String {
    let mut msg = String::from(
        "No usable Claude credential for this schedule — `claude auth status` reports \
         not logged in for the environment this run would get, so it was not started \
         (a run in this state fails in ~2s having done no work). Fix one of: ",
    );
    if let Some(dir) = config_dir {
        msg.push_str(&format!(
            "(1) this schedule's provider sets CLAUDE_CONFIG_DIR={dir}, which makes the CLI \
             read credentials from that directory instead of the keychain login you use \
             interactively — either clear that field on the provider, or log in once against \
             it so it has its own credentials; "
        ));
    }
    msg.push_str(
        "set an API key on the schedule's provider (Settings → Providers), or give the \
         provider a CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.",
    );
    msg
}

/// Which identity variables the env overlay must supply.
///
/// Pure so the case that actually matters — a parent with no `USER`, which is
/// what a Finder-launched app gets — is testable without mutating the test
/// process's own environment.
///
/// An inherited, non-empty value always wins: the fallback exists to recover an
/// identity, never to override one the app was given.
fn identity_overlay(
    inherited_user: Option<&str>,
    inherited_logname: Option<&str>,
    login: Option<&str>,
) -> Vec<(&'static str, String)> {
    let Some(login) = login.filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    [("USER", inherited_user), ("LOGNAME", inherited_logname)]
        .into_iter()
        .filter(|(_, inherited)| !inherited.is_some_and(|v| !v.is_empty()))
        .map(|(key, _)| (key, login.to_string()))
        .collect()
}

/// The login name from the password database, independent of the environment.
///
/// Deliberately *not* `std::env::var("USER")`: the whole point is to recover a
/// usable identity when the process did not inherit one.
fn os_login_name() -> Option<String> {
    // SAFETY: getpwuid returns a pointer into storage owned by libc. We copy
    // the name out immediately and never retain the pointer.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() {
            return None;
        }
        let name = (*pw).pw_name;
        if name.is_null() {
            return None;
        }
        std::ffi::CStr::from_ptr(name)
            .to_str()
            .ok()
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }
}

/// Resolve a command_template binary token to a spawnable executable.
///
/// A bare token that isn't found on PATH is almost certainly a shell alias
/// (e.g. `claude-work`), which a direct (non-shell) spawn cannot run. In that
/// case fall back to the canonical `claude` binary — provider env such as
/// `CLAUDE_CONFIG_DIR` (applied separately) reproduces the alias's behaviour.
fn resolve_binary(token: &str) -> String {
    // A path (absolute or relative) is used verbatim.
    if token.contains('/') {
        return token.to_string();
    }
    // Search PATH for an executable file named `token`.
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            if dir.is_empty() {
                continue;
            }
            let candidate = Path::new(dir).join(token);
            if candidate.is_file() {
                return token.to_string();
            }
        }
    }
    "claude".to_string()
}

fn expand_tilde(s: &str) -> String {
    if s == "~" {
        return std::env::var("HOME").unwrap_or_else(|_| s.to_string());
    }
    if let Some(rest) = s.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `shutdown_running_jobs` must terminate a registered run's process group
    /// (the close-the-app-stops-jobs guarantee) and clear the registry.
    #[test]
    fn shutdown_running_jobs_kills_registered_process_group() {
        // Spawn a long-lived child in its own session, exactly like dispatch_run
        // does, so its PID is also a process-group id we can signal as a unit.
        let mut cmd = Command::new("sleep");
        cmd.arg("60");
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = cmd.spawn().expect("spawn sleep");
        let pid = child.id();

        let registry = new_registry();
        registry.lock().unwrap().insert(42, pid);

        shutdown_running_jobs(&registry);

        // Registry is drained so a second close is a no-op.
        assert!(registry.lock().unwrap().is_empty());

        // The child must have been terminated by the group signal. try_wait
        // reaps the zombie and confirms exit (poll briefly for the kernel).
        let mut exited = false;
        for _ in 0..100 {
            match child.try_wait() {
                Ok(Some(_)) => {
                    exited = true;
                    break;
                }
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(_) => break,
            }
        }
        assert!(exited, "shutdown_running_jobs should have killed the child");
    }

    /// Empty-registry shutdown is a harmless no-op.
    #[test]
    fn shutdown_running_jobs_noop_when_empty() {
        let registry = new_registry();
        shutdown_running_jobs(&registry);
        assert!(registry.lock().unwrap().is_empty());
    }

    fn write_tmp(name: &str, body: &str) -> String {
        let path =
            std::env::temp_dir().join(format!("codenest-test-{}-{name}.log", std::process::id()));
        fs::write(&path, body).expect("write tmp transcript");
        path.to_string_lossy().to_string()
    }

    /// A clean single-run transcript yields its tokens, cost (`total_cost_usd`),
    /// and a non-error outcome.
    #[test]
    fn parse_transcript_reads_success_result() {
        let body = concat!(
            r#"{"type":"system","subtype":"init"}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.503,"usage":{"input_tokens":12896,"output_tokens":895},"result":"PASS Weather Report"}"#,
            "\n",
        );
        let path = write_tmp("success", body);
        let parsed = parse_transcript(&path);
        assert_eq!(parsed.tokens_in, Some(12896));
        assert_eq!(parsed.tokens_out, Some(895));
        assert_eq!(parsed.cost_usd, Some(0.503));
        assert!(!parsed.is_error);
        assert_eq!(parsed.summary.as_deref(), Some("PASS Weather Report"));
        let _ = fs::remove_file(&path);
    }

    /// A 401 that exits 0 with a synthetic message is flagged via `is_error` so
    /// the dispatcher can record it as failed rather than "succeeded".
    #[test]
    fn parse_transcript_flags_is_error() {
        let body = concat!(
            r#"{"type":"system","subtype":"init"}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":true,"total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"result":"Failed to authenticate. API Error: 401"}"#,
            "\n",
        );
        let path = write_tmp("autherr", body);
        let parsed = parse_transcript(&path);
        assert!(parsed.is_error);
        let _ = fs::remove_file(&path);
    }

    /// Regression: when a stale run's transcript precedes the real one (the
    /// append-mode + reused-run_id bug), the parser must report the LAST run.
    #[test]
    fn parse_transcript_takes_last_run_when_stale_content_precedes() {
        let body = concat!(
            // Stale prior-era run: a 401 (is_error, 0 tokens).
            r#"{"type":"result","subtype":"success","is_error":true,"total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"result":"Failed to authenticate. API Error: 401"}"#,
            "\n",
            // Real run appended below it: a healthy success.
            r#"{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.503,"usage":{"input_tokens":12896,"output_tokens":895},"result":"PASS Weather Report"}"#,
            "\n",
        );
        let path = write_tmp("stale", body);
        let parsed = parse_transcript(&path);
        assert!(!parsed.is_error, "should report the last (successful) run");
        assert_eq!(parsed.tokens_in, Some(12896));
        assert_eq!(parsed.tokens_out, Some(895));
        assert_eq!(parsed.summary.as_deref(), Some("PASS Weather Report"));
        let _ = fs::remove_file(&path);
    }

    /// Helper: produce a minimal PendingRun for command-builder tests.
    fn make_run(
        result_kind: Option<&str>,
        artifact_target_path: Option<&str>,
        prompt: &str,
        provider_id: Option<i64>,
    ) -> PendingRun {
        PendingRun {
            run_id: 1,
            schedule_id: 1,
            session_id: "sess-test".to_string(),
            trigger: "manual".to_string(),
            agent_name: None,
            prompt: Some(prompt.to_string()),
            project_id: None,
            provider_id,
            model: None,
            run_mode: None,
            permission_mode: None,
            allowed_tools: None,
            max_budget_usd: None,
            max_runtime_sec: None,
            notify_policy: None,
            schedule_name: None,
            result_kind: result_kind.map(str::to_string),
            artifact_target_path: artifact_target_path.map(str::to_string),
        }
    }

    /// For an artifact run with a target path the prompt must include the
    /// DELIVERABLE suffix pointing at the exact target path.
    #[test]
    fn build_claude_command_appends_deliverable_suffix_for_artifact() {
        let target = "/tmp/codenest-test-artifact-output.md";
        let run = make_run(Some("artifact"), Some(target), "Write a report.", Some(1));
        let (args, _) = build_claude_command(&run, None, "sess-test")
            .expect("build_claude_command should succeed");
        let prompt_arg = args.last().expect("prompt must be last arg");
        assert!(
            prompt_arg.contains("DELIVERABLE:"),
            "expected DELIVERABLE suffix in prompt, got: {prompt_arg}"
        );
        assert!(
            prompt_arg.contains(target),
            "expected target path in prompt, got: {prompt_arg}"
        );
    }

    /// For a transcript run the prompt must NOT include any DELIVERABLE suffix.
    #[test]
    fn build_claude_command_no_suffix_for_transcript() {
        let run = make_run(
            Some("transcript"),
            Some("/tmp/ignored.md"),
            "Summarize the codebase.",
            Some(1),
        );
        let (args, _) = build_claude_command(&run, None, "sess-test")
            .expect("build_claude_command should succeed");
        let prompt_arg = args.last().expect("prompt must be last arg");
        assert!(
            !prompt_arg.contains("DELIVERABLE:"),
            "transcript prompt must not have DELIVERABLE suffix, got: {prompt_arg}"
        );
    }

    // -- #45: credential resolution for scheduled runs ----------------------

    /// The CLI's own report drives the decision: `loggedIn` true/false map to
    /// Ok/NotLoggedIn, and anything else must degrade to Unknown (dispatch
    /// anyway) so an output change can never silently stop every schedule.
    #[test]
    fn parse_auth_status_maps_logged_in_flag() {
        assert_eq!(
            parse_auth_status(r#"{"loggedIn":true,"authMethod":"claude.ai"}"#),
            AuthPreflight::Ok
        );
        assert_eq!(
            parse_auth_status(r#"{"loggedIn":true,"authMethod":"api_key"}"#),
            AuthPreflight::Ok
        );
        assert_eq!(
            parse_auth_status(r#"{"loggedIn":false,"authMethod":"none"}"#),
            AuthPreflight::NotLoggedIn
        );
        // Pretty-printed output (what the CLI actually emits) parses the same.
        assert_eq!(
            parse_auth_status("{\n  \"loggedIn\": false,\n  \"authMethod\": \"none\"\n}\n"),
            AuthPreflight::NotLoggedIn
        );
        // Degrade-to-dispatch cases.
        assert_eq!(parse_auth_status(""), AuthPreflight::Unknown);
        assert_eq!(parse_auth_status("not json at all"), AuthPreflight::Unknown);
        assert_eq!(
            parse_auth_status(r#"{"authMethod":"none"}"#),
            AuthPreflight::Unknown
        );
        assert_eq!(
            parse_auth_status(r#"{"loggedIn":"yes"}"#),
            AuthPreflight::Unknown
        );
    }

    /// A probe whose binary does not exist must not block dispatch.
    #[test]
    fn preflight_auth_is_unknown_when_binary_is_missing() {
        let env = HashMap::new();
        assert_eq!(
            preflight_auth(
                "/nonexistent/codenest-test-no-such-claude-binary",
                &env,
                None
            ),
            AuthPreflight::Unknown
        );
    }

    /// A probe that exits non-zero with no JSON is Unknown, not NotLoggedIn —
    /// only an explicit `loggedIn:false` may cancel a run.
    #[test]
    fn preflight_auth_is_unknown_for_non_json_output() {
        let env = HashMap::new();
        // `false` ignores its args and exits 1 writing nothing.
        assert_eq!(preflight_auth("false", &env, None), AuthPreflight::Unknown);
    }

    /// The refusal message must name CLAUDE_CONFIG_DIR when the run's overlay
    /// sets one — that is the cause operators actually hit, and the CLI's own
    /// "run /login" text points the wrong way because they *are* logged in.
    #[test]
    fn no_credential_message_names_the_config_dir_cause() {
        let with_dir = no_credential_message(Some("/home/u/.claude"));
        assert!(with_dir.contains("CLAUDE_CONFIG_DIR=/home/u/.claude"));
        assert!(with_dir.contains("provider"));

        let without_dir = no_credential_message(None);
        assert!(
            !without_dir.contains("CLAUDE_CONFIG_DIR"),
            "must not invent a config-dir cause that does not apply: {without_dir}"
        );
        // Both forms must still offer the credential remedies.
        for msg in [&with_dir, &without_dir] {
            assert!(msg.contains("API key"), "missing API-key remedy: {msg}");
            assert!(
                msg.contains("CLAUDE_CODE_OAUTH_TOKEN"),
                "missing token remedy: {msg}"
            );
        }
    }

    /// The identity fallback: a scheduled run must carry a `USER` so the CLI
    /// can find the keychain login by account name. The password-database name
    /// is the source, never the (possibly absent) parent environment.
    #[test]
    fn os_login_name_returns_a_usable_login() {
        let name = os_login_name().expect("password database must yield a login name");
        assert!(!name.is_empty());
        // When the parent *does* have USER, the two must agree — otherwise the
        // fallback would authenticate as a different account than the app.
        if let Ok(env_user) = std::env::var("USER") {
            if !env_user.is_empty() {
                assert_eq!(name, env_user);
            }
        }
    }

    /// The case the fix exists for: a parent with no `USER` (a Finder-launched
    /// app) must still hand the child an identity, taken from the password
    /// database. Without this the keychain login lookup misses entirely.
    #[test]
    fn identity_overlay_supplies_a_login_when_the_parent_has_none() {
        assert_eq!(
            identity_overlay(None, None, Some("pat")),
            vec![("USER", "pat".to_string()), ("LOGNAME", "pat".to_string())]
        );
        // An empty inherited value is as useless as a missing one.
        assert_eq!(
            identity_overlay(Some(""), Some(""), Some("pat")),
            vec![("USER", "pat".to_string()), ("LOGNAME", "pat".to_string())]
        );
    }

    /// An identity the app was actually given always wins — the fallback
    /// recovers one, it never overrides one.
    #[test]
    fn identity_overlay_never_overrides_an_inherited_login() {
        assert!(identity_overlay(Some("pat"), Some("pat"), Some("other")).is_empty());
        // Each variable is decided on its own.
        assert_eq!(
            identity_overlay(Some("pat"), None, Some("pat")),
            vec![("LOGNAME", "pat".to_string())]
        );
        assert_eq!(
            identity_overlay(None, Some("pat"), Some("pat")),
            vec![("USER", "pat".to_string())]
        );
    }

    /// With no login resolvable there is nothing to seed — and nothing empty
    /// must be seeded, which would mask the real lookup.
    #[test]
    fn identity_overlay_is_empty_without_a_resolvable_login() {
        assert!(identity_overlay(None, None, None).is_empty());
        assert!(identity_overlay(None, None, Some("")).is_empty());
    }

    /// `build_claude_command` must leave an inherited `USER` alone (the dev
    /// case) and must not fabricate one that disagrees with the OS.
    #[test]
    fn build_claude_command_env_carries_a_login_identity() {
        let run = make_run(None, None, "Do the thing.", Some(1));
        let (_, env) = build_claude_command(&run, None, "sess-test")
            .expect("build_claude_command should succeed");

        let inherited = std::env::var("USER").ok().filter(|v| !v.is_empty());
        match inherited {
            // Parent supplied one: no overlay entry needed, the child inherits it.
            Some(_) => assert!(
                !env.contains_key("USER"),
                "must not shadow an inherited USER"
            ),
            // Parent had none (packaged/launchd case): the overlay must supply it.
            None => assert_eq!(
                env.get("USER").map(String::as_str),
                os_login_name().as_deref()
            ),
        }
    }

    /// The scheduled-run markers must survive alongside the identity fallback.
    #[test]
    fn build_claude_command_keeps_scheduled_markers() {
        let run = make_run(None, None, "Do the thing.", Some(1));
        let (_, env) = build_claude_command(&run, None, "sess-test")
            .expect("build_claude_command should succeed");
        assert_eq!(
            env.get("CODENEST_SESSION_MODE").map(String::as_str),
            Some("scheduled")
        );
        assert_eq!(
            env.get("CODENEST_SCHEDULE_RUN_ID").map(String::as_str),
            Some("1")
        );
    }

    /// For an artifact run with NO target path the prompt is unchanged.
    #[test]
    fn build_claude_command_no_suffix_for_artifact_without_target() {
        let run = make_run(Some("artifact"), None, "Write a report.", Some(1));
        let (args, _) = build_claude_command(&run, None, "sess-test")
            .expect("build_claude_command should succeed");
        let prompt_arg = args.last().expect("prompt must be last arg");
        assert!(
            !prompt_arg.contains("DELIVERABLE:"),
            "artifact without target must not have DELIVERABLE suffix, got: {prompt_arg}"
        );
    }
}
