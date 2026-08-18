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

// jsdom ships no `ResizeObserver`; the composer constructs one over
// `.editorStack` to re-anchor the open command menu. Nothing here asserts on
// the anchor, so a no-op is enough — see `composer-mention-menu.test.tsx` for
// the stub that actually drives a resize.
class StubResizeObserver {
  observe(): void {
    /* no-op */
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
  StubResizeObserver as unknown as typeof ResizeObserver;

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

// A `vi.mock` factory replaces the module wholesale, and `agent-composer.tsx`
// statically imports `composer-suggest.tsx` (the menus' data probe), which
// reaches these on any render path that mounts it — which now includes typing a
// `/`, because the slash menu is fed from the same invocables catalog (#47).
// `catalogRef` is a hoisted holder so a test can seed that catalog before
// rendering; `undefined` is the still-loading/failed shape.
//
// Each hook returns one *stable* `data`, the way react-query does. Rebuilding
// `{ data: [] }` per call would make the probe's `sources` memo recompute every
// render, its `onSources` effect fire every render, and the parent setState that
// effect performs re-render forever — a live infinite loop, not a stale value.
const { catalogRef, EMPTY_TASKS, EMPTY_LIBRARY } = vi.hoisted(() => ({
  catalogRef: { current: undefined as unknown },
  EMPTY_TASKS: { data: [] as unknown[] },
  EMPTY_LIBRARY: { data: { items: [] as unknown[] } },
}));

vi.mock("../../../lib/api", () => ({
  useTasks: () => EMPTY_TASKS,
  useLibraryItems: () => EMPTY_LIBRARY,
  useInvocables: () => ({ data: catalogRef.current }),
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
        color: null,
      },
    ],
    loaded: true,
    loading: false,
    lastUsed: { providerId: 1, model: null },
  });
}

/** The four commands this repo actually ships, as the catalog reports them. */
const PROJECT_COMMANDS = [
  {
    name: "code-review-pr",
    alias: "codenest-app:code-review-pr",
    invoke_token: "/code-review-pr",
    description: "Reviews a pull request opened by someone else.",
    argument_hint: "<PR number | branch | URL>",
  },
  {
    name: "commit-message",
    alias: "codenest-app:commit-message",
    invoke_token: "/commit-message",
    description: "Generates a git commit message in project format.",
    argument_hint: null,
  },
  {
    name: "generate-pull-request",
    alias: "codenest-app:generate-pull-request",
    invoke_token: "/generate-pull-request",
    description: "Prepares pull request text locally.",
    argument_hint: null,
  },
  {
    name: "ship",
    alias: "codenest-app:ship",
    invoke_token: "/ship",
    description: "Autonomous delivery pipeline, two lanes.",
    argument_hint: "<#24 #25 …>",
  },
];

