import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LaunchComposer } from "../launch-composer";
import {
  useAgentCatalogStore,
  type CatalogProvider,
} from "../../../stores/agent-catalog-store";
import { composeSectionPrompt } from "../../../lib/launch-composer";
import type { LaunchComposerPlan } from "../../../lib/launch-composer";
import type { LaunchPromptSection } from "../../../lib/launch-seed";
import {
  SidecarError,
  type LaunchPreset,
  type LaunchPresetCreate,
} from "../../../lib/api";

// The module-mock pattern `components/__tests__/import-projects-modal.test.tsx:22-35`
// already uses, kept *partial* (via `importOriginal`) rather than a full
// replace: `agent-catalog-store.ts` imports the real `fetchSidecar` from this
// same module at runtime, and the cold-catalog cases below need that real
// implementation intact (they stub `globalThis.fetch`, not `fetchSidecar`).
//
// `useLaunchPresets`/`useCreateLaunchPreset` are mocked too — these renders
// have no `QueryClientProvider`, so a real `useQuery`/`useMutation` throws
// "No QueryClient set". This is a test-harness change only: every existing
// assertion below is untouched.
const {
  mockUseProjects,
  mockUseLookups,
  mockUseLaunchPresets,
  mockUseCreateLaunchPreset,
  mockUseDeleteLaunchPreset,
} = vi.hoisted(() => ({
  mockUseProjects: vi.fn(),
  mockUseLookups: vi.fn(),
  mockUseLaunchPresets: vi.fn(),
  mockUseCreateLaunchPreset: vi.fn(),
  mockUseDeleteLaunchPreset: vi.fn(),
}));

vi.mock("../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api")>();
  return {
    ...actual,
    useProjects: () => mockUseProjects(),
    useLookups: () => mockUseLookups(),
    useLaunchPresets: () => mockUseLaunchPresets(),
    useCreateLaunchPreset: () => mockUseCreateLaunchPreset(),
    useDeleteLaunchPreset: () => mockUseDeleteLaunchPreset(),
  };
});

interface TestProject {
  id: number;
  name: string;
  path: string | null;
}

function project(overrides: Partial<TestProject> = {}): TestProject {
  return { id: 1, name: "codenest", path: "/repo/codenest", ...overrides };
}

function provider(overrides: Partial<CatalogProvider> = {}): CatalogProvider {
  return {
    id: 1,
    name: "anthropic",
    displayName: "Anthropic",
    command: "claude {session_id}",
    env: {},
    models: [],
    defaultModel: null,
    color: null,
    ...overrides,
  };
}

function resetStore(): void {
  useAgentCatalogStore.setState({
    providers: [],
    loaded: false,
    loading: false,
    lastUsed: { providerId: null, model: null },
  });
}

// `.lp-ghost`/`.lp-recipe`/`.lp-seg` buttons all pair an icon glyph with a
// label, so an exact accessible-name match is brittle (and, for the "Shell"
// label, ambiguous — the pane-kind toggle and the "+ Shell" button would
// both match). Finding by class + a precise text check sidesteps both.
function ghostButton(label: string): HTMLButtonElement {
  const btn = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".lp-ghost"),
  ).find((b) => b.textContent?.includes(label));
  if (!btn) throw new Error(`no .lp-ghost button containing "${label}"`);
  return btn;
}

function recipeButton(label: string): HTMLButtonElement {
  const btn = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".lp-recipe"),
  ).find((b) => b.querySelector("b")?.textContent === label);
  if (!btn) throw new Error(`no .lp-recipe button labelled "${label}"`);
  return btn;
}

function paneKindToggle(label: "Agent" | "Shell"): HTMLButtonElement {
  const btn = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      ".lp-insp__acts .lp-seg button",
    ),
  ).find((b) => b.textContent === label);
  if (!btn) throw new Error(`no pane-kind toggle labelled "${label}"`);
  return btn;
}

function footerText(): string {
  return document.querySelector(".lp-summary")?.textContent ?? "";
}

function launchButton(): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(".lp-btn--primary");
  if (!btn) throw new Error("no primary launch button");
  return btn;
}

function promptSection(
  overrides: Partial<LaunchPromptSection> = {},
): LaunchPromptSection {
  return {
    id: "title",
    label: "Title + ref",
    text: "You are working on task #7: Investigate CI",
    tokens: 11,
    default_on: true,
    ...overrides,
  };
}

