/**
 * shell.test.tsx
 *
 * The top-bar and OmniBar Launch entry points (task #35): both must reach
 * `LaunchComposerDialog` with no source. The heavy chrome siblings
 * (`Sidebar`, `Topbar`, `OmniBar`, `NotificationBell`, `ScreenshotButton`)
 * are stubbed — this file's job is the Launch button and the
 * `OMNI_EVENT_OPEN_LAUNCH` listener, not the rest of the shell's chrome
 * (which has no test of its own today and is out of scope here).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Shell } from "../shell";
import { useAgentCatalogStore } from "../../../stores/agent-catalog-store";
import { OMNI_EVENT_OPEN_LAUNCH } from "../../../lib/omni-commands";

const { mockUseActiveSessionCounts, mockUseProjects, mockUseLookups } =
  vi.hoisted(() => ({
    mockUseActiveSessionCounts: vi.fn(),
    mockUseProjects: vi.fn(),
    mockUseLookups: vi.fn(),
  }));

vi.mock("../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api")>();
  return {
    ...actual,
    useActiveSessionCounts: () => mockUseActiveSessionCounts(),
    useProjects: () => mockUseProjects(),
    useLookups: () => mockUseLookups(),
    useLaunchPresets: () => ({ data: [] }),
    useCreateLaunchPreset: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeleteLaunchPreset: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useUpsertLaunchOverride: () => ({ mutateAsync: vi.fn() }),
  };
});

vi.mock("../sidebar", () => ({ Sidebar: () => null }));
vi.mock("../topbar", () => ({ Topbar: () => null }));
vi.mock("../../omni-bar", () => ({ OmniBar: () => null }));
vi.mock("../../notification-bell", () => ({ NotificationBell: () => null }));
vi.mock("../../screenshot/screenshot-button", () => ({
  ScreenshotButton: () => null,
}));

beforeEach(() => {
  mockUseActiveSessionCounts.mockReturnValue({ activeCount: 0 });
  mockUseProjects.mockReturnValue({
    data: [{ id: 1, name: "codenest", path: "/repo/codenest" }],
  });
  mockUseLookups.mockReturnValue({ data: { profiles: [] } });
  useAgentCatalogStore.setState({
    providers: [
      {
        id: 1,
        name: "anthropic",
        displayName: "Anthropic",
        command: "claude {session_id}",
        env: {},
        models: [],
        defaultModel: null,
        color: null,
      },
    ],
    loaded: true,
    loading: false,
    lastUsed: { providerId: null, model: null },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Shell — Launch entry points", () => {
  it("the top-bar Launch button opens the composer with no source ref", () => {
    render(
      <MemoryRouter>
        <Shell>
          <div>page content</div>
        </Shell>
      </MemoryRouter>,
    );

    expect(document.querySelector('[aria-label="Launch session"]')).toBeNull();

    const launchButton = Array.from(
      document.querySelectorAll("button"),
    ).find((b) => b.textContent?.includes("Launch"));
    if (!launchButton) throw new Error("expected the top-bar Launch button");
    fireEvent.click(launchButton);

    expect(
      document.querySelector('[aria-label="Launch session"]'),
    ).not.toBeNull();
    expect(document.querySelector(".lp-head__ref")).toBeNull();
  });

  it("the OmniBar's open-launch event opens the same dialog", async () => {
    render(
      <MemoryRouter>
        <Shell>
          <div>page content</div>
        </Shell>
      </MemoryRouter>,
    );

    expect(document.querySelector('[aria-label="Launch session"]')).toBeNull();

    await act(async () => {
      document.dispatchEvent(new Event(OMNI_EVENT_OPEN_LAUNCH));
    });

    expect(
      document.querySelector('[aria-label="Launch session"]'),
    ).not.toBeNull();
  });
});
