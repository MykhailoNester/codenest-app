import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentPermissionDialog } from "../terminal/agent-permission-dialog";
import type { PermissionRequest } from "../../lib/agent-conversation";

function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: "req_1",
    toolName: "Bash",
    displayName: "Bash",
    input: { command: "curl -s https://example.com" },
    description: "Fetch URL with curl and report exit code",
    toolUseId: "toolu_1",
    sessionKey: "Bash curl -s https://example.com",
    ...overrides,
  };
}

interface Handlers {
  onAllow: ReturnType<typeof vi.fn>;
  onAllowSession: ReturnType<typeof vi.fn>;
  onDeny: ReturnType<typeof vi.fn>;
}

function renderDialog(
  props: Partial<{ isFocusedPane: boolean }> = {},
): Handlers {
  const onAllow = vi.fn();
  const onAllowSession = vi.fn();
  const onDeny = vi.fn();
  render(
    <AgentPermissionDialog
      request={makeRequest()}
      isFocusedPane={props.isFocusedPane ?? true}
      onAllow={onAllow}
      onAllowSession={onAllowSession}
      onDeny={onDeny}
    />,
  );
  return { onAllow, onAllowSession, onDeny };
}

// `afterEach(cleanup)` is mandatory: `frontend/vite.config.ts` does not set
// `globals: true`, so Testing Library's auto-cleanup never registers.
afterEach(() => {
  cleanup();
});

describe("AgentPermissionDialog keyboard model", () => {
  it("Enter fires onAllow exactly once", async () => {
    const { onAllow, onAllowSession, onDeny } = renderDialog();
    await userEvent.keyboard("{Enter}");
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(onAllowSession).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("a and A both fire onAllowSession", async () => {
    const { onAllowSession } = renderDialog();
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyDown(window, { key: "A" });
    expect(onAllowSession).toHaveBeenCalledTimes(2);
  });

  it("Escape fires onDeny", async () => {
    const { onDeny } = renderDialog();
    await userEvent.keyboard("{Escape}");
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it("meta+A fires nothing — a select-all must not become a permission grant", () => {
    const { onAllow, onAllowSession, onDeny } = renderDialog();
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    expect(onAllow).not.toHaveBeenCalled();
    expect(onAllowSession).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("a keydown from inside [data-agent-composer] fires none of the three", () => {
    const composer = document.createElement("div");
    composer.setAttribute("data-agent-composer", "");
    const input = document.createElement("textarea");
    composer.appendChild(input);
    document.body.appendChild(composer);

    const { onAllow, onAllowSession, onDeny } = renderDialog();
    fireEvent.keyDown(input, { key: "a" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onAllow).not.toHaveBeenCalled();
    expect(onAllowSession).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();

    document.body.removeChild(composer);
  });

  it("with isFocusedPane={false}, none of the three keys fires anything", () => {
    const { onAllow, onAllowSession, onDeny } = renderDialog({ isFocusedPane: false });
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onAllow).not.toHaveBeenCalled();
    expect(onAllowSession).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("the Allow button holds focus on mount", () => {
    renderDialog();
    const [allowBtn] = screen.getAllByRole("button");
    expect(document.activeElement).toBe(allowBtn);
  });

  it("clicking each button fires the same handler as its key", async () => {
    const { onAllow, onAllowSession, onDeny } = renderDialog();
    const [allowBtn, allowSessionBtn, denyBtn] = screen.getAllByRole("button");
    const user = userEvent.setup();
    await user.click(allowBtn!);
    await user.click(allowSessionBtn!);
    await user.click(denyBtn!);
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(onAllowSession).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledTimes(1);
  });
});
