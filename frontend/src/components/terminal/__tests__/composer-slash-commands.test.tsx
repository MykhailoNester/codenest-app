// The regression this task exists to fix: the composer's `<textarea>` used
// to be a dumb text field, so typing `/model opus` and pressing Enter sent
// that literal string to `claude --print` as chat content. These tests pin
// that a command line now runs against the session instead — through the
// existing `agentSetModel`/`agentSetPermissionMode` IPC calls and the
// existing restart path — and that an unregistered `/foo` still falls
// through to text, but never silently.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AgentComposer } from "../agent-composer";
import { useComposerStore } from "../../../stores/composer-store";
import { useAgentSessionStore } from "../../../stores/agent-session-store";
import { useAgentCatalogStore } from "../../../stores/agent-catalog-store";
import { emptyConversation, type ConversationState } from "../../../lib/agent-conversation";

const {
  agentInterruptMock,
  agentSendMock,
  agentSetModelMock,
  agentSetPermissionModeMock,
  recordAgentExitedMock,
} = vi.hoisted(() => ({
  agentInterruptMock: vi.fn<(paneId: string) => Promise<undefined>>(async () => undefined),
  agentSendMock: vi.fn<(paneId: string, text: string) => Promise<undefined>>(
    async () => undefined,
  ),
  agentSetModelMock: vi.fn<(paneId: string, model: string) => Promise<undefined>>(
    async () => undefined,
  ),
  agentSetPermissionModeMock: vi.fn<(paneId: string, mode: string) => Promise<undefined>>(
    async () => undefined,
  ),
  recordAgentExitedMock: vi.fn<
    (paneId: string, exitCode: number | null, sessionId?: string | null) => undefined
  >(() => undefined),
}));

vi.mock("../../../lib/ipc", () => ({
  agentInterrupt: (paneId: string) => agentInterruptMock(paneId),
  agentSend: (paneId: string, text: string) => agentSendMock(paneId, text),
  agentSetModel: (paneId: string, model: string) => agentSetModelMock(paneId, model),
  agentSetPermissionMode: (paneId: string, mode: string) =>
    agentSetPermissionModeMock(paneId, mode),
}));

vi.mock("../../../lib/agent-run-telemetry", () => ({
  recordAgentExited: (paneId: string, exitCode: number | null, sessionId?: string | null) =>
    recordAgentExitedMock(paneId, exitCode, sessionId),
}));

// No test in this file types an `@`, but a `vi.mock` factory replaces the
// module wholesale, and `agent-composer.tsx` statically imports
// `composer-suggest.tsx` (the mention menu's data probe), which reaches
// these on any render path that mounts it.
vi.mock("../../../lib/api", () => ({
  useTasks: () => ({ data: [] }),
  useLibraryItems: () => ({ data: { items: [] } }),
  useTeamMembers: () => ({ data: [] }),
  fetchLibraryItemBySlug: vi.fn(async () => null),
  fetchSidecar: vi.fn(async () => []),
}));

const LEAF = "leaf-1";

const SEEDED_MODEL = { value: "claude-opus-4-6", label: "Opus 4.6" };

/** The pattern `agent-catalog-store.test.ts:42-52` uses. Without this,
 *  `ctx.models` is empty, `resolveOption` passes the arg through verbatim,
 *  and the `/model opus` assertions below would be exercising the wrong
 *  branch (round-1 note 7). */
function seedCatalog(): void {
  useAgentCatalogStore.setState({
    providers: [
      {
        id: 1,
        name: "claude-work",
        displayName: "claude-work",
        command: "claude-work {session_id}",
        env: {},
        models: [
          {
            id: 4,
            provider_id: 1,
            model_name: SEEDED_MODEL.value,
            display_name: SEEDED_MODEL.label,
            is_default: true,
            is_enabled: true,
          },
        ],
        defaultModel: SEEDED_MODEL.value,
      },
    ],
    loaded: true,
    loading: false,
    lastUsed: { providerId: 1, model: null },
  });
}

function seedSession(over: Partial<ConversationState> = {}): void {
  useAgentSessionStore.setState({
    panes: { [LEAF]: { ...emptyConversation(), status: "running", ...over } },
  });
}

