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
 *
 * ## Re-homed from the two test files #345 deleted
 *
 * #345 deleted Mission Control and the `ActiveSessions` panel. The assertions
 * below that came from their test files are the ones about behaviour this page
 * now owns, not about the pages that are gone:
 *
 *   * the Needs You preview's limit, its "oldest" figure and its empty copy;
 *   * the board counts and the estimated spend figure;
 *   * the source chip and the compaction marker, carried onto the running list
 *     because nothing else in the app renders either;
 *   * "leaves no trace of the page it replaced", widened to cover Mission
 *     Control as well as the Overview page before it.
 */

// `node:fs` resolves at runtime (vitest runs on node) but not at type level:
// the app's tsconfig carries only `vite/client` types, and adding `node` to it
// so one test can read files would put `process`, `Buffer` and friends in scope
// for every browser module in the app. The gap is named here instead, and the
// two functions used are given their real shapes just below.
// prettier-ignore
// @ts-expect-error -- node builtins are outside this project's type roots
import { readdirSync, readFileSync } from "node:fs";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { DeckHomePage } from "../deck-home";
import type { ActivityEntry, AgentSession, AttentionQueue } from "../../lib/api";

interface DirEntry {
  name: string;
  isDirectory(): boolean;
}

const readdir = readdirSync as (
  dir: string,
  options: { withFileTypes: true },
) => DirEntry[];
const readFile = readFileSync as (path: string, encoding: "utf8") => string;

declare const process: { cwd(): string };

/**
 * `frontend/src`. Vitest's working directory is the vite root (`frontend`), and
 * `import.meta.url` is an `http://` URL under jsdom, so the cwd is the only
 * handle on the tree that resolves.
 */
const SRC_DIR = `${process.cwd()}/src`;

function walk(dir: string): string[] {
  return readdir(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** `grep -rn <needle> frontend/src` — `path:line: text` for each match. */
function grepSrc(needle: string): string[] {
  return walk(SRC_DIR).flatMap((file) =>
    readFile(file, "utf8")
      .split("\n")
      .flatMap((line, i) =>
        line.includes(needle)
          ? [`${file.slice(SRC_DIR.length)}:${i + 1}: ${line.trim()}`]
          : [],
      ),
  );
}

/**
 * The needles are assembled rather than written out, because this file lives
 * under `frontend/src` and `grepSrc` reads it too — spelling a retired name out
 * here would make this test its own match and the criterion unsatisfiable. The
 * prose above says "Mission Control" with a space for the same reason.
 */
const RETIRED = [
  ["overview", "page"].join("-"),
  ["Overview", "Page"].join(""),
  ["mission", "control"].join("-"),
  ["Mission", "ControlPage"].join(""),
];

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

/** The SSE handler the page registers, captured so a test can drive it. */
let emit: ((data: unknown, eventName: string) => void) | null = null;

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

/** A minimal open queue row; only the fields the preview reads matter. */
const baseItem = {
  id: 1,
  kind: "session_stalled",
  severity: "stalled",
  state: "open",
  dedup_key: "session_stalled:s1",
  seen_count: 1,
  title: "Session idle 42m with unfinished work",
  detail: "3 uncommitted files",
  session_id: "s1",
  project_id: 2,
  task_id: null,
  schedule_id: null,
  payload_json: null,
  first_seen_at: "2026-09-10 11:00:00",
  last_seen_at: "2026-09-10 12:00:00",
  resolved_at: null,
  resolution: null,
  muted_until: null,
  pane_id: null,
  session_status: "active",
  project_name: "codenest-app",
};

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 1,
    session_id: "s-1",
    profile: "claude",
    status: "active",
    cwd: "/repo",
    project_id: 1,
    provider_id: null,
    model: "claude-opus-5",
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    project_name: "codenest-app",
    initial_prompt: null,
    current_tool: null,
    total_tool_calls: 0,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    ended_at: null,
    last_event_at: null,
    ...overrides,
  };
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <DeckHomePage />
    </MemoryRouter>,
  );
}

