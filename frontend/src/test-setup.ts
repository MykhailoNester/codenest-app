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
//
// The suite also raises Testing Library's async timeout. Its default is 1s,
// measured in wall clock, and vitest runs these 120 files in parallel — so a
// `waitFor` that resolves in milliseconds on an idle machine can exceed it
// purely because other workers have the CPU. That surfaced as
// `agent-pane-prompt-seed.test.tsx` failing in full runs and passing alone,
// which two separate agents hit independently. The timeout only bounds how
// long a *failing* assertion waits before it reports, so raising it costs a
// slow failure and buys a suite that does not fail on machine load.

import { configure } from "@testing-library/react";

configure({ asyncUtilTimeout: 5_000 });

class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    InertResizeObserver as unknown as typeof ResizeObserver;
}
