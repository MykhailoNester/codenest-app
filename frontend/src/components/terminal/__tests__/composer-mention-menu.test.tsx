// The `@`-mention overlay used to be a purely cosmetic, read-only div — this
// pins that it is now a live suggestion trigger over the workspace's invocable
// agents and skills, open tasks and library snippets (Design decision 7/10),
// and that mounting it costs nothing until an `@` token actually exists.
//
// The agent group reads the sidecar's invocables catalog, scoped to the pane's
// cwd. It used to read the hand-curated `members` table, which is empty on a
// normal install — so the group was structurally always empty however many
// agents the workspace had linked, which is the bug these tests now guard.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentComposer } from "../agent-composer";
import { useComposerStore } from "../../../stores/composer-store";
import { useAgentSessionStore } from "../../../stores/agent-session-store";
import { useAgentCatalogStore } from "../../../stores/agent-catalog-store";

const {
  agentSendMock,
  useTasksMock,
  useLibraryItemsMock,
  useInvocablesMock,
  fetchLibraryItemBySlugMock,
} = vi.hoisted(() => ({
  agentSendMock: vi.fn<(paneId: string, text: string) => Promise<undefined>>(
    async () => undefined,
  ),
  useTasksMock: vi.fn(),
  useLibraryItemsMock: vi.fn(),
  useInvocablesMock: vi.fn<(cwd?: string | null) => unknown>(),
  fetchLibraryItemBySlugMock: vi.fn<(slug: string) => Promise<null>>(async () => null),
}));

vi.mock("../../../lib/ipc", () => ({
  agentInterrupt: vi.fn(async () => undefined),
  agentSend: (paneId: string, text: string) => agentSendMock(paneId, text),
  agentSetModel: vi.fn(async () => undefined),
  agentSetPermissionMode: vi.fn(async () => undefined),
}));

vi.mock("../../../lib/agent-run-telemetry", () => ({
  recordAgentExited: vi.fn(),
}));

vi.mock("../../../lib/api", () => ({
  useTasks: () => useTasksMock(),
  useLibraryItems: () => useLibraryItemsMock(),
  useInvocables: (cwd?: string | null) => useInvocablesMock(cwd),
  fetchLibraryItemBySlug: (slug: string) => fetchLibraryItemBySlugMock(slug),
  fetchSidecar: vi.fn(async () => []),
}));

// jsdom implements no layout and so ships no `ResizeObserver`; the composer
// constructs one over `.editorStack` to re-anchor an open suggestion panel.
// Unlike the no-op stubs elsewhere in this directory, this one keeps the live
// callbacks so a resize can be driven deliberately — the re-anchor is the
// behaviour under test, not incidental setup.
const resizeCallbacks = new Set<ResizeObserverCallback>();

class StubResizeObserver {
  // Assigned in the body rather than as a constructor parameter property:
  // `erasableSyntaxOnly` in tsconfig.app.json rejects the shorthand.
  private readonly cb: ResizeObserverCallback;

  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }

  observe(): void {
    resizeCallbacks.add(this.cb);
  }
  unobserve(): void {
    resizeCallbacks.delete(this.cb);
  }
  disconnect(): void {
    resizeCallbacks.delete(this.cb);
  }
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
  StubResizeObserver as unknown as typeof ResizeObserver;

/** Runs every observer the composer has attached, as the browser would after
 *  `.editorStack` has been re-laid-out. */
function fireStackResize(): void {
  act(() => {
    for (const cb of [...resizeCallbacks]) cb([], {} as ResizeObserver);
  });
}

const LEAF = "leaf-1";

function renderComposer(cwd?: string): void {
  render(
    <AgentComposer
      leafId={LEAF}
      status="running"
      providerId={null}
      model={null}
      permissionMode={null}
      cwd={cwd}
      onRequestRestart={() => undefined}
    />,
  );
}

/** A catalog row as the sidecar returns it. */
function invocable(over: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "project",
    display_name: null,
    description: null,
    model: null,
    project_id: 5,
    project_name: "miragold",
    canonical_path: "/repo/.claude/agents/x.md",
    link_path: "/ws/.claude/agents/x.md",
    verify_status: "ok",
    shared: true,
    ...over,
  };
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

