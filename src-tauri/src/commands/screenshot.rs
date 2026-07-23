//! Screenshot capture command and ring overlay window management.
//!
//! # Production flow
//! 1. Global hotkey (`Ctrl+Shift+2`, registered in `AppInner`) fires.
//! 2. `open_screenshot_ring` spawns the ring overlay window centered at the
//!    cursor.
//! 3. The user clicks the "Screenshot" action in the ring.
//! 4. The ring page calls `ring_capture` (Tauri command).
//! 5. `ring_capture` runs `screencapture -i` on a blocking thread-pool thread.
//! 6. On success it emits `screenshot-ready` (with `CaptureResult`) to the
//!    ring window; on failure it emits `screenshot-cancelled` (with error code).
//! 7. The ring page morphs from ring UI → drag thumbnail in-place (same window,
//!    no close/reopen flash).
//! 8. The user drags the thumbnail into a terminal tab.
//! 9. On drop (or Escape), `close_screenshot_ring` destroys the window.
//!
//! # `capture_screenshot` command
//! This is a **pure primitive** — it runs the blocking capture and returns a
//! `CaptureResult`, but does NOT spawn any window.  It is retained for direct
//! invocation from devtools and for use by future automation scripts.  The ring
//! window is the only production drag surface.
//!
//! # File lifecycle
//! PNGs are written to `$TMPDIR/codenest-shots/<uuid>.png`.  The consumer
//! (the drop handler) must delete the file after inserting it.  A
//! best-effort age-sweep runs at the start of each capture call.
//!
//! # Coordinate conventions
//! `NSEvent::mouseLocation()` returns AppKit global coordinates: origin at the
//! bottom-left of the *primary* display, Y up, in **logical points**.
//! Tauri's `LogicalPosition` uses top-left origin, Y down.  Conversion:
//!
//! ```text
//! y_tauri = primary_display_height_points − y_appkit
//! ```
//!
//! Use `CGDisplay::main().bounds().size.height` (logical points) — NOT
//! `pixels_high()` (physical backing pixels, wrong on Retina displays).
//!
//! # Focus / accessory behavior
//! The ring window uses `decorations(false)`, `always_on_top`, and
//! `accept_first_mouse(true)`.  macOS does not reassign key-window focus during
//! a drag, so the target app stays active throughout.  A true `NSPanel`
//! accessory window would require raw `objc2` calls outside Tauri 2's public
//! API; the current approach is correct for the drag-out use case.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Successful capture result returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    /// Absolute path to the saved PNG under `$TMPDIR/codenest-shots/`.
    /// The consumer (the drop handler) must delete this file after
    /// inserting it into the target terminal session.
    pub path: String,
    /// Cursor X in Tauri **logical points**, top-left origin (primary-display
    /// anchored global coordinate space — pass directly to `LogicalPosition`).
    pub cursor_x: f64,
    /// Cursor Y in Tauri **logical points**, top-left origin (primary-display
    /// anchored global coordinate space — pass directly to `LogicalPosition`).
    pub cursor_y: f64,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Capture a user-selected screen region interactively.
///
/// **Pure primitive** — runs `screencapture -i -s -x` on a blocking thread
/// and returns a `CaptureResult`.  Does NOT open any window; the ring window
/// is the production drag surface (see `ring_capture`).
///
/// # Errors
/// | Code | Meaning |
/// |---|---|
/// | `"cancelled"` | User pressed Escape; no file was written. |
/// | `"permission-denied"` | Screen Recording permission not granted. |
/// | any other string | Unexpected system / IO error. |
#[tauri::command]
pub async fn capture_screenshot() -> Result<CaptureResult, String> {
    tauri::async_runtime::spawn_blocking(capture_screenshot_blocking)
        .await
        .map_err(|e| format!("capture task panicked: {e}"))?
}

// ---------------------------------------------------------------------------
// Ring overlay window
// ---------------------------------------------------------------------------

/// Side length of the radial ring overlay (logical points).
///
/// 240 px gives the puck + accent-ring wrapper comfortable breathing room
/// while remaining compact next to the cursor.  The visible disc (`.puck`)
/// is 200 px; the extra 40 px are transparent gutter consumed by the
/// 2 px animated accent-ring wrapper + shadow spread.
const RING_SIZE: f64 = 240.0;

