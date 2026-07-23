/// Window placement helpers.
///
/// These functions are pure geometry where possible so they can be unit-tested
/// without a Tauri runtime.
use tauri::{AppHandle, LogicalPosition, LogicalSize, WebviewWindow};

// ---------------------------------------------------------------------------
// Pure geometry helpers (unit-testable without a Tauri runtime)
// ---------------------------------------------------------------------------

/// A monitor rectangle in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LogicalRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl LogicalRect {
    pub fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }

    /// Returns `true` if the given point lies inside this rectangle
    /// (inclusive of the top-left corner, exclusive of bottom-right).
    pub fn contains_point(&self, px: f64, py: f64) -> bool {
        px >= self.x && px < self.x + self.w && py >= self.y && py < self.y + self.h
    }
}

/// Return `true` if the window centroid lies inside at least one of the
/// supplied monitor work-area rectangles.
pub fn centroid_on_any_monitor(
    win_x: f64,
    win_y: f64,
    win_w: f64,
    win_h: f64,
    monitors: &[LogicalRect],
) -> bool {
    let cx = win_x + win_w / 2.0;
    let cy = win_y + win_h / 2.0;
    monitors.iter().any(|m| m.contains_point(cx, cy))
}

/// Clamp a window size to at most `factor` of the work-area, but never below
/// the supplied `min_*` values.
pub fn clamped_size(
    preferred_w: f64,
    preferred_h: f64,
    work_w: f64,
    work_h: f64,
    factor: f64,
    min_w: f64,
    min_h: f64,
) -> (f64, f64) {
    let max_w = (work_w * factor).max(min_w);
    let max_h = (work_h * factor).max(min_h);
    (
        preferred_w.min(max_w).max(min_w),
        preferred_h.min(max_h).max(min_h),
    )
}

// ---------------------------------------------------------------------------
// Tauri-coupled helper
// ---------------------------------------------------------------------------

