import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { WorkspaceNavigator } from "../workspace-navigator";
import { useExplorerStore } from "../../../stores/explorer-store";
import type { Project } from "../../../lib/api";
import type {
  DirListing,
  FileIndex,
  GitRootStatus,
  WatchState,
} from "../../../lib/ipc";

// ---------------------------------------------------------------------------
// Mocks — following the factory pattern at
// components/terminal/__tests__/terminal-tab-persistence.test.tsx:50-113.
// Every export the render subtree reads must be listed, because a vi.mock
// factory replaces the module wholesale for every importer in this file's
// graph (`use-explorer-sync.ts`, `use-find-actions.ts`, `explorer-tree.tsx`,
// `changed-list.tsx`, `stores/terminal-store.ts` all resolve to these same
// mocked modules).
//
// This project has no `@testing-library/jest-dom` — assertions below use
// plain Vitest matchers (`.toBeNull()`, `.toContain()`, textContent checks)
// rather than `toBeInTheDocument()`, matching every other test file here.
// ---------------------------------------------------------------------------

const {
  mockGetWorkspacePath,
  mockGitStatusForRoots,
  mockFsWatchSetRoots,
  mockFsBuildFileIndex,
  mockFsListDir,
  eventHandlers,
} = vi.hoisted(() => ({
  mockGetWorkspacePath: vi.fn(async () => "/repo/workspace"),
  mockGitStatusForRoots: vi.fn<(paths: string[]) => Promise<GitRootStatus[]>>(
    async () => [],
  ),
  mockFsWatchSetRoots: vi.fn<(roots: string[]) => Promise<WatchState>>(
    async () => baseWatchState(),
  ),
  mockFsBuildFileIndex: vi.fn<
    (root: string, maxFiles?: number) => Promise<FileIndex>
  >(async () => ({
    root: "/repo",
    files: [],
    count: 0,
    truncated: false,
    source: "git",
    elapsedMs: 1,
    skippedNonUtf8: 0,
  })),
  mockFsListDir: vi.fn<(path: string) => Promise<DirListing>>(async () => ({
    path: "/repo",
    entries: [],
    truncated: false,
  })),
  // F1 regression guard: the real `useEvent` (`lib/ipc.ts`) subscribes
  // inside a `useEffect` keyed only on the event name, so it freezes
  // whatever handler closure existed at first mount forever. A no-op mock
  // hides that entirely — this map + the `useEvent` mock below reproduce
  // the real freeze semantics instead, so a test can drive a batch through
  // the actual (possibly-stale-closure) handler `use-explorer-sync.ts`
  // registered.
  eventHandlers: new Map<string, (payload: unknown) => void>(),
}));

function baseWatchState(overrides: Partial<WatchState> = {}): WatchState {
  return {
    backend: "fsevent",
    watchedRoots: [],
    rootCount: 0,
    maxRoots: 8,
    rejected: [],
    degraded: false,
    indexedFileCount: 0,
    indexedRootCount: 0,
    batchesEmitted: 0,
    changesEmitted: 0,
    changesDropped: 0,
    debounceMs: 150,
    excludedDirs: [],
    ...overrides,
  };
}

vi.mock("../../../lib/api", () => ({
  useProjects: () => ({ data: mockProjects, isLoading: false, error: null }),
}));

