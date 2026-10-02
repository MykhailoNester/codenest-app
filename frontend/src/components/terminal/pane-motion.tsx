/**
 * The agent pane's motion cues — the session strip's spinner and thinking dot,
 * and the transcript's streaming dot — driven by the Web Animations API rather
 * than by `@keyframes`.
 *
 * Keyframes are the one thing neither an inline style nor a Deck class can
 * express — Deck has no animation primitive at all — so the alternative was to
 * drop the motion, which is what the onboarding conversion did with its ring.
 * Here the spin and the pulse are the strip's only *live* signal: "Bash 0:14"
 * and "Thinking" read identically whether the session is working or wedged.
 * `element.animate` keeps that signal with no stylesheet, and reads
 * `prefers-reduced-motion` directly rather than through a media query this file
 * can no longer write.
 *
 * Split from `session-hud-chrome.ts` because `react-refresh/only-export-
 * components` will not have components and constants in one module.
 */

import { useCallback, type CSSProperties, type ReactElement } from "react";

const DOT_STYLE: CSSProperties = { width: 5, height: 5, borderRadius: "50%" };

const THINK_DOT_STYLE: CSSProperties = { ...DOT_STYLE, background: "var(--warn)" };

/** The transcript's own live dot. An `<em>` because that is the tag the
 *  streaming line has always used; `fontStyle: normal` keeps the UA's italic
 *  off a 5px square. */
const STREAM_DOT_STYLE: CSSProperties = {
  ...DOT_STYLE,
  background: "var(--run)",
  fontStyle: "normal",
};

const SPIN_STYLE: CSSProperties = { display: "inline-block", color: "var(--run)" };

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const PULSE_FRAMES: Keyframe[] = [
  { opacity: 0.35 },
  { opacity: 1, offset: 0.5 },
  { opacity: 0.35 },
];
const PULSE_OPTIONS: KeyframeAnimationOptions = {
  duration: 1250,
  easing: "ease-in-out",
  iterations: Infinity,
};

/** Same shape as the thinking pulse, a touch quicker — the transcript's dot
 *  tracks live text rather than an inferred state. */
const STREAM_OPTIONS: KeyframeAnimationOptions = {
  duration: 1100,
  easing: "ease-in-out",
  iterations: Infinity,
};
const STREAM_FRAMES: Keyframe[] = PULSE_FRAMES;

const SPIN_FRAMES: Keyframe[] = [
  { transform: "rotate(0deg)" },
  { transform: "rotate(360deg)" },
];
const SPIN_OPTIONS: KeyframeAnimationOptions = {
  duration: 1900,
  easing: "linear",
  iterations: Infinity,
};

/**
 * Starts the loop on mount and cancels it on unmount, through React 19's ref
 * cleanup. Guarded for jsdom, which implements neither `animate` nor
 * `matchMedia`, and for a reader who has asked the OS for less motion.
 */
function useLoopAnimation(
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): (el: HTMLElement | null) => (() => void) | undefined {
  return useCallback(
    (el: HTMLElement | null) => {
      if (el === null) return;
      if (typeof el.animate !== "function") return;
      if (prefersReducedMotion()) return;
      const animation = el.animate(keyframes, options);
      return () => animation.cancel();
    },
    [keyframes, options],
  );
}

/** The pulsing dot beside "Thinking". */
export function ThinkingDot(): ReactElement {
  const ref = useLoopAnimation(PULSE_FRAMES, PULSE_OPTIONS);
  return <span ref={ref} style={THINK_DOT_STYLE} data-hud-pulse />;
}

/** The pulsing dot beside the transcript's streaming text. */
export function StreamingDot(): ReactElement {
  const ref = useLoopAnimation(STREAM_FRAMES, STREAM_OPTIONS);
  return <em ref={ref} style={STREAM_DOT_STYLE} data-stream-pulse />;
}

/** The turning gear beside a running tool. */
export function ToolSpinner(): ReactElement {
  const ref = useLoopAnimation(SPIN_FRAMES, SPIN_OPTIONS);
  return (
    <span ref={ref} style={SPIN_STYLE} data-hud-spin>
      ⚙
    </span>
  );
}
