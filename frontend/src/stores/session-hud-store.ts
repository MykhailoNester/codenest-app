/**
 * Session-state HUD store — one shared SSE subscription + one hydration
 * fetch for the whole app (D3: no new polling loop), plus one shared
 * ref-counted git-status poller keyed by cwd (D12: one `git` spawn per
 * distinct cwd, not per pane).
 *
 * zustand (already a dependency; see `stores/terminal-store.ts`).
 */

import { useEffect } from "react";
import { create } from "zustand";
import { fetchPaneHuds, type PaneHud } from "../lib/api";
import {
  getGitPaneStatus,
  isTauriAvailable,
  type GitPaneStatus,
} from "../lib/ipc";
import { sseRegistry, SSE_EVENT_NAMES } from "../lib/sse-registry";

interface SessionHudState {
  byPane: Record<string, PaneHud>;
  gitByCwd: Record<string, GitPaneStatus | null>;
}

export const useSessionHudStore = create<SessionHudState>(() => ({
  byPane: {},
  gitByCwd: {},
}));

/** Selector: this pane's HUD facts, or `null` when it has no live session. */
export function useSessionHud(paneId: string): PaneHud | null {
  return useSessionHudStore((s) => s.byPane[paneId] ?? null);
}

// ─── Hydration + SSE deltas (D3) ────────────────────────────────────────────

let started = false;

function isPaneHud(value: unknown): value is PaneHud {
  return (
    typeof value === "object" &&
    value !== null &&
    "pane_id" in value &&
    "session_id" in value
  );
}

function applySnapshot(huds: PaneHud[]): void {
  const byPane: Record<string, PaneHud> = {};
  for (const hud of huds) byPane[hud.pane_id] = hud;
  useSessionHudStore.setState({ byPane });
}

function applyDelta(hud: PaneHud): void {
  useSessionHudStore.setState((s) => ({
    byPane: { ...s.byPane, [hud.pane_id]: hud },
  }));
}

/**
 * Handle one SSE message. Per C2, a message with no `hud` key means "no
 * update" and is ignored outright — that covers `launch` and any other kind
 * with nothing to say about the HUD.
 */
function handleSse(eventName: string, data: unknown): void {
  if (typeof data !== "object" || data === null || !("hud" in data)) return;
  const hud = (data as { hud: unknown }).hud;
  if (eventName === "snapshot") {
    applySnapshot(Array.isArray(hud) ? hud.filter(isPaneHud) : []);
    return;
  }
  if (isPaneHud(hud)) applyDelta(hud);
}

/**
 * Subscribe the whole app to the agents SSE stream's additive `hud` field
 * and hydrate once via `GET /api/v1/agents/hud`. Idempotent — every
 * `<SessionHud/>` calls this from an effect on mount, and only the first
 * call does anything.
 */
export function startSessionHudFeed(): void {
  if (started) return;
  started = true;
  sseRegistry.subscribe("agents", SSE_EVENT_NAMES, handleSse);
  fetchPaneHuds()
    .then((huds) => applySnapshot(huds))
    .catch(() => undefined);
}

// ─── Git status (D12) ───────────────────────────────────────────────────────
//
// One module-level 30 s interval refreshes every registered cwd once per
// tick, ref-counted so N panes sharing a cwd (the common case in a split)
// spawn one `git` process, not N. The interval exists only while at least
// one cwd is registered.

const GIT_POLL_MS = 30_000;

const gitRefCounts = new Map<string, number>();
let gitInterval: ReturnType<typeof setInterval> | null = null;

async function refreshGitCwd(cwd: string): Promise<void> {
  // `invoke` throws outside the Tauri shell, and a real terminal pane cannot
  // exist there anyway — guards both the first call and every later tick.
  if (!isTauriAvailable()) return;
  let status: GitPaneStatus | null;
  try {
    status = await getGitPaneStatus(cwd);
  } catch {
    status = null;
  }
  useSessionHudStore.setState((s) => ({
    gitByCwd: { ...s.gitByCwd, [cwd]: status },
  }));
}

function startGitInterval(): void {
  if (gitInterval != null) return;
  gitInterval = setInterval(() => {
    for (const cwd of gitRefCounts.keys()) void refreshGitCwd(cwd);
  }, GIT_POLL_MS);
}

function stopGitInterval(): void {
  if (gitInterval != null) {
    clearInterval(gitInterval);
    gitInterval = null;
  }
}

function registerGitCwd(cwd: string): void {
  const count = gitRefCounts.get(cwd) ?? 0;
  gitRefCounts.set(cwd, count + 1);
  if (count === 0) {
    void refreshGitCwd(cwd);
    startGitInterval();
  }
}

function unregisterGitCwd(cwd: string): void {
  const count = gitRefCounts.get(cwd) ?? 0;
  if (count <= 1) {
    gitRefCounts.delete(cwd);
    useSessionHudStore.setState((s) => {
      const next = { ...s.gitByCwd };
      delete next[cwd];
      return { gitByCwd: next };
    });
  } else {
    gitRefCounts.set(cwd, count - 1);
  }
  if (gitRefCounts.size === 0) stopGitInterval();
}

/**
 * Selector + lifecycle hook: registers `cwd` in the shared poller on mount,
 * deregisters on unmount or when `cwd` changes, and returns the latest known
 * status (`null` before the first poll resolves, or when the path is not a
 * git repository).
 */
export function useGitPaneStatus(cwd: string | undefined): GitPaneStatus | null {
  const status = useSessionHudStore((s) =>
    cwd !== undefined ? (s.gitByCwd[cwd] ?? null) : null,
  );
  useEffect(() => {
    if (cwd === undefined) return;
    registerGitCwd(cwd);
    return () => unregisterGitCwd(cwd);
  }, [cwd]);
  return status;
}