beforeEach(() => {
  useComposerStore.setState({ panes: {}, history: [] });
  useAgentSessionStore.setState({ panes: {}, sessionAllowed: {} });
  agentSendMock.mockClear();
  fetchLibraryItemBySlugMock.mockClear();
  useTasksMock.mockClear();
  useLibraryItemsMock.mockClear();
  useInvocablesMock.mockClear();
  useTasksMock.mockReturnValue({
    data: [{ id: 4, title: "Align the migration", status: "todo", description: "the plan" }],
  });
  useLibraryItemsMock.mockReturnValue({
    data: { items: [{ id: 1, slug: "aliasing-notes", title: "Aliasing notes", body: "…", tags: [], source: "", created_at: "", updated_at: "" }] },
  });
  useInvocablesMock.mockReturnValue({
    data: {
      scope: "workspace",
      cwd: null,
      project_id: null,
      project_name: null,
      agents: [
        invocable({
          name: "aliasing-agent",
          alias: "miragold:aliasing-agent",
          invoke_token: "@agent-aliasing-agent",
          description: "Reviews aliasing.",
        }),
        invocable({
          name: "miragold--code-reviewer",
          alias: "miragold:code-reviewer",
          invoke_token: "@agent-miragold--code-reviewer",
          materialized: true,
        }),
      ],
      skills: [
        invocable({
          name: "aliasing-skill",
          alias: "miragold:aliasing-skill",
          invoke_token: "/aliasing-skill",
        }),
      ],
      commands: [],
      shadowed: [],
    },
  });
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

describe("@ mention menu", () => {
  it("lists a matching agent, skill, task and snippet with group headers", async () => {
    renderComposer();
    typeDraft("@ali");

    const listbox = await screen.findByRole("listbox");
    expect(listbox.textContent).toContain("miragold:aliasing-agent");
    expect(listbox.textContent).toContain("miragold:aliasing-skill");
    expect(listbox.textContent).toContain("Align the migration");
    expect(listbox.textContent).toContain("Aliasing notes");
    expect(listbox.textContent).toContain("agents");
    expect(listbox.textContent).toContain("skills");
    expect(listbox.textContent).toContain("tasks");
    expect(listbox.textContent).toContain("snippets");
  });

  it("scopes the catalog to the pane's cwd", async () => {
    renderComposer("/repo/miragold");
    typeDraft("@ali");
    await screen.findByRole("listbox");

    expect(useInvocablesMock).toHaveBeenCalledWith("/repo/miragold");
  });

  it("still lists agents when the catalog fetch failed — no error state", async () => {
    useInvocablesMock.mockReturnValue({ data: undefined });
    renderComposer();
    typeDraft("@ali");

    const listbox = await screen.findByRole("listbox");
    expect(listbox.textContent).toContain("Align the migration");
    expect(listbox.textContent).not.toContain("agents");
  });

  it("opens nothing for a bare `@`", () => {
    renderComposer();
    typeDraft("@");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens nothing for a mid-word `@` that matches no one — round-1 gap 2", () => {
    useTasksMock.mockReturnValue({ data: [] });
    useLibraryItemsMock.mockReturnValue({ data: { items: [] } });
    useInvocablesMock.mockReturnValue({ data: undefined });
    renderComposer();
    typeDraft("user@host");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("attaches a task pill and removes the token when a task row is picked", async () => {
    renderComposer();
    typeDraft("@ali");
    await screen.findByRole("listbox");

    fireEvent.click(screen.getByText("Align the migration"));

    const pane = useComposerStore.getState().panes[LEAF];
    expect(pane?.pills).toEqual([
      expect.objectContaining({ kind: "task", taskId: 4, title: "Align the migration" }),
    ]);
    expect(pane?.draft).toBe("");
  });

  it("attaches a template pill carrying the body when a library row is picked", async () => {
    renderComposer();
    typeDraft("@ali");
    await screen.findByRole("listbox");

    fireEvent.click(screen.getByText("Aliasing notes"));

    const pane = useComposerStore.getState().panes[LEAF];
    expect(pane?.pills).toEqual([
      expect.objectContaining({ kind: "template", slug: "aliasing-notes", title: "Aliasing notes", body: "…" }),
    ]);
  });

  it("inserts the catalog's own token and attaches no pill when an agent is picked", async () => {
    renderComposer();
    typeDraft("@ali");
    await screen.findByRole("listbox");

    fireEvent.click(screen.getByText("miragold:aliasing-agent"));

    await waitFor(() => expect(editor().value).toBe("@agent-aliasing-agent "));
    expect(useComposerStore.getState().panes[LEAF]?.pills ?? []).toEqual([]);
  });

  it("inserts a materialized alias's token, not its display label (#45)", async () => {
    renderComposer();
    typeDraft("@code-rev");
    await screen.findByRole("listbox");

    fireEvent.click(screen.getByText("miragold:code-reviewer"));

    await waitFor(() =>
      expect(editor().value).toBe("@agent-miragold--code-reviewer "),
    );
  });

  it("inserts `/<skill>` when the pick is the whole draft", async () => {
    renderComposer();
    typeDraft("@alias");
    await screen.findByRole("listbox");

    fireEvent.click(screen.getByText("miragold:aliasing-skill"));

    await waitFor(() => expect(editor().value).toBe("/aliasing-skill "));
  });

  it("inserts a bare skill name mid-sentence, where `/x` would not be a command", async () => {
    renderComposer();
    typeDraft("please use @alias");
    await screen.findByRole("listbox");

    fireEvent.click(screen.getByText("miragold:aliasing-skill"));

    await waitFor(() => expect(editor().value).toBe("please use aliasing-skill "));
  });

  it("fetches by slug on Enter, and reports a miss or a failure — the shared resolver is really used", async () => {
    renderComposer();
    typeDraft("@library:not-in-page");
    await screen.findByRole("listbox");

    pressKey("Enter");
    await waitFor(() =>
      expect(screen.getByText("No library item @library:not-in-page")).toBeTruthy(),
    );
    expect(fetchLibraryItemBySlugMock).toHaveBeenCalledWith("not-in-page");

    fetchLibraryItemBySlugMock.mockRejectedValueOnce(new Error("sidecar unreachable"));
    typeDraft("@library:also-missing");
    await screen.findByRole("listbox");
    pressKey("Enter");
    await waitFor(() =>
      expect(screen.getByText(/^Library lookup failed: sidecar unreachable/)).toBeTruthy(),
    );
  });

  it("keeps the mention data probe out of the DOM until an `@` token exists — decision 10", () => {
    renderComposer();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(useInvocablesMock).not.toHaveBeenCalled();

    typeDraft("@ali");
    expect(useInvocablesMock).toHaveBeenCalled();
  });

  // The bug: picking a mention attaches a context pill, the pill row grows (a
  // chip can wrap to a second line), and `.editorStack` gets taller — but the
  // measuring effect depends only on the draft, the trigger and the row count,
  // so nothing re-ran and the next menu opened against the pre-pill geometry.
  // `caretAnchor` derives `bottom` from the stack's height, so a stale height
  // is exactly a vertically offset panel.
  it("re-anchors an open menu when the editor stack changes height", async () => {
    let stackHeight = 120;
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => stackHeight,
    });
    try {
      renderComposer();
      typeDraft("@ali");
      const before = (await screen.findByRole("listbox")).style.bottom;
      expect(parseFloat(before)).toBeGreaterThan(0);

      // One wrapped pill line taller. Nothing the measuring effect depends on
      // has changed — only the box.
      stackHeight = 160;
      fireStackResize();

      expect(parseFloat(screen.getByRole("listbox").style.bottom)).toBe(
        parseFloat(before) + 40,
      );
    } finally {
      // `clientHeight` is readonly in lib.dom, so `delete` is a type error;
      // removing the own property restores jsdom's inherited getter all the same.
      Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    }
  });
});