/**
 * Render, then push one session through the captured SSE handler. Inside `act`
 * because the page stores the snapshot in state, and an update dispatched
 * outside `act` never flushes — every assertion would read an empty list rather
 * than the row under test.
 */
function renderWithSession(s: AgentSession): void {
  renderPage();
  act(() => {
    emit?.({ sessions: [s] }, "snapshot");
  });
}

beforeEach(() => {
  storage = installLocalStorage();
  mockUseAttention.mockReturnValue({ data: emptyQueue(), isLoading: false });
  mockUseDashboard.mockReturnValue({ data: { recent_activity: [] } });
  mockUseDailySpend.mockReturnValue({ data: { cost_usd: 7.42 } });
  emit = null;
  mockSSE.mockImplementation(
    (_key: string, cb: (data: unknown, eventName: string) => void) => {
      emit = cb;
    },
  );
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

  // Re-homed. The old page rendered the same rule through a `KpiTile`; a `?? 0`
  // here would print "0 todo · 0 backlog" on first paint and whenever the
  // sidecar is unreachable, which is this page's own doctrine broken on the
  // page that states it. An empty board and an unanswered query look nothing
  // alike to a reader and must not look alike here.
  it("dashes the board counts until the dashboard payload answers", () => {
    const tile = (): HTMLElement | null =>
      screen.getByText(/your board/i).parentElement;
    renderPage();
    expect(tile()?.querySelector(".v")?.textContent).toBe("—");
    expect(screen.getByText(/waiting for the sidecar/i)).toBeTruthy();
  });
});

describe("the figures carried off the retired page", () => {
  it("shows the estimated spend and the board counts", () => {
    mockUseDashboard.mockReturnValue({
      data: {
        recent_activity: [],
        task_counts: {
          backlog: 29,
          todo: 13,
          "in-progress": 2,
          blocked: 0,
          done: 40,
        },
      },
    });
    renderPage();

    expect(screen.getByText("$7.42")).toBeTruthy();
    expect(screen.getByText(/spend today · estimated/i)).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy(); // 13 todo + 29 backlog
    expect(screen.getByText(/13 todo · 29 backlog/)).toBeTruthy();
  });

  it("names the count behind the mean resolution, not just the mean", () => {
    mockUseAttention.mockReturnValue({
      isLoading: false,
      data: {
        ...emptyQueue(),
        counts: { ...emptyQueue().counts, resolved_today: 5 },
      },
    });
    renderPage();
    expect(screen.getByText(/5 resolved today/)).toBeTruthy();
  });
});

describe("needs you preview", () => {
  it("names the 30-second re-check and the hook lane when empty", () => {
    renderPage();
    expect(
      screen.getByText(/re-checks every 30 seconds/i, { exact: false }),
    ).toBeTruthy();
    expect(
      screen.getByText(/blocking permission prompts arrive with the hooks lane/i),
    ).toBeTruthy();
  });

  it("previews at most four items and reports the longest wait", () => {
    const now = Date.now();
    const iso = (msAgo: number): string =>
      new Date(now - msAgo).toISOString().replace("T", " ").replace("Z", "");
    mockUseAttention.mockReturnValue({
      isLoading: false,
      data: {
        ...emptyQueue(),
        counts: { ...emptyQueue().counts, open: 6 },
        // Severity-grouped, oldest-first *within* a group — so the oldest item
        // overall sits in the middle of the list, not at either end.
        items: [1, 2, 3, 4, 5, 6].map((n) => ({
          ...baseItem,
          id: n,
          title: `Item ${n}`,
          first_seen_at: iso(n === 3 ? 3 * 3600_000 : 60_000 * n),
        })),
      },
    });
    renderPage();

    expect(screen.getByText("Item 4")).toBeTruthy();
    expect(screen.queryByText("Item 5")).toBeNull();
    expect(screen.getByText("oldest 3h ago")).toBeTruthy();
  });
});