/// Validate the window's on-screen position and clamp it back onto the primary
/// monitor if its centroid is not inside any available monitor's work-area.
///
/// Additionally re-asserts a minimum inner size of 600 × 400 logical pixels
/// because `tauri-plugin-window-state` can restore a size smaller than the
/// original `min_inner_size` constraint.
///
/// # Errors
/// Returns the Tauri error string if any window query or mutation fails.  The
/// caller should treat this as non-fatal and log the error rather than
/// propagating it to the user.
pub fn clamp_window_to_monitor(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    // --- collect monitor work-areas as logical rects ---------------------------
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;

    // Primary monitor fallback: use the first available monitor.
    let primary = app
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.first().cloned());

    // We need at least one monitor to do anything useful.
    let Some(primary_mon) = primary else {
        return Ok(());
    };

    let scale = primary_mon.scale_factor();

    // Build logical rects from each monitor's work-area.
    let logical_rects: Vec<LogicalRect> = monitors
        .iter()
        .map(|m| {
            let sf = m.scale_factor();
            let wa = m.work_area();
            LogicalRect::new(
                wa.position.x as f64 / sf,
                wa.position.y as f64 / sf,
                wa.size.width as f64 / sf,
                wa.size.height as f64 / sf,
            )
        })
        .collect();

    // --- current window geometry (physical → logical) -------------------------
    let outer_pos = window.outer_position().map_err(|e| e.to_string())?;
    let outer_size = window.outer_size().map_err(|e| e.to_string())?;

    let win_x = outer_pos.x as f64 / scale;
    let win_y = outer_pos.y as f64 / scale;
    let win_w = outer_size.width as f64 / scale;
    let win_h = outer_size.height as f64 / scale;

    // --- re-centre if off-screen ----------------------------------------------
    if !centroid_on_any_monitor(win_x, win_y, win_w, win_h, &logical_rects) {
        let wa = primary_mon.work_area();
        let work_w = wa.size.width as f64 / scale;
        let work_h = wa.size.height as f64 / scale;
        let work_x = wa.position.x as f64 / scale;
        let work_y = wa.position.y as f64 / scale;

        let (new_w, new_h) = clamped_size(win_w, win_h, work_w, work_h, 0.9, 600.0, 400.0);
        let new_x = work_x + (work_w - new_w) / 2.0;
        let new_y = work_y + (work_h - new_h) / 2.0;

        window
            .set_size(LogicalSize::new(new_w, new_h))
            .map_err(|e| e.to_string())?;
        window
            .set_position(LogicalPosition::new(new_x, new_y))
            .map_err(|e| e.to_string())?;
    }

    // --- re-assert minimum size (plugin-state may restore a smaller size) -----
    window
        .set_min_size(Some(LogicalSize::new(600.0_f64, 400.0_f64)))
        .map_err(|e| e.to_string())?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Unit tests (pure geometry, no Tauri runtime needed)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn single_monitor() -> Vec<LogicalRect> {
        vec![LogicalRect::new(0.0, 0.0, 1440.0, 900.0)]
    }

    fn dual_monitors() -> Vec<LogicalRect> {
        vec![
            LogicalRect::new(0.0, 0.0, 1440.0, 900.0),
            LogicalRect::new(1440.0, 0.0, 2560.0, 1440.0),
        ]
    }

    // ---- centroid_on_any_monitor --------------------------------------------

    #[test]
    fn centroid_in_primary_monitor_returns_true() {
        let monitors = single_monitor();
        // Window sitting squarely in the middle of a 1440×900 display.
        assert!(centroid_on_any_monitor(
            300.0, 200.0, 800.0, 500.0, &monitors
        ));
    }

    #[test]
    fn centroid_on_second_monitor_returns_true() {
        let monitors = dual_monitors();
        // Window on the right monitor (starts at x=1440).
        assert!(centroid_on_any_monitor(
            1600.0, 100.0, 800.0, 500.0, &monitors
        ));
    }

    #[test]
    fn centroid_off_all_monitors_returns_false() {
        let monitors = single_monitor();
        // Window parked at x=99999 (off-screen).
        assert!(!centroid_on_any_monitor(
            99999.0, 99999.0, 800.0, 500.0, &monitors
        ));
    }

    #[test]
    fn centroid_exactly_on_edge_is_outside() {
        // The rect is exclusive of the bottom-right corner.
        let monitors = single_monitor(); // 0..1440, 0..900
                                         // A 0×0 "window" at exactly (1440, 900) — centroid equals that point.
        assert!(!centroid_on_any_monitor(1440.0, 900.0, 0.0, 0.0, &monitors));
    }

    #[test]
    fn centroid_just_inside_right_edge() {
        let monitors = single_monitor(); // 0..1440, 0..900
                                         // Centroid at (1439, 450) — should be inside.
        assert!(centroid_on_any_monitor(
            1338.0, 200.0, 200.0, 500.0, &monitors
        ));
    }

    #[test]
    fn centroid_partially_off_screen_but_centroid_still_on_monitor() {
        let monitors = single_monitor();
        // Window extends 100 px beyond the right edge but centroid is at x=900.
        assert!(centroid_on_any_monitor(
            700.0, 200.0, 400.0, 400.0, &monitors
        ));
    }

    // ---- clamped_size -------------------------------------------------------

    #[test]
    fn clamped_size_respects_factor() {
        // Work area 1440×900, factor=0.9, preferred 1200×800.
        let (w, h) = clamped_size(1200.0, 800.0, 1440.0, 900.0, 0.9, 600.0, 400.0);
        assert!(w <= 1440.0 * 0.9 + f64::EPSILON);
        assert!(h <= 900.0 * 0.9 + f64::EPSILON);
        assert_eq!(w, 1200.0); // 1200 < 1296
        assert_eq!(h, 800.0); // 800 < 810
    }

    #[test]
    fn clamped_size_does_not_go_below_min() {
        let (w, h) = clamped_size(200.0, 150.0, 1440.0, 900.0, 0.9, 600.0, 400.0);
        assert_eq!(w, 600.0);
        assert_eq!(h, 400.0);
    }

    #[test]
    fn clamped_size_reduces_oversized_window() {
        // Preferred is larger than 90% of the work area.
        let (w, h) = clamped_size(2000.0, 1200.0, 1440.0, 900.0, 0.9, 600.0, 400.0);
        assert!((w - 1296.0).abs() < f64::EPSILON);
        assert!((h - 810.0).abs() < f64::EPSILON);
    }
}