function saveAsPresetButton(): HTMLButtonElement {
  return ghostButton("Save as preset");
}

function fakePreset(overrides: Partial<LaunchPreset> = {}): LaunchPreset {
  return {
    id: 7,
    name: "Saved preset",
    project_id: 1,
    provider_id: 1,
    rows: 1,
    cols: 2,
    extra_args: "",
    target: "embedded",
    profile_id: null,
    created_at: "2026-01-01 00:00:00",
    cells: null,
    panes: [
      {
        kind: "agent",
        provider_id: 1,
        model: "opus",
        permission_mode: "",
        send_prompt: true,
      },
      { kind: "shell", shell: "", command: "npm run dev" },
    ],
    split: "cols",
    shape: "panes",
    unresolved: [],
    ...overrides,
  };
}

/** The prompt's current text, whichever of the view/edit pair is rendered. */
function promptText(): string {
  const pre = document.querySelector(".lp-promptview pre");
  if (pre) return pre.textContent ?? "";
  const textarea = document.querySelector<HTMLTextAreaElement>(".lp-prompt");
  return textarea?.value ?? "";
}

/** The Ticket context header's `~X.XXk tokens` total — distinct from the
 *  Prompt section's own `.lp-h__meta` ("N of M agent panes"). */
function ticketContextTotal(): string {
  const heading = Array.from(document.querySelectorAll(".lp-h--row")).find(
    (el) => el.querySelector("span")?.textContent === "Ticket context",
  );
  const meta = heading?.querySelector(".lp-h__meta");
  if (!meta) throw new Error("no Ticket context header");
  return meta.textContent ?? "";
}

function ctxRow(label: string): HTMLElement {
  const row = Array.from(document.querySelectorAll<HTMLElement>(".lp-ctxrow")).find(
    (el) => el.querySelector(".lp-ctxrow__l")?.textContent === label,
  );
  if (!row) throw new Error(`no .lp-ctxrow labelled "${label}"`);
  return row;
}

function ctxCheckbox(label: string): HTMLInputElement {
  const input = ctxRow(label).querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!input) throw new Error(`no checkbox in the "${label}" row`);
  return input;
}

let createPresetMutateAsync: ReturnType<typeof vi.fn>;
let deletePresetMutateAsync: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockUseProjects.mockReturnValue({ data: [project()] });
  mockUseLookups.mockReturnValue({ data: { profiles: [] } });
  useAgentCatalogStore.setState({
    providers: [provider()],
    loaded: true,
    loading: false,
    lastUsed: { providerId: null, model: null },
  });

  mockUseLaunchPresets.mockReturnValue({ data: [] });
  createPresetMutateAsync = vi.fn().mockResolvedValue(fakePreset());
  mockUseCreateLaunchPreset.mockReturnValue({
    mutateAsync: createPresetMutateAsync,
    isPending: false,
  });
  deletePresetMutateAsync = vi.fn().mockResolvedValue({ ok: true });
  mockUseDeleteLaunchPreset.mockReturnValue({
    mutateAsync: deletePresetMutateAsync,
    isPending: false,
  });
});

