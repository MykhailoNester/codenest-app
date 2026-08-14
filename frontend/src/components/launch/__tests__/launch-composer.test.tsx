import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { LaunchComposer } from "../launch-composer";
import { useAgentCatalogStore, type CatalogProvider } from "../../../stores/agent-catalog-store";
import { composeSectionPrompt } from "../../../lib/launch-composer";
import type { LaunchComposerPlan } from "../../../lib/launch-composer";
import type { LaunchPromptSection } from "../../../lib/launch-seed";

// The module-mock pattern `components/__tests__/import-projects-modal.test.tsx:22-35`
// already uses, kept *partial* (via `importOriginal`) rather than a full
// replace: `agent-catalog-store.ts` imports the real `fetchSidecar` from this
// same module at runtime, and the cold-catalog cases below need that real
// implementation intact (they stub `globalThis.fetch`, not `fetchSidecar`).
const { mockUseProjects, mockUseLookups } = vi.hoisted(() => ({
  mockUseProjects: vi.fn(),
  mockUseLookups: vi.fn(),
}));

vi.mock("../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api")>();
  return {
    ...actual,
    useProjects: () => mockUseProjects(),
    useLookups: () => mockUseLookups(),
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
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>(".lp-ghost")).find((b) =>
    b.textContent?.includes(label),
  );
  if (!btn) throw new Error(`no .lp-ghost button containing "${label}"`);
  return btn;
}

function recipeButton(label: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>(".lp-recipe")).find(
    (b) => b.querySelector("b")?.textContent === label,
  );
  if (!btn) throw new Error(`no .lp-recipe button labelled "${label}"`);
  return btn;
}

function paneKindToggle(label: "Agent" | "Shell"): HTMLButtonElement {
  const btn = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".lp-insp__acts .lp-seg button"),
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

function promptSection(overrides: Partial<LaunchPromptSection> = {}): LaunchPromptSection {
  return {
    id: "title",
    label: "Title + ref",
    text: "You are working on task #7: Investigate CI",
    tokens: 11,
    default_on: true,
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

beforeEach(() => {
  mockUseProjects.mockReturnValue({ data: [project()] });
  mockUseLookups.mockReturnValue({ data: { profiles: [] } });
  useAgentCatalogStore.setState({
    providers: [provider()],
    loaded: true,
    loading: false,
    lastUsed: { providerId: null, model: null },
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
    expect(document.querySelector(".lp-head__t")?.textContent).toBe("Launch session");
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
    expect(document.querySelector(".lp-head__s")?.textContent).toContain("Fix the thing");
  });

  it("degrades to a readable disabled state with zero providers and zero projects, without throwing", () => {
    useAgentCatalogStore.setState({ providers: [], loaded: true, loading: false });
    mockUseProjects.mockReturnValue({ data: [] });

    expect(() =>
      render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />),
    ).not.toThrow();

    const selects = Array.from(document.querySelectorAll<HTMLButtonElement>(".lp-select"));
    const providerTrigger = selects.find((b) => b.textContent?.includes("No providers configured"));
    const projectTrigger = selects.find((b) => b.textContent?.includes("No project with a path"));
    expect(providerTrigger?.disabled).toBe(true);
    expect(projectTrigger?.disabled).toBe(true);

    expect(launchButton().disabled).toBe(true);
    expect(launchButton().getAttribute("title")).not.toBeNull();
  });

  it("a catalog arriving after mount converges the default pane onto a real provider", () => {
    useAgentCatalogStore.setState({ providers: [], loaded: false, loading: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("sidecar not up yet");
      }),
    );

    const onLaunch = vi.fn();
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={onLaunch} />);

    expect(document.querySelector(".lp-pane__body")?.textContent).toBe("Unknown provider");

    const p1 = provider({ id: 11, displayName: "Anthropic", defaultModel: "opus" });
    const p2 = provider({ id: 12, displayName: "OpenAI", defaultModel: "gpt" });
    act(() => {
      useAgentCatalogStore.setState({ providers: [p1, p2], loaded: true, loading: false });
    });

    expect(document.querySelector(".lp-pane__body")?.textContent).not.toBe("Unknown provider");
    expect(document.querySelector(".lp-pane__body")?.textContent).toContain("opus");
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
    useAgentCatalogStore.setState({ providers: [], loaded: false, loading: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("sidecar not up yet");
      }),
    );

    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);
    fireEvent.click(recipeButton("Compare 3"));

    const panesBefore = Array.from(document.querySelectorAll<HTMLElement>(".lp-pane"));
    expect(panesBefore).toHaveLength(3);
    const editedId = panesBefore[0]?.dataset.paneId;
    if (!editedId) throw new Error("expected a pane id on the first preview pane");

    // The selected (first) pane is switched to shell via the inspector —
    // flips `recipe` to "custom" and the pane is no longer an agent.
    fireEvent.click(paneKindToggle("Shell"));
    expect(document.querySelector(".lp-custom")).not.toBeNull();

    const editedPaneEl = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(`.lp-pane[data-pane-id="${editedId}"]`);
    expect(editedPaneEl()?.className).toContain("lp-pane--shell");

    const p1 = provider({ id: 31, displayName: "Anthropic", defaultModel: "opus" });
    act(() => {
      useAgentCatalogStore.setState({ providers: [p1], loaded: true, loading: false });
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
    const providerTrigger = document.querySelector<HTMLButtonElement>(".lp-rows .lp-select");
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
    expect(plan.panes.length).toBe(document.querySelectorAll(".lp-pane").length);
    expect(plan.projectId).toBe(project().id);
  });

  it("ignores the keyboard while closed", () => {
    const onClose = vi.fn();
    const onLaunch = vi.fn();
    render(<LaunchComposer open={false} onClose={onClose} onLaunch={onLaunch} />);
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

    expect(onLaunchButton.mock.calls[0]?.[0]).toEqual(onLaunchKey.mock.calls[0]?.[0]);
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
