/**
 * Session-state HUD store — one shared SSE subscription + one hydration
 * fetch, fanned out to every `<SessionHud/>` instance by `pane_id`.
 *
 * Follows the module-level `useSyncExternalStore` idiom of
 * `stores/provider-store.ts`: plain module state, an exported subscriber
 * hook, and exported non-hook mutators. No zustand needed for one map keyed
 * by pane.
 *
 * Live updates ride the existing `/api/v1/agents/stream` SSE connection (via
 * `sseRegistry`, ref-counted across every consumer already using that
 * stream) — this store never opens its own connection and never polls.
 */

import { useSyncExternalStore } from "react";
import { fetchSessionHud, type SessionHudPane } from "../lib/api";
import { sseRegistry, SSE_EVENT_NAMES } from "../lib/sse-registry";

let byPane: Record<string, SessionHudPane> = {};
const listeners = new Set<() => void>();
let refCount = 0;
let unsubscribeSse: (() => void) | null = null;

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isHudPane(value: unknown): value is SessionHudPane {
  return (
    typeof value === "object" &&
    value !== null &&
    "pane_id" in value &&
    "status" in value
  );
}

/** Replace the whole map, keyed by `pane_id`, dropping ended sessions. */
function applySnapshot(panes: SessionHudPane[]): void {
  const next: Record<string, SessionHudPane> = {};
  for (const pane of panes) {
    if (pane.status === "ended") continue;
    next[pane.pane_id] = pane;
  }
  byPane = next;
  emit();
}

/**
 * Upsert (or, on `status === "ended"`, remove) one pane's row. `null` is a
 * no-op — the stream sends `hud: null` for events with no resolvable pane
 * (an external `claude` session with no Codenest pane).
 */
function applyDelta(hud: SessionHudPane | null): void {
  if (hud === null) return;
  const next = { ...byPane };
  if (hud.status === "ended") {
    delete next[hud.pane_id];
  } else {
    next[hud.pane_id] = hud;
  }
  byPane = next;
  emit();
}

function handleSse(eventName: string, data: unknown): void {
  if (typeof data !== "object" || data === null || !("hud" in data)) {
    // `launch` messages and any future event with no `hud` field — ignore.
    return;
  }
  const hud = (data as { hud: unknown }).hud;
  if (eventName === "snapshot") {
    if (Array.isArray(hud)) {
      applySnapshot(hud.filter(isHudPane));
    }
    return;
  }
  if (hud === null || isHudPane(hud)) {
    applyDelta(hud);
  }
}

/**
 * Acquire the shared subscription; returns a release function. Ref-counted
 * so N panes share one `EventSource` (via `sseRegistry`) and one hydration
 * fetch.
 */
export function acquireSessionHudStream(): () => void {
  refCount += 1;
  if (refCount === 1) {
    unsubscribeSse = sseRegistry.subscribe("agents", SSE_EVENT_NAMES, handleSse);
    // Where `EventSource` is undefined (jsdom, or any non-browser host),
    // `sseRegistry.subscribe` deliberately no-ops the connection
    // (sse-registry.ts's `getEventSourceCtor`) — nothing will ever deliver a
    // `snapshot` to reconcile a one-shot hydration fetch against, so seeding
    // state from it would leave a permanently stale snapshot on screen,
    // exactly the kind of value this HUD must never show. Skipping the
    // fetch there keeps the store honest and keeps unrelated component
    // tests off the network.
    if (typeof EventSource !== "undefined") {
      void fetchSessionHud()
        .then((snapshot) => applySnapshot(snapshot.panes))
        .catch(() => undefined);
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    refCount -= 1;
    if (refCount <= 0) {
      refCount = 0;
      unsubscribeSse?.();
      unsubscribeSse = null;
      byPane = {};
      emit();
    }
  };
}

export function useSessionHudPane(paneId: string): SessionHudPane | null {
  return useSyncExternalStore(
    subscribe,
    () => byPane[paneId] ?? null,
    () => null,
  );
}

/** Test-only: reset all module state between test cases. */
export function _resetSessionHudStoreForTests(): void {
  byPane = {};
  refCount = 0;
  unsubscribeSse?.();
  unsubscribeSse = null;
}
