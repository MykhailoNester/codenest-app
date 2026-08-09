// The `@`-mention overlay used to be a purely cosmetic, read-only div — this
// pins that it is now a live suggestion trigger over Codenest agents, open
// tasks and library snippets (Design decision 7/10), and that mounting it
// costs nothing until an `@` token actually exists.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentComposer } from "../agent-composer";
import { useComposerStore } from "../../../stores/composer-store";
import { useAgentSessionStore } from "../../../stores/agent-session-store";
import { useAgentCatalogStore } from "../../../stores/agent-catalog-store";

const {
  agentSendMock,
  useTasksMock,
  useLibraryItemsMock,
  useTeamMembersMock,
  fetchLibraryItemBySlugMock,
} = vi.hoisted(() => ({
  agentSendMock: vi.fn<(paneId: string, text: string) => Promise<undefined>>(
    async () => undefined,
  ),
  useTasksMock: vi.fn(),
  useLibraryItemsMock: vi.fn(),
  useTeamMembersMock: vi.fn(),
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
  useTeamMembers: () => useTeamMembersMock(),
  fetchLibraryItemBySlug: (slug: string) => fetchLibraryItemBySlugMock(slug),
  fetchSidecar: vi.fn(async () => []),
}));

const LEAF = "leaf-1";

function renderComposer(): void {
  render(
    <AgentComposer
      leafId={LEAF}
      status="running"
      providerId={null}
      model={null}
      permissionMode={null}
      onRequestRestart={() => undefined}
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

beforeEach(() => {
  useComposerStore.setState({ panes: {}, history: [] });
  useAgentSessionStore.setState({ panes: {}, sessionAllowed: {} });
  agentSendMock.mockClear();
  fetchLibraryItemBySlugMock.mockClear();
  useTasksMock.mockClear();
  useLibraryItemsMock.mockClear();
  useTeamMembersMock.mockClear();
  useTasksMock.mockReturnValue({
    data: [{ id: 4, title: "Align the migration", status: "todo", description: "the plan" }],
  });
  useLibraryItemsMock.mockReturnValue({
    data: { items: [{ id: 1, slug: "aliasing-notes", title: "Aliasing notes", body: "…", tags: [], source: "", created_at: "", updated_at: "" }] },
  });
  useTeamMembersMock.mockReturnValue({
    data: [
      {
        id: 1,
        name: "Alice Ops",
        role: "ops",
        type: "agent",
        subtype: null,
        department: null,
        status: "active",
        agent_file: "/w/.claude/agents/alice-ops.md",
        joined_date: null,
        notes: null,
      },
      {
        id: 2,
        name: "Bob Human",
        role: "eng",
        type: "human",
        subtype: null,
        department: null,
        status: "active",
        agent_file: null,
        joined_date: null,
        notes: null,
      },
    ],
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
  it("lists a matching agent, task and snippet with group headers", async () => {
    renderComposer();
    typeDraft("@ali");

    const listbox = await screen.findByRole("listbox");
    expect(listbox.textContent).toContain("Alice Ops");
    expect(listbox.textContent).toContain("Align the migration");
    expect(listbox.textContent).toContain("Aliasing notes");
    // Only the human member (not `type: "agent"`) and never appears.
    expect(listbox.textContent).not.toContain("Bob Human");
    expect(listbox.textContent).toContain("agents");
    expect(listbox.textContent).toContain("tasks");
    expect(listbox.textContent).toContain("snippets");
  });

  it("opens nothing for a bare `@`", () => {
    renderComposer();
    typeDraft("@");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens nothing for a mid-word `@` that matches no one — round-1 gap 2", () => {
    useTasksMock.mockReturnValue({ data: [] });
    useLibraryItemsMock.mockReturnValue({ data: { items: [] } });
    useTeamMembersMock.mockReturnValue({ data: [] });
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

  it("inserts @agent-<slug> and attaches no pill when an agent row is picked", async () => {
    renderComposer();
    typeDraft("@ali");
    await screen.findByRole("listbox");

    fireEvent.click(screen.getByText("Alice Ops"));

    await waitFor(() => expect(editor().value).toBe("@agent-alice-ops "));
    expect(useComposerStore.getState().panes[LEAF]?.pills ?? []).toEqual([]);
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
    expect(useTeamMembersMock).not.toHaveBeenCalled();

    typeDraft("@ali");
    expect(useTeamMembersMock).toHaveBeenCalled();
  });
});