afterEach(() => {
  cleanup();
  resetStore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LaunchComposer", () => {
  it("renders 'Launch session' with no ref when opened without a source", () => {
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);
    expect(document.querySelector(".lp-head__t")?.textContent).toBe(
      "Launch session",
    );
    expect(document.querySelector(".lp-head__ref")).toBeNull();
  });

  it("shows the #<id> ref and the source title when a source is given", () => {
    render(
      <LaunchComposer
        open
        onClose={vi.fn()}
        onLaunch={vi.fn()}
        source={{ kind: "task", id: 42, title: "Fix the thing" }}
      />,
    );
    expect(document.querySelector(".lp-head__ref")?.textContent).toBe("#42");
    expect(document.querySelector(".lp-head__s")?.textContent).toContain(
      "Fix the thing",
    );
  });

  it("degrades to a readable disabled state with zero providers and zero projects, without throwing", () => {
    useAgentCatalogStore.setState({
      providers: [],
      loaded: true,
      loading: false,
    });
    mockUseProjects.mockReturnValue({ data: [] });

    expect(() =>
      render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />),
    ).not.toThrow();

    const selects = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".lp-select"),
    );
    const providerTrigger = selects.find((b) =>
      b.textContent?.includes("No providers configured"),
    );
    const projectTrigger = selects.find((b) =>
      b.textContent?.includes("No project with a path"),
    );
    expect(providerTrigger?.disabled).toBe(true);
    expect(projectTrigger?.disabled).toBe(true);

    expect(launchButton().disabled).toBe(true);
    expect(launchButton().getAttribute("title")).not.toBeNull();
  });

  it("a catalog arriving after mount converges the default pane onto a real provider", () => {
    useAgentCatalogStore.setState({
      providers: [],
      loaded: false,
      loading: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("sidecar not up yet");
      }),
    );

    const onLaunch = vi.fn();
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={onLaunch} />);

    expect(document.querySelector(".lp-pane__body")?.textContent).toBe(
      "Unknown provider",
    );

    const p1 = provider({
      id: 11,
      displayName: "Anthropic",
      defaultModel: "opus",
    });
    const p2 = provider({ id: 12, displayName: "OpenAI", defaultModel: "gpt" });
    act(() => {
      useAgentCatalogStore.setState({
        providers: [p1, p2],
        loaded: true,
        loading: false,
      });
    });

    expect(document.querySelector(".lp-pane__body")?.textContent).not.toBe(
      "Unknown provider",
    );
    expect(document.querySelector(".lp-pane__body")?.textContent).toContain(
      "opus",
    );
    const providerTrigger = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".lp-select"),
    ).find((b) => b.textContent?.includes("Anthropic"));
    expect(providerTrigger).toBeDefined();

    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(onLaunch).toHaveBeenCalledTimes(1);
    const plan = onLaunch.mock.calls[0]?.[0] as LaunchComposerPlan;
    const agentPane = plan.panes.find((p) => p.kind === "agent");
    expect(agentPane).toMatchObject({ providerId: 11, model: "opus" });
  });

  it("a user-edited pane is not clobbered by a late-arriving catalog", () => {
    useAgentCatalogStore.setState({
      providers: [],
      loaded: false,
      loading: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("sidecar not up yet");
      }),
    );

    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);
    fireEvent.click(recipeButton("Compare 3"));

    const panesBefore = Array.from(
      document.querySelectorAll<HTMLElement>(".lp-pane"),
    );
    expect(panesBefore).toHaveLength(3);
    const editedId = panesBefore[0]?.dataset.paneId;
    if (!editedId)
      throw new Error("expected a pane id on the first preview pane");

    // The selected (first) pane is switched to shell via the inspector —
    // flips `recipe` to "custom" and the pane is no longer an agent.
    fireEvent.click(paneKindToggle("Shell"));
    expect(document.querySelector(".lp-custom")).not.toBeNull();

    const editedPaneEl = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(
        `.lp-pane[data-pane-id="${editedId}"]`,
      );
    expect(editedPaneEl()?.className).toContain("lp-pane--shell");

    const p1 = provider({
      id: 31,
      displayName: "Anthropic",
      defaultModel: "opus",
    });
    act(() => {
      useAgentCatalogStore.setState({
        providers: [p1],
        loaded: true,
        loading: false,
      });
    });

    // The edited pane is still the same shell pane, untouched.
    expect(editedPaneEl()?.dataset.paneId).toBe(editedId);
    expect(editedPaneEl()?.className).toContain("lp-pane--shell");

    // The other two (still-agent) panes converged onto the real provider.
    const agentBodies = Array.from(
      document.querySelectorAll<HTMLElement>(".lp-pane--agent .lp-pane__body"),
    ).map((el) => el.textContent);
    expect(agentBodies).toHaveLength(2);
    expect(agentBodies.every((t) => t?.includes("opus"))).toBe(true);
  });

  it("recipe -> custom: applying a recipe then adding a pane keeps the footer in step", () => {
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);
    fireEvent.click(recipeButton("Dev setup"));
    expect(footerText()).toContain("1 agent");
    expect(footerText()).toContain("2 shells");
    expect(launchButton().textContent).toContain("Launch 3 panes");

    fireEvent.click(ghostButton("Shell"));
    expect(document.querySelector(".lp-custom")).not.toBeNull();
    expect(footerText()).toContain("1 agent");
    expect(footerText()).toContain("3 shells");
    expect(launchButton().textContent).toContain("Launch 4 panes");
  });

  it("never renders a remove control for the last remaining pane", () => {
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);
    fireEvent.click(recipeButton("Single agent"));
    expect(document.querySelectorAll(".lp-pane__x")).toHaveLength(0);
  });

  it("Escape closes an open menu first, then the dialog", () => {
    const onClose = vi.fn();
    render(<LaunchComposer open onClose={onClose} onLaunch={vi.fn()} />);
    const providerTrigger = document.querySelector<HTMLButtonElement>(
      ".lp-rows .lp-select",
    );
    if (!providerTrigger) throw new Error("expected the Provider trigger");
    fireEvent.click(providerTrigger);
    expect(document.querySelector(".lp-pop__menu")).not.toBeNull();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(document.querySelector(".lp-pop__menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Cmd+Enter calls onLaunch with the composed plan", () => {
    const onLaunch = vi.fn();
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={onLaunch} />);
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(onLaunch).toHaveBeenCalledTimes(1);
    const plan = onLaunch.mock.calls[0]?.[0] as LaunchComposerPlan;
    expect(plan.panes.length).toBe(
      document.querySelectorAll(".lp-pane").length,
    );
    expect(plan.projectId).toBe(project().id);
  });

  it("ignores the keyboard while closed", () => {
    const onClose = vi.fn();
    const onLaunch = vi.fn();
    render(
      <LaunchComposer open={false} onClose={onClose} onLaunch={onLaunch} />,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(onClose).not.toHaveBeenCalled();
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("the Launch button produces the same plan as Cmd+Enter", () => {
    const onLaunchButton = vi.fn();
    const { unmount } = render(
      <LaunchComposer open onClose={vi.fn()} onLaunch={onLaunchButton} />,
    );
    fireEvent.click(launchButton());
    expect(onLaunchButton).toHaveBeenCalledTimes(1);
    unmount();

    const onLaunchKey = vi.fn();
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={onLaunchKey} />);
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(onLaunchKey).toHaveBeenCalledTimes(1);

    expect(onLaunchButton.mock.calls[0]?.[0]).toEqual(
      onLaunchKey.mock.calls[0]?.[0],
    );
  });
});

describe("saved presets in the recipe row", () => {
  it("render as extra .lp-recipe buttons after the four built-ins, and applying one replaces the pane list", () => {
    mockUseLaunchPresets.mockReturnValue({
      data: [fakePreset({ name: "My Preset" })],
    });
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);

    expect(footerText()).toContain("1 agent");
    expect(footerText()).toContain("1 shell");
    expect(launchButton().textContent).toContain("Launch 2 panes");

    fireEvent.click(recipeButton("My Preset"));

    expect(footerText()).toContain("1 agent");
    expect(footerText()).toContain("1 shell");
    expect(launchButton().textContent).toContain("Launch 2 panes");
    expect(document.querySelector(".lp-pane--shell")).not.toBeNull();
  });

  it("a preset with unresolved.length > 0 still applies and disables Launch", () => {
    mockUseLaunchPresets.mockReturnValue({
      data: [
        fakePreset({
          name: "Broken Preset",
          panes: [
            {
              kind: "agent",
              provider_id: 999,
              model: null,
              permission_mode: "",
              send_prompt: true,
            },
          ],
          unresolved: [{ pane_index: 0, provider_id: 999, reason: "missing" }],
        }),
      ],
    });
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);

    fireEvent.click(recipeButton("Broken Preset"));

    expect(document.querySelector(".lp-pane__body")?.textContent).toBe(
      "Unknown provider",
    );
    expect(launchButton().disabled).toBe(true);
    expect(launchButton().getAttribute("title")).not.toBeNull();
  });
});

