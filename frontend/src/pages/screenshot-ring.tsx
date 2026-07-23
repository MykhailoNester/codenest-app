/**
 * Screenshot ring overlay window page.
 *
 * # Window lifecycle
 * 1. Global hotkey fires → Rust `open_screenshot_ring` spawns this window
 *    centered at the cursor.
 * 2. The user sees a radial ring with a single "Screenshot" action (and a
 *    visible "×" dismiss button in every phase).
 * 3. Clicking "Screenshot" calls `ring_capture` (Rust), which runs
 *    `screencapture -i` on a blocking thread.
 * 4. Rust emits `screenshot-ready` (with `CaptureResult`) or
 *    `screenshot-cancelled` (error code string) to this window.
 * 5. On `screenshot-ready` the page morphs in-place to a drag thumbnail
 *    (same window, same label, no close/reopen flash).
 * 6. The user drags the thumbnail into a terminal tab.  On drop/cancel/Escape
 *    the window closes via `close_screenshot_ring`.
 *
 * # Hotkey
 * Default: `Ctrl+Shift+2` — no documented macOS system binding.
 * Configurable via sidecar setting `"screenshot.hotkey"`.
 *
 * # Window unification
 * A single window drives the entire flow so there is no close/reopen race or
 * visual flash between the ring and the thumbnail phases.
 *
 * # Transparency
 * The Tauri window is transparent (`macOSPrivateApi: true` in tauri.conf.json,
 * `.transparent(true)` in screenshot.rs).  The root element is transparent and
 * only the `.puck` disc provides the visible background, giving a true floating
 * round overlay with no opaque square corners.
 */

import { useEffect, useState, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DragThumbnail } from "../components/screenshot/drag-thumbnail";
import type { CaptureResult } from "../lib/ipc";
import styles from "../components/screenshot/screenshot-ring.module.css";

// ---------------------------------------------------------------------------
// Phase types
// ---------------------------------------------------------------------------

