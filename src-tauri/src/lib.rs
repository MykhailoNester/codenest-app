mod agent;
mod commands;
mod fswatch;
mod pty;
mod scheduler;
mod session;
mod sidecar;
mod tray;
mod window;
mod workspace;

use commands::browser::{
    preview_close, preview_navigate, preview_open, preview_set_bounds, preview_show,
};
use commands::docs::{open_in_editor, open_path, read_file_text, reveal_in_finder};
use commands::fs_nav::{fs_build_file_index, fs_list_dir};
use commands::git::{get_git_pane_status, get_recent_commits, git_status_for_roots};
use commands::hooks::run_hook_probe;
use commands::screenshot::{
    capture_screenshot, close_screenshot_ring, open_screenshot_ring, ring_capture,
};
use fswatch::{fs_watch_set_roots, fs_watch_status};
use window::clamp_window_to_monitor;

use std::sync::Arc;
use tauri::Manager;

// ---------------------------------------------------------------------------
// Sidecar commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_sidecar_status(state: tauri::State<'_, sidecar::SidecarManager>) -> sidecar::SidecarStatus {
    state.status()
}

// ---------------------------------------------------------------------------
// PTY commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn open_terminal(
    args: pty::OpenTerminalArgs,
    state: tauri::State<'_, Arc<pty::PtyManager>>,
    app: tauri::AppHandle,
) -> Result<pty::TerminalHandle, String> {
    state.open_terminal(args, app)
}

#[tauri::command]
fn terminal_input(
    args: pty::TerminalInputArgs,
    state: tauri::State<'_, Arc<pty::PtyManager>>,
) -> Result<(), String> {
    state.terminal_input(args)
}

#[tauri::command]
fn terminal_resize(
    args: pty::ResizeTerminalArgs,
    state: tauri::State<'_, Arc<pty::PtyManager>>,
) -> Result<(), String> {
    state.terminal_resize(args)
}

#[tauri::command]
fn close_terminal(
    args: pty::CloseTerminalArgs,
    state: tauri::State<'_, Arc<pty::PtyManager>>,
) -> Result<(), String> {
    state.close_terminal(args)
}

#[tauri::command]
fn get_active_terminal_count(state: tauri::State<'_, Arc<pty::PtyManager>>) -> usize {
    state.active_count()
}

// ---------------------------------------------------------------------------
// Window commands
// ---------------------------------------------------------------------------

/// Open the secondary "terminals" window, or focus it if it already exists.
///
/// First call: builds a new `WebviewWindow` pointed at
/// `index.html#/window/terminals`. The frontend uses the hash to render
/// `<TerminalsPage />` directly, without the main app shell.
///
/// Subsequent calls: brings the existing window to the front via
/// `set_focus()`. `WebviewWindowBuilder::new` would panic on a duplicate
/// label, so the guard must run first.
#[tauri::command]
async fn open_terminals_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("terminals") {
        let _ = window.show();
        let _ = window.unminimize();
        // Clamp in case window-state restored it to a disconnected monitor.
        if let Err(e) = clamp_window_to_monitor(&app, &window) {
            log::warn!("clamp_window_to_monitor (reuse path): {e}");
        }
        return window.set_focus().map_err(|e| e.to_string());
    }

    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "terminals",
        tauri::WebviewUrl::App("index.html#/window/terminals".into()),
    )
    .title("Codenest Terminals")
    .inner_size(1200.0, 800.0)
    .min_inner_size(600.0, 400.0)
    .resizable(true)
    .build()
    .map_err(|e| e.to_string())?;

    // Clamp in case window-state plugin restored an off-screen position.
    if let Err(e) = clamp_window_to_monitor(&app, &window) {
        log::warn!("clamp_window_to_monitor (new window): {e}");
    }

    Ok(())
}

