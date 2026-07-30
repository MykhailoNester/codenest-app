import { useEffect, useState, type ReactElement } from "react";
import {
  getGitPaneStatus,
  isTauriAvailable,
  type GitPaneStatus,
} from "../../lib/ipc";
import {
  acquireSessionHudStream,
  useSessionHudPane,
} from "../../stores/session-hud-store";
import {
  contextPercent,
  elapsedSecondsSince,
  formatHudElapsed,
  formatToolElapsed,
  formatTokensShort,
  shortModelLabel,
} from "./session-hud-format";
import styles from "./session-hud.module.css";

// ─── Per-pane session-state strip ──────────────────────────────────────────
//
// Honesty contract (binding on every cell added here): a cell renders a real
// value or it does not render at all. There is no placeholder number, no em
// dash, no zero standing in for "unknown" — see `app/models/session_hud.py`'s
// module docstring for the sidecar side of the same contract.
//
// - D4 (see `app/services/session_hud_service.py`): "thinking" has no hook —
//   it is inferred from the newest hook event type. The tooltip on that cell
//   says so; treat this as the one cell in the strip that is an inference
//   rather than a fact.
// - D9 (`stores/session-hud-store.ts`): the hydration fetch is skipped when
//   `EventSource` does not exist, so a torn-down environment never shows a
//   snapshot nothing can refresh.
// - D10: the 1 s elapsed ticker below is a single module-level interval
//   shared by every mounted pane, copied in shape from
//   `pages/schedules.tsx`'s `useNow` — `react-hooks/purity` treats
//   `Date.now()` as impure, so it is only ever read inside
//   `session-hud-format.ts`'s plain helpers, never here.
// - D11: a pane whose process has exited (`exited === true`) stops
//   subscribing to the ticker, so its elapsed values freeze at their last
//   real reading instead of counting up for a dead process. The git cell
//   keeps polling — the directory is still real even if the shell isn't.
// - The cost cell surfaces `cost_usd` exactly as the sidecar stored it. That
//   arithmetic prices every model at Sonnet-4 rates
//   (`app/services/agent_service.py:444-445`) — a real, separately tracked
//   defect this branch does not touch.

interface SessionHudProps {
  paneId: string;
  cwd: string | undefined;
  active: boolean;
  /** True once the pane's backing process has exited — see D11. */
  exited: boolean;
}

// ─── Shared 1 s elapsed ticker (D10) ────────────────────────────────────────
// One interval for every mounted `<SessionHud/>`, not one per pane. Paused
// whenever the document is hidden, exactly like `pages/schedules.tsx`'s
// `useNow`.

const _tickSubs = new Set<() => void>();
let _tickTimer: ReturnType<typeof setInterval> | null = null;
let _visibilityBound = false;

function _startTicker(): void {
  if (_tickTimer != null) return;
  if (typeof document !== "undefined" && document.hidden) return;
  _tickTimer = setInterval(() => {
    for (const fn of _tickSubs) fn();
  }, 1000);
}

function _stopTicker(): void {
  if (_tickTimer != null) {
    clearInterval(_tickTimer);
    _tickTimer = null;
  }
}

function _bindVisibility(): void {
  if (_visibilityBound || typeof document === "undefined") return;
  _visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) _stopTicker();
    else if (_tickSubs.size > 0) _startTicker();
  });
}

/**
 * Re-render once per second while `enabled` (paused when the tab is
 * hidden). `enabled` is `false` for a pane with no live session and for one
 * whose process has exited (D11) — its elapsed values then freeze instead
 * of ticking for a session that no longer exists or a process that is dead.
 */
function useHudTick(enabled: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    _bindVisibility();
    const cb = (): void => setTick((n) => (n + 1) % 1_000_000);
    _tickSubs.add(cb);
    _startTicker();
    return () => {
      _tickSubs.delete(cb);
      if (_tickSubs.size === 0) _stopTicker();
    };
  }, [enabled]);
}

