/**
 * The two P1 rows the design's "Data behind this screen" table puts on a
 * running session: the source chip (`entrypoint`, via Lane C) and the
 * compaction marker (epic #153 / #166).
 *
 * Both were initially omitted from #166 on the stated grounds that no merged
 * dependency put the fields on `AgentSession`. That was wrong — #163 is merged,
 * migration 009 adds `source_app`/`cli_version`, 014 adds `compaction_count`
 * and `context_peak_tokens`, and the sidecar selects `s.*` — so these exist to
 * stop that conclusion being reached a second time.
 *
 * The behaviour worth pinning is the three-way distinction, because two of the
 * three states look identical if anyone reaches for `?? 0` or `?? ""`:
 *
 *   * a value the scanner found        → render it verbatim
 *   * `null` (scanner has not looked)  → dashed "unknown"
 *   * absent (sidecar predates 009)    → dashed "unknown", same as null
 *
 * and that a session which was never compacted shows nothing at all rather
 * than a "compacted ×0" badge.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { AgentSession } from "../../../../lib/api";

// The panel subscribes over SSE. These tests are about what a row renders for
// a given session shape, so the stream is replaced by a handler this file
// drives directly.
let emit: ((data: unknown, eventName: string) => void) | null = null;

vi.mock("../../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/api")>();
  return {
    ...actual,
    useSidecarSSE: (_channel: string, handler: (d: unknown, e: string) => void) => {
      emit = handler;
    },
  };
});

const { ActiveSessions } = await import("../active-sessions");

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

function renderWith(s: AgentSession): void {
  render(<ActiveSessions />);
  // Inside `act`: the panel stores the snapshot in state, and a React state
  // update dispatched outside act never flushes, so every assertion below
  // would query an empty list rather than the row under test.
  act(() => {
    emit?.({ sessions: [s] }, "snapshot");
  });
}

afterEach(() => {
  cleanup();
  emit = null;
});

describe("source chip", () => {
  it("renders the raw entrypoint string the scanner found", () => {
    renderWith(session({ source_app: "cli", cli_version: "2.1.251" }));
    expect(screen.getByText("cli")).toBeTruthy();
  });

  it("renders a different client's value just as verbatim", () => {
    // Three values exist on this machine and the set is open, so nothing may
    // map a client to a fixed presentation.
    renderWith(session({ source_app: "sdk-cli" }));
    expect(screen.getByText("sdk-cli")).toBeTruthy();
  });

  it("says unknown when the scanner has not reached the session (null)", () => {
    renderWith(session({ source_app: null }));
    expect(screen.getByText("unknown")).toBeTruthy();
  });

  it("says unknown when the sidecar is too old to send the field at all", () => {
    // A process launched before migration 009 omits the key entirely rather
    // than sending null. Absent and null are the same claim: we do not know.
    const stale = session();
    delete (stale as Partial<AgentSession>).source_app;
    renderWith(stale);
    expect(screen.getByText("unknown")).toBeTruthy();
  });

  it("puts the CLI version in the tooltip rather than the chip", () => {
    renderWith(session({ source_app: "cli", cli_version: "2.1.251" }));
    expect(screen.getByText("cli").getAttribute("title")).toBe(
      "Started by cli · CLI 2.1.251",
    );
  });
});

describe("compaction marker", () => {
  it("shows the count when the session was compacted", () => {
    renderWith(session({ compaction_count: 2 }));
    expect(screen.getByText("compacted ×2")).toBeTruthy();
  });

  it("shows nothing for a scanned session that was never compacted", () => {
    // 0 is a real measurement here, but a "compacted ×0" badge is noise on
    // every healthy row — the marker earns its place only when it fired.
    renderWith(session({ compaction_count: 0 }));
    expect(screen.queryByText(/compacted/)).toBeNull();
  });

  it("shows nothing when the field is absent or null", () => {
    renderWith(session({ compaction_count: null }));
    expect(screen.queryByText(/compacted/)).toBeNull();
  });

  it("names the peak context in the tooltip when one was recorded", () => {
    renderWith(session({ compaction_count: 1, context_peak_tokens: 214_000 }));
    expect(screen.getByText("compacted ×1").getAttribute("title")).toBe(
      "Peak context 214,000 tokens before compaction",
    );
  });
});