function renderComposer(
  props: Partial<{
    status: ConversationState["status"];
    providerId: number | null;
    permissionMode: string | null;
    onRequestRestart: () => void;
  }> = {},
): void {
  render(
    <AgentComposer
      leafId={LEAF}
      status={props.status ?? "running"}
      providerId={props.providerId ?? 1}
      model={null}
      permissionMode={props.permissionMode ?? null}
      onRequestRestart={props.onRequestRestart ?? (() => undefined)}
    />,
  );
}

function editor(): HTMLTextAreaElement {
  return screen.getByPlaceholderText("Message the agent…") as HTMLTextAreaElement;
}

function typeDraft(text: string): void {
  fireEvent.change(editor(), { target: { value: text } });
}

function pressKey(key: string): void {
  fireEvent.keyDown(editor(), { key });
}

/** The suggestion panel's own rows — scoped to its `listbox`, since the
 *  mode/model/provider `<select>`s each render native `<option>` elements
 *  that would otherwise collide with a bare `getAllByRole("option")`. */
function suggestOptions(): HTMLElement[] {
  return within(screen.getByRole("listbox")).getAllByRole("option");
}

beforeEach(() => {
  useComposerStore.setState({ panes: {}, history: [] });
  useAgentSessionStore.setState({ panes: {}, sessionAllowed: {} });
  agentInterruptMock.mockClear();
  agentSendMock.mockClear();
  agentSetModelMock.mockClear();
  agentSetPermissionModeMock.mockClear();
  recordAgentExitedMock.mockClear();
});

afterEach(() => {
  cleanup();
  useAgentCatalogStore.setState({
    providers: [],
    loaded: false,
    loading: false,
    lastUsed: { providerId: null, model: null },
  });
});

describe("the removed /model and /mode commands — no second way in", () => {
  it("fall through to text instead of running, so the dropdowns stay authoritative", async () => {
    seedCatalog();
    seedSession();
    renderComposer();

    typeDraft("/model opus");
    expect(screen.getByText(/^\/model is not a Codenest command/)).toBeTruthy();
    pressKey("Enter");

    await waitFor(() => expect(agentSendMock).toHaveBeenCalledWith(LEAF, "/model opus"));
    expect(agentSetModelMock).not.toHaveBeenCalled();
  });

  it("never reach the permission-mode control channel either", async () => {
    seedCatalog();
    seedSession();
    renderComposer();

    typeDraft("/mode");
    pressKey("Enter");

    await waitFor(() => expect(agentSendMock).toHaveBeenCalledWith(LEAF, "/mode"));
    expect(agentSetPermissionModeMock).not.toHaveBeenCalled();
  });
});

describe("unregistered commands — decision 4", () => {
  it("falls through to text, with a visible warning before Enter is pressed", async () => {
    renderComposer();
    typeDraft("/nope");

    expect(screen.getByText(/^\/nope is not a Codenest command/)).toBeTruthy();

    pressKey("Enter");
    await waitFor(() => expect(agentSendMock).toHaveBeenCalledWith(LEAF, "/nope"));
  });

  it("suppresses the warning while the menu is offering candidates — round-1 note 3", () => {
    renderComposer();
    typeDraft("/c");

    expect(screen.queryByText(/is not a Codenest command/)).toBeNull();
  });
});

describe("/clear — decision 6", () => {
  it("restarts locally, empties the composer and transcript, and reports the exit under the ended session's id", async () => {
    const onRequestRestart = vi.fn();
    seedSession({ sessionId: "session-1" });
    useComposerStore.setState({
      panes: {
        [LEAF]: {
          draft: "",
          pills: [{ id: "p1", kind: "file", path: "/x" }],
          queued: [],
          fanoutAll: false,
        },
      },
      history: [],
    });
    renderComposer({ onRequestRestart });

    typeDraft("/clear");
    pressKey("Enter");

    await waitFor(() => expect(onRequestRestart).toHaveBeenCalledTimes(1));
    expect(recordAgentExitedMock).toHaveBeenCalledWith(LEAF, null, "session-1");
    expect(useAgentSessionStore.getState().panes[LEAF]).toBeUndefined();
    expect(useComposerStore.getState().panes[LEAF]?.pills ?? []).toEqual([]);
  });

  it("still runs on an exited session — Send is not disabled for a command", async () => {
    const onRequestRestart = vi.fn();
    seedSession({ status: "exited", sessionId: "session-1" });
    renderComposer({ status: "exited", onRequestRestart });

    typeDraft("/clear");
    expect((screen.getByRole("button", { name: /Run/ }) as HTMLButtonElement).disabled).toBe(false);

    pressKey("Enter");
    await waitFor(() => expect(onRequestRestart).toHaveBeenCalledTimes(1));
  });
});

