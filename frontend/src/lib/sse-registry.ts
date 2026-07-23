// Centralized SSE manager.
//
// Why a module-level singleton: an `EventSource` is a persistent network
// connection — opening one per React component mount wastes a socket and
// duplicates events. The registry ref-counts subscribers per stream URL so
// the first `subscribe` opens the connection and the last `unsubscribe`
// closes it. Reconnect uses 1 s → 2 s → … → 30 s exponential backoff and
// resets to 1 s after a successful `onopen`.
//
// Public API mirrors what `useSidecarSSE` needs: subscribe with a key,
// receive events, get back an unsubscribe function.

import { SIDECAR_BASE_URL } from "./sidecar-url";

const STREAM_URLS: Record<string, string> = {
  agents: `${SIDECAR_BASE_URL}/api/v1/agents/stream`,
};

export const SSE_EVENT_NAMES = [
  "snapshot",
  "session_started",
  "prompt",
  "pre_tool",
  "post_tool",
  "stop",
  "session_ended",
  "session_removed",
  "update",
] as const;

export type SseHandler = (eventName: string, data: unknown) => void;

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

interface SseEntry {
  url: string;
  eventNames: readonly string[];
  es: EventSource | null;
  handlers: Set<SseHandler>;
  refCount: number;
  backoffMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

// `EventSource` is undefined in non-browser environments (SSR / Node test
// runners). Fall back to a no-op when missing so unit tests can mock it
// before the module is imported.
type EventSourceCtor = typeof globalThis extends { EventSource: infer E }
  ? E
  : never;
function getEventSourceCtor(): EventSourceCtor | null {
  return typeof EventSource !== "undefined"
    ? (EventSource as unknown as EventSourceCtor)
    : null;
}

export class SseRegistry {
  private entries = new Map<string, SseEntry>();

  subscribe(
    streamKey: string,
    eventNames: readonly string[],
    handler: SseHandler,
  ): () => void {
    const url = STREAM_URLS[streamKey];
    if (!url) {
      throw new Error(`Unknown SSE stream key: ${streamKey}`);
    }

    let entry = this.entries.get(streamKey);
    if (!entry) {
      entry = {
        url,
        eventNames,
        es: null,
        handlers: new Set(),
        refCount: 0,
        backoffMs: INITIAL_BACKOFF_MS,
        reconnectTimer: null,
      };
      this.entries.set(streamKey, entry);
      this.openConnection(streamKey, entry);
    }

    entry.handlers.add(handler);
    entry.refCount += 1;

    return () => this.unsubscribe(streamKey, handler);
  }

  private unsubscribe(streamKey: string, handler: SseHandler): void {
    const entry = this.entries.get(streamKey);
    if (!entry) return;
    if (!entry.handlers.delete(handler)) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      this.closeConnection(entry);
      this.entries.delete(streamKey);
    }
  }

  private openConnection(streamKey: string, entry: SseEntry): void {
    const Ctor = getEventSourceCtor();
    if (!Ctor) return;
    const es = new (Ctor as { new (url: string): EventSource })(entry.url);
    entry.es = es;

    const dispatch = (eventName: string) => (e: MessageEvent) => {
      let payload: unknown;
      try {
        payload = JSON.parse(e.data as string);
      } catch {
        return;
      }
      // Snapshot handlers to a stable list — handlers may unsubscribe
      // synchronously inside the callback, mutating the live Set.
      const snapshot = Array.from(entry.handlers);
      for (const h of snapshot) {
        try {
          h(eventName, payload);
        } catch {
          /* swallow per-handler errors */
        }
      }
    };

    for (const name of entry.eventNames) {
      es.addEventListener(name, dispatch(name));
    }

    es.onopen = () => {
      entry.backoffMs = INITIAL_BACKOFF_MS;
    };

    es.onerror = () => {
      // EventSource auto-reconnects in some browsers but not consistently;
      // explicitly close + schedule with our own backoff for predictable
      // behaviour and to avoid duplicate listeners after a transient blip.
      this.scheduleReconnect(streamKey, entry);
    };
  }

  private closeConnection(entry: SseEntry): void {
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    if (entry.es) {
      entry.es.close();
      entry.es = null;
    }
  }

  private scheduleReconnect(streamKey: string, entry: SseEntry): void {
    if (entry.reconnectTimer) return;
    if (entry.es) {
      entry.es.close();
      entry.es = null;
    }
    const delay = entry.backoffMs;
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      // Bail if everyone unsubscribed while we waited.
      if (!this.entries.has(streamKey) || entry.refCount <= 0) return;
      this.openConnection(streamKey, entry);
    }, delay);
    entry.backoffMs = Math.min(entry.backoffMs * 2, MAX_BACKOFF_MS);
  }

  // Test-only helpers.
  _hasEntry(streamKey: string): boolean {
    return this.entries.has(streamKey);
  }
  _entryRefCount(streamKey: string): number {
    return this.entries.get(streamKey)?.refCount ?? 0;
  }
}

export const sseRegistry = new SseRegistry();