/// Open the screenshot-ring overlay window at the current cursor position.
///
/// The window is centered at the cursor.  If it is already open (rapid
/// double-trigger), the existing window is focused rather than creating a
/// second one.
#[tauri::command]
pub async fn open_screenshot_ring(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("screenshot-ring") {
        let _ = win.set_focus();
        return Ok(());
    }

    let (cx, cy) = cursor_position_top_left();
    // Center the ring on the cursor.
    let x = cx - RING_SIZE / 2.0;
    let y = cy - RING_SIZE / 2.0;
    log::info!(
        "open_screenshot_ring: cursor=({cx:.0},{cy:.0}) ring_pos=({x:.0},{y:.0}) size={RING_SIZE}"
    );

    let win = WebviewWindowBuilder::new(
        &app,
        "screenshot-ring",
        WebviewUrl::App("index.html#/window/screenshot-ring".into()),
    )
    .title("")
    .inner_size(RING_SIZE, RING_SIZE)
    .resizable(false)
    .decorations(false)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    // transparent(true): the window surface is transparent so the CSS puck
    // disc floats without opaque square corners.  Requires
    // `app.macOSPrivateApi: true` in tauri.conf.json (internal tool only).
    .transparent(true)
    // Build hidden: we position and clamp to a real monitor BEFORE showing, so
    // bad cursor math can never leave the window stranded off-screen (which
    // would make it invisible while still stealing focus).
    .visible(false)
    // accept_first_mouse: the first click must reach the WebView, not be
    // swallowed by window-activation on macOS.
    .accept_first_mouse(true)
    .build()
    .map_err(|e| e.to_string())?;

    win.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;

    // Keep the ring fully on-screen WITHOUT resizing it.  (Do NOT use
    // crate::window::clamp_window_to_monitor here — that helper enforces a
    // 600x400 minimum meant for the large terminals window and would balloon
    // this 200px ring to near-fullscreen.)
    if let Ok(monitors) = app.available_monitors() {
        let target = monitors
            .iter()
            .find(|m| {
                let sf = m.scale_factor();
                let mx = m.position().x as f64 / sf;
                let my = m.position().y as f64 / sf;
                let mw = m.size().width as f64 / sf;
                let mh = m.size().height as f64 / sf;
                x >= mx && x < mx + mw && y >= my && y < my + mh
            })
            .cloned()
            .or_else(|| app.primary_monitor().ok().flatten())
            .or_else(|| monitors.first().cloned());

        if let Some(mon) = target {
            let sf = mon.scale_factor();
            let mx = mon.position().x as f64 / sf;
            let my = mon.position().y as f64 / sf;
            let mw = mon.size().width as f64 / sf;
            let mh = mon.size().height as f64 / sf;
            let cxp = x.clamp(mx, (mx + mw - RING_SIZE).max(mx));
            let cyp = y.clamp(my, (my + mh - RING_SIZE).max(my));
            if (cxp - x).abs() > 0.5 || (cyp - y).abs() > 0.5 {
                log::info!("open_screenshot_ring: clamped to ({cxp:.0},{cyp:.0})");
                win.set_position(LogicalPosition::new(cxp, cyp))
                    .map_err(|e| e.to_string())?;
            }
        }
    }

    win.show().map_err(|e| e.to_string())?;
    let _ = win.set_focus();

    Ok(())
}

