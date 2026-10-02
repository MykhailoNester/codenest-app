/**
 * DeckShell — the Launch entry points, re-homed from the deleted
 * `components/layout/__tests__/shell.test.tsx` (#345).
 *
 * The old `Shell` is gone, but the contract these two tests pinned is DeckShell's
 * too and is the reason it is worth pinning: the status row's `launch` button
 * and the palette's `OMNI_EVENT_OPEN_LAUNCH` event must both reach
 * `LaunchComposerDialog` with no source ref. The event exists precisely so the
 * palette does not have to thread a callback through every page, which means
 * nothing else would notice if the listener stopped being registered.
 *
 * The heavy chrome siblings are stubbed — this file is about the two entry
 * points, not the rail or the status line.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DeckShell } from "../deck-shell";
import { useAgentCatalogStore } from "../../../stores/agent-catalog-store";
import { OMNI_EVENT_OPEN_LAUNCH } from "../../../lib/omni-commands";

const {
  mockUseActiveSessionCounts,
  mockUseProjects,
  mockUseLookups,
  mockUseAttention,
  mockUseDailySpend,
} = vi.hoisted(() => ({
  mockUseActiveSessionCounts: vi.fn(),
  mockUseProjects: vi.fn(),
  mockUseLookups: vi.fn(),
  mockUseAttention: vi.fn(),
  mockUseDailySpend: vi.fn(),
}));

vi.mock("../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api")>();
  return {
    ...actual,
    useActiveSessionCounts: () => mockUseActiveSessionCounts(),
    useProjects: () => mockUseProjects(),
    useLookups: () => mockUseLookups(),
    useAttention: () => mockUseAttention(),
    useDailySpend: () => mockUseDailySpend(),
    useLaunchPresets: () => ({ data: [] }),
    useCreateLaunchPreset: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeleteLaunchPreset: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useUpsertLaunchOverride: () => ({ mutateAsync: vi.fn() }),
  };
});

vi.mock("../../notification-bell", () => ({ NotificationBell: () => null }));

function renderShell(): void {
  render(
    <MemoryRouter>
      <DeckShell title="deck">
        <div>page content</div>
      </DeckShell>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockUseActiveSessionCounts.mockReturnValue({ activeCount: 0 });
  mockUseProjects.mockReturnValue({
    data: [{ id: 1, name: "codenest", path: "/repo/codenest" }],
  });
  mockUseLookups.mockReturnValue({ data: { profiles: [] } });
  mockUseAttention.mockReturnValue({ data: undefined });
  mockUseDailySpend.mockReturnValue({ data: undefined });
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

describe("DeckShell — Launch entry points", () => {
  it("the status row's launch button opens the composer with no source ref", () => {
    renderShell();

    expect(document.querySelector('[aria-label="Launch session"]')).toBeNull();

    const launchButton = Array.from(document.querySelectorAll("button")).find(
      // Case-insensitive because Deck lowercases every control label; the old
      // Shell's button read "Launch". The rule is which button, not its case.
      (b) => b.textContent?.toLowerCase().includes("launch"),
    );
    if (!launchButton) throw new Error("expected the status row's launch button");
    fireEvent.click(launchButton);

    expect(
      document.querySelector('[aria-label="Launch session"]'),
    ).not.toBeNull();
    // Opened from the top bar there is no source, so the header carries no
    // `#id — title` meta. Was `.lp-head__ref` before the Deck conversion
    // (#283); the ref now rides `.dk-modal__h .dk-meta`.
    expect(document.querySelector(".dk-modal__h .dk-meta")).toBeNull();
    expect(document.querySelector(".dk-modal__h h2")?.textContent).toBe(
      "launch session",
    );
  });

  it("the palette's open-launch event opens the same dialog", async () => {
    renderShell();

    expect(document.querySelector('[aria-label="Launch session"]')).toBeNull();

    await act(async () => {
      document.dispatchEvent(new Event(OMNI_EVENT_OPEN_LAUNCH));
    });

    expect(
      document.querySelector('[aria-label="Launch session"]'),
    ).not.toBeNull();
  });
});