function seedInvocables(): void {
  catalogRef.current = {
    scope: "project",
    cwd: "/repo",
    project_id: 3,
    project_name: "codenest-app",
    agents: [],
    skills: [],
    commands: PROJECT_COMMANDS.map((c) => ({
      kind: "project",
      project_id: 3,
      project_name: "codenest-app",
      canonical_path: `/repo/.claude/commands/${c.name}.md`,
      link_path: null,
      verify_status: "ok",
      shared: true,
      ...c,
    })),
    shadowed: [],
  };
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
  catalogRef.current = undefined;
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
  it("empties the transcript and pills but keeps the very same session running", async () => {
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

    await waitFor(() => expect(agentSendMock).toHaveBeenCalledWith(LEAF, "/clear"));

    // The three symptoms this command used to cause, each asserted absent.
    // A restart while the old process is still registered is what produced
    // "agent session already running" and wedged the pane.
    expect(onRequestRestart).not.toHaveBeenCalled();
    // Reporting an exit is what made the sidecar announce the run as finished
    // and the pane render "Session ended (exit 0)" behind a Restart button.
    expect(recordAgentExitedMock).not.toHaveBeenCalled();

    const pane = useAgentSessionStore.getState().panes[LEAF];
    expect(pane).toBeDefined();
    expect(pane?.sessionId).toBe("session-1");
    expect(pane?.status).not.toBe("exited");
    expect(pane?.turns).toEqual([]);
    expect(useComposerStore.getState().panes[LEAF]?.pills ?? []).toEqual([]);
  });

  it("clears locally without a doomed forward when the session has already ended", async () => {
    const onRequestRestart = vi.fn();
    seedSession({ status: "exited", sessionId: "session-1" });
    renderComposer({ status: "exited", onRequestRestart });

    typeDraft("/clear");
    expect((screen.getByRole("button", { name: /Run/ }) as HTMLButtonElement).disabled).toBe(false);

    pressKey("Enter");

    await waitFor(() =>
      expect(useAgentSessionStore.getState().panes[LEAF]?.turns).toEqual([]),
    );
    expect(agentSendMock).not.toHaveBeenCalled();
    expect(onRequestRestart).not.toHaveBeenCalled();
    expect(recordAgentExitedMock).not.toHaveBeenCalled();
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

describe("untypeable characters \u2014 the macOS arrow-key bug", () => {
  // WebKit inserts NSRightArrowFunctionKey (U+F703) into the field when it
  // does not resolve the press to an editing command, which is why pressing
  // Right five times left five tofu boxes in the draft.
  const RIGHT = "\uF703";

  it("keeps arrow-key codepoints out of the draft and out of the wire", async () => {
    renderComposer();

    typeDraft(RIGHT.repeat(5));
    expect(editor().value).toBe("");
    expect(useComposerStore.getState().panes[LEAF]?.draft ?? "").toBe("");

    typeDraft(`ship${RIGHT} it`);
    expect(editor().value).toBe("ship it");

    pressKey("Enter");
    await waitFor(() => expect(agentSendMock).toHaveBeenCalled());
    const sent = agentSendMock.mock.calls.at(-1)?.[1] as string;
    expect(sent).toContain("ship it");
    expect(sent).not.toContain(RIGHT);
  });

  it("does not disturb ordinary text", () => {
    renderComposer();
    typeDraft("hello \uD83C\uDF89 world");
    expect(editor().value).toBe("hello \uD83C\uDF89 world");
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

describe("a project's own commands — #47", () => {
  it("offers them below the built-ins, with their descriptions, for a bare `/`", async () => {
    seedInvocables();
    renderComposer();

    typeDraft("/");

    // The probe reports the catalog on the effect after the `/` renders.
    await waitFor(() => expect(suggestOptions()).toHaveLength(3 + 4));
    const labels = suggestOptions().map((row) => row.textContent);
    expect(labels[0]).toContain("/clear");
    expect(labels[3]).toContain("/code-review-pr");
    expect(labels[3]).toContain("Reviews a pull request opened by someone else.");
    // Two group headers, one per run — built-ins first.
    const groups = within(screen.getByRole("listbox"))
      .getAllByText(/^(commands|project commands)$/)
      .map((el) => el.textContent);
    expect(groups).toEqual(["commands", "project commands"]);
  });

  it("stops calling a shipped command unregistered, and forwards it verbatim", async () => {
    seedInvocables();
    seedSession();
    renderComposer();

    typeDraft("/ship");
    await waitFor(() => expect(suggestOptions()).toHaveLength(1));
    // Dismissing the menu is what used to reveal the warning — so this asserts
    // the *lookup* found the command, not just that the menu suppressed the row.
    pressKey("Escape");
    expect(screen.queryByText(/is not a Codenest command/)).toBeNull();

    pressKey("Enter");
    await waitFor(() => expect(agentSendMock).toHaveBeenCalledWith(LEAF, "/ship"));
  });

  it("sends the argument along as typed", async () => {
    seedInvocables();
    seedSession();
    renderComposer();

    typeDraft("/ship #47 --dry-run");
    // One row: the typed argument, labelled with the file's argument-hint.
    await waitFor(() => expect(suggestOptions()).toHaveLength(1));
    expect(suggestOptions()[0]?.textContent).toContain("<#24 #25 …>");

    pressKey("Enter");
    await waitFor(() =>
      expect(agentSendMock).toHaveBeenCalledWith(LEAF, "/ship #47 --dry-run"),
    );
  });

  it("completes to `/name ` rather than firing a command that expects an argument", async () => {
    seedInvocables();
    seedSession();
    renderComposer();

    typeDraft("/ship");
    await waitFor(() => expect(suggestOptions()).toHaveLength(1));
    pressKey("Enter");

    // Deliberate two-step for a command declaring an `argument-hint`: the pick
    // hands the caret back with the argument still to write. A command with no
    // hint has nothing to wait for and runs on pick, like every built-in.
    expect(editor().value).toBe("/ship ");
    expect(agentSendMock).not.toHaveBeenCalled();
  });

  it("still warns about a genuinely unknown command", async () => {
    seedInvocables();
    renderComposer();

    typeDraft("/nope");
    await waitFor(() =>
      expect(screen.getByText(/^\/nope is not a Codenest command/)).toBeTruthy(),
    );
    pressKey("Enter");
    await waitFor(() => expect(agentSendMock).toHaveBeenCalledWith(LEAF, "/nope"));
  });

  it("lists them in the /help panel too", async () => {
    seedInvocables();
    renderComposer();

    typeDraft("/help");
    pressKey("Enter");

    const panel = await screen.findByRole("note");
    await waitFor(() =>
      expect(within(panel).getByText(/^\/ship(\s|$)/)).toBeTruthy(),
    );
    for (const name of ["clear", "compact", "help", "commit-message"]) {
      expect(within(panel).getByText(new RegExp(`^/${name}(\\s|$)`))).toBeTruthy();
    }
  });

  it("degrades to the three built-ins when the catalog has not answered", async () => {
    // `catalogRef` is left undefined — a failed or still-loading fetch must not
    // turn the menu into an error surface.
    renderComposer();
    typeDraft("/");

    await waitFor(() => expect(suggestOptions()).toHaveLength(3));
    expect(screen.queryByText("project commands")).toBeNull();
  });
});
