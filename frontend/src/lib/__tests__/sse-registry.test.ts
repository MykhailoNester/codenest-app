import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock EventSource before importing the registry so the module-level
// singleton uses our fake constructor.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  listeners = new Map<string, (e: MessageEvent) => void>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, handler: (e: MessageEvent) => void): void {
    this.listeners.set(name, handler);
  }
  close(): void {
    this.closed = true;
  }
  dispatch(name: string, data: unknown): void {
    const h = this.listeners.get(name);
    if (h) h(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
  triggerError(): void {
    if (this.onerror) this.onerror();
  }
  triggerOpen(): void {
    if (this.onopen) this.onopen();
  }
}

describe("SseRegistry", () => {
  let SseRegistry: typeof import("../sse-registry").SseRegistry;
  let SSE_EVENT_NAMES: typeof import("../sse-registry").SSE_EVENT_NAMES;

  beforeEach(async () => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    (
      globalThis as unknown as { EventSource: typeof FakeEventSource }
    ).EventSource = FakeEventSource;
    vi.resetModules();
    const mod = await import("../sse-registry");
    SseRegistry = mod.SseRegistry;
    SSE_EVENT_NAMES = mod.SSE_EVENT_NAMES;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens exactly one EventSource for two subscribers on the same key", () => {
    const reg = new SseRegistry();
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = reg.subscribe("agents", SSE_EVENT_NAMES, a);
    const unsubB = reg.subscribe("agents", SSE_EVENT_NAMES, b);

    expect(FakeEventSource.instances.length).toBe(1);
    expect(reg._entryRefCount("agents")).toBe(2);

    // Both handlers receive events.
    FakeEventSource.instances[0]!.dispatch("update", { hello: "world" });
    expect(a).toHaveBeenCalledWith("update", { hello: "world" });
    expect(b).toHaveBeenCalledWith("update", { hello: "world" });

    unsubA();
    unsubB();
  });

  it("closes the connection only after the last subscriber unsubscribes", () => {
    const reg = new SseRegistry();
    const unsubA = reg.subscribe("agents", SSE_EVENT_NAMES, () => {});
    const unsubB = reg.subscribe("agents", SSE_EVENT_NAMES, () => {});
    const es = FakeEventSource.instances[0]!;

    unsubA();
    expect(es.closed).toBe(false);
    expect(reg._hasEntry("agents")).toBe(true);

    unsubB();
    expect(es.closed).toBe(true);
    expect(reg._hasEntry("agents")).toBe(false);
  });

  it("reconnects after onerror with exponential backoff", () => {
    const reg = new SseRegistry();
    reg.subscribe("agents", SSE_EVENT_NAMES, () => {});
    expect(FakeEventSource.instances.length).toBe(1);

    // First error → schedule reconnect after 1000 ms.
    FakeEventSource.instances[0]!.triggerError();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances.length).toBe(2);

    // Second error → backoff doubles to 2000 ms.
    FakeEventSource.instances[1]!.triggerError();
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.instances.length).toBe(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances.length).toBe(3);

    // Successful onopen resets backoff to 1000 ms.
    FakeEventSource.instances[2]!.triggerOpen();
    FakeEventSource.instances[2]!.triggerError();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances.length).toBe(4);
  });
});