describe("/compact — decision 5", () => {
  it("sends the literal command with no pill blocks, even with a pill attached", async () => {
    useComposerStore.setState({
      panes: {
        [LEAF]: {
          draft: "",
          pills: [{ id: "p1", kind: "template", slug: "s", title: "T", body: "B" }],
          queued: [],
          fanoutAll: false,
        },
      },
      history: [],
    });
    renderComposer();

    typeDraft("/compact");
    pressKey("Enter");

    await waitFor(() => expect(agentSendMock).toHaveBeenCalledWith(LEAF, "/compact"));
  });
});

describe("/help — decision 12", () => {
  it("opens a read-only panel listing every command and clears the draft", async () => {
    renderComposer();
    typeDraft("/help");
    pressKey("Enter");

    const panel = await screen.findByRole("note");
    // The boundary requires whitespace or end-of-string after the name so a
    // row cannot be matched by a command that merely prefixes it.
    for (const name of ["clear", "compact", "help"]) {
      expect(within(panel).getByText(new RegExp(`^/${name}(\\s|$)`))).toBeTruthy();
    }
    for (const gone of ["model", "mode"]) {
      expect(within(panel).queryByText(new RegExp(`^/${gone}(\\s|$)`))).toBeNull();
    }
    expect(within(panel).queryAllByRole("option")).toHaveLength(0);
    expect(editor().value).toBe("");
  });

  it("does not survive typing — Enter afterwards sends the new text, not a menu pick — round-1 gap 5", async () => {
    renderComposer();
    typeDraft("/help");
    pressKey("Enter");
    await screen.findByRole("note");

    typeDraft("hello there");
    expect(screen.queryByRole("note")).toBeNull();
    expect(editor().value).toBe("hello there");

    pressKey("Enter");
    await waitFor(() => expect(agentSendMock).toHaveBeenCalled());
    const lastCall = agentSendMock.mock.calls.at(-1);
    expect(lastCall?.[1]).toContain("hello there");
  });
});

describe("multi-line drafts — decision 3", () => {
  it("never lets a command line eat the prose that follows a newline", async () => {
    seedCatalog();
    renderComposer();
    fireEvent.change(editor(), { target: { value: "/compact\nplease explain" } });

    expect(screen.getByRole("button", { name: /^Send/ })).toBeTruthy();

    pressKey("Enter");
    await waitFor(() => expect(agentSendMock).toHaveBeenCalled());
    const sent = agentSendMock.mock.calls.at(-1)?.[1] as string;
    expect(sent).toContain("please explain");
  });
});

describe("queue", () => {
  it("is disabled while the draft is a registered command", () => {
    renderComposer({ status: "running" });
    typeDraft("/clear");
    expect((screen.getByRole("button", { name: /Queue/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("keyboard precedence", () => {
  it("Escape closes the menu without interrupting; with the menu closed it still interrupts", async () => {
    renderComposer({ status: "running" });
    typeDraft("/c");
    expect(screen.getByRole("listbox")).toBeTruthy();

    pressKey("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(agentInterruptMock).not.toHaveBeenCalled();

    pressKey("Escape");
    await waitFor(() => expect(agentInterruptMock).toHaveBeenCalledWith(LEAF));
  });
});

describe("menu navigation — decision 12's memo-identity argument", () => {
  it("moves the highlight on ArrowDown twice, surviving the re-render each keystroke causes", () => {
    renderComposer();
    typeDraft("/c");

    const rows = suggestOptions;
    expect(rows()).toHaveLength(2); // /clear, /compact
    expect(rows()[0]?.getAttribute("data-active")).toBe("true");

    pressKey("ArrowDown");
    expect(rows()[1]?.getAttribute("data-active")).toBe("true");

    pressKey("ArrowDown");
    // Wraps back to the first row — and moved *again*, proving the first
    // ArrowDown's highlight was not reset by its own re-render.
    expect(rows()[0]?.getAttribute("data-active")).toBe("true");
  });
});
