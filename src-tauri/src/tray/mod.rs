//! System-tray integration (Phase 3.4).
//!
//! ## What it does
//!
//! - Creates a tray icon on app startup.
//! - When the tray menu is clicked/opened, fetches the schedule list + most-
//!   recent run status from the sidecar and builds a dynamic menu.
//! - Each schedule gets a "Run now" item that calls POST /schedules/{id}/fire.
//! - If any schedule's last run failed the tray icon gets a red badge (on macOS
//!   this is implemented as a template-image swap).
//! - A `schedule_run_finished` event from the scheduler triggers a menu rebuild
//!   so the tray reflects the latest status without waiting for the next open.
//!
//! ## Architecture note
//!
//! The tray must be built on the Tauri setup thread (not a background thread)
//! because `TrayIconBuilder` needs a reference to the `AppHandle` that is only
//! available inside `setup()`.  Subsequent menu updates are done from background
//! threads via `AppHandle::tray_handle`.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

const SIDECAR_BASE: &str = "http://127.0.0.1:8002";
/// How long we allow the sidecar HTTP calls that rebuild the menu to take.
const HTTP_TIMEOUT_SECS: u64 = 5;
/// Tray icon identifier — used to locate it later via `app.tray_by_id`.
pub const TRAY_ID: &str = "schedules-tray";

// ---------------------------------------------------------------------------
// Sidecar types needed for the tray
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct TraySchedule {
    id: i64,
    name: String,
    enabled: bool,
}

#[derive(Debug, Deserialize)]
struct TrayScheduleRun {
    status: String,
}

#[derive(Debug, Deserialize)]
struct TrayRunsResp {
    runs: Vec<TrayScheduleRun>,
}

// ---------------------------------------------------------------------------
// Shared tray state (last-known "any failure" flag for icon badge)
// ---------------------------------------------------------------------------

/// Shared mutable flag: `true` when at least one schedule's last run failed.
/// Protected by a Mutex so background threads can update it safely.
pub type TrayFailureFlag = Arc<Mutex<bool>>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Build the tray icon and register event handlers.
///
/// Called once from `lib.rs::setup`.  Returns the shared failure flag so the
/// scheduler thread can toggle it via `update_tray_after_run`.
pub fn init(app: &AppHandle) -> Result<TrayFailureFlag, String> {
    let failure_flag: TrayFailureFlag = Arc::new(Mutex::new(false));

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "no default icon for tray".to_string())?;

    // Build the initial (static) menu shown before the first real fetch.
    let menu = build_static_menu(app, false)?;

    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .tooltip("Codenest — Schedules")
        .on_menu_event({
            let app = app.clone();
            move |_tray, event| {
                handle_menu_event(&app, event.id().as_ref());
            }
        })
        .on_tray_icon_event({
            let app = app.clone();
            move |_tray, event| {
                // On left-click: show / focus the main window.
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.unminimize();
                        let _ = win.set_focus();
                    }
                }
                // On right-click (opens menu): refresh the menu contents.
                if let TrayIconEvent::Click {
                    button: MouseButton::Right,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    refresh_tray_menu(&app);
                }
            }
        })
        .build(app)
        .map_err(|e| format!("tray build: {e}"))?;

    Ok(failure_flag)
}

/// Called by the scheduler's finish thread each time a run completes.
/// Updates the tray icon badge and rebuilds the menu.
pub fn update_tray_after_run(app: &AppHandle, failure_flag: &TrayFailureFlag, status: &str) {
    let is_failure = !matches!(status, "succeeded");
    // We only flip it to "has failure"; clearing requires a full menu rebuild.
    if is_failure {
        if let Ok(mut f) = failure_flag.lock() {
            *f = true;
        }
    }
    refresh_tray_menu(app);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Rebuild the tray menu from live sidecar data in a background thread.
fn refresh_tray_menu(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let client = match reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[tray] failed to build http client: {e}");
                return;
            }
        };

        // Fetch schedule list.
        let schedules: Vec<TraySchedule> = match client
            .get(format!("{SIDECAR_BASE}/api/v1/schedules"))
            .send()
            .and_then(|r| r.json::<serde_json::Value>())
        {
            Ok(v) => {
                if let Some(arr) = v.get("schedules").and_then(|x| x.as_array()) {
                    arr.iter()
                        .filter_map(|s| serde_json::from_value(s.clone()).ok())
                        .collect()
                } else {
                    vec![]
                }
            }
            Err(e) => {
                log::debug!("[tray] schedule fetch failed: {e}");
                vec![]
            }
        };

        // For each schedule: fetch its last run status.
        let mut any_failure = false;
        let mut items: Vec<(TraySchedule, Option<String>)> = Vec::new();
        for sched in schedules {
            let last_status: Option<String> = client
                .get(format!(
                    "{SIDECAR_BASE}/api/v1/schedules/{}/runs?limit=1",
                    sched.id
                ))
                .send()
                .ok()
                .and_then(|r| r.json::<TrayRunsResp>().ok())
                .and_then(|r| r.runs.into_iter().next())
                .map(|run| run.status);

            if let Some(ref s) = last_status {
                if matches!(s.as_str(), "failed" | "timed_out" | "missed") {
                    any_failure = true;
                }
            }
            items.push((sched, last_status));
        }

        // Rebuild the menu.
        match build_dynamic_menu(&app, &items, any_failure) {
            Ok(menu) => {
                if let Some(tray) = app.tray_by_id(TRAY_ID) {
                    if let Err(e) = tray.set_menu(Some(menu)) {
                        log::warn!("[tray] set_menu failed: {e}");
                    }
                    // Red icon when any schedule has a recent failure.
                    // We use tooltip text instead of a custom icon (avoids
                    // needing to ship a separate red-dot asset in dev).
                    let tooltip = if any_failure {
                        "Codenest — Schedules (failure)"
                    } else {
                        "Codenest — Schedules"
                    };
                    let _ = tray.set_tooltip(Some(tooltip));
                }
            }
            Err(e) => log::warn!("[tray] build_dynamic_menu failed: {e}"),
        }
    });
}

