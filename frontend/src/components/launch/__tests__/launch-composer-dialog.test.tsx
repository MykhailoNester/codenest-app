/**
 * launch-composer-dialog.test.tsx
 *
 * The wiring the plan for task #35 adds: `LaunchComposerDialog` maps a
 * `LaunchSeed` onto `LaunchComposer`'s seed props and, on `onLaunch`, turns
 * the plan into a `PaneLaunchSpec` and actually launches it. `LaunchComposer`
 * itself is exercised in depth by `launch-composer.test.tsx`; this file's job
 * is the run-the-launch half plus the "Source no longer exists" branch and
 * the shared entry-point button.
 *
 * `applyPaneLayout` is replaced on the real `useTerminalStore` (the pattern
 * `pages/__tests__/terminal-window-root.test.tsx` already uses) rather than
 * exercised end to end — this file's job is to prove the *spec* handed to
 * it, not to re-open a PTY (covered by `terminal-store-pane-layout.test.ts`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LaunchComposerDialog } from "../launch-composer-dialog";
import { LaunchFromSourceButton } from "../launch-from-source-button";
import { useAgentCatalogStore } from "../../../stores/agent-catalog-store";
import {
  useTerminalStore,
  type ApplyPaneLayoutResult,
} from "../../../stores/terminal-store";
import * as pendingLaunchStore from "../../../stores/pending-launch-store";
import { TERMINAL_ROUTE } from "../../../lib/nav-items";
import type { LaunchSeed } from "../../../lib/launch-seed";
import type { PaneLaunchSpec } from "../../../lib/launch";
import { LAUNCH_DEFAULTS_KEY } from "../../../lib/launch-defaults";

const {
  mockUseProjects,
  mockUseLookups,
  mockUseLaunchPresets,
  mockUseCreateLaunchPreset,
  mockUseDeleteLaunchPreset,
  mockUseUpsertLaunchOverride,
  mockNavigate,
  mockPathsExist,
  mockOpenTerminalsWindow,
  mockUseLaunchSeed,
} = vi.hoisted(() => ({
  mockUseProjects: vi.fn(),
  mockUseLookups: vi.fn(),
  mockUseLaunchPresets: vi.fn(),
  mockUseCreateLaunchPreset: vi.fn(),
  mockUseDeleteLaunchPreset: vi.fn(),
  mockUseUpsertLaunchOverride: vi.fn(),
  mockNavigate: vi.fn(),
  mockPathsExist: vi.fn(),
  mockOpenTerminalsWindow: vi.fn(),
  mockUseLaunchSeed: vi.fn(),
}));

vi.mock("../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api")>();
  return {
    ...actual,
    useProjects: () => mockUseProjects(),
    useLookups: () => mockUseLookups(),
    useLaunchPresets: () => mockUseLaunchPresets(),
    useCreateLaunchPreset: () => mockUseCreateLaunchPreset(),
    useDeleteLaunchPreset: () => mockUseDeleteLaunchPreset(),
    useUpsertLaunchOverride: () => mockUseUpsertLaunchOverride(),
  };
});

vi.mock("../../../lib/launch-seed", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/launch-seed")>();
  return { ...actual, useLaunchSeed: () => mockUseLaunchSeed() };
});

vi.mock("../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/ipc")>();
  return {
    ...actual,
    pathsExist: (paths: string[]) => mockPathsExist(paths),
    openTerminalsWindow: () => mockOpenTerminalsWindow(),
  };
});

vi.mock("react-router-dom", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

interface TestProject {
  id: number;
  name: string;
  path: string | null;
}

function testProject(overrides: Partial<TestProject> = {}): TestProject {
  return { id: 1, name: "codenest", path: "/repo/codenest", ...overrides };
}

function seed(overrides: Partial<LaunchSeed> = {}): LaunchSeed {
  return {
    source: { kind: "task", id: 1, title: "Fix the thing", url: "/tasks/1" },
    project: { id: 1, name: "codenest", path: "/repo/codenest" },
    prompt: "You are working on task #1: Fix the thing",
    sections: [],
    provider_id: 1,
    model: "opus",
    rows: 1,
    cols: 1,
    target: "embedded",
    profile_id: null,
    extra_args: null,
    prompt_fanout: "primary",
    has_override: false,
    ...overrides,
  };
}

function cmdEnter(): void {
  fireEvent.keyDown(window, { key: "Enter", metaKey: true });
}

/** A plain `Map`-backed stub — jsdom's own `localStorage` collides with
 *  Node's `--localstorage-file` implementation in this repo's test runner,
 *  the same reason every other file that touches `localStorage` stubs one
 *  instead of using the real global. */
function installLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
  });
}

let upsertOverrideMutateAsync: ReturnType<typeof vi.fn>;
const applyPaneLayoutMock = vi.fn<
  (spec: PaneLaunchSpec) => Promise<ApplyPaneLayoutResult>
>(async () => ({ openedCount: 1, failedCount: 0 }));

beforeEach(() => {
  installLocalStorage();

  mockUseProjects.mockReturnValue({ data: [testProject()] });
  mockUseLookups.mockReturnValue({
    data: { profiles: [{ id: 9, name: "Work" }] },
  });
  mockUseLaunchPresets.mockReturnValue({ data: [] });
  mockUseCreateLaunchPreset.mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  });
  mockUseDeleteLaunchPreset.mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  });

  upsertOverrideMutateAsync = vi.fn().mockResolvedValue({});
  mockUseUpsertLaunchOverride.mockReturnValue({
    mutateAsync: upsertOverrideMutateAsync,
  });

  mockPathsExist.mockResolvedValue([
    { path: "/repo/codenest", exists: true, is_dir: true },
  ]);
  mockOpenTerminalsWindow.mockResolvedValue(undefined);
  mockNavigate.mockClear();

  useAgentCatalogStore.setState({
    providers: [
      {
        id: 1,
        name: "anthropic",
        displayName: "Anthropic",
        command: "claude {session_id}",
        env: {},
        models: [],
        defaultModel: "opus",
        color: null,
      },
    ],
    loaded: true,
    loading: false,
    lastUsed: { providerId: null, model: null },
  });

  applyPaneLayoutMock.mockClear();
  useTerminalStore.setState({ applyPaneLayout: applyPaneLayoutMock });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LaunchComposerDialog — seeding", () => {
  it("a 2×2 seed opens the composer with four agent panes and the source ref", () => {
    render(
      <LaunchComposerDialog
        open
        onClose={vi.fn()}
        source={{ kind: "task", id: 1 }}
        seed={seed({ rows: 2, cols: 2 })}
      />,
    );

    expect(document.querySelectorAll(".lp-pane--agent")).toHaveLength(4);
    expect(document.querySelector(".lp-head__ref")?.textContent).toBe("#1");
  });

  it('a null seed with a source renders the "Source no longer exists" panel and no composer', () => {
    render(
      <LaunchComposerDialog
        open
        onClose={vi.fn()}
        source={{ kind: "task", id: 1 }}
        seed={null}
      />,
    );

    expect(screen.getByText("Source no longer exists")).toBeTruthy();
    expect(
      document.querySelector('[aria-label="Launch session"]'),
    ).toBeNull();
  });
});

