/**
 * Step 05's visible states. The verification bar carried its tone in four CSS
 * module classes (`verifyIdle`/`verifyOn`/`verifyWarn`/`verifyErr`) and the
 * per-event chips in three more; the Deck conversion moved all seven onto
 * `data-s`, and nothing else in the suite would catch them all collapsing to
 * one tone. The step cannot be reached in review, so each tone is asserted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { HookVerifyReport, Provider } from "../../../lib/api";

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
vi.mock("../../../lib/ipc", () => ({
  isTauriAvailable: () => mockIsTauriAvailable(),
  runHookProbe: vi.fn(),
}));

const { HooksStep } = await import("../hooks-step");

// A fictional config home — this is a public repo and a first-run fixture is
// where a real one tends to get baked in.
const CONFIG_HOME = "/config/claude";

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: "anthropic",
    display_name: "Anthropic",
    command_template: "claude",
    default_args: "",
    is_enabled: true,
    color: null,
    default_env: { CLAUDE_CONFIG_DIR: CONFIG_HOME },
    models: ["default"],
    default_model: null,
    has_api_key: false,
    base_url: null,
    ...overrides,
  } as Provider;
}

function report(
  events: { event: string; status: string; detail?: string | null }[],
  overall = "ok",
): HookVerifyReport {
  return {
    base_url: "http://127.0.0.1:8002",
    expected_events: ["SessionStart"],
    overall,
    results: [
      {
        config_home: CONFIG_HOME,
        settings_path: `${CONFIG_HOME}/settings.json`,
        file_status: "ok",
        detail: null,
        events,
        found_elsewhere: [],
      },
    ],
  } as unknown as HookVerifyReport;
}

/** The bar's state glyph — the single element carrying its tone. */
function barState(): string | null {
  const glyphs = document.querySelectorAll(".dk-s[data-s]");
  return glyphs[glyphs.length - 1]?.getAttribute("data-s") ?? null;
}

/** The chips, not the prose — "SessionStart" also appears in the step's hint. */
function chip(event: string): HTMLElement {
  const found = Array.from(
    document.querySelectorAll<HTMLElement>(".dk-tag"),
  ).find((el) => el.textContent === event);
  if (!found) throw new Error(`no chip for ${event}`);
  return found;
}

function chipState(event: string): string | null {
  return chip(event).getAttribute("data-s");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseProviders.mockReturnValue({ data: [makeProvider()] });
  mockUseHookStatus.mockReturnValue({
    data: { connected: false, sessions: 0, last_ping_at: null },
  });
  mockUseVerifyHooks.mockReturnValue({ isPending: false, mutateAsync: vi.fn() });
  mockUseMintHookSelfTest.mockReturnValue({
    isPending: false,
    mutateAsync: vi.fn(),
  });
  mockIsTauriAvailable.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
});

describe("HooksStep states", () => {
  it("starts idle — not the amber that reads as 'waiting on you'", () => {
    render(<HooksStep registerCommit={vi.fn()} />);
    expect(barState()).toBe("idle");
  });

  it("goes green once every event verifies", async () => {
    mockUseVerifyHooks.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn().mockResolvedValue(report([])),
    });
    render(<HooksStep registerCommit={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Test hooks" }));
    await waitFor(() => expect(barState()).toBe("done"));
  });

  it("carries each event verdict as its own tone", async () => {
    mockUseVerifyHooks.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn().mockResolvedValue(
        report(
          [
            { event: "SessionStart", status: "ok", detail: null },
            { event: "PreToolUse", status: "missing", detail: null },
            { event: "PostToolUse", status: "mismatch", detail: "wrong url" },
          ],
          "error",
        ),
      ),
    });
    render(<HooksStep registerCommit={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Test hooks" }));

    await waitFor(() => chip("SessionStart"));
    expect(chipState("SessionStart")).toBe("done");
    expect(chipState("PreToolUse")).toBe("wait");
    // "mismatch" and "malformed" are both errors, not warnings.
    expect(chipState("PostToolUse")).toBe("fail");
  });

  it("keeps the detail of a mismatched event reachable as a title", async () => {
    mockUseVerifyHooks.mockReturnValue({
      isPending: false,
      mutateAsync: vi
        .fn()
        .mockResolvedValue(
          report([{ event: "PostToolUse", status: "mismatch", detail: "wrong url" }]),
        ),
    });
    render(<HooksStep registerCommit={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Test hooks" }));
    await waitFor(() => chip("PostToolUse"));
    expect(chip("PostToolUse").getAttribute("title")).toBe("wrong url");
  });

  it("disables Test hooks when no provider has a config home, and says why", () => {
    mockUseProviders.mockReturnValue({
      data: [makeProvider({ default_env: {} })],
    });
    render(<HooksStep registerCommit={vi.fn()} />);
    expect(
      (screen.getByRole("button", { name: "Test hooks" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getByText(/No provider has a config home yet/),
    ).toBeTruthy();
    // And the unwired provider is named rather than silently dropped.
    expect(screen.getByText(/Missing config home/)).toBeTruthy();
  });

  it("disables the live test outside the desktop shell, and says why", () => {
    mockIsTauriAvailable.mockReturnValue(false);
    render(<HooksStep registerCommit={vi.fn()} />);
    expect(
      (screen.getByRole("button", { name: "Run live test" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("The live test needs the desktop app.")).toBeTruthy();
  });

  it("points at step 03 when nothing is configured at all", () => {
    mockUseProviders.mockReturnValue({ data: [] });
    render(<HooksStep registerCommit={vi.fn()} />);
    expect(screen.getByText(/go back to Step 03/)).toBeTruthy();
  });

  it("shows the target settings path the user must paste into", () => {
    render(<HooksStep registerCommit={vi.fn()} />);
    const target = screen.getByLabelText(
      "Target settings file (read-only)",
    ) as HTMLInputElement;
    expect(target.value).toBe(`${CONFIG_HOME}/settings.json`);
    expect(target.readOnly).toBe(true);
  });
});