/// Close the detached terminals window (if it exists and has no remaining panes).
///
/// Called by the frontend Stop action after it removes the last pane from the
/// popout window.  If the window does not exist, or if the caller decides not
/// to close it (e.g. there are other panes), no-op is the correct behaviour.
///
/// The `force` flag allows the caller to close unconditionally (e.g. when it
/// has already verified no panes remain).  When `force = false` this is a
/// pure no-op so callers can safely pass false as a sentinel.
#[tauri::command]
async fn close_terminals_window(app: tauri::AppHandle, force: bool) -> Result<(), String> {
    if !force {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window("terminals") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Emit a `focus-pane` event to the terminals window so it can activate a
/// specific tab.  The payload is forwarded verbatim; the frontend's
/// `TerminalWindowRoot` listens for this event and calls
/// `setActiveTab` / `setFocusedLeaf` accordingly.
#[tauri::command]
async fn emit_focus_pane_to_terminals(
    app: tauri::AppHandle,
    pane_id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    if let Some(window) = app.get_webview_window("terminals") {
        window
            .emit("focus-pane", pane_id)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Emit a `stop-agent-pane` event to the terminals window.
///
/// The terminals window's `TerminalWindowRoot` listens for this event,
/// closes the named pane from its layout (via `closePane`), and then
/// closes the window itself when no panes remain.  This is the cross-window
/// Stop-cleanup path for agents launched into the detached popout window.
///
/// The PTY is killed separately via `close_terminal` before this is called.
#[tauri::command]
async fn emit_stop_agent_pane_to_terminals(
    app: tauri::AppHandle,
    pane_id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    if let Some(window) = app.get_webview_window("terminals") {
        window
            .emit("stop-agent-pane", pane_id)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Path existence check
// ---------------------------------------------------------------------------

/// One entry in the `paths_exist` response.
///
/// `exists` is `true` when the path is reachable on disk.
/// `is_dir` is `true` when the path exists AND is a directory.
/// A valid launch cwd must satisfy both: `exists && is_dir`.
#[derive(Debug, serde::Serialize)]
pub struct PathCheck {
    pub path: String,
    pub exists: bool,
    pub is_dir: bool,
}

/// Check whether each path in `paths` exists on disk and is a directory.
///
/// Returns one `PathCheck` per input path, in the same order.  The command
/// never errors — every path that cannot be stat'd is reported as
/// `{ exists: false, is_dir: false }`.  This keeps the frontend call-site
/// simple: any entry with `!exists || !is_dir` is invalid.
#[tauri::command]
fn paths_exist(paths: Vec<String>) -> Vec<PathCheck> {
    paths
        .into_iter()
        .map(|p| {
            let path = std::path::Path::new(&p);
            let exists = path.exists();
            let is_dir = exists && path.is_dir();
            PathCheck {
                path: p,
                exists,
                is_dir,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Schedule live-attach helpers
// ---------------------------------------------------------------------------

/// Returned by `get_schedule_run_pty_id` so the frontend can subscribe to the
/// correct `terminal_output:{pty_id}` event stream.
#[derive(Debug, serde::Serialize)]
pub struct ScheduleRunPtyInfo {
    pub pty_id: Option<String>,
}

/// Shared map: run_id → pty_id for active (running) scheduled runs.
/// Populated by the scheduler when it starts a run, cleared on finish.
type ActiveRunPtyMap = Arc<std::sync::Mutex<std::collections::HashMap<i64, String>>>;

/// Ask the scheduler which pty_id is streaming output for the given run_id.
///
/// Returns `{ pty_id: null }` when the run is not currently running (already
/// finished or not yet started).  The frontend uses this to decide whether to
/// render a live xterm or fall back to the static transcript.
#[tauri::command]
fn get_schedule_run_pty_id(
    run_id: i64,
    state: tauri::State<'_, ActiveRunPtyMap>,
) -> ScheduleRunPtyInfo {
    let map = state.lock().unwrap();
    ScheduleRunPtyInfo {
        pty_id: map.get(&run_id).cloned(),
    }
}

// ---------------------------------------------------------------------------
// Notification commands
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
pub struct EmitNotificationArgs {
    pub title: String,
    pub body: Option<String>,
    pub priority: String,
}

#[tauri::command]
async fn emit_native_notification(
    app: tauri::AppHandle,
    args: EmitNotificationArgs,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let mut n = app.notification().builder().title(&args.title);
    if let Some(body) = &args.body {
        n = n.body(body);
    }
    n.show().map_err(|e| e.to_string())
}

/// Request macOS notification permission and return the resulting state.
///
/// On desktop (macOS/Linux/Windows) `request_permission()` always returns
/// `Granted` immediately — the actual OS permission dialog is shown by the
/// system on the first `show()` call from a signed app bundle.  Calling this
/// command on first launch therefore ensures the OS has a chance to register
/// the app as a notification sender before the first real notification fires.
/// The string `"granted"` / `"denied"` / `"default"` is returned so the
/// frontend can store it and avoid re-prompting.
#[tauri::command]
async fn request_notification_permission(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_notification::NotificationExt;
    let state = app
        .notification()
        .request_permission()
        .map_err(|e| e.to_string())?;
    let label = format!("{state:?}").to_lowercase();
    log::info!("[notification] permission state after request: {label}");
    Ok(label)
}

// ---------------------------------------------------------------------------
// App entry
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pty_manager = Arc::new(pty::PtyManager::new());
    // Pre-clone for the scheduler dispatch loop so it doesn't contend with the
    // on_window_event move closure that also needs the Arc.
    let pty_for_scheduler = Arc::clone(&pty_manager);

    // Registry of live duplex agent-pane `claude` sessions, keyed by pane id.
    // One clone for the CloseRequested handler's move closure, exactly as
    // run_registry_for_close / pty_for_scheduler do below.
    let agent_manager = Arc::new(agent::AgentManager::new());
    let agent_for_close = Arc::clone(&agent_manager);

    // Live filesystem watcher for the workspace navigator (fs_watch_set_roots
    // / fs_watch_status). Pre-clone for the CloseRequested handler so the
    // debouncer thread is always stopped before the sidecar shuts down.
    let fs_watch = Arc::new(fswatch::FsWatchManager::new());
    let fs_watch_for_close = Arc::clone(&fs_watch);

    // Registry of in-flight scheduled-run process groups. The scheduler inserts
    // on launch / removes on finish; the main window's CloseRequested handler
    // stops any survivors so closing the app never leaves scheduled `claude`
    // jobs running orphaned. One clone per move-closure that needs it.
    let run_registry = scheduler::new_registry();
    let run_registry_for_close = run_registry.clone();

    // Map of run_id → pty_id for runs that are currently active.
    // The scheduler writes here when a run starts; we expose it via IPC so
    // the frontend can subscribe to the correct event stream for live attach.
    let active_run_pty_map: ActiveRunPtyMap =
        Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(sidecar::SidecarManager::new())
        .manage(pty_manager.clone())
        .manage(agent_manager.clone())
        .manage(active_run_pty_map.clone())
        .manage(fs_watch)
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Build the WorkspaceManager — resolves app-data and resource paths.
            // Path resolution is required for sidecar env-var injection so we
            // propagate the error here (this would only fail on a mis-configured
            // Tauri install, not during normal operation).
            let ws_manager = workspace::WorkspaceManager::new(app.handle())?;

            // Bootstrap the on-disk directory tree (create dirs idempotently).
            // Non-fatal: a failure here means the workspace dirs are missing, but
            // the sidecar can still start and will surface the issue via its own
            // health endpoint.
            if let Err(e) = ws_manager.bootstrap() {
                log::warn!("[workspace] directory bootstrap failed (continuing): {e}");
            }

            let app_data_dir = ws_manager.app_data_dir().to_path_buf();
            let bundle_resources_dir = ws_manager.bundle_resources_dir().to_path_buf();

            app.manage(ws_manager);

            // Start the sidecar with workspace paths injected as env vars so the
            // Python config layer can resolve workspace paths without hardcoding.
            let manager = app.state::<sidecar::SidecarManager>();
            manager.start(app.handle().clone(), &app_data_dir, &bundle_resources_dir);

            // Start the schedule dispatch loop. It polls the sidecar every
            // POLL_INTERVAL_SECS for queued schedule runs and launches them as
            // background PTY sessions. The loop runs regardless of whether any
            // React window is focused — pure Rust background thread.
            {
                let app_for_scheduler = app.handle().clone();
                let data_dir_for_scheduler = app_data_dir.clone();
                scheduler::start(
                    app_for_scheduler,
                    Arc::clone(&pty_for_scheduler),
                    data_dir_for_scheduler,
                    run_registry.clone(),
                );
            }

            // Tray icon (Phase 3.4) — init after sidecar start so the initial
            // menu refresh can reach the API if the sidecar comes up quickly.
            let tray_failure_flag = match tray::init(app.handle()) {
                Ok(flag) => flag,
                Err(e) => {
                    log::warn!("[tray] init failed (continuing without tray): {e}");
                    Arc::new(std::sync::Mutex::new(false))
                }
            };

            // Listen for schedule_run_started to populate the active PTY map,
            // and schedule_run_finished to update the tray icon + clean up.
            {
                use tauri::Listener;
                let active_map = active_run_pty_map.clone();
                app.listen("schedule_run_started", move |event| {
                    if let Ok(payload) = serde_json::from_str::<scheduler::ScheduleRunStartedPayload>(event.payload()) {
                        let mut map = active_map.lock().unwrap();
                        map.insert(payload.run_id, payload.pty_id.clone());
                        log::debug!("[lib] run {} started, pty_id={}", payload.run_id, payload.pty_id);
                    }
                });
            }
            {
                use tauri::Listener;
                let active_map = active_run_pty_map.clone();
                let tray_flag = tray_failure_flag.clone();
                let app_handle = app.handle().clone();
                app.listen("schedule_run_finished", move |event| {
                    if let Ok(payload) = serde_json::from_str::<scheduler::ScheduleRunFinishedPayload>(event.payload()) {
                        let mut map = active_map.lock().unwrap();
                        map.remove(&payload.run_id);
                        drop(map);
                        tray::update_tray_after_run(&app_handle, &tray_flag, &payload.status);
                    }
                });
            }

            // Clamp the main window in case window-state restored it to a
            // disconnected monitor (e.g. after unplugging an external display).
            if let Some(main_win) = app.get_webview_window("main") {
                if let Err(e) = clamp_window_to_monitor(app.handle(), &main_win) {
                    log::warn!("clamp_window_to_monitor (main window): {e}");
                }
            }

            // On macOS the default application menu contains a "Close Window"
            // item bound to Cmd+W under the File menu.  That native shortcut
            // fires a CloseRequested window event which terminates the sidecar
            // and kills every PTY — before the JS keydown capture handler can
            // intercept it and run the in-app tab-close action instead.
            //
            // We replace the whole app menu with a minimal custom menu that
            // keeps the Edit menu (for system-level text shortcuts like Cmd+C/V
            // inside non-terminal inputs) and removes the File menu's
            // Close Window item.  All other standard items (About, Quit,
            // Hide, Services, etc.) are preserved via the OS default submenu.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
                let handle = app.handle();
                // Build: AppName > (About, separator, Hide, HideOthers,
                //                    ShowAll, separator, Quit)
                let app_submenu = Submenu::with_items(
                    handle,
                    "Codenest",
                    true,
                    &[
                        &PredefinedMenuItem::about(handle, None, None)?,
                        &PredefinedMenuItem::separator(handle)?,
                        &PredefinedMenuItem::hide(handle, None)?,
                        &PredefinedMenuItem::hide_others(handle, None)?,
                        &PredefinedMenuItem::show_all(handle, None)?,
                        &PredefinedMenuItem::separator(handle)?,
                        &PredefinedMenuItem::quit(handle, None)?,
                    ],
                )?;
                // Build: Edit > (Undo, Redo, sep, Cut, Copy, Paste,
                //                SelectAll)
                let edit_submenu = Submenu::with_items(
                    handle,
                    "Edit",
                    true,
                    &[
                        &PredefinedMenuItem::undo(handle, None)?,
                        &PredefinedMenuItem::redo(handle, None)?,
                        &PredefinedMenuItem::separator(handle)?,
                        &PredefinedMenuItem::cut(handle, None)?,
                        &PredefinedMenuItem::copy(handle, None)?,
                        &PredefinedMenuItem::paste(handle, None)?,
                        &PredefinedMenuItem::select_all(handle, None)?,
                    ],
                )?;
                // Build: Window > (Minimize, Zoom) — no Close Window.
                // The JS capture-phase handler in use-terminal-shortcuts.ts
                // owns Cmd+W and routes it to the in-app tab/pane close.
                let window_submenu = Submenu::with_items(
                    handle,
                    "Window",
                    true,
                    &[
                        &PredefinedMenuItem::minimize(handle, None)?,
                        &PredefinedMenuItem::maximize(handle, None)?,
                        &PredefinedMenuItem::fullscreen(handle, None)?,
                    ],
                )?;
                let menu =
                    Menu::with_items(handle, &[&app_submenu, &edit_submenu, &window_submenu])?;
                app.set_menu(menu)?;
            }

            Ok(())
        })
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Sidecar shutdown + PTY drain are gated to the main window.
                // The terminals window manages its own close-confirmation in
                // the frontend; closing it must NOT take down the sidecar or
                // the PTY sessions running across both windows.
                if window.label() == "main" {
                    // Close the preview child webview before the window
                    // animates away so it doesn't float above the close
                    // animation.
                    if let Some(preview) = window.app_handle().get_webview("preview") {
                        let _ = preview.close();
                    }
                    // Stop any scheduled-run `claude` jobs still executing BEFORE
                    // the sidecar goes down, so they don't keep running orphaned
                    // (and can still report their terminal status to the live
                    // sidecar). No-op when nothing is in flight.
                    scheduler::shutdown_running_jobs(&run_registry_for_close);
                    // Stop the live filesystem watcher's debouncer thread
                    // before the sidecar goes down; no-op if nothing was
                    // ever watched.
                    fs_watch_for_close.stop();
                    let sidecar = window.state::<sidecar::SidecarManager>();
                    sidecar.shutdown();
                    pty_manager.close_all();
                    // Same guarantee for a live duplex agent-pane session: without
                    // this, a `claude` process kept open by an interactive pane
                    // would survive app quit as an orphan, the exact failure mode
                    // `scheduler::shutdown_running_jobs` exists to prevent for
                    // scheduled runs.
                    agent_for_close.close_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_sidecar_status,
            open_terminal,
            terminal_input,
            terminal_resize,
            close_terminal,
            get_active_terminal_count,
            open_terminals_window,
            close_terminals_window,
            emit_focus_pane_to_terminals,
            emit_stop_agent_pane_to_terminals,
            open_path,
            reveal_in_finder,
            open_in_editor,
            read_file_text,
            emit_native_notification,
            request_notification_permission,
            preview_open,
            preview_set_bounds,
            preview_navigate,
            preview_show,
            preview_close,
            workspace::get_workspace_path,
            workspace::get_org_agents_path,
            workspace::get_app_data_path,
            session::open_command_center_session,
            session::open_project_session,
            agent::agent_start,
            agent::agent_send,
            agent::agent_interrupt,
            agent::agent_stop,
            get_recent_commits,
            git_status_for_roots,
            get_git_pane_status,
            fs_list_dir,
            fs_build_file_index,
            fs_watch_set_roots,
            fs_watch_status,
            paths_exist,
            capture_screenshot,
            open_screenshot_ring,
            close_screenshot_ring,
            ring_capture,
            get_schedule_run_pty_id,
            run_hook_probe,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
