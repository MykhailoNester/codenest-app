/**
 * StartupSplash — the full-screen surface shown while the sidecar boots and
 * the onboarding state is still unknown. Drawn on Deck (#283).
 *
 * It is the first thing anyone sees on launch, and it was the loudest thing
 * in the app: a purple radial wash, a floating logo inside a pulsing halo, a
 * blue→violet gradient-clipped wordmark and an indeterminate bar sweeping on
 * a 1.25s loop — four simultaneous animations announcing that nothing has
 * happened yet. Deck's answer to "is this live" is one character, so that is
 * what this is now: the `~` running glyph against the console ground, the
 * wordmark in the structural face, and the caption.
 *
 * Nothing above it carries `.deck` — the gate renders this *instead of* the
 * app tree (see `GateSplash` in `App.tsx`) — so the root opts in itself, the
 * same way `pages/terminal-window-root.tsx` does for the popout.
 *
 * On the motion
 * -------------
 * The stylesheet ended in a `@media (prefers-reduced-motion: reduce)` block
 * switching off `.logo`, `.halo` and `.barFill`. That block is **moot, not
 * dropped**: all three animations are gone with the stylesheet, and what
 * replaces them is a static glyph. There is no motion left for the query to
 * reduce, and a `@keyframes` cannot be reintroduced without a stylesheet —
 * which is the thing this ticket removes.
 */
import type { CSSProperties, ReactElement } from "react";

/**
 * Deck has no full-screen surface — `.dk-app` is the real shell's two-column
 * grid and `.dk-scrim` dims something underneath, which on launch is nothing.
 * So this is a local constant, the same call `pages/terminal-window-root.tsx`
 * makes for its own root. It only positions: the ground, the ink and the face
 * all come from `.deck` itself.
 */
const SPLASH_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 9999,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

/** The stack. Centred, and gapped at Deck's own rhythm rather than by eye. */
const CENTER_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "var(--u3)",
};

/**
 * The wordmark. `.dk-title h1` is 15px mono with a tight track and is the
 * app's largest type outside `.dk-big`; this borrows its size but spaces the
 * letters out, because a six-letter name at 15px reads as a word rather than
 * as a mark otherwise.
 */
const WORDMARK_STYLE: CSSProperties = {
  fontSize: "15px",
  letterSpacing: "0.22em",
  textTransform: "uppercase",
  textIndent: "0.22em",
};

/** The slow-start note. `.dk-note` caps at 80ch; a centred column wants less. */
const NOTE_STYLE: CSSProperties = { maxWidth: "44ch", textAlign: "center" };

export interface StartupSplashProps {
  /** Soft deadline elapsed — show the "taking longer" copy + Retry button. */
  slow?: boolean;
  /** Invoked when the user clicks Retry (re-checks readiness + onboarding). */
  onRetry?: () => void;
}

export function StartupSplash({
  slow = false,
  onRetry,
}: StartupSplashProps = {}): ReactElement {
  return (
    <div
      className="deck"
      style={SPLASH_STYLE}
      role="status"
      aria-label="Starting Codenest"
    >
      <div style={CENTER_STYLE}>
        {/* The mark stays — it is the product's identity, not a semantic icon,
            and Deck's "icons out" trade is about the latter. What goes is the
            float animation and the purple drop-shadow around it. */}
        <img src="/favicon.svg" alt="" width={44} height={42} />
        <div style={WORDMARK_STYLE}>Codenest</div>
        {/* The one state glyph, carrying its own word for a screen reader —
            `run` is `~`, which is what every live row in the app shows. It
            replaces the sweeping indeterminate bar. */}
        <span className="dk-s" data-s="run" role="img" aria-label="running" />
        <div className="dim" style={{ fontSize: "var(--fs-s)" }}>
          {slow
            ? "Still starting the workspace engine…"
            : "Initializing workspace…"}
        </div>
        {slow && (
          <div style={CENTER_STYLE}>
            <p className="dk-note sans" style={NOTE_STYLE}>
              This is taking longer than usual — the local engine may still be
              warming up. Your setup is safe; nothing is lost.
            </p>
            {onRetry && (
              <button type="button" className="dk-btn" onClick={onRetry}>
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
