/// Embedded-webview commands for the Preview tab.
///
/// A single child webview labelled `"preview"` is created on first call to
/// `preview_open` and reused for subsequent navigations (recreating per
/// navigation would flicker on WKWebView). It is parented to the `main`
/// window's content view (`WryWebViewParent`) and positioned to cover the
/// `.frameWrap` rectangle reported by the frontend in logical pixels.
///
/// **Positioning strategy:** `apply_frame` anchors against the *main webview
/// sibling's* actual NSView frame, then adds a viewport-derived `inset_top`
/// to convert from CSS space to NSView space.  The inset arises because
/// `NSFullSizeContentViewWindowMask` causes the sibling NSView to fill the
/// full window (including title bar), while WebKit insets its web content by
/// the traffic-light/title-bar height.  `getBoundingClientRect()` measures
/// in the inset content space; the sibling frame is in full-window space.
/// `inset_top = sibling_h - window.innerHeight` bridges the gap without
/// hardcoding any pixel value.
///
/// No DPI scaling is applied: on macOS both CSS pixels and `NSView.frame`
/// values are expressed in logical points, so the values from
/// `getBoundingClientRect()` map 1:1 onto AppKit frame coordinates.
///
/// **Security:** the `"preview"` webview is intentionally excluded from every
/// capability that grants `core:*` commands.  Remote sites must never reach
/// `window.__TAURI__`.  The `preview-webview.json` capability grants the
/// calling `"main"` window (not the child) the right to issue these commands.
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};

/// Client-area rectangle reported by the frontend via `getBoundingClientRect()`,
/// plus the CSS viewport dimensions used to derive the WebKit content inset.
///
/// On a full-size-content-view macOS window, `window.innerHeight` (== `vh`) is
/// smaller than the main webview's NSView height by the title-bar height.
/// `inset_top = sibling_h - vh` converts CSS y-coordinates to NSView-space
/// y-coordinates without hardcoding any pixel value.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// CSS viewport width (`window.innerWidth`).
    pub vw: f64,
    /// CSS viewport height (`window.innerHeight`).
    pub vh: f64,
}