describe("+ Save as preset", () => {
  it("Save calls mutateAsync once with the on-screen composition and no rows/cols/provider_id keys", () => {
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);
    fireEvent.click(recipeButton("Dev setup")); // 1 agent + 2 shells, split grid

    fireEvent.click(saveAsPresetButton());
    const nameInput = document.querySelector<HTMLInputElement>(
      ".lp-savebar .lp-input",
    );
    if (!nameInput) throw new Error("expected the save-bar name input");
    fireEvent.change(nameInput, { target: { value: "Dev setup preset" } });

    const saveButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".lp-savebar .lp-btn"),
    ).find((b) => b.textContent === "Save");
    if (!saveButton) throw new Error("expected the Save button");
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);

    expect(createPresetMutateAsync).toHaveBeenCalledTimes(1);
    const payload = createPresetMutateAsync.mock
      .calls[0]?.[0] as LaunchPresetCreate;
    expect(payload).toMatchObject({
      name: "Dev setup preset",
      project_id: project().id,
      target: "embedded",
      profile_id: null,
      extra_args: "",
      split: "grid",
    });
    expect(payload.panes).toHaveLength(3);
    expect(payload).not.toHaveProperty("rows");
    expect(payload).not.toHaveProperty("cols");
    expect(payload).not.toHaveProperty("provider_id");
  });

  it("with an all-shell composition, Save is disabled with the at-least-one-agent-pane reason as its title", () => {
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);
    fireEvent.click(recipeButton("Single agent"));
    fireEvent.click(paneKindToggle("Shell"));

    fireEvent.click(saveAsPresetButton());
    const nameInput = document.querySelector<HTMLInputElement>(
      ".lp-savebar .lp-input",
    );
    if (!nameInput) throw new Error("expected the save-bar name input");
    fireEvent.change(nameInput, { target: { value: "All shell" } });

    const saveButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".lp-savebar .lp-btn"),
    ).find((b) => b.textContent === "Save");
    if (!saveButton) throw new Error("expected the Save button");
    expect(saveButton.disabled).toBe(true);
    expect(saveButton.getAttribute("title")).toContain("agent pane");
  });

  it("a rejected save leaves the bar open and renders .lp-saveerr; nothing launches", async () => {
    createPresetMutateAsync.mockRejectedValue(
      new SidecarError("conflict", 409, "/api/v1/launch-presets"),
    );
    const onLaunch = vi.fn();
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={onLaunch} />);

    fireEvent.click(saveAsPresetButton());
    const nameInput = document.querySelector<HTMLInputElement>(
      ".lp-savebar .lp-input",
    );
    if (!nameInput) throw new Error("expected the save-bar name input");
    fireEvent.change(nameInput, { target: { value: "Dup Name" } });

    const saveButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".lp-savebar .lp-btn"),
    ).find((b) => b.textContent === "Save");
    if (!saveButton) throw new Error("expected the Save button");
    await act(async () => {
      fireEvent.click(saveButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector(".lp-savebar")).not.toBeNull();
    expect(document.querySelector(".lp-saveerr")?.textContent).toContain(
      "Dup Name",
    );
    expect(onLaunch).not.toHaveBeenCalled();
  });
});