type Phase =
  | { kind: "ring" }
  | { kind: "capturing" }
  | { kind: "thumbnail"; result: CaptureResult }
  | { kind: "error"; code: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Close this overlay window via the Rust command.  Idempotent. */
function closeRing(): void {
  void invoke("close_screenshot_ring").catch((err) => {
    console.error("close_screenshot_ring failed:", err);
  });
}

/** Human-readable label for a stable error code. */
function errorLabel(code: string): string {
  if (code === "permission-denied")
    return "Screen Recording permission required. Open System Settings › Privacy › Screen Recording.";
  return `Capture error: ${code}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Shared dismiss × button rendered inside the puck for non-thumbnail phases. */
function DismissButton(): ReactElement {
  return (
    <button
      type="button"
      onClick={closeRing}
      aria-label="Dismiss"
      className={styles.dismiss}
    >
      ×
    </button>
  );
}

/** Camera SVG — inline, no external icon dependency. */
function CameraIcon(): ReactElement {
  return (
    <svg
      className={styles.cameraIcon}
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

/** Warning/error triangle icon. */
function ErrorIcon(): ReactElement {
  return (
    <svg
      className={styles.errorIcon}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Phase content blocks
// ---------------------------------------------------------------------------

/** Idle ring phase — centred camera action. */
function RingPhaseContent({
  onCapture,
}: {
  onCapture: () => void;
}): ReactElement {
  return (
    <div className={styles.phaseContent}>
      <button
        type="button"
        onClick={onCapture}
        className={styles.primaryAction}
        aria-label="Capture screenshot region"
      >
        <CameraIcon />
        <span className={styles.actionLabel}>Screenshot</span>
      </button>
    </div>
  );
}

/** Capturing phase — pulsing animation while screencapture -i runs. */
function CapturingPhaseContent(): ReactElement {
  return (
    <div className={styles.phaseContent}>
      <div className={styles.capturingInner}>
        <div className={styles.pulseRing}>
          <div className={styles.pulseCore} />
        </div>
        <span className={styles.capturingLabel}>Select region</span>
      </div>
    </div>
  );
}

/** Error phase — icon + message + auto-dismiss. */
function ErrorPhaseContent({ code }: { code: string }): ReactElement {
  return (
    <div className={styles.phaseContent}>
      <div className={styles.errorInner}>
        <ErrorIcon />
        <p className={styles.errorText}>{errorLabel(code)}</p>
        <span className={styles.errorDismissHint}>Closing in 3s…</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ScreenshotRingPage(): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: "ring" });

  // ── Transparent window background ─────────────────────────────────────────
  //
  // The global index.css sets an opaque background on `html, body, #root`;
  // override ALL THREE here so the transparent Tauri window surface shows
  // through wherever the puck disc is not painted.  Missing `#root` (the React
  // mount node) leaves an opaque square behind the round puck.  Cleaned up on
  // unmount (defensive — this window is destroyed by closeRing, but React
  // cleanup still runs first).

  useEffect(() => {
    const targets = [
      document.documentElement,
      document.body,
      document.getElementById("root"),
    ].filter((el): el is HTMLElement => el != null);

    const prev = targets.map((el) => el.style.background);
    targets.forEach((el) => {
      el.style.background = "transparent";
    });
    return () => {
      targets.forEach((el, i) => {
        el.style.background = prev[i] ?? "";
      });
    };
  }, []);

  // ── Tauri event subscriptions ──────────────────────────────────────────────

  useEffect(() => {
    const unlistenReady = listen<CaptureResult>("screenshot-ready", (event) => {
      setPhase({ kind: "thumbnail", result: event.payload });
    });

    const unlistenCancelled = listen<string>(
      "screenshot-cancelled",
      (event) => {
        const code = event.payload;
        if (code === "cancelled") {
          closeRing();
        } else {
          setPhase({ kind: "error", code });
        }
      },
    );

    return () => {
      void unlistenReady.then((fn) => fn());
      void unlistenCancelled.then((fn) => fn());
    };
  }, []);

  // ── Keyboard handling ──────────────────────────────────────────────────────

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") closeRing();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ── Auto-dismiss error phase after 3 s ────────────────────────────────────

  useEffect(() => {
    if (phase.kind !== "error") return;
    const t = setTimeout(closeRing, 3000);
    return () => clearTimeout(t);
  }, [phase.kind]);

  // ── Capture trigger ────────────────────────────────────────────────────────

  function handleCaptureClick(): void {
    setPhase({ kind: "capturing" });
    // ring_capture only rejects on a genuine Tauri transport error (e.g. the
    // spawn_blocking thread panicked before any event could be emitted).
    // Capture-level outcomes (cancelled, permission-denied) are conveyed via
    // the screenshot-ready / screenshot-cancelled events handled above — do
    // NOT set the error phase here, or the event listener races with the catch.
    void invoke("ring_capture").catch((err: unknown) => {
      console.error("ring_capture transport error:", err);
    });
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  // Determine whether the accent ring should be in the faster "capturing" mode.
  const isCapturing = phase.kind === "capturing";

  return (
    <div className={styles.root}>
      {/* Animated accent ring sits behind the puck */}
      <div
        className={
          isCapturing
            ? `${styles.ringWrapper} ${styles.ringWrapperCapturing}`
            : styles.ringWrapper
        }
      />

      <div className={styles.puck}>
        {phase.kind === "ring" && (
          <>
            <RingPhaseContent onCapture={handleCaptureClick} />
            <DismissButton />
          </>
        )}

        {phase.kind === "capturing" && (
          <>
            <CapturingPhaseContent />
            <DismissButton />
          </>
        )}

        {phase.kind === "thumbnail" && (
          // DragThumbnail provides its own dismiss button and hint label.
          <DragThumbnail
            path={phase.result.path}
            onDragDone={closeRing}
            padding={6}
            hint="Drag into a terminal"
          />
        )}

        {phase.kind === "error" && (
          <>
            <ErrorPhaseContent code={phase.code} />
            <DismissButton />
          </>
        )}
      </div>
    </div>
  );
}
