/**
 * The replay panel's capability list, pinned (#283).
 *
 * The conversion to Deck moved every surface of this panel off `d3-*` classes,
 * so these assertions are keyed on what the panel *does* — the slider, the
 * transport labels, the two lists, the modal, the inspect-lanes route — and
 * never on a class name that a later restyle can take away.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AgentEvent, AgentSession, ProfileOut } from "../../../lib/api";
import { ReplayPanel } from "../replay-panel";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => navigate };
});

afterEach(() => {
  cleanup();
  navigate.mockReset();
});

// A generic path, never this machine's: the panel renders a real cwd at
// runtime, but a fixture that carried one would put a developer's home
// directory in a public repo.
const CWD = "/projects/alpha";

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 1,
    session_id: "sess-1",
    profile: "work",
    status: "ended",
    cwd: CWD,
    project_id: 1,
    provider_id: 1,
    model: "claude-opus",
    tokens_in: 100,
    tokens_out: 50,
    cost_usd: 0.42,
    project_name: "Alpha",
    initial_prompt: "Ship it",
    current_tool: null,
    total_tool_calls: 4,
    started_at: "2026-08-11T16:00:00Z",
    ended_at: "2026-08-11T16:05:00Z",
    last_event_at: null,
    ...overrides,
  };
}

function makeEvent(id: number, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id,
    session_id: "sess-1",
    event_type: "PreToolUse",
    tool_name: "Bash",
    summary: `ran step ${id}`,
    payload_json: null,
    created_at: `2026-08-11T16:0${id}:00Z`,
    ...overrides,
  };
}

const EVENTS: AgentEvent[] = [
  makeEvent(1, { tool_name: "Bash" }),
  makeEvent(2, { tool_name: "Read" }),
  makeEvent(3, { tool_name: "Bash" }),
  makeEvent(4, { tool_name: "Edit", event_type: "PostToolUse" }),
];

const PROFILES: ProfileOut[] = [];

function renderPanel(
  props: Partial<React.ComponentProps<typeof ReplayPanel>> = {},
) {
  return render(
    <MemoryRouter>
      <ReplayPanel
        session={makeSession()}
        events={EVENTS}
        profiles={PROFILES}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("ReplayPanel", () => {
  it("names the session, not a surface that no longer exists", () => {
    const { container } = renderPanel();
    expect(
      container.querySelector('[aria-label="Session replay"]'),
    ).not.toBeNull();
    // #269 deleted the Command Center; the breadcrumb that named it went
    // with #283. Case-insensitive because the Deck bar is lowercase and the
    // point of the assertion is the name, not its casing.
    expect(screen.queryByText(/command center/i)).toBeNull();
  });

  it("renders the scrubbable timeline", () => {
    renderPanel();
    const slider = screen.getByRole("slider", {
      name: /session timeline scrubber/i,
    });
    expect(slider.getAttribute("aria-valuenow")).toBe("100");

    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(slider.getAttribute("aria-valuenow")).toBe("95");

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(slider.getAttribute("aria-valuenow")).toBe("100");
  });

  it("offers play, step and speed transport", () => {
    renderPanel();
    expect(screen.getByLabelText(/step back/i)).toBeTruthy();
    expect(screen.getByLabelText(/step forward/i)).toBeTruthy();

    const play = screen.getByLabelText("Play");
    fireEvent.click(play);
    expect(screen.getByLabelText("Pause")).toBeTruthy();

    const speeds = screen.getByRole("group", { name: /playback speed/i });
    const two = screen.getByRole("button", { name: "2×" });
    expect(speeds.contains(two)).toBe(true);
    fireEvent.click(two);
    expect(two.getAttribute("aria-pressed")).toBe("true");
  });

  it("lists the last actions and opens one in the event modal", () => {
    renderPanel();
    const list = screen.getByRole("grid", { name: "Last actions" });
    expect(list.querySelectorAll(".dk-line").length).toBe(4);

    fireEvent.click(screen.getByText("ran step 2"));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("counts the tools used and draws each one's share", () => {
    const { container } = renderPanel();
    const list = screen.getByRole("grid", { name: "Tools used" });
    // Three PreToolUse tools; the PostToolUse row is not a call.
    expect(list.querySelectorAll(".dk-line").length).toBe(2);
    expect(list.querySelectorAll(".dk-meter").length).toBe(2);

    const bash = screen.getByRole("progressbar", { name: /^Bash share/ });
    expect(bash.getAttribute("aria-valuenow")).toBe("67");
    expect(container.textContent).toContain("Bash");
  });

  it("says so when a session recorded no tool calls", () => {
    renderPanel({ events: [] });
    expect(screen.getAllByText(/no tool calls yet/i).length).toBe(2);
    expect(screen.getByText(/no activity/i)).toBeTruthy();
  });

  it("sends Inspect lanes to the inspect tab", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /inspect lanes/i }));
    expect(navigate).toHaveBeenCalledTimes(1);
    const to = navigate.mock.calls[0]?.[0] as string;
    expect(to).toContain("session=sess-1");
    expect(to).toContain("tab=inspect");
  });

  it("offers back only when the mount gave it somewhere to go", () => {
    const onClose = vi.fn();
    const { unmount } = renderPanel({ onClose });
    fireEvent.click(screen.getByRole("button", { name: /^back$/i }));
    expect(onClose).toHaveBeenCalled();

    // Escape is the same exit.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    unmount();

    renderPanel();
    expect(screen.queryByRole("button", { name: /^back$/i })).toBeNull();
  });

  it("reads an active session as live", () => {
    renderPanel({ session: makeSession({ status: "active" }) });
    expect(screen.getAllByText(/^live$/).length).toBeGreaterThan(0);
  });
});