/// Set the NSView frame of the child webview `wv` to `bounds`.
///
/// This is the macOS-specific implementation.  It:
///   1. Dispatches via `with_webview` so all NSView calls run on the main
///      thread, even when the Tauri command handler runs on a worker thread.
///   2. Finds the main webview sibling by iterating `parent.subviews()` and
///      picking the view whose pointer differs from ours.  The sibling's
///      frame is the anchor rectangle, absorbing any window-level insets.
///   3. Derives `inset_top = sibling_h - bounds.vh` to bridge the gap between
///      the CSS content space and the full NSView space introduced by
///      `NSFullSizeContentViewWindowMask`.
///   4. Branches on `parent.isFlipped()` to apply the correct y formula.
///   5. CSS px and `NSView.frame` values are both in logical points on macOS,
///      so the `Bounds` values are used directly — no scale-factor multiply.
#[cfg(target_os = "macos")]
fn apply_frame(wv: &tauri::Webview, bounds: &Bounds) -> Result<(), String> {
    let (lx, ly, lw, lh, vw, vh) = (bounds.x, bounds.y, bounds.w, bounds.h, bounds.vw, bounds.vh);
    wv.with_webview(move |pw| unsafe {
        use objc2_app_kit::{NSView, NSWindow};
        use objc2_foundation::{NSPoint, NSRect, NSSize};

        // pw.inner() is the raw WKWebView pointer; cast to NSView so we can
        // access its superview (the WryWebViewParent content view).
        let view: &NSView = &*(pw.inner() as *const NSView);

        let Some(parent) = view.superview() else {
            eprintln!("[preview] ERROR: preview view has no superview");
            return;
        };

        // Flush any pending subview layout so sibling frames are settled.
        // The parent's own frame is window-driven and always current on the
        // main thread; this only synchronises child positions — not load-bearing.
        if parent.needsLayout() {
            parent.layout();
        }

        let parent_frame = parent.frame();
        let is_flipped = parent.isFlipped();

        #[cfg(debug_assertions)]
        eprintln!(
            "[preview] requested bounds: lx={lx:.1} ly={ly:.1} lw={lw:.1} lh={lh:.1} vw={vw:.1} vh={vh:.1}"
        );
        #[cfg(debug_assertions)]
        eprintln!(
            "[preview] parent frame: origin=({:.1},{:.1}) size=({:.1}x{:.1}) isFlipped={is_flipped}",
            parent_frame.origin.x,
            parent_frame.origin.y,
            parent_frame.size.width,
            parent_frame.size.height,
        );

        // Window backing scale factor — logged for diagnostics only.
        // Coordinate values are in logical points, so no multiply is applied.
        #[cfg(debug_assertions)]
        let scale = view
            .window()
            .as_deref()
            .map(|w: &NSWindow| w.backingScaleFactor())
            .unwrap_or(1.0);
        #[cfg(debug_assertions)]
        eprintln!("[preview] window backingScaleFactor={scale:.1}");

        // Find the main webview sibling: iterate parent's subviews and take
        // the first one whose pointer differs from our preview view.
        // WryWebViewParent hosts exactly two WKWebViews (main + preview);
        // if no sibling is found, fall back to the parent frame so the
        // command still produces a result.
        let subviews = parent.subviews();
        let sibling_frame: Option<NSRect> = {
            let mut found: Option<NSRect> = None;
            for i in 0..subviews.len() {
                // SAFETY: index is within bounds; the array is not mutated
                // while these references are live.
                let sv: &NSView = subviews.objectAtIndex_unchecked(i);
                if !std::ptr::eq(sv as *const NSView, view as *const NSView) {
                    found = Some(sv.frame());
                    break;
                }
            }
            found
        };

        let (mx, my, mw, mh) = match sibling_frame {
            Some(f) => {
                #[cfg(debug_assertions)]
                eprintln!(
                    "[preview] sibling frame: origin=({:.1},{:.1}) size=({:.1}x{:.1})",
                    f.origin.x, f.origin.y, f.size.width, f.size.height
                );
                (f.origin.x, f.origin.y, f.size.width, f.size.height)
            }
            None => {
                eprintln!(
                    "[preview] WARNING: no sibling found — falling back to parent frame"
                );
                (
                    parent_frame.origin.x,
                    parent_frame.origin.y,
                    parent_frame.size.width,
                    parent_frame.size.height,
                )
            }
        };

        // Derive the inset that NSFullSizeContentViewWindowMask introduces:
        // the sibling NSView fills the full window (including title bar), but
        // WebKit insets its web content so CSS y=0 sits below the title bar.
        // `window.innerHeight` (vh) measures only the inset content height, so
        // `sibling_h - vh` gives the top inset without hardcoding any value.
        // `inset_left` is expected to be 0 on standard windows; included
        // symmetrically and clamped to ≥0 as a defensive measure.
        let inset_top = (mh - vh).max(0.0);
        let inset_left = ((mw - vw) / 2.0).max(0.0);
        #[cfg(debug_assertions)]
        eprintln!("[preview] derived inset: top={inset_top:.1} left={inset_left:.1}");

        // Compute child origin in parent coordinates, branching on isFlipped:
        //   Flipped (top-left origin): y increases downward — no y-flip needed.
        //   Not flipped (bottom-left origin): y increases upward — flip needed.
        let origin = if is_flipped {
            NSPoint::new(mx + inset_left + lx, my + inset_top + ly)
        } else {
            NSPoint::new(mx + inset_left + lx, my + mh - inset_top - ly - lh)
        };
        let size = NSSize::new(lw, lh);
        view.setFrame(NSRect::new(origin, size));

        #[cfg(debug_assertions)]
        {
            let after = view.frame();
            eprintln!(
                "[preview] preview frame after setFrame: origin=({:.1},{:.1}) size=({:.1}x{:.1})",
                after.origin.x, after.origin.y, after.size.width, after.size.height
            );
            // Non-flipped confirmation: screen-space top = my + mh - (after.origin.y + lh).
            // This should equal ly + inset_top (CSS top in full-window coordinates).
            let screen_top = my + mh - (after.origin.y + lh);
            eprintln!("[preview] screen-space top={screen_top:.1} (expected css_ly={ly:.1} + inset_top={inset_top:.1} = {:.1})", ly + inset_top);
        }
    })
    .map_err(|e| e.to_string())
}

