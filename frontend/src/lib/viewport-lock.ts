/**
 * Keeps the React root's box exactly the size of the webview viewport (#43).
 *
 * The reported failure: after an update applied and the webview reloaded, the
 * whole UI rendered at roughly the window's previous, smaller dimensions in the
 * top-left corner, the rest of the window stayed black, and the app — a fixed
 * viewport with scrolling confined to its panes — became scrollable as a whole.
 * A root box that kept a stale size while the window did not, with no
 * re-measure afterwards.
 *
 * `index.css` fixes the root to the viewport rect (`position: fixed; inset: 0`)
 * so there is no percentage chain to go stale in the first place. This module is
 * the second half: it mirrors the live viewport metrics into the root's own
 * inline `width`/`height` on every signal that the viewport may have changed,
 * which both pins the size to a measured fact and, by writing a different value
 * than the box currently has, forces the relayout a webview that missed the
 * resize never performed.
 *
 * Signals, all of them cheap and idempotent:
 *
 * - `resize` on the window — the ordinary case, including a window resized while
 *   the app is still starting up (Rust's `clamp_window_to_monitor` can call
 *   `set_size` after the webview is already loading).
 * - `pageshow` — a reload, including the one an applied update triggers, and a
 *   restore from the page cache.
 * - `visualViewport`'s own `resize` — fires for viewport changes that do not
 *   resize the window (zoom, an on-screen keyboard).
 * - a `ResizeObserver` on `<html>` — the backstop for a viewport change that
 *   produced no event at all, which is the shape of the bug being fixed.
 *
 * Deliberately not a React hook: it must be installed before the first render
 * and outlive every unmount (a reload remounts the tree, and the ring/detached
 * windows share this bundle), so it is wired in `main.tsx` against the real
 * `#root` element instead of from inside a component's effect.
 */

/** Viewport size in CSS pixels, as the document itself reports it. */
export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * Reads the viewport's own size. `documentElement.clientWidth/Height` rather
 * than `window.inner*`: the former excludes a classic scrollbar and is the box
 * `position: fixed; inset: 0` resolves against, so the two always agree.
 */
export function readViewportSize(doc: Document): ViewportSize {
  return {
    width: doc.documentElement.clientWidth,
    height: doc.documentElement.clientHeight,
  };
}

/**
 * Writes the current viewport size onto `root` as inline pixels, and returns it.
 * A no-op when the inline value already says the same thing — so the common
 * case of several signals firing for one resize costs one style write, not
 * four.
 */
export function syncRootToViewport(root: HTMLElement): ViewportSize {
  const size = readViewportSize(root.ownerDocument);
  const width = `${size.width}px`;
  const height = `${size.height}px`;
  if (root.style.width !== width) root.style.width = width;
  if (root.style.height !== height) root.style.height = height;
  return size;
}

/**
 * Installs the viewport lock and returns a disposer. The disposer exists for
 * tests and for symmetry; in the app the lock lives as long as the document
 * does.
 */
export function installViewportLock(root: HTMLElement): () => void {
  const view = root.ownerDocument.defaultView;
  if (!view) return () => {};

  const sync = (): void => {
    syncRootToViewport(root);
  };
  sync();

  view.addEventListener("resize", sync);
  view.addEventListener("pageshow", sync);
  const visual = view.visualViewport ?? null;
  visual?.addEventListener("resize", sync);

  // The backstop: a viewport that changed without emitting `resize`. Observing
  // `<html>` rather than `#root` — `#root` is what this module writes to, and
  // observing one's own writes is how a ResizeObserver loop starts.
  let observer: ResizeObserver | null = null;
  if (typeof view.ResizeObserver === "function") {
    observer = new view.ResizeObserver(sync);
    observer.observe(root.ownerDocument.documentElement);
  }

  return () => {
    view.removeEventListener("resize", sync);
    view.removeEventListener("pageshow", sync);
    visual?.removeEventListener("resize", sync);
    observer?.disconnect();
  };
}
