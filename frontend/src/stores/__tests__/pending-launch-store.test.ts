import { describe, it, expect, beforeEach, vi } from "vitest";
import { enqueue, consume, subscribe } from "../pending-launch-store";
import type { LaunchSpec } from "../../lib/launch";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpec(target: "embedded" | "popout" = "embedded"): LaunchSpec {
  return {
    projectId: 1,
    cwd: "/tmp/proj",
    providerId: 1,
    providerCommand: "claude\n",
    rows: 1,
    cols: 1,
    target,
    profileId: null,
  };
}

/** Install a simple in-memory localStorage stub. */
function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const fake: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
  };
  vi.stubGlobal("localStorage", fake);
  return store;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pending-launch-store", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  // ─── enqueue / consume ────────────────────────────────────────────────────

  it("write-then-consume returns the spec exactly once", () => {
    const spec = makeSpec("embedded");
    enqueue(spec);
    const first = consume("embedded");
    expect(first).toEqual(spec);
    // Second consume should return null — slot is cleared after first read.
    const second = consume("embedded");
    expect(second).toBeNull();
  });

  it("consume with target mismatch returns null and leaves slot intact", () => {
    const spec = makeSpec("popout");
    enqueue(spec);
    // embedded window tries to consume a popout spec — mismatch.
    const mismatch = consume("embedded");
    expect(mismatch).toBeNull();
    // Slot is still there for the popout window.
    const correct = consume("popout");
    expect(correct).toEqual(spec);
  });

  it("consume returns null when slot is empty", () => {
    expect(consume("embedded")).toBeNull();
  });

  it("consume clears corrupted JSON and returns null", () => {
    localStorage.setItem("codenest.pendingLaunch", "{not json");
    expect(consume("embedded")).toBeNull();
    // Slot should be cleared after corruption is detected.
    expect(localStorage.getItem("codenest.pendingLaunch")).toBeNull();
  });

  it("enqueue overwrites a previously queued spec", () => {
    const spec1 = makeSpec("embedded");
    const spec2 = { ...makeSpec("embedded"), cwd: "/other/path" };
    enqueue(spec1);
    enqueue(spec2);
    const result = consume("embedded");
    expect(result?.cwd).toBe("/other/path");
  });

  // ─── subscribe ────────────────────────────────────────────────────────────

  it("cross-tab broadcast subscriber fires once for matching target", () => {
    const cb = vi.fn();
    const unsub = subscribe("embedded", cb);

    const spec = makeSpec("embedded");

    // Simulate a storage event fired from another window writing the spec.
    const event = new StorageEvent("storage", {
      key: "codenest.pendingLaunch",
      newValue: JSON.stringify(spec),
      oldValue: null,
    });
    window.dispatchEvent(event);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(spec);

    unsub();
  });

  it("subscriber does not fire for mismatched target", () => {
    const cb = vi.fn();
    const unsub = subscribe("popout", cb);

    // Emit a spec meant for "embedded" — subscriber is for "popout".
    const event = new StorageEvent("storage", {
      key: "codenest.pendingLaunch",
      newValue: JSON.stringify(makeSpec("embedded")),
      oldValue: null,
    });
    window.dispatchEvent(event);

    expect(cb).not.toHaveBeenCalled();
    unsub();
  });

  it("subscriber does not fire when newValue is null (slot cleared)", () => {
    const cb = vi.fn();
    const unsub = subscribe("embedded", cb);

    const event = new StorageEvent("storage", {
      key: "codenest.pendingLaunch",
      newValue: null,
      oldValue: JSON.stringify(makeSpec("embedded")),
    });
    window.dispatchEvent(event);

    expect(cb).not.toHaveBeenCalled();
    unsub();
  });

  it("subscriber does not fire for unrelated storage keys", () => {
    const cb = vi.fn();
    const unsub = subscribe("embedded", cb);

    const event = new StorageEvent("storage", {
      key: "some.other.key",
      newValue: JSON.stringify(makeSpec("embedded")),
    });
    window.dispatchEvent(event);

    expect(cb).not.toHaveBeenCalled();
    unsub();
  });

  it("unsubscribed listener does not fire", () => {
    const cb = vi.fn();
    const unsub = subscribe("embedded", cb);
    unsub();

    const event = new StorageEvent("storage", {
      key: "codenest.pendingLaunch",
      newValue: JSON.stringify(makeSpec("embedded")),
    });
    window.dispatchEvent(event);

    expect(cb).not.toHaveBeenCalled();
  });
});