describe("LaunchComposer — Ticket context sections (task #33)", () => {
  it("renders no Ticket context section without sections, and keeps initialPrompt verbatim", () => {
    render(
      <LaunchComposer
        open
        onClose={vi.fn()}
        onLaunch={vi.fn()}
        initialPrompt="hand-typed prompt, no ticket"
      />,
    );
    expect(document.querySelector(".lp-ctx")).toBeNull();
    expect(promptText()).toBe("hand-typed prompt, no ticket");
  });

  it("renders one row per section with its ~tokens and the header total", () => {
    const sections: LaunchPromptSection[] = [
      promptSection({ id: "title", label: "Title + ref", text: "t".repeat(4 * 28), tokens: 28 }),
      promptSection({
        id: "description",
        label: "Description",
        text: "d".repeat(4 * 12),
        tokens: 12,
      }),
      promptSection({ id: "project", label: "Project", text: "p".repeat(4 * 8), tokens: 8 }),
    ];
    render(
      <LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} sections={sections} />,
    );

    expect(document.querySelectorAll(".lp-ctxrow")).toHaveLength(3);
    expect(ctxRow("Title + ref").querySelector(".lp-ctxrow__t")?.textContent).toBe("~28");
    expect(ticketContextTotal()).toBe("~0.05k tokens");
  });

  it("unchecking Description removes exactly its text and drops the total", () => {
    const sections: LaunchPromptSection[] = [
      promptSection({ id: "title", label: "Title + ref", text: "title text", tokens: 3 }),
      promptSection({
        id: "description",
        label: "Description",
        text: "description text",
        tokens: 5,
      }),
    ];
    render(
      <LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} sections={sections} />,
    );

    expect(promptText()).toContain("description text");
    expect(promptText()).toContain("title text");

    fireEvent.click(ctxCheckbox("Description"));

    expect(promptText()).not.toContain("description text");
    expect(promptText()).toContain("title text");
    expect(ticketContextTotal()).toBe("~0.00k tokens"); // 3 tokens left
  });

  it("unchecking every section leaves an empty prompt and a ~0.00k total, Launch stays enabled", () => {
    const sections: LaunchPromptSection[] = [
      promptSection({ id: "title", label: "Title + ref", text: "title text", tokens: 3 }),
      promptSection({
        id: "description",
        label: "Description",
        text: "description text",
        tokens: 5,
      }),
    ];
    render(
      <LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} sections={sections} />,
    );

    fireEvent.click(ctxCheckbox("Title + ref"));
    fireEvent.click(ctxCheckbox("Description"));

    expect(promptText()).toBe("");
    expect(ticketContextTotal()).toBe("~0.00k tokens");
    expect(launchButton().disabled).toBe(false);
  });

  it("a section with default_on false starts unchecked and is excluded from the prompt", () => {
    const sections: LaunchPromptSection[] = [
      promptSection({ id: "title", label: "Title + ref", text: "title text", tokens: 3 }),
      promptSection({
        id: "labels",
        label: "Labels",
        text: "Labels: Bug",
        tokens: 4,
        default_on: false,
      }),
    ];
    render(
      <LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} sections={sections} />,
    );

    expect(ctxCheckbox("Labels").checked).toBe(false);
    expect(promptText()).not.toContain("Labels: Bug");
    expect(promptText()).toBe("title text");
  });

  it("hand-editing the prompt pauses the toggles and says so", () => {
    const sections: LaunchPromptSection[] = [
      promptSection({ id: "title", label: "Title + ref", text: "title text", tokens: 3 }),
      promptSection({
        id: "description",
        label: "Description",
        text: "description text",
        tokens: 5,
      }),
    ];
    render(
      <LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} sections={sections} />,
    );

    fireEvent.click(ghostButton("Edit"));
    const textarea = document.querySelector<HTMLTextAreaElement>(".lp-prompt");
    if (!textarea) throw new Error("expected the prompt textarea");
    fireEvent.change(textarea, { target: { value: "a hand edit" } });

    const checkboxes = Array.from(
      document.querySelectorAll<HTMLInputElement>(".lp-ctxrow input"),
    );
    expect(checkboxes.length).toBeGreaterThan(0);
    expect(checkboxes.every((cb) => cb.disabled)).toBe(true);
    expect(document.querySelector(".lp-ctx")?.className).toContain("is-locked");
    expect(document.querySelector(".lp-ctx__note")?.textContent).toContain(
      "Prompt edited — toggles paused",
    );
  });

  it("Reset from ticket re-composes and re-enables the toggles", () => {
    const sections: LaunchPromptSection[] = [
      promptSection({ id: "title", label: "Title + ref", text: "title text", tokens: 3 }),
      promptSection({
        id: "description",
        label: "Description",
        text: "description text",
        tokens: 5,
      }),
    ];
    render(
      <LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} sections={sections} />,
    );

    fireEvent.click(ghostButton("Edit"));
    const textarea = document.querySelector<HTMLTextAreaElement>(".lp-prompt");
    if (!textarea) throw new Error("expected the prompt textarea");
    fireEvent.change(textarea, { target: { value: "a hand edit" } });
    expect(document.querySelector(".lp-ctx")?.className).toContain("is-locked");

    fireEvent.click(ghostButton("Reset from ticket"));

    const expected = composeSectionPrompt(sections, new Set(["title", "description"]));
    expect(promptText()).toBe(expected);
    const checkboxes = Array.from(
      document.querySelectorAll<HTMLInputElement>(".lp-ctxrow input"),
    );
    expect(checkboxes.every((cb) => !cb.disabled)).toBe(true);
    expect(document.querySelector(".lp-ctx")?.className).not.toContain("is-locked");
  });

  it("typing the composed text back un-pauses the toggles", () => {
    const sections: LaunchPromptSection[] = [
      promptSection({ id: "title", label: "Title + ref", text: "title text", tokens: 3 }),
      promptSection({
        id: "description",
        label: "Description",
        text: "description text",
        tokens: 5,
      }),
    ];
    render(
      <LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} sections={sections} />,
    );

    const composed = composeSectionPrompt(sections, new Set(["title", "description"]));
    fireEvent.click(ghostButton("Edit"));
    const textarea = document.querySelector<HTMLTextAreaElement>(".lp-prompt");
    if (!textarea) throw new Error("expected the prompt textarea");

    fireEvent.change(textarea, { target: { value: "a hand edit" } });
    expect(document.querySelector(".lp-ctx")?.className).toContain("is-locked");

    fireEvent.change(textarea, { target: { value: composed } });
    expect(document.querySelector(".lp-ctx")?.className).not.toContain("is-locked");
    const checkboxes = Array.from(
      document.querySelectorAll<HTMLInputElement>(".lp-ctxrow input"),
    );
    expect(checkboxes.every((cb) => !cb.disabled)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Composer additions (task #35)
// ---------------------------------------------------------------------------

function sessionRow(label: string): HTMLElement {
  const row = Array.from(
    document.querySelectorAll<HTMLElement>(".lp-rows .lp-row"),
  ).find((el) => el.querySelector(".lp-row__l")?.textContent === label);
  if (!row) throw new Error(`no .lp-row labelled "${label}"`);
  return row;
}

describe("LaunchComposer — initialTarget / initialProfileId (task #35)", () => {
  it("seed the Session block", () => {
    mockUseLookups.mockReturnValue({
      data: { profiles: [{ id: 5, name: "Work profile" }] },
    });
    render(
      <LaunchComposer
        open
        onClose={vi.fn()}
        onLaunch={vi.fn()}
        initialTarget="popout"
        initialProfileId={5}
      />,
    );

    const profileRow = sessionRow("Profile");
    expect(profileRow.querySelector(".lp-select__v")?.textContent).toBe(
      "Work profile",
    );

    const popoutButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".lp-seg button"),
    ).find((b) => b.textContent === "Popout window");
    expect(popoutButton?.className).toContain("is-on");
  });
});

describe("LaunchComposer — MAX_LAUNCH_PANES cap (task #35)", () => {
  it("Launch is disabled above the cap, with a matching tooltip", () => {
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);
    // devpair starts at 2 panes (1 agent, 1 shell) — 7 more agent panes push
    // the composition to 9, one past MAX_LAUNCH_PANES.
    for (let i = 0; i < 7; i++) {
      fireEvent.click(ghostButton("Agent"));
    }
    expect(document.querySelectorAll(".lp-pane")).toHaveLength(9);
    expect(launchButton().disabled).toBe(true);
    expect(launchButton().getAttribute("title")).toContain(
      "at most 8 panes",
    );
  });
});