/// Close the screenshot-ring overlay window.  Idempotent.
#[tauri::command]
pub fn close_screenshot_ring(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("screenshot-ring") {
        win.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Capture a screen region and notify the ring window of the result.
///
/// Called by the ring page when the user clicks the "Screenshot" action.
/// Runs the blocking capture on a thread-pool thread; on completion emits
/// either `screenshot-ready` (with `CaptureResult`) or `screenshot-cancelled`
/// (with an error string) to the `screenshot-ring` window.
///
/// The ring page listens for these events and morphs from ring UI → drag
/// thumbnail without a window close/reopen cycle.
#[tauri::command]
pub async fn ring_capture(app: AppHandle) -> Result<(), String> {
    let result = tauri::async_runtime::spawn_blocking(capture_screenshot_blocking)
        .await
        .map_err(|e| format!("capture task panicked: {e}"))?;

    if let Some(win) = app.get_webview_window("screenshot-ring") {
        match result {
            Ok(ref r) => {
                let _ = win.emit("screenshot-ready", r);
            }
            Err(ref e) => {
                let _ = win.emit("screenshot-cancelled", e);
            }
        }
    }

    // The event is the single source of truth for capture outcomes.  Returning
    // Ok(()) here means cancelled/permission-denied are conveyed only via the
    // emitted event, so the frontend .catch never races with the event listener.
    // We only propagate Err for the spawn_blocking join panic above (line 166)
    // which is a genuine transport failure that prevents any emit.
    Ok(())
}

// ---------------------------------------------------------------------------
// Blocking capture implementation
// ---------------------------------------------------------------------------

/// Synchronous inner implementation, called from a blocking thread-pool
/// thread so the async runtime and main thread stay free.
/// Resolve the `screencapture` binary path.  It is at `/usr/sbin` on macOS;
/// fall back to `/usr/bin` (older layouts) and finally a bare name for PATH
/// resolution.
fn screencapture_bin() -> &'static str {
    if std::path::Path::new("/usr/sbin/screencapture").exists() {
        "/usr/sbin/screencapture"
    } else if std::path::Path::new("/usr/bin/screencapture").exists() {
        "/usr/bin/screencapture"
    } else {
        "screencapture"
    }
}

fn capture_screenshot_blocking() -> Result<CaptureResult, String> {
    // On macOS, ask for the permission so the system prompt appears on first
    // use.  We deliberately do NOT pre-gate on `preflight()`: in `tauri dev`
    // the process that actually performs the capture (`/usr/bin/screencapture`)
    // can inherit the launching terminal's Screen Recording grant even when
    // THIS binary's own `preflight()` reports false.  Pre-gating would wrongly
    // block a capture that in fact succeeds, so we attempt first and only fall
    // back to a permission verdict when no file is produced.
    #[cfg(target_os = "macos")]
    {
        use core_graphics::access::ScreenCaptureAccess;
        ScreenCaptureAccess.request();
    }

    // --- output path ---------------------------------------------------------
    let shots_dir = std::env::temp_dir().join("codenest-shots");
    std::fs::create_dir_all(&shots_dir).map_err(|e| format!("failed to create shots dir: {e}"))?;

    // Best-effort sweep of PNGs older than 10 minutes.
    sweep_old_shots(&shots_dir);

    let path: PathBuf = shots_dir.join(format!("{}.png", Uuid::new_v4()));
    let path_str = path
        .to_str()
        .ok_or_else(|| "temp path contains non-UTF-8 characters".to_string())?
        .to_string();

    // --- capture -------------------------------------------------------------
    // -i  interactive region select
    // -s  mouse-selection mode only (no window snapping)
    // -x  suppress shutter sound
    //
    // `screencapture` lives at /usr/sbin on macOS (not /usr/bin); fall back to
    // /usr/bin and a bare PATH lookup across macOS versions just in case.
    Command::new(screencapture_bin())
        .args(["-i", "-s", "-x", &path_str])
        .status()
        .map_err(|e| format!("failed to spawn screencapture: {e}"))?;

    // A written file means the capture succeeded.
    if path.exists() {
        let (cursor_x, cursor_y) = cursor_position_top_left();
        return Ok(CaptureResult {
            path: path_str,
            cursor_x,
            cursor_y,
        });
    }

    // No file: distinguish a user cancel (Escape) from a permission denial so
    // the ring can show the right message.
    #[cfg(target_os = "macos")]
    {
        use core_graphics::access::ScreenCaptureAccess;
        if !ScreenCaptureAccess.preflight() {
            return Err("permission-denied".to_string());
        }
    }

    Err("cancelled".to_string())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Delete PNG files in `dir` older than 10 minutes.  Errors are silently
/// ignored — this is best-effort GC.
fn sweep_old_shots(dir: &std::path::Path) {
    const MAX_AGE_SECS: u64 = 600;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("png") {
            continue;
        }
        if let Ok(meta) = std::fs::metadata(&p) {
            if let Ok(modified) = meta.modified() {
                if let Ok(age) = now.duration_since(modified) {
                    if age.as_secs() >= MAX_AGE_SECS {
                        let _ = std::fs::remove_file(&p);
                    }
                }
            }
        }
    }
}

/// Return the current cursor position in Tauri logical points (top-left
/// origin, primary-display anchored).
///
/// IMPORTANT: use `bounds().size.height` (logical points), NOT `pixels_high()`
/// (physical backing pixels — wrong on HiDPI/Retina displays).
#[cfg(target_os = "macos")]
fn cursor_position_top_left() -> (f64, f64) {
    use core_graphics::display::CGDisplay;
    use objc2_app_kit::NSEvent;

    let loc = NSEvent::mouseLocation();
    // Primary display's logical height anchors the global Y-flip.
    let primary_height = CGDisplay::main().bounds().size.height;
    (loc.x, primary_height - loc.y)
}

/// Stub for non-macOS targets.
#[cfg(not(target_os = "macos"))]
fn cursor_position_top_left() -> (f64, f64) {
    (0.0, 0.0)
}