export function SessionHud({
  paneId,
  cwd,
  active,
  exited,
}: SessionHudProps): ReactElement | null {
  const hud = useSessionHudPane(paneId);
  useEffect(() => acquireSessionHudStream(), []);
  useHudTick(hud !== null && !exited);

  const [git, setGit] = useState<GitPaneStatus | null>(null);
  useEffect(() => {
    // Guard order is load-bearing: return on plain props BEFORE touching any
    // `lib/ipc` export. Vitest 4 wraps a `vi.mock` factory's namespace in a
    // Proxy that THROWS on the first access to an export the factory did not
    // return (`[vitest] No "<name>" export is defined on the "<path>" mock`),
    // so an unconditional `isTauriAvailable()` call here would explode inside
    // any unrelated test that mocks `lib/ipc` partially. Short-circuiting on
    // props first is both cheaper (skip inactive/cwd-less panes entirely)
    // and mock-safe.
    if (!active || !cwd) return;
    if (!isTauriAvailable()) return;

    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        const status = await getGitPaneStatus(cwd);
        if (!cancelled) setGit(status);
      } catch {
        if (!cancelled) setGit(null);
      }
    };
    void run();
    // One `git status` per visible pane per 15 s; a hidden tab polls
    // nothing because this whole effect is gated on `active`.
    const interval = setInterval(() => void run(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [cwd, active]);

  const cells: ReactElement[] = [];

  if (hud?.model) {
    cells.push(
      <div key="model" className={styles.hcell} data-cell="model">
        <span className={`${styles.hv} ${styles.acc}`} title={hud.model}>
          {hud.model_display ?? shortModelLabel(hud.model)}
        </span>
      </div>,
    );
  }

  if (hud !== null && hud.context_tokens != null && hud.context_window) {
    const pct = contextPercent(hud.context_tokens, hud.context_window);
    cells.push(
      <div key="ctx" className={styles.hcell} data-cell="ctx">
        <span className={styles.hk}>ctx</span>
        <span className={styles.cbar}>
          <span className={styles.cbarFill} style={{ width: `${pct}%` }} />
        </span>
        <span
          className={`${styles.hv} ${pct < 60 ? styles.ok : styles.warn}`}
        >
          {pct}%
        </span>
      </div>,
    );
    cells.push(
      <div key="tokens" className={styles.hcell} data-cell="tokens">
        <span className={`${styles.hv} ${styles.pink}`}>
          {formatTokensShort(hud.context_tokens)}/
          {formatTokensShort(hud.context_window)}
        </span>
      </div>,
    );
  }

  if (hud !== null) {
    cells.push(
      <div key="cost" className={styles.hcell} data-cell="cost">
        <span className={`${styles.hv} ${styles.warn}`}>
          ${hud.cost_usd.toFixed(2)}
        </span>
      </div>,
    );

    const elapsedSeconds = elapsedSecondsSince(hud.started_at);
    if (elapsedSeconds !== null) {
      cells.push(
        <div key="elapsed" className={styles.hcell} data-cell="elapsed">
          <span className={styles.hv}>{formatHudElapsed(elapsedSeconds)}</span>
        </div>,
      );
    }
  }

  const gitLabel = git?.branch ?? git?.headShort;
  if (git !== null && gitLabel) {
    cells.push(
      <div key="git" className={styles.hcell} data-cell="git">
        <span className={`${styles.hv} ${styles.ok}`}>{gitLabel}</span>
        {git.dirty ? (
          <span className={`${styles.hv} ${styles.warn}`}>*</span>
        ) : null}
        {git.ahead != null && git.ahead > 0 ? (
          <span className={`${styles.hv} ${styles.info}`}>+{git.ahead}</span>
        ) : null}
      </div>,
    );
  }

  if (hud !== null && hud.current_tool) {
    const toolElapsedSeconds = elapsedSecondsSince(
      hud.current_tool_started_at,
    );
    cells.push(
      <div key="tool" className={styles.hcell} data-cell="tool">
        <span className={styles.spin}>⚙</span>
        <span className={`${styles.hv} ${styles.info}`}>
          {hud.current_tool}
        </span>
        {toolElapsedSeconds !== null ? (
          <span className={styles.hv} style={{ color: "var(--fg-3)" }}>
            {formatToolElapsed(toolElapsedSeconds)}
          </span>
        ) : null}
      </div>,
    );
  }

  if (hud?.thinking === true) {
    cells.push(
      <div
        key="thinking"
        className={styles.hcell}
        data-cell="thinking"
        title="Inferred from the hook stream — Claude Code fires no thinking hook."
      >
        <span className={styles.think}>
          <span className={styles.thinkDot} />
          Thinking
        </span>
      </div>,
    );
  }

  if (hud !== null && hud.todo_total != null && hud.todo_total > 0) {
    const total = hud.todo_total;
    const done = hud.todo_done ?? 0;
    const pct = Math.round((done / total) * 100);
    cells.push(
      <div key="todo" className={styles.hcell} data-cell="todo">
        <span className={styles.hk}>todo</span>
        <span className={styles.tdbar}>
          <span className={styles.tdbarFill} style={{ width: `${pct}%` }} />
        </span>
        <span className={`${styles.hv} ${styles.pink}`}>
          {done}/{total}
        </span>
      </div>,
    );
  }

  if (cells.length === 0) return null;

  // "No live agent session bound to this pane" (prototype:383's shell-pane
  // treatment), extended by D11 to a pane whose process has exited.
  const dim = hud === null || exited;

  return (
    <div
      className={dim ? `${styles.hud} ${styles.dimmed}` : styles.hud}
      data-testid="session-hud"
      data-dimmed={dim ? "true" : "false"}
    >
      {cells}
    </div>
  );
}