describe("LaunchComposer — preset delete (task #35)", () => {
  it("deleting a saved preset chip calls useDeleteLaunchPreset and not applyPreset", () => {
    const preset = fakePreset({ name: "My Preset" });
    mockUseLaunchPresets.mockReturnValue({ data: [preset] });
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);

    const chip = recipeButton("My Preset");
    const deleteButton = chip.querySelector<HTMLButtonElement>(".lp-recipe__x");
    if (!deleteButton) {
      throw new Error("expected a delete button on the preset chip");
    }

    fireEvent.click(deleteButton);

    expect(deletePresetMutateAsync).toHaveBeenCalledTimes(1);
    expect(deletePresetMutateAsync).toHaveBeenCalledWith(preset.id);
    // stopPropagation proof: the chip's own onClick (applyPreset) never
    // fired — the built-in "Agent + shell" recipe is still the active one.
    expect(recipeButton("Agent + shell").className).toContain("is-on");
    expect(chip.className).not.toContain("is-on");
  });

  it("Enter/Space on the delete button deletes the preset instead of applying it", async () => {
    // Regression test for the keydown-bubbling race: the outer chip is a
    // `role="button"` div whose own onKeyDown applies the preset on
    // Enter/Space. Without `stopPropagation` on the nested delete button's
    // onKeyDown, that keydown bubbles up and fires `applyThisPreset()` —
    // and the outer handler's `preventDefault()` suppresses the button's
    // own native click activation, so the delete never happens.
    const preset = fakePreset({ name: "My Preset" });
    mockUseLaunchPresets.mockReturnValue({ data: [preset] });
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);

    const chip = recipeButton("My Preset");
    const deleteButton = chip.querySelector<HTMLButtonElement>(".lp-recipe__x");
    if (!deleteButton) {
      throw new Error("expected a delete button on the preset chip");
    }

    deleteButton.focus();
    await userEvent.keyboard("{Enter}");

    expect(deletePresetMutateAsync).toHaveBeenCalledTimes(1);
    expect(deletePresetMutateAsync).toHaveBeenCalledWith(preset.id);
    expect(recipeButton("Agent + shell").className).toContain("is-on");
    expect(chip.className).not.toContain("is-on");

    deleteButton.focus();
    await userEvent.keyboard(" ");

    expect(deletePresetMutateAsync).toHaveBeenCalledTimes(2);
  });
});
