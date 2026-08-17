// Vitest environment setup (`setupFiles` in `vite.config.ts`), run once per
// test file before its imports.
//
// jsdom implements no layout, so it ships no `ResizeObserver`. Components that
// construct one on mount therefore throw in tests but not in any browser —
// a pure environment gap, never a real defect, which is why the stub belongs
// here rather than in production code behind a `typeof` guard.
//
// Installed only when the global is absent, so a test file that wants to
// *drive* resize callbacks (`composer-mention-menu.test.tsx`,
// `terminal-tab-persistence.test.tsx`) keeps overriding it with its own
// recording stub exactly as before.

class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    InertResizeObserver as unknown as typeof ResizeObserver;
}
