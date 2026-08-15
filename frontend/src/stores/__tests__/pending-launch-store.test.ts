import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  enqueue,
  consume,
  subscribe,
  hasPendingPopoutLaunch,
} from "../pending-launch-store";
import { isPaneLaunchSpec, type PaneLaunchSpec } from "../../lib/launch";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePaneSpec(
  target: "embedded" | "popout" = "embedded",
): PaneLaunchSpec {
  return {
    panes: [{ kind: "agent", providerId: 1 }],
    split: "cols",
    target,
  };
}

/** A grid-shaped spec from a pre-#35 build — no `panes` array, so it fails
 *  `isPaneLaunchSpec`. Written as raw JSON (never through `enqueue`, which
 *  now only accepts a `PaneLaunchSpec`) to simulate a slot left over from
 *  before the upgrade. */
function legacyGridSpecJson(target: "embedded" | "popout" = "embedded"): string {
  return JSON.stringify({
    projectId: 1,
    cwd: "/tmp/proj",
    providerId: 1,
    providerCommand: "claude\n",
    rows: 1,
    cols: 1,
    target,
    profileId: null,
  });
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
    const spec = makePaneSpec("embedded");
    enqueue(spec);
    const first = consume("embedded");
    expect(first).toEqual(spec);
    // Second consume should return null — slot is cleared after first read.
    const second = consume("embedded");
    expect(second).toBeNull();
  });

  it("consume with target mismatch returns null and leaves slot intact", () => {
    const spec = makePaneSpec("popout");
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
    const spec1 = makePaneSpec("embedded");
    const spec2: PaneLaunchSpec = {
      ...makePaneSpec("embedded"),
      panes: [{ kind: "shell", cwd: "/other/path" }],
    };
    enqueue(spec1);
    enqueue(spec2);
    const result = consume("embedded");
    expect(result).toEqual(spec2);
  });

  it("a PaneLaunchSpec round-trips through the popout slot and is recognised by isPaneLaunchSpec", () => {
    const spec = makePaneSpec("popout");
    enqueue(spec);
    const result = consume("popout");
    expect(result).toEqual(spec);
    expect(result !== null && isPaneLaunchSpec(result)).toBe(true);
  });

  it("a legacy grid spec is dropped and the slot cleared", () => {
    localStorage.setItem("codenest.pendingLaunch", legacyGridSpecJson("embedded"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(consume("embedded")).toBeNull();
    expect(localStorage.getItem("codenest.pendingLaunch")).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("hasPendingPopoutLaunch is false for a legacy popout spec", () => {
    localStorage.setItem("codenest.pendingLaunch", legacyGridSpecJson("popout"));
    // A legacy grid spec has no `panes` array — hasPendingPopoutLaunch must
    // not report true, or the popout would skip hydrateFromStorage and then
    // consume drops the spec anyway, leaving the window empty.
    expect(hasPendingPopoutLaunch()).toBe(false);
  });

  it("hasPendingPopoutLaunch is true for a real popout PaneLaunchSpec", () => {
    enqueue(makePaneSpec("popout"));
    expect(hasPendingPopoutLaunch()).toBe(true);
  });

  // ─── subscribe ────────────────────────────────────────────────────────────

  it("cross-tab broadcast subscriber fires once for matching target", () => {
    const cb = vi.fn();
    const unsub = subscribe("embedded", cb);

    const spec = makePaneSpec("embedded");

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
      newValue: JSON.stringify(makePaneSpec("embedded")),
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
      oldValue: JSON.stringify(makePaneSpec("embedded")),
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
      newValue: JSON.stringify(makePaneSpec("embedded")),
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
      newValue: JSON.stringify(makePaneSpec("embedded")),
    });
    window.dispatchEvent(event);

    expect(cb).not.toHaveBeenCalled();
  });

  it("subscriber drops a legacy grid spec broadcast and does not invoke the callback", () => {
    const cb = vi.fn();
    const unsub = subscribe("embedded", cb);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const event = new StorageEvent("storage", {
      key: "codenest.pendingLaunch",
      newValue: legacyGridSpecJson("embedded"),
      oldValue: null,
    });
    window.dispatchEvent(event);

    expect(cb).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
    unsub();
  });
});