describe("LaunchComposerDialog — running the launch", () => {
  it("an embedded launch calls applyPaneLayout with the task's attribution and navigates", async () => {
    localStorage.setItem(
      LAUNCH_DEFAULTS_KEY,
      JSON.stringify({ profile_id: 9 }),
    );
    const onClose = vi.fn();
    render(
      <LaunchComposerDialog
        open
        onClose={onClose}
        source={{ kind: "task", id: 1 }}
        seed={seed()}
      />,
    );

    await act(async () => {
      cmdEnter();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(applyPaneLayoutMock).toHaveBeenCalledTimes(1);
    const spec = applyPaneLayoutMock.mock.calls[0]![0];
    expect(spec.source).toEqual({ kind: "task", id: 1 });
    expect(spec.projectId).toBe(1);
    expect(spec.panes[0]).toMatchObject({
      cwd: "/repo/codenest",
      profileName: "Work",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(TERMINAL_ROUTE);
  });

  it("a popout launch enqueues the spec and opens the window, without applyPaneLayout", async () => {
    const onClose = vi.fn();
    render(
      <LaunchComposerDialog
        open
        onClose={onClose}
        source={{ kind: "task", id: 1 }}
        seed={seed({ target: "popout", has_override: true })}
      />,
    );

    await act(async () => {
      cmdEnter();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(applyPaneLayoutMock).not.toHaveBeenCalled();
    expect(mockOpenTerminalsWindow).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    const queued = pendingLaunchStore.consume("popout");
    expect(queued).not.toBeNull();
    expect(queued?.source).toEqual({ kind: "task", id: 1 });
  });

  it("the override PUT preserves rows/cols/extra_args/prompt_fanout and supersedes project/provider/model/profile/target", async () => {
    render(
      <LaunchComposerDialog
        open
        onClose={vi.fn()}
        source={{ kind: "task", id: 1 }}
        seed={seed({
          rows: 2,
          cols: 3,
          extra_args: "--flag",
          prompt_fanout: "every",
          has_override: true,
          target: "popout",
        })}
      />,
    );

    await act(async () => {
      cmdEnter();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(upsertOverrideMutateAsync).toHaveBeenCalledTimes(1);
    const { kind, id, payload } = upsertOverrideMutateAsync.mock.calls[0]![0];
    expect(kind).toBe("task");
    expect(id).toBe(1);
    expect(payload).toMatchObject({
      rows: 2,
      cols: 3,
      extra_args: "--flag",
      prompt_fanout: "every",
      project_id: 1,
      provider_id: 1,
      model: "opus",
      target: "popout",
    });
  });

  it("a project path that fails pathsExist blocks the launch", async () => {
    mockPathsExist.mockResolvedValue([
      { path: "/repo/codenest", exists: false, is_dir: false },
    ]);
    render(
      <LaunchComposerDialog
        open
        onClose={vi.fn()}
        source={{ kind: "task", id: 1 }}
        seed={seed()}
      />,
    );

    await act(async () => {
      cmdEnter();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(applyPaneLayoutMock).not.toHaveBeenCalled();
    expect(
      document.querySelector('[aria-label="Launch session"]'),
    ).not.toBeNull();
  });

  it("a launch is not started twice by a double Cmd+Enter", async () => {
    render(
      <LaunchComposerDialog
        open
        onClose={vi.fn()}
        source={{ kind: "task", id: 1 }}
        seed={seed()}
      />,
    );

    await act(async () => {
      cmdEnter();
      cmdEnter();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(applyPaneLayoutMock).toHaveBeenCalledTimes(1);
  });
});

describe("LaunchComposerDialog — sticky defaults (decision 6)", () => {
  it("with has_override false, a stored popout target wins over the seed's embedded default", () => {
    localStorage.setItem(
      LAUNCH_DEFAULTS_KEY,
      JSON.stringify({ target: "popout" }),
    );
    render(
      <LaunchComposerDialog
        open
        onClose={vi.fn()}
        source={{ kind: "task", id: 1 }}
        seed={seed({ has_override: false, target: "embedded" })}
      />,
    );

    const popoutButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".lp-seg button"),
    ).find((b) => b.textContent === "Popout window");
    expect(popoutButton?.className).toContain("is-on");
  });

  it("with has_override true, the seed's target wins over a stored default", () => {
    localStorage.setItem(
      LAUNCH_DEFAULTS_KEY,
      JSON.stringify({ target: "embedded" }),
    );
    render(
      <LaunchComposerDialog
        open
        onClose={vi.fn()}
        source={{ kind: "task", id: 1 }}
        seed={seed({ has_override: true, target: "popout" })}
      />,
    );

    const popoutButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".lp-seg button"),
    ).find((b) => b.textContent === "Popout window");
    expect(popoutButton?.className).toContain("is-on");
  });

  it("after a launch, codenest.launch.defaults holds the launched target/profile and a pre-existing rows key", async () => {
    localStorage.setItem(
      LAUNCH_DEFAULTS_KEY,
      JSON.stringify({ rows: 3, cols: 2 }),
    );
    render(
      <LaunchComposerDialog
        open
        onClose={vi.fn()}
        source={{ kind: "task", id: 1 }}
        seed={seed({ has_override: true, target: "popout", profile_id: 9 })}
      />,
    );

    await act(async () => {
      cmdEnter();
      await Promise.resolve();
      await Promise.resolve();
    });

    const stored = JSON.parse(localStorage.getItem(LAUNCH_DEFAULTS_KEY)!) as {
      rows?: number;
      target?: string;
      profile_id?: number | null;
    };
    expect(stored.rows).toBe(3);
    expect(stored.target).toBe("popout");
    expect(stored.profile_id).toBe(9);
  });
});

describe("LaunchFromSourceButton — opens the composer (task #35)", () => {
  it("clicking the button opens the composer dialog", () => {
    mockUseLaunchSeed.mockReturnValue({
      data: seed(),
      isLoading: false,
      isError: false,
    });

    render(<LaunchFromSourceButton kind="task" id={1} label="Launch" />);

    fireEvent.click(screen.getByText("Launch"));

    expect(
      document.querySelector('[aria-label="Launch session"]'),
    ).not.toBeNull();
  });
});
