import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HooksStep } from "../hooks-step";
import type { HookVerifyReport, Provider } from "../../../lib/api";
import type { HookProbeResult } from "../../../lib/ipc";

// ─── lib/api mocks ────────────────────────────────────────────────────────────
//
// hooks-step.tsx pulls its data/mutations from `lib/api`, and
// `hook-verify-copy.ts` (imported unmocked, for its pure classification
// functions) pulls a value import of `SidecarError` from the same module —
// so the mock factory below must export it too, even though this suite never
// triggers a `describeRequestFailure` branch that checks `instanceof`.
const mockUseProviders = vi.fn();
const mockUseHookStatus = vi.fn();
const mockUseVerifyHooks = vi.fn();
const mockUseMintHookSelfTest = vi.fn();
const mockFetchHookSelfTestReceipt = vi.fn();

vi.mock("../../../lib/api", () => ({
  SIDECAR_BASE_URL: "http://127.0.0.1:8002",
  SidecarError: class SidecarError extends Error {
    status: number;
    path: string;
    constructor(message: string, status: number, path: string) {
      super(message);
      this.status = status;
      this.path = path;
    }
  },
  useHookSnippet: () => ({ data: undefined }),
  useHookStatus: (...args: unknown[]) => mockUseHookStatus(...args),
  useMintHookSelfTest: () => mockUseMintHookSelfTest(),
  useProviders: (...args: unknown[]) => mockUseProviders(...args),
  useVerifyHooks: () => mockUseVerifyHooks(),
  fetchHookSelfTestReceipt: (...args: unknown[]) =>
    mockFetchHookSelfTestReceipt(...args),
}));

const mockIsTauriAvailable = vi.fn();
const mockRunHookProbe = vi.fn();

vi.mock("../../../lib/ipc", () => ({
  isTauriAvailable: () => mockIsTauriAvailable(),
  runHookProbe: (...args: unknown[]) => mockRunHookProbe(...args),
}));

// ─── fixtures ─────────────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: "anthropic",
    display_name: "Anthropic",
    command_template: "claude",
    default_args: "",
    is_enabled: true,
    color: null,
    default_env: { CLAUDE_CONFIG_DIR: "/Users/x/.claude" },
    models: ["default"],
    default_model: null,
    has_api_key: false,
    base_url: null,
    ...overrides,
  };
}

const OK_REPORT: HookVerifyReport = {
  base_url: "http://127.0.0.1:8002",
  expected_events: ["SessionStart"],
  overall: "ok",
  results: [
    {
      config_home: "/Users/x/.claude",
      settings_path: "/Users/x/.claude/settings.json",
      file_status: "ok",
      detail: null,
      events: [],
      found_elsewhere: [],
    },
  ],
};

// httpStatus: null with no receipt hit yet -> classifyLiveProbe's
// "unreachable" branch, independent of whatever the receipt says.
const UNREACHABLE_PROBE: HookProbeResult = {
  httpStatus: null,
  exitCode: 7,
  curlMissing: false,
  durationMs: 12,
  stderr: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseProviders.mockReturnValue({ data: [makeProvider()] });
  mockUseHookStatus.mockReturnValue({
    data: { connected: false, sessions: 0, last_ping_at: null },
  });
  mockIsTauriAvailable.mockReturnValue(true);
});

// ─── tests ────────────────────────────────────────────────────────────────────

describe("HooksStep", () => {
  it("clears a stale live-probe outcome once Test hooks reports success", async () => {
    mockUseMintHookSelfTest.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn().mockResolvedValue({
        token: "tok1",
        url: "http://127.0.0.1:8002/api/v1/workspace/hooks/self-test/tok1",
        max_time_seconds: 5,
        expires_in_seconds: 60,
        command: "curl ...",
      }),
    });
    mockRunHookProbe.mockResolvedValue(UNREACHABLE_PROBE);
    mockFetchHookSelfTestReceipt.mockResolvedValue({
      known: true,
      received: true,
      elapsed_ms: 5,
    });
    mockUseVerifyHooks.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn().mockResolvedValue(OK_REPORT),
    });

    render(<HooksStep registerCommit={vi.fn()} />);

    // Run live test first — it fails with a stale, "reachable" outcome
    // (nothing answered), which sets `live` to an error state.
    fireEvent.click(screen.getByRole("button", { name: "Run live test" }));
    await screen.findByText(/Nothing answered at/);

    // A subsequent, successful Test hooks click must not be shadowed by
    // that stale `live` outcome: verifyBarCopy ranks `live` above `report`,
    // so onTestHooks must reset `live` itself, the same way onLiveTest
    // already resets `failure`/`live` on its own re-runs.
    fireEvent.click(screen.getByRole("button", { name: "Test hooks" }));
    await screen.findByText("All six hook events verified in settings.json.");

    expect(screen.queryByText(/Nothing answered at/)).toBeNull();
  });
});
