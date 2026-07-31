// The `agent_runs` write contract, plus the window check that decides a run's
// `target`. Both are small, and both are load-bearing: a pane that posts nothing
// is invisible on the Command Center, and a pane that posts the wrong target
// gets a Focus button that looks in the wrong window.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  recordAgentLaunch,
  recordAgentExited,
  reconcileAgentRuns,
} from "../agent-run-telemetry";
import {
  currentPaneTarget,
  isTerminalsWindow,
  isScreenshotRingWindow,
  TERMINALS_WINDOW_HASH,
} from "../window-target";

const { fetchSidecarMock, listLivePanesMock, isTauriAvailableMock } = vi.hoisted(
  () => ({
    fetchSidecarMock: vi.fn(),
    listLivePanesMock: vi.fn(),
    isTauriAvailableMock: vi.fn(),
  }),
);

vi.mock("../api", () => ({
  fetchSidecar: (path: string, init?: RequestInit) =>
    fetchSidecarMock(path, init),
}));

vi.mock("../ipc", () => ({
  listLivePanes: () => listLivePanesMock(),
  isTauriAvailable: () => isTauriAvailableMock(),
}));

function bodyOf(call: unknown[] | undefined): Record<string, unknown> {
  const init = call?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

beforeEach(() => {
  fetchSidecarMock.mockReset().mockResolvedValue(undefined);
  listLivePanesMock.mockReset().mockResolvedValue([]);
  isTauriAvailableMock.mockReset().mockReturnValue(true);
});

afterEach(() => {
  window.location.hash = "";
});

describe("recordAgentLaunch", () => {
  it("posts the launch payload to the run-recording endpoint", () => {
    recordAgentLaunch({
      pane_id: "leaf-1",
      session_id: "sess-1",
      provider: 1,
      cwd: "/w/acme",
      model: "claude-opus-5",
      target: "popout",
    });

    const call = fetchSidecarMock.mock.calls[0];
    expect(call?.[0]).toBe("/api/v1/agents/events/launch");
    expect((call?.[1] as RequestInit).method).toBe("POST");
    expect(bodyOf(call)).toEqual({
      pane_id: "leaf-1",
      session_id: "sess-1",
      provider: 1,
      cwd: "/w/acme",
      model: "claude-opus-5",
      target: "popout",
    });
  });

  it("swallows a sidecar failure rather than surfacing it to the launch", () => {
    // Telemetry must never turn a working session into a visible error, and the
    // sidecar can still be starting when the first pane mounts.
    fetchSidecarMock.mockRejectedValue(new Error("sidecar down"));

    expect(() => recordAgentLaunch({ pane_id: "leaf-1" })).not.toThrow();
  });
});

describe("recordAgentExited", () => {
  it("posts the pane and exit code to the liveness endpoint", () => {
    recordAgentExited("leaf-1", 0);

    const call = fetchSidecarMock.mock.calls[0];
    expect(call?.[0]).toBe("/api/v1/agents/runs/exited");
    expect(bodyOf(call)).toEqual({ pane_id: "leaf-1", exit_code: 0 });
  });

  it("sends a null exit code when none is known", () => {
    // The teardown path has no exit code — it reports *that* the run ended.
    recordAgentExited("leaf-1", null);

    expect(bodyOf(fetchSidecarMock.mock.calls[0])).toEqual({
      pane_id: "leaf-1",
      exit_code: null,
    });
  });

  it("names the session that ended when one is known", () => {
    // A pane keeps its id across a Restart, and these posts are unordered — so
    // an unscoped report could end the replacement instead of the run it means.
    recordAgentExited("leaf-1", 0, "sess-old");

    expect(bodyOf(fetchSidecarMock.mock.calls[0])).toEqual({
      pane_id: "leaf-1",
      exit_code: 0,
      session_id: "sess-old",
    });
  });

  it("omits the session id for the PTY path, which has none", () => {
    recordAgentExited("pty-1", 0, null);

    expect(bodyOf(fetchSidecarMock.mock.calls[0])).not.toHaveProperty(
      "session_id",
    );
  });

  it("swallows a sidecar failure", () => {
    fetchSidecarMock.mockRejectedValue(new Error("sidecar down"));

    expect(() => recordAgentExited("leaf-1", 1)).not.toThrow();
  });
});

describe("window-target", () => {
  it("reads the detached terminals window off the hash", () => {
    window.location.hash = TERMINALS_WINDOW_HASH;

    expect(isTerminalsWindow()).toBe(true);
    expect(isScreenshotRingWindow()).toBe(false);
    expect(currentPaneTarget()).toBe("popout");
  });

  it("treats the main window as embedded", () => {
    window.location.hash = "";

    expect(isTerminalsWindow()).toBe(false);
    expect(currentPaneTarget()).toBe("embedded");
  });

  it("does not mistake another routed window for the terminals one", () => {
    window.location.hash = "#/window/screenshot-ring";

    expect(isTerminalsWindow()).toBe(false);
    expect(isScreenshotRingWindow()).toBe(true);
    expect(currentPaneTarget()).toBe("embedded");
  });
});

describe("reconcileAgentRuns", () => {
  it("sends the shell's live pane list and returns how many runs were ended", async () => {
    listLivePanesMock.mockResolvedValue(["leaf-1", "pty-2"]);
    fetchSidecarMock.mockResolvedValue({ ended: 3 });

    await expect(reconcileAgentRuns()).resolves.toBe(3);

    const call = fetchSidecarMock.mock.calls[0];
    expect(call?.[0]).toBe("/api/v1/agents/runs/reconcile");
    expect(bodyOf(call)).toEqual({ live_pane_ids: ["leaf-1", "pty-2"] });
  });

  it("does not sweep without a Tauri backend", async () => {
    // Nothing can enumerate live children, so an empty list would read as
    // "every run is dead" and end all of them.
    isTauriAvailableMock.mockReturnValue(false);

    await expect(reconcileAgentRuns()).resolves.toBeNull();
    expect(fetchSidecarMock).not.toHaveBeenCalled();
  });

  it("reports null rather than 0 when the sweep itself fails", async () => {
    // `null` is "no information"; 0 would claim nothing was stale.
    fetchSidecarMock.mockRejectedValue(new Error("sidecar down"));

    await expect(reconcileAgentRuns()).resolves.toBeNull();
  });

  it("reports null when the live-pane query fails", async () => {
    listLivePanesMock.mockRejectedValue(new Error("no such command"));

    await expect(reconcileAgentRuns()).resolves.toBeNull();
    expect(fetchSidecarMock).not.toHaveBeenCalled();
  });
});