/**
 * Both carried off `ActiveSessions` with that panel's own test file. The
 * three-way distinction is the part worth pinning, because two of the three
 * states look identical the moment anyone reaches for `?? 0` or `?? ""`:
 *
 *   * a value the scanner found       → render it verbatim
 *   * `null` (scanner has not looked) → "unknown"
 *   * absent (sidecar predates 009)   → "unknown", the same claim
 */
describe("source chip", () => {
  it("renders the raw entrypoint string the scanner found", () => {
    renderWithSession(session({ source_app: "cli", cli_version: "2.1.251" }));
    expect(screen.getByText("cli")).toBeTruthy();
  });

  it("renders a different client's value just as verbatim", () => {
    // Three values exist on this machine and the set is open, so nothing may
    // map a client to a fixed presentation.
    renderWithSession(session({ source_app: "sdk-cli" }));
    expect(screen.getByText("sdk-cli")).toBeTruthy();
  });

  it("says unknown when the scanner has not reached the session (null)", () => {
    renderWithSession(session({ source_app: null }));
    expect(screen.getByText("unknown")).toBeTruthy();
  });

  it("says unknown when the sidecar is too old to send the field at all", () => {
    // A process launched before migration 009 omits the key entirely rather
    // than sending null. Absent and null are the same claim: we do not know.
    const stale = session();
    delete (stale as Partial<AgentSession>).source_app;
    renderWithSession(stale);
    expect(screen.getByText("unknown")).toBeTruthy();
  });

  it("puts the CLI version in the tooltip rather than the chip", () => {
    renderWithSession(session({ source_app: "cli", cli_version: "2.1.251" }));
    expect(screen.getByText("cli").getAttribute("title")).toBe(
      "Started by cli · CLI 2.1.251",
    );
  });
});

describe("compaction marker", () => {
  it("shows the count when the session was compacted", () => {
    renderWithSession(session({ compaction_count: 2 }));
    expect(screen.getByText("compacted ×2")).toBeTruthy();
  });

  it("shows nothing for a scanned session that was never compacted", () => {
    // 0 is a real measurement here, but a "compacted ×0" badge is noise on
    // every healthy row — the marker earns its place only when it fired.
    renderWithSession(session({ compaction_count: 0 }));
    expect(screen.queryByText(/compacted/)).toBeNull();
  });

  it("shows nothing when the field is absent or null", () => {
    renderWithSession(session({ compaction_count: null }));
    expect(screen.queryByText(/compacted/)).toBeNull();
  });

  it("names the peak context in the tooltip when one was recorded", () => {
    renderWithSession(
      session({ compaction_count: 1, context_peak_tokens: 214_000 }),
    );
    expect(screen.getByText("compacted ×1").getAttribute("title")).toBe(
      "Peak context 214,000 tokens before compaction",
    );
  });
});

describe("the pages this one replaced", () => {
  it("leaves no trace of either of them in frontend/src", () => {
    for (const needle of RETIRED) {
      const hits = grepSrc(needle);
      expect(hits, hits.join("\n")).toHaveLength(0);
    }
  });
});

describe("in progress (#272 — folded off pages/in-progress.tsx)", () => {
  it("lists what is being worked on, with the started date that page carried", () => {
    mockUseDashboard.mockReturnValue({
      data: {
        recent_activity: [],
        in_progress_tasks: [
          {
            id: 12,
            title: "Ship the migration",
            project_name: "codenest",
            assignee_name: "Orion",
            priority: "high",
            started_date: "2026-09-30",
          },
        ],
      },
    });
    renderPage();

    const grid = screen.getByRole("grid", { name: "In progress" });
    expect(grid.textContent).toContain("Ship the migration");
    expect(grid.textContent).toContain("codenest");
    // The one column Work's task line does not carry, which is why the fold
    // put this group here rather than only on the board.
    expect(grid.textContent).toContain("2026-09-30");
  });

  it("says nothing is being worked on rather than drawing an empty grid", () => {
    mockUseDashboard.mockReturnValue({
      data: { recent_activity: [], in_progress_tasks: [] },
    });
    renderPage();
    expect(screen.getByText("Nothing is being worked on.")).toBeTruthy();
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
