/**
 * The consent gate on Settings → Telemetry.
 *
 * This file exists because independent verification of #179 deleted the
 * confirm step outright — rewiring both first-click handlers to write
 * immediately — and the entire frontend suite still passed. The ticket's
 * central property was the one thing nothing checked.
 *
 * What is being protected is not a UI nicety. The button behind this gate
 * writes the user's real `settings.json`, and turning telemetry on makes a
 * figure arriving over an unauthenticated loopback endpoint outrank every
 * other source this app has, permanently. A regression that let one click do
 * that would be silent in every other test.
 *
 * `hooks-page.test.tsx` has the same shape for #171's identical pattern; this
 * follows it deliberately rather than inventing a second idiom.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TelemetryTab } from "../telemetry-tab";
import type { TelemetryReport, TelemetryResult } from "../../../lib/api";

const { mockUseTelemetryPlan, mockSetMutate, mockUseProviders } = vi.hoisted(
  () => ({
    mockUseTelemetryPlan: vi.fn(),
    mockSetMutate: vi.fn(),
    mockUseProviders: vi.fn(),
  }),
);

vi.mock("../../../lib/api", () => ({
  useTelemetryPlan: (...a: unknown[]) => mockUseTelemetryPlan(...a),
  useSetTelemetry: () => ({
    mutate: mockSetMutate,
    isPending: false,
    data: undefined,
  }),
  useProviders: () => mockUseProviders(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function result(over: Partial<TelemetryResult> = {}): TelemetryResult {
  return {
    config_home: "~/.claude",
    settings_path: "/home/u/.claude/settings.json",
    status: "planned",
    refusal: null,
    changed: true,
    created_file: false,
    backup_path: null,
    state: "off",
    enable: [
      {
        key: "CLAUDE_CODE_ENABLE_TELEMETRY",
        action: "add",
        value: "1",
        detail: null,
      },
    ],
    disable: [],
    left_foreign: 1,
    notes: [],
    ...over,
  } as TelemetryResult;
}

function report(over: Partial<TelemetryReport> = {}): TelemetryReport {
  return {
    base_url: "http://localhost:8002",
    endpoint_url: "http://localhost:8002",
    export_interval_ms: 60000,
    dry_run: true,
    mode: "plan",
    overall: "planned",
    results: [result()],
    ...over,
  } as TelemetryReport;
}

function renderTab(data: TelemetryReport = report()): void {
  mockUseProviders.mockReturnValue({ data: [], isLoading: false });
  mockUseTelemetryPlan.mockReturnValue({
    data,
    isLoading: false,
    error: null,
  });
  render(<TelemetryTab />);
}

describe("Telemetry consent gate", () => {
  it("does not write on the first click — it asks", () => {
    renderTab();
    fireEvent.click(screen.getByText(/Turn telemetry on/i));
    expect(mockSetMutate).not.toHaveBeenCalled();
  });

  it("writes only after the explicit confirm", () => {
    renderTab();
    fireEvent.click(screen.getByText(/Turn telemetry on/i));
    fireEvent.click(screen.getByText("Yes, write the file"));
    expect(mockSetMutate).toHaveBeenCalledTimes(1);
    expect(mockSetMutate.mock.calls[0]?.[0]).toMatchObject({ mode: "enable" });
  });

  it("gates the disable path behind its own confirm too", () => {
    renderTab(
      report({
        results: [
          result({
            state: "on",
            enable: [],
            disable: [
              {
                key: "CLAUDE_CODE_ENABLE_TELEMETRY",
                action: "remove",
                value: "1",
                detail: null,
              },
            ],
          }),
        ],
      }),
    );
    // The phrase also appears in the consent prose ("Turn telemetry off
    // below…"), so target the control rather than the first match.
    fireEvent.click(
      screen.getByRole("button", { name: /Turn telemetry off/i }),
    );
    expect(mockSetMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Yes, remove them"));
    expect(mockSetMutate).toHaveBeenCalledTimes(1);
    expect(mockSetMutate.mock.calls[0]?.[0]).toMatchObject({
      mode: "disable",
    });
  });

  it("names the file it is about to write, before writing it", () => {
    renderTab();
    fireEvent.click(screen.getByText(/Turn telemetry on/i));
    // Named in the plan and again in the confirm — both are wanted, so assert
    // presence rather than uniqueness.
    expect(
      screen.getAllByText(/\/home\/u\/\.claude\/settings\.json/).length,
    ).toBeGreaterThan(0);
  });

  it("backing out of the confirm writes nothing", () => {
    renderTab();
    fireEvent.click(screen.getByText(/Turn telemetry on/i));
    fireEvent.click(screen.getByText(/Cancel|Not now|No,/i));
    expect(mockSetMutate).not.toHaveBeenCalled();
  });
});
