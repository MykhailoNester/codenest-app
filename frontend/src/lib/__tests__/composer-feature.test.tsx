import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { readComposerFeature, useComposerFeature } from "../composer-feature";
import { FEATURE_CACHE_KEY, FEATURE_CACHE_EVENT } from "../nav-items";

// This test environment's global `localStorage` is not a full `Storage`
// (Node's built-in implementation lacks `.clear()` here) — the same reason
// `terminal-store.test.ts` stubs a fake one instead of using the raw global.
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

describe("readComposerFeature", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  it("is false with no cache, matching FEATURE_DEFAULTS", () => {
    expect(readComposerFeature()).toBe(false);
  });

  it("is true when the cache says so", () => {
    localStorage.setItem(FEATURE_CACHE_KEY, JSON.stringify({ composer: true }));
    expect(readComposerFeature()).toBe(true);
  });

  it("is false when the cache explicitly says so", () => {
    localStorage.setItem(FEATURE_CACHE_KEY, JSON.stringify({ composer: false }));
    expect(readComposerFeature()).toBe(false);
  });

  it("falls back to the default for malformed JSON", () => {
    localStorage.setItem(FEATURE_CACHE_KEY, "{not json");
    expect(readComposerFeature()).toBe(false);
  });

  it("falls back to the default for a non-boolean value", () => {
    localStorage.setItem(FEATURE_CACHE_KEY, JSON.stringify({ composer: "yes" }));
    expect(readComposerFeature()).toBe(false);
  });

  it("falls back to the default when localStorage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
    });
    expect(readComposerFeature()).toBe(false);
  });
});

function Probe() {
  const enabled = useComposerFeature();
  return <span data-testid="probe">{String(enabled)}</span>;
}

describe("useComposerFeature", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  // `afterEach(cleanup)` is mandatory: `frontend/vite.config.ts` does not set
  // `globals: true`, so Testing Library's auto-cleanup never registers.
  afterEach(() => {
    cleanup();
  });

  it("renders with no QueryClientProvider", () => {
    // The regression guard: this hook must never need react-query.
    expect(() => render(<Probe />)).not.toThrow();
  });

  it("re-renders on a dispatched FEATURE_CACHE_EVENT", () => {
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("false");

    act(() => {
      localStorage.setItem(FEATURE_CACHE_KEY, JSON.stringify({ composer: true }));
      window.dispatchEvent(new Event(FEATURE_CACHE_EVENT));
    });

    expect(screen.getByTestId("probe").textContent).toBe("true");
  });

  it("re-renders on a storage event", () => {
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("false");

    act(() => {
      localStorage.setItem(FEATURE_CACHE_KEY, JSON.stringify({ composer: true }));
      window.dispatchEvent(new Event("storage"));
    });

    expect(screen.getByTestId("probe").textContent).toBe("true");
  });
});
