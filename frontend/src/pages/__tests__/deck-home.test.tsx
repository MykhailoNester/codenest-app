/**
 * Deck home — the page at `/` (#282).
 *
 * Three claims, and nothing about layout:
 *
 *   * **A figure the app cannot measure is an em dash, never 0.** Inherited
 *     from Mission Control and one careless `?? 0` away from being lost. It
 *     covers the unbuilt lanes *and* the not-yet-answered ones: "running" is a
 *     dash until the session stream's snapshot arrives, because an empty list
 *     before it is not a reading of zero sessions.
 *   * **"Since you last looked" splits the changed list at the stored mark.**
 *     Newer above the rule, older below, and the rule itself only drawn when
 *     there is a mark to draw it at — a first visit must not claim that ten
 *     things happened while you were away.
 *   * **The page says the mark is per-browser.** It is `localStorage`, not
 *     sidecar state, and a divider that implies a server-side last-seen would
 *     be the page overstating what it knows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { DeckHomePage } from "../deck-home";
import type { ActivityEntry, AttentionQueue } from "../../lib/api";

const { mockUseAttention, mockUseDashboard, mockUseDailySpend, mockSSE } =
  vi.hoisted(() => ({
    mockUseAttention: vi.fn(),
    mockUseDashboard: vi.fn(),
    mockUseDailySpend: vi.fn(),
    mockSSE: vi.fn(),
  }));

vi.mock("../../lib/api", () => ({
  useAttention: (...args: unknown[]) => mockUseAttention(...args),
  useDashboard: () => mockUseDashboard(),
  useDailySpend: () => mockUseDailySpend(),
  useSidecarSSE: (key: string, cb: unknown) => mockSSE(key, cb),
}));

// The chrome has its own tests; this file is about the page's claims.
vi.mock("../../components/deck/deck-shell", () => ({
  DeckShell: ({ children, crumb }: { children: ReactNode; crumb?: string }) => (
    <div>
      <span>{crumb}</span>
      {children}
    </div>
  ),
}));

const LAST_LOOKED_KEY = "codenest.deck.last-looked";

/**
 * The same fake the terminal-store and nav-group tests install: jsdom's own
 * `localStorage` in this setup has no `clear`, so a test that assumes the real
 * Storage API fails for a reason unrelated to what it is testing.
 */
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

let storage: Map<string, string>;

function emptyQueue(): AttentionQueue {
  return {
    items: [],
    counts: {
      blocking: 0,
      stalled: 0,
      queued: 0,
      open: 0,
      muted: 0,
      resolved_today: 0,
      resolved_today_avg_seconds: null,
    },
  };
}

/** Naive UTC, the way the sidecar emits every timestamp. */
function naiveUtc(msAgo: number): string {
  return new Date(Date.now() - msAgo)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");
}

function change(id: number, msAgo: number): ActivityEntry {
  return {
    id,
    entity_type: "task",
    entity_id: 200 + id,
    action: "status_changed",
    old_value: "todo",
    new_value: `moved-${id}`,
    actor: "orion-ops",
    created_at: naiveUtc(msAgo),
  };
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <DeckHomePage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  storage = installLocalStorage();
  mockUseAttention.mockReturnValue({ data: emptyQueue(), isLoading: false });
  mockUseDashboard.mockReturnValue({ data: { recent_activity: [] } });
  mockUseDailySpend.mockReturnValue({ data: { cost_usd: 7.42 } });
  mockSSE.mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the honesty rule: a dash, never a zero", () => {
  it("dashes the lanes that do not exist and names each one", () => {
    renderPage();
    for (const label of [
      /plan headroom · no ceiling in plan usage/i,
      /tool failures · needs the otlp receiver/i,
    ]) {
      const tile = screen.getByText(label).parentElement;
      expect(tile?.textContent).toContain("—");
      expect(tile?.querySelector(".v")?.textContent).not.toMatch(/\d/);
    }
  });

  it("dashes 'running' until the session snapshot has actually arrived", () => {
    // No SSE event delivered: the stream has not answered. Zero would claim it
    // had, and that nothing was running.
    renderPage();
    const tile = screen.getByText(/running · waiting for the stream/i).parentElement;
    expect(tile?.querySelector(".v")?.textContent).toBe("—");
  });
});

describe("since you last looked", () => {
  it("puts changes newer than the mark above the rule and older ones below", () => {
    storage.set(LAST_LOOKED_KEY, String(Date.now() - 60 * 60_000));
    mockUseDashboard.mockReturnValue({
      data: {
        recent_activity: [change(1, 10 * 60_000), change(2, 5 * 60 * 60_000)],
      },
    });
    renderPage();

    expect(screen.getByText("since you last looked")).toBeTruthy();
    // The grids carry the split in their own labels, so it survives for a
    // screen reader as well as for the eye.
    const above = screen.getByRole("grid", {
      name: "Changed since you last looked",
    });
    const below = screen.getByRole("grid", {
      name: "Changed before you last looked",
    });
    expect(above.textContent).toContain("moved-1");
    expect(above.textContent).not.toContain("moved-2");
    expect(below.textContent).toContain("moved-2");
    expect(screen.getByText("1 new")).toBeTruthy();
  });

  it("draws no rule and claims nothing new on a first visit", () => {
    mockUseDashboard.mockReturnValue({
      data: { recent_activity: [change(1, 10 * 60_000)] },
    });
    renderPage();

    expect(screen.queryByText("since you last looked")).toBeNull();
    expect(screen.queryByRole("grid", { name: /since you last looked/ })).toBeNull();
    expect(screen.getByText("first visit in this browser")).toBeTruthy();
  });

  it("stamps the mark on the way out so leaving counts as having looked", () => {
    const { unmount } = render(
      <MemoryRouter>
        <DeckHomePage />
      </MemoryRouter>,
    );
    expect(storage.get(LAST_LOOKED_KEY)).toBeUndefined();
    unmount();
    expect(Number(storage.get(LAST_LOOKED_KEY))).toBeGreaterThan(0);
  });

  it("says out loud that the mark is per-browser, not server-side", () => {
    renderPage();
    expect(
      screen.getByText(/remembered in this browser only/i),
    ).toBeTruthy();
    expect(screen.getByText(/no server-side last-seen state yet/i)).toBeTruthy();
  });
});