// Declared as an async factory so `useEffect` can be obtained via a dynamic
// `import("react")` inside the factory body — referencing the test file's
// top-level React import directly would hit Vitest's "no out-of-scope
// variables in a mock factory" hoisting restriction (same technique as
// `terminal-tab-persistence.test.tsx:68-73`).
vi.mock("../../../lib/ipc", async () => {
  const { useEffect } = await import("react");
  return {
    fsListDir: mockFsListDir,
    fsBuildFileIndex: mockFsBuildFileIndex,
    gitStatusForRoots: mockGitStatusForRoots,
    fsWatchSetRoots: mockFsWatchSetRoots,
    fsWatchStatus: vi.fn(async () => baseWatchState()),
    getWorkspacePath: mockGetWorkspacePath,
    openInEditor: vi.fn(async () => undefined),
    revealInFinder: vi.fn(async () => undefined),
    sendTerminalInput: vi.fn(async () => undefined),
    openTerminal: vi.fn(async () => ({ id: "pty-mock" })),
    closeTerminal: vi.fn(async () => undefined),
    // Mirrors the real `useEvent`'s freeze semantics instead of being a
    // permissive no-op — see the `eventHandlers` comment above.
    useEvent: (event: string, handler: (payload: unknown) => void): void => {
      useEffect(() => {
        eventHandlers.set(event, handler);
        return () => {
          eventHandlers.delete(event);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [event]);
    },
    FS_CHANGE_BATCH_EVENT: "fs_change_batch",
  };
});

function project(
  overrides: Partial<Project> & { id: number; name: string },
): Project {
  return {
    description: null,
    tech_stack: null,
    status: "active",
    path: `/repo/${overrides.name}`,
    root_path: `/repo/${overrides.name}`,
    is_workspace: 0,
    is_active: 1,
    default_provider_id: null,
    profile_id: null,
    created_at: "2026-01-01T00:00:00",
    ...overrides,
  };
}

let mockProjects: Project[] = [];

function resetExplorerStore(): void {
  useExplorerStore.setState({
    mode: "ws",
    lastTreeMode: "ws",
    query: "",
    trees: {},
    expanded: {},
    selectedPath: null,
    watch: null,
    gitByRootId: {},
    indexByRootId: {},
    panelWidth: 262,
    panelCollapsed: false,
  });
}

beforeEach(() => {
  // `resetExplorerStore` below is what actually isolates tests; localStorage
  // itself is left alone (this environment's `--localstorage-file` warning
  // means clear()/removeItem() are unreliable here, and every persistence
  // read/write in `explorer-store.ts` is already try/catch-guarded).
  resetExplorerStore();
  mockProjects = [
    project({ id: 1, name: "codenest-app" }),
    project({ id: 2, name: "miragold" }),
  ];
  mockGetWorkspacePath.mockClear().mockResolvedValue("/repo/workspace");
  mockGitStatusForRoots.mockClear().mockResolvedValue([]);
  mockFsWatchSetRoots.mockClear().mockResolvedValue(baseWatchState());
  mockFsBuildFileIndex.mockClear();
  mockFsListDir.mockClear();
  eventHandlers.clear();
});

afterEach(() => {
  cleanup();
});

/** Find the `role="treeitem"` row whose text starts with `label` — the
 *  root row's own name, distinguishing it from any nested row. */
function findRootRow(label: string): HTMLElement {
  const row = screen
    .getAllByRole("treeitem")
    .find((el) => el.textContent?.includes(label));
  if (!row) throw new Error(`no treeitem row found for "${label}"`);
  return row;
}

describe("WorkspaceNavigator", () => {
  it("renders three mode chips with live sublabels", async () => {
    render(<WorkspaceNavigator />);

    // Two projects + the virtual Shared root, once getWorkspacePath resolves.
    await waitFor(() => {
      const wsTab = screen.getByRole("tab", { name: /Workspace/ });
      within(wsTab).getByText("3 roots");
    });

    const projTab = screen.getByRole("tab", { name: /Project/ });
    within(projTab).getByText("follows pane");
    const chgTab = screen.getByRole("tab", { name: /Changed/ });
    within(chgTab).getByText("git");
  });

  it("clicking a mode chip swaps the tree body", async () => {
    render(<WorkspaceNavigator />);
    await waitFor(() => {
      expect(screen.getByRole("tree", { name: "Workspace" })).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("tab", { name: /Changed/ }));

    expect(screen.getByRole("tree", { name: "Changed" })).not.toBeNull();
    expect(screen.queryByRole("tree", { name: "Workspace" })).toBeNull();
  });

  it("⌘P enters find mode and Escape returns to the previous chip", async () => {
    render(<WorkspaceNavigator />);
    await waitFor(() => {
      expect(screen.getByRole("tree", { name: "Workspace" })).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("tab", { name: /Changed/ }));
    expect(screen.getByRole("tree", { name: "Changed" })).not.toBeNull();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "p",
          metaKey: true,
          bubbles: true,
        }),
      );
    });
    expect(screen.getByRole("tree", { name: "Find" })).not.toBeNull();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    // Returns to Changed, not Workspace — pins lastTreeMode.
    expect(screen.getByRole("tree", { name: "Changed" })).not.toBeNull();
    expect(screen.queryByRole("tree", { name: "Workspace" })).toBeNull();
  });

  it("the footer states the watcher's real backend, counts and exclusion list", async () => {
    mockFsWatchSetRoots.mockResolvedValue(
      baseWatchState({
        backend: "fsevent",
        rootCount: 3,
        indexedFileCount: 1284,
        excludedDirs: [".git", "node_modules"],
      }),
    );

    const { container } = render(<WorkspaceNavigator />);

    await waitFor(() => {
      expect(container.textContent).toContain("FSEvents");
    });
    expect(container.textContent).toContain("1,284");
    expect(container.textContent).toContain("watching 3 roots");
    expect(container.textContent).toContain(".git");
    expect(container.textContent).toContain("node_modules");
  });

  it("shows no excluded-dirs line when the watcher reports none", async () => {
    mockFsWatchSetRoots.mockResolvedValue(baseWatchState({ excludedDirs: [] }));

    const { container } = render(<WorkspaceNavigator />);

    await waitFor(() => {
      expect(container.textContent).toContain("watching 0 roots");
    });
    expect(container.textContent).not.toContain("node_modules");
    expect(container.textContent).not.toContain(".git");
  });

  it("a clean root says clean", async () => {
    mockGitStatusForRoots.mockResolvedValue([
      {
        root: "/repo/codenest-app",
        repoRoot: "/repo/codenest-app",
        isRepo: true,
        branch: "main",
        detached: false,
        dirty: false,
        ahead: null,
        behind: null,
        files: [],
        truncated: false,
        error: null,
      },
      {
        root: "/repo/miragold",
        repoRoot: "/repo/miragold",
        isRepo: true,
        branch: "main",
        detached: false,
        dirty: false,
        ahead: null,
        behind: null,
        files: [],
        truncated: false,
        error: null,
      },
      {
        root: "/repo/workspace/.claude",
        repoRoot: null,
        isRepo: false,
        branch: null,
        detached: false,
        dirty: false,
        ahead: null,
        behind: null,
        files: [],
        truncated: false,
        error: null,
      },
    ]);

    render(<WorkspaceNavigator />);
    await waitFor(() => {
      expect(screen.getByRole("tree", { name: "Workspace" })).not.toBeNull();
    });
    fireEvent.click(screen.getByRole("tab", { name: /Changed/ }));

    await waitFor(() => {
      expect(screen.getAllByText("clean").length).toBeGreaterThan(0);
    });
  });

  it("Workspace mode shows each root's branch and dirty marker on first paint, from a single unconditional call", async () => {
    mockGitStatusForRoots.mockResolvedValue([
      {
        root: "/repo/codenest-app",
        repoRoot: "/repo/codenest-app",
        isRepo: true,
        branch: "main",
        detached: false,
        dirty: true,
        ahead: null,
        behind: null,
        files: [],
        truncated: false,
        error: null,
      },
      {
        root: "/repo/miragold",
        repoRoot: "/repo/miragold",
        isRepo: true,
        branch: "feature/x",
        detached: false,
        dirty: false,
        ahead: null,
        behind: null,
        files: [],
        truncated: false,
        error: null,
      },
      {
        root: "/repo/workspace/.claude",
        repoRoot: null,
        isRepo: false,
        branch: null,
        detached: false,
        dirty: false,
        ahead: null,
        behind: null,
        files: [],
        truncated: false,
        error: null,
      },
    ]);

    render(<WorkspaceNavigator />);

    await waitFor(() => {
      const row = findRootRow("codenest-app");
      expect(row.textContent).toContain("main");
    });

    // Dirty marker on the dirty root only.
    expect(findRootRow("codenest-app").textContent).toContain("*");
    expect(findRootRow("miragold").textContent?.includes("*")).toBe(false);
    // The non-repo shared root renders no branch node at all — no guessed
    // "main", no placeholder dash.
    const sharedRow = findRootRow("Agents & skills");
    expect(sharedRow.textContent).not.toContain("main");
    expect(sharedRow.textContent).not.toContain("—");

    expect(mockGitStatusForRoots).toHaveBeenCalledTimes(1);
    expect(mockGitStatusForRoots.mock.calls[0]?.[0]).toEqual([
      "/repo/codenest-app",
      "/repo/miragold",
      "/repo/workspace/.claude",
    ]);
  });

  it("shows no branch placeholder while git status is in flight", async () => {
    mockGitStatusForRoots.mockReturnValue(new Promise(() => undefined));

    render(<WorkspaceNavigator />);

    await waitFor(() => {
      expect(findRootRow("codenest-app")).not.toBeNull();
    });
    const row = findRootRow("codenest-app");
    expect(row.textContent).not.toContain("—");
    expect(row.textContent).not.toContain("…");
    expect(row.textContent).not.toContain("main");
  });

  // F1 regression guard: `use-explorer-sync.ts`'s `fs_change_batch` handler
  // used to schedule its debounced git refresh by calling `runGitRefresh`
  // directly — a closure `useEvent` froze at first mount, when `roots` was
  // still empty (workspace path resolution hadn't settled yet). That made
  // the debounced refresh a permanent no-op: it silently called the stale,
  // empty-roots version forever, so branch/dirty markers and the Changed
  // list never picked up a real filesystem change. A no-op `useEvent` mock
  // hid this completely (the handler was never invoked at all) — this test
  // reproduces the real freeze semantics (see `eventHandlers` above) and
  // actually drives a batch through the registered handler.
  it("a filesystem change batch refreshes git status through the live handler, not a closure frozen at mount", async () => {
    render(<WorkspaceNavigator />);

    // Let the mount-time cycle (item 4 in use-explorer-sync.ts) settle
    // before clearing the mock, so what's left afterwards can only be the
    // response to the batch fired below.
    await waitFor(() => {
      expect(mockGitStatusForRoots).toHaveBeenCalled();
    });
    mockGitStatusForRoots.mockClear();

    const handler = eventHandlers.get("fs_change_batch");
    expect(handler).toBeDefined();

    act(() => {
      handler?.({
        seq: 1,
        rescan: false,
        dropped: 0,
        changes: [
          {
            kind: "modified",
            root: "/repo/codenest-app",
            path: "/repo/codenest-app/a.ts",
            fromPath: null,
            isDir: false,
          },
        ],
      });
    });

    // The debounce is 400ms (GIT_REFRESH_DEBOUNCE_MS) — before the fix this
    // never fired at all, so a generous waitFor timeout is the point, not
    // a risk of a false pass.
    await waitFor(
      () => {
        expect(mockGitStatusForRoots).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );
    // Called with the full, resolved root set — proof it ran the live
    // `runGitRefresh` (closed over the settled `roots`), not a frozen
    // closure that would have called it with `[]` or not at all.
    expect(mockGitStatusForRoots.mock.calls.at(-1)?.[0]).toEqual([
      "/repo/codenest-app",
      "/repo/miragold",
      "/repo/workspace/.claude",
    ]);
  });
});
