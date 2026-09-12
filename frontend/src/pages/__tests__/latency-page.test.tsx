import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { LatencyPage } from "../latency";
import {
  FEATURE_DEFAULTS,
  FEATURES,
  KNOWN_FEATURES_ORDERED,
  NAV_ITEMS,
} from "../../lib/nav-items";
import type { TraceOperationsReport } from "../../lib/api";

const { mockUseTraceOperations } = vi.hoisted(() => ({
  mockUseTraceOperations: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  useTraceOperations: () => mockUseTraceOperations(),
}));

vi.mock("../../components/layout/shell", () => ({
  Shell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function op(over: Partial<TraceOperationsReport["operations"][0]> = {}) {
  return {
    span_name: "claude_code.hook",
    category: "hook",
    operation: "PreToolUse",
    count: 4,
    error_count: 1,
    total_duration_ms: 800,
    avg_duration_ms: 200,
    min_duration_ms: 100,
    max_duration_ms: 400,
    sessions: 2,
    last_seen_at: "2026-09-12 10:00:00",
    ...over,
  };
}

function report(
  over: Partial<TraceOperationsReport> = {},
): TraceOperationsReport {
  return {
    operations: [op()],
    session_count: 2,
    span_count: 4,
    receiver: {
      requests: 3,
      spans_seen: 4,
      spans_stored: 4,
      spans_rejected: 0,
      rejections: {},
      unknown_sessions: [],
      unknown_spans: [],
    },
    ...over,
  };
}

describe("the latency page", () => {
  it("shows each operation's run count, failure count and duration", () => {
    mockUseTraceOperations.mockReturnValue({
      data: report(),
      isPending: false,
      isError: false,
    });
    render(<LatencyPage />);

    expect(screen.getByText("PreToolUse")).toBeTruthy();
    expect(screen.getByText("1 (25%)")).toBeTruthy(); // failures, as a rate
    expect(screen.getAllByText("200 ms").length).toBeGreaterThan(0); // average
    expect(screen.getByText("400 ms")).toBeTruthy(); // max
  });

  it("says it covers only what the receiver observed", () => {
    mockUseTraceOperations.mockReturnValue({
      data: report(),
      isPending: false,
      isError: false,
    });
    render(<LatencyPage />);
    expect(document.body.textContent).toContain(
      "covers only what that receiver observed",
    );
  });

  it("explains the empty case rather than showing an empty table", () => {
    mockUseTraceOperations.mockReturnValue({
      data: report({ operations: [], span_count: 0, session_count: 0 }),
      isPending: false,
      isError: false,
    });
    render(<LatencyPage />);
    expect(screen.getByText("No spans have arrived yet")).toBeTruthy();
    expect(document.body.textContent).toContain("Telemetry");
  });
});

describe("the nav registration", () => {
  it("is in every registry a slug needs to be switchable on", () => {
    // A slug missing from any of these can never be enabled — see AGENTS.md's
    // "Frontend chrome renders only from known-good state".
    expect(FEATURE_DEFAULTS["latency"]).toBe(true);
    expect(KNOWN_FEATURES_ORDERED).toContain("latency");
    expect(FEATURES["latency"]).toEqual(["latency"]);
    expect(NAV_ITEMS.some((i) => i.slug === "latency")).toBe(true);
  });
});