/// Non-macOS fallback: delegate to wry's built-in set_bounds.
#[cfg(not(target_os = "macos"))]
fn apply_frame(wv: &tauri::Webview, bounds: &Bounds) -> Result<(), String> {
    use tauri::Rect;
    wv.set_bounds(Rect {
        position: LogicalPosition::new(bounds.x, bounds.y).into(),
        size: LogicalSize::new(bounds.w, bounds.h).into(),
    })
    .map_err(|e| e.to_string())
}

/// Open (or reuse) the embedded preview webview and navigate it to `url`.
///
/// - Reuse path: the `"preview"` webview already exists — navigate, reposition,
///   and show it.
/// - Create path: create a new child webview parented to the `main` window,
///   then immediately apply the correct frame via `apply_frame`.
///
/// Returns `Err(String)` if `url` is invalid or the webview cannot be created.
#[tauri::command]
pub fn preview_open(url: String, bounds: Bounds, app: AppHandle) -> Result<(), String> {
    let parsed = url
        .parse::<url::Url>()
        .map_err(|e| format!("invalid URL: {e}"))?;

    // Reuse path.
    if let Some(wv) = app.get_webview("preview") {
        wv.navigate(parsed).map_err(|e| e.to_string())?;
        apply_frame(&wv, &bounds)?;
        wv.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Create path: add a new child webview to the main window, then apply
    // the correct AppKit frame.  `add_child` sets an initial frame based on
    // the logical position/size we pass, but it does not flush AppKit layout
    // first; `apply_frame` corrects the frame after layout has settled.
    let main = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let wv = main
        .add_child(
            tauri::WebviewBuilder::new("preview", WebviewUrl::External(parsed)),
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.w, bounds.h),
        )
        .map_err(|e| e.to_string())?;

    apply_frame(&wv, &bounds)?;

    Ok(())
}

/// Reposition and resize the preview webview to `bounds`.
/// No-op if the webview does not exist yet.
#[tauri::command]
pub fn preview_set_bounds(bounds: Bounds, app: AppHandle) -> Result<(), String> {
    let Some(wv) = app.get_webview("preview") else {
        return Ok(());
    };
    apply_frame(&wv, &bounds)
}

/// Navigate the preview webview to a new URL without changing its bounds.
#[tauri::command]
pub fn preview_navigate(url: String, app: AppHandle) -> Result<(), String> {
    let parsed = url
        .parse::<url::Url>()
        .map_err(|e| format!("invalid URL: {e}"))?;
    let Some(wv) = app.get_webview("preview") else {
        return Ok(());
    };
    wv.navigate(parsed).map_err(|e| e.to_string())
}

/// Show or hide the preview webview.  Used when the History dropdown is open
/// (which would be occluded by the native overlay) and when the app is
/// backgrounded.
#[tauri::command]
pub fn preview_show(visible: bool, app: AppHandle) -> Result<(), String> {
    let Some(wv) = app.get_webview("preview") else {
        return Ok(());
    };
    if visible {
        wv.show().map_err(|e| e.to_string())
    } else {
        wv.hide().map_err(|e| e.to_string())
    }
}

/// Close and destroy the preview webview.  Called on route unmount and when
/// the main window closes.  Idempotent: no-op if already absent.
#[tauri::command]
pub fn preview_close(app: AppHandle) -> Result<(), String> {
    let Some(wv) = app.get_webview("preview") else {
        return Ok(());
    };
    wv.close().map_err(|e| e.to_string())
}