/// Build the static placeholder menu shown before the first live fetch.
fn build_static_menu(app: &AppHandle, any_failure: bool) -> Result<Menu<tauri::Wry>, String> {
    let header = MenuItem::with_id(
        app,
        "header",
        if any_failure {
            "Codenest — Schedules ⚠"
        } else {
            "Codenest — Schedules"
        },
        false,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;

    let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;

    let open = MenuItem::with_id(app, "open_dashboard", "Open Dashboard", true, None::<&str>)
        .map_err(|e| e.to_string())?;

    Menu::with_items(app, &[&header, &sep, &open]).map_err(|e| e.to_string())
}

/// Build a menu populated with live schedule data.
fn build_dynamic_menu(
    app: &AppHandle,
    items: &[(TraySchedule, Option<String>)],
    any_failure: bool,
) -> Result<Menu<tauri::Wry>, String> {
    let header_text = if any_failure {
        "Codenest — Schedules ⚠".to_string()
    } else {
        "Codenest — Schedules".to_string()
    };
    let header = MenuItem::with_id(app, "header", &header_text, false, None::<&str>)
        .map_err(|e| e.to_string())?;

    let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let open = MenuItem::with_id(app, "open_dashboard", "Open Dashboard", true, None::<&str>)
        .map_err(|e| e.to_string())?;

    if items.is_empty() {
        let none = MenuItem::with_id(app, "no_schedules", "No schedules", false, None::<&str>)
            .map_err(|e| e.to_string())?;
        let sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
        return Menu::with_items(app, &[&header, &sep, &none, &sep2, &open])
            .map_err(|e| e.to_string());
    }

    let sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;

    let mut menu_refs: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();
    menu_refs.push(Box::new(header));
    menu_refs.push(Box::new(sep));

    for (sched, last_status) in items {
        let glyph = match last_status.as_deref() {
            Some("succeeded") => "✓",
            Some("failed") | Some("timed_out") | Some("missed") => "✗",
            Some("running") => "◐",
            Some("queued") => "◷",
            _ => "○",
        };
        let enabled_marker = if sched.enabled { "" } else { " (off)" };
        let label = format!("{glyph} {}{enabled_marker}", sched.name);

        let item_id = format!("run_now_{}", sched.id);
        let run_label = format!("▶ Run now: {}", sched.name);

        let schedule_label = MenuItem::with_id(app, &item_id, &label, false, None::<&str>)
            .map_err(|e| e.to_string())?;
        let run_btn = MenuItem::with_id(app, &item_id, &run_label, sched.enabled, None::<&str>)
            .map_err(|e| e.to_string())?;

        menu_refs.push(Box::new(schedule_label));
        menu_refs.push(Box::new(run_btn));
    }

    menu_refs.push(Box::new(sep2));
    menu_refs.push(Box::new(open));

    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        menu_refs.iter().map(|b| b.as_ref()).collect();

    Menu::with_items(app, &refs).map_err(|e| e.to_string())
}

/// Handle tray menu item clicks.
fn handle_menu_event(app: &AppHandle, id: &str) {
    if id == "open_dashboard" {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
        return;
    }
    if let Some(rest) = id.strip_prefix("run_now_") {
        if let Ok(schedule_id) = rest.parse::<i64>() {
            fire_schedule(schedule_id);
        }
    }
}

/// POST /schedules/{id}/fire — fire immediately.
fn fire_schedule(schedule_id: i64) {
    std::thread::spawn(move || {
        let client = match reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[tray] fire_schedule: client build failed: {e}");
                return;
            }
        };
        let url = format!("{SIDECAR_BASE}/api/v1/schedules/{schedule_id}/fire");
        match client.post(&url).send() {
            Ok(resp) if resp.status().is_success() => {
                log::info!("[tray] fired schedule {schedule_id}");
            }
            Ok(resp) => {
                log::warn!("[tray] fire schedule {schedule_id}: HTTP {}", resp.status());
            }
            Err(e) => {
                log::warn!("[tray] fire schedule {schedule_id}: {e}");
            }
        }
    });
}
