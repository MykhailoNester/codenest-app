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
  type ProviderModel,
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

function providerModel(
  overrides: Partial<ProviderModel> = {},
): ProviderModel {
  return {
    id: 1,
    provider_id: 1,
    model_name: "opus",
    display_name: "Opus",
    is_default: false,
    is_enabled: true,
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

// Deck draws a secondary action as `.dk-btn.bare`; these buttons all pair a
// glyph with a label, so an exact accessible-name match is brittle (and, for
// the "Shell" label, ambiguous — "+ Shell" and the pane-kind toggle would both
// match). The pane-kind toggle is a `.dk-seg` segment, so class + a precise
// text check still keeps the two apart. Was `.lp-ghost` before #283.
function ghostButton(label: string): HTMLButtonElement {
  const btn = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".dk-btn.bare"),
  ).find((b) => b.textContent?.includes(label));
  if (!btn) throw new Error(`no .dk-btn.bare button containing "${label}"`);
  return btn;
}

/** A recipe/preset row. Was a `.lp-recipe` button; now a `DeckLine` in the
 *  recipe `DeckGrid`, found through that grid's accessible name. */
function recipeButton(label: string): HTMLElement {
  const row = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[aria-label="Recipes and saved presets"] .dk-line',
    ),
  ).find((b) => b.querySelector("b")?.textContent === label);
  if (!row) throw new Error(`no recipe row labelled "${label}"`);
  return row;
}

/** The overflow trigger on a preset row — the delete lives behind it now,
 *  per Deck's rule that a destructive row action goes in the menu. */
function presetMenuTrigger(name: string): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(
    `button[aria-label="Actions for preset ${name}"]`,
  );
  if (!btn) throw new Error(`no overflow trigger for preset "${name}"`);
  return btn;
}

function presetDeleteItem(name: string): HTMLButtonElement {
  const btn = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[role="menu"] [role="menuitem"]',
    ),
  ).find((b) => b.textContent === `Delete preset ${name}`);
  if (!btn) throw new Error(`no Delete menuitem for preset "${name}"`);
  return btn;
}

/** Was `.lp-insp__acts .lp-seg button`; Deck marks the live segment `.on`. */
function paneKindToggle(label: "Agent" | "Shell"): HTMLButtonElement {
  const btn = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".dk-seg button"),
  ).find((b) => b.textContent === label);
  if (!btn) throw new Error(`no pane-kind toggle labelled "${label}"`);
  return btn;
}

/** Was `.lp-summary`. */
function footerText(): string {
  return document.querySelector("[data-summary]")?.textContent ?? "";
}

/** Was `.lp-btn--primary`; `.dk-btn.pri` is Deck's one primary per surface. */
function launchButton(): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(".dk-btn.pri");
  if (!btn) throw new Error("no primary launch button");
  return btn;
}

/** A `<select>` by accessible name. Every selector was an `.lp-select`
 *  popover trigger before #283 and is a real `<select>` in `.dk-sel` now. */
function selectFor(label: string): HTMLSelectElement {
  const el = document.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  );
  if (!el) throw new Error(`no <select> labelled "${label}"`);
  return el;
}

/** The pane tiles. Were `.lp-pane`; `data-pane-id` is unchanged and
 *  `data-pane-kind` replaces the `.lp-pane--agent`/`--shell` modifiers. */
function paneTiles(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]"));
}

/** The "custom" marker on the layout heading. Was `.lp-custom`; now a
 *  `.dk-tag` in the `DeckGroup`'s note slot. */
function customTag(): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>(".dk-tag")).find(
    (el) => el.textContent === "custom",
  );
}

/** Was `.lp-pane__body`. */
function paneBodies(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-pane-body]"),
  ).map((el) => el.textContent ?? "");
}

/** The heading `.dk-meta` of the `DeckGroup` whose label starts with `label` —
 *  replaces `.lp-h--row .lp-h__meta`. */
function groupMeta(label: string): string {
  const head = Array.from(
    document.querySelectorAll<HTMLElement>(".dk-group__h"),
  ).find((el) => el.textContent?.startsWith(label));
  if (!head) throw new Error(`no DeckGroup heading starting "${label}"`);
  const meta = head.querySelector(".dk-meta");
  if (!meta) throw new Error(`no .dk-meta in the "${label}" heading`);
  return meta.textContent ?? "";
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
    extra_args: "",
    target: "embedded",
    profile_id: null,
    created_at: "2026-01-01 00:00:00",
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
    unresolved: [],
    ...overrides,
  };
}

/** The prompt's current text, whichever of the view/edit pair is rendered.
 *  The read-only view is a `<pre>` in a `.dk-out` frame (was `.lp-promptview`)
 *  and the editor is a `.dk-ctl` textarea (was `.lp-prompt`). */
function promptText(): string {
  const pre = document.querySelector(".dk-out pre");
  if (pre) return pre.textContent ?? "";
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Prompt"]',
  );
  return textarea?.value ?? "";
}

/** The ticket context heading's `~X.XXk tokens` total — distinct from the
 *  prompt group's own meta ("N of M agent panes"). */
function ticketContextTotal(): string {
  return groupMeta("ticket context");
}

/** Was `.lp-ctxrow`; now a `DeckLine` in the ticket-context `DeckGrid`,
 *  identified by its checkbox's accessible name rather than `.lp-ctxrow__l`. */
function ctxRow(label: string): HTMLElement {
  const row = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[aria-label="Ticket context sections"] .dk-line',
    ),
  ).find(
    (el) =>
      el.querySelector('input[type="checkbox"]')?.getAttribute("aria-label") ===
      label,
  );
  if (!row) throw new Error(`no ticket-context row labelled "${label}"`);
  return row;
}

function ctxCheckbox(label: string): HTMLInputElement {
  const input = ctxRow(label).querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  if (!input) throw new Error(`no checkbox in the "${label}" row`);
  return input;
}

/** The prompt editor. Was `.lp-prompt`. */
function promptTextarea(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Prompt"]',
  );
  if (!el) throw new Error("expected the prompt textarea");
  return el;
}

/** Every ticket-context checkbox. */
function ctxCheckboxes(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(
      '[aria-label="Ticket context sections"] input[type="checkbox"]',
    ),
  );
}

/**
 * Whether the section toggles are paused. `.lp-ctx.is-locked` carried this
 * before #283; the class is gone, so the assertion now reads the two things
 * the user actually sees — every checkbox disabled, and the explanatory note
 * with its "Reset from ticket" escape hatch on screen.
 */
function togglesPaused(): boolean {
  const boxes = ctxCheckboxes();
  const noted = Array.from(document.querySelectorAll(".dk-meta")).some((el) =>
    el.textContent?.includes("Prompt edited — toggles paused"),
  );
  return boxes.length > 0 && boxes.every((cb) => cb.disabled) && noted;
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
    // `.lp-head__t` → the `<h2>` in `.dk-modal__h`. Deck's modal headings are
    // lowercase, so this matches case-insensitively rather than dropping the
    // assertion that the dialog names itself.
    expect(
      document.querySelector(".dk-modal__h h2")?.textContent?.toLowerCase(),
    ).toBe("launch session");
    // The source ref rode `.lp-head__ref`; with no source there is no meta at
    // all in the header.
    expect(document.querySelector(".dk-modal__h .dk-meta")).toBeNull();
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
    const headMeta = document.querySelector(".dk-modal__h .dk-meta");
    expect(headMeta?.textContent).toContain("#42");
    expect(headMeta?.textContent).toContain("Fix the thing");
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

    // Was a pair of `.lp-select` popover triggers; both are real `<select>`s
    // now, and the placeholder is the single rendered <option>.
    const providerSelect = selectFor("Provider");
    const projectSelect = selectFor("Project");
    expect(providerSelect.textContent).toContain("No providers configured");
    expect(projectSelect.textContent).toContain("No project with a path");
    expect(providerSelect.disabled).toBe(true);
    expect(projectSelect.disabled).toBe(true);

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

    expect(paneBodies()[0]).toBe("Unknown provider");

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

    expect(paneBodies()[0]).not.toBe("Unknown provider");
    expect(paneBodies()[0]).toContain("opus");
    // The provider select now holds the converged id, and lists both
    // providers as options.
    const providerSelect = selectFor("Provider");
    expect(providerSelect.value).toBe("11");
    expect(providerSelect.textContent).toContain("Anthropic");
    expect(providerSelect.textContent).toContain("OpenAI");

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

    const panesBefore = paneTiles();
    expect(panesBefore).toHaveLength(3);
    const editedId = panesBefore[0]?.dataset.paneId;
    if (!editedId)
      throw new Error("expected a pane id on the first preview pane");

    // The selected (first) pane is switched to shell via the inspector —
    // flips `recipe` to "custom" and the pane is no longer an agent.
    fireEvent.click(paneKindToggle("Shell"));
    expect(customTag()).not.toBeNull();

    const editedPaneEl = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(`[data-pane-id="${editedId}"]`);
    // `.lp-pane--shell` → the `data-pane-kind` attribute.
    expect(editedPaneEl()?.dataset.paneKind).toBe("shell");

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
    expect(editedPaneEl()?.dataset.paneKind).toBe("shell");

    // The other two (still-agent) panes converged onto the real provider.
    const agentBodies = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-pane-kind="agent"] [data-pane-body]',
      ),
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
    expect(customTag()).not.toBeNull();
    expect(footerText()).toContain("1 agent");
    expect(footerText()).toContain("3 shells");
    expect(launchButton().textContent).toContain("Launch 4 panes");
  });

  it("never renders a remove control for the last remaining pane", () => {
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);
    fireEvent.click(recipeButton("Single agent"));
    // `.lp-pane__x` → the `.dk-pane__h` remove button, found by its label.
    expect(
      document.querySelectorAll('button[aria-label^="Remove "]'),
    ).toHaveLength(0);
  });

  it("Escape closes the dialog", () => {
    // The first half of this test proved Escape closed an open `.lp-pop__menu`
    // before it closed the dialog. Every selector is a native `<select>` now,
    // so that menu belongs to the OS and never reaches the document — there is
    // no app-level selector menu left to close first. The dialog half, and the
    // "one Escape, one close" assertion, are unchanged.
    const onClose = vi.fn();
    render(<LaunchComposer open onClose={onClose} onLaunch={vi.fn()} />);
    expect(selectFor("Provider").disabled).toBe(false);

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Cmd+Enter calls onLaunch with the composed plan", () => {
    const onLaunch = vi.fn();
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={onLaunch} />);
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(onLaunch).toHaveBeenCalledTimes(1);
    const plan = onLaunch.mock.calls[0]?.[0] as LaunchComposerPlan;
    expect(plan.panes.length).toBe(paneTiles().length);
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
  it("render as extra rows after the four built-ins, and applying one replaces the pane list", () => {
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
    expect(
      document.querySelector('[data-pane-kind="shell"]'),
    ).not.toBeNull();
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

    // The row carries the `wait` glyph and an "unresolved" tag before it is
    // even applied.
    const row = recipeButton("Broken Preset");
    expect(row.querySelector(".dk-s")?.getAttribute("data-s")).toBe("wait");
    expect(row.textContent).toContain("unresolved");

    fireEvent.click(row);

    expect(paneBodies()[0]).toBe("Unknown provider");
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
      'input[aria-label="Preset name"]',
    );
    if (!nameInput) throw new Error("expected the save-bar name input");
    fireEvent.change(nameInput, { target: { value: "Dev setup preset" } });

    const saveButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".dk-modal__f .dk-btn"),
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

  it("saves an all-shell composition — Save is enabled and the payload is the shell panes (task #36)", () => {
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);
    fireEvent.click(recipeButton("Single agent"));
    fireEvent.click(paneKindToggle("Shell"));

    fireEvent.click(saveAsPresetButton());
    const nameInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="Preset name"]',
    );
    if (!nameInput) throw new Error("expected the save-bar name input");
    fireEvent.change(nameInput, { target: { value: "All shell" } });

    const saveButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".dk-modal__f .dk-btn"),
    ).find((b) => b.textContent === "Save");
    if (!saveButton) throw new Error("expected the Save button");
    expect(saveButton.disabled).toBe(false);
    expect(saveButton.getAttribute("title")).toBeNull();

    fireEvent.click(saveButton);
    const payload = createPresetMutateAsync.mock
      .calls[0]?.[0] as LaunchPresetCreate;
    expect(payload.name).toBe("All shell");
    expect(payload.panes).toEqual([{ kind: "shell", shell: "", command: "" }]);
  });

  it("a rejected save leaves the bar open and renders the error note; nothing launches", async () => {
    createPresetMutateAsync.mockRejectedValue(
      new SidecarError("conflict", 409, "/api/v1/launch-presets"),
    );
    const onLaunch = vi.fn();
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={onLaunch} />);

    fireEvent.click(saveAsPresetButton());
    const nameInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="Preset name"]',
    );
    if (!nameInput) throw new Error("expected the save-bar name input");
    fireEvent.change(nameInput, { target: { value: "Dup Name" } });

    const saveButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".dk-modal__f .dk-btn"),
    ).find((b) => b.textContent === "Save");
    if (!saveButton) throw new Error("expected the Save button");
    await act(async () => {
      fireEvent.click(saveButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The bar is still open — `.lp-savebar` is gone, so its name input
    // standing in for it — and the error rides `.dk-comp__note.err`.
    expect(
      document.querySelector('input[aria-label="Preset name"]'),
    ).not.toBeNull();
    expect(
      document.querySelector(".dk-comp__note.err")?.textContent,
    ).toContain("Dup Name");
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
    // `.lp-ctx` is gone; the whole ticket-context grid is absent instead.
    expect(
      document.querySelector('[aria-label="Ticket context sections"]'),
    ).toBeNull();
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

    expect(ctxCheckboxes()).toHaveLength(3);
    // `.lp-ctxrow__t` → the row's last (right-aligned) cell.
    expect(ctxRow("Title + ref").querySelector(".r")?.textContent).toBe("~28");
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
    const textarea = promptTextarea();
    fireEvent.change(textarea, { target: { value: "a hand edit" } });

    const checkboxes = ctxCheckboxes();
    expect(checkboxes.length).toBeGreaterThan(0);
    expect(checkboxes.every((cb) => cb.disabled)).toBe(true);
    // `.lp-ctx.is-locked` + `.lp-ctx__note` → `togglesPaused()`, which asserts
    // the same two user-visible facts: every box disabled, and the note shown.
    expect(togglesPaused()).toBe(true);
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
    const textarea = promptTextarea();
    fireEvent.change(textarea, { target: { value: "a hand edit" } });
    expect(togglesPaused()).toBe(true);

    fireEvent.click(ghostButton("Reset from ticket"));

    const expected = composeSectionPrompt(sections, new Set(["title", "description"]));
    expect(promptText()).toBe(expected);
    expect(ctxCheckboxes().every((cb) => !cb.disabled)).toBe(true);
    expect(togglesPaused()).toBe(false);
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
    const textarea = promptTextarea();

    fireEvent.change(textarea, { target: { value: "a hand edit" } });
    expect(togglesPaused()).toBe(true);

    fireEvent.change(textarea, { target: { value: composed } });
    expect(togglesPaused()).toBe(false);
    expect(ctxCheckboxes().every((cb) => !cb.disabled)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Composer additions (task #35)
// ---------------------------------------------------------------------------

/** Was `.lp-rows .lp-row` with an `.lp-row__l` label; every label/control pair
 *  in the inspector and the session block is a `.dk-kv` row now. */
function sessionRow(label: string): HTMLElement {
  const row = Array.from(
    document.querySelectorAll<HTMLElement>(".dk-kv"),
  ).find((el) => el.querySelector("span")?.textContent === label);
  if (!row) throw new Error(`no .dk-kv row labelled "${label}"`);
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

    // `.lp-select__v` carried the chosen label; a real `<select>` reports it
    // through its selected option.
    const profileRow = sessionRow("Profile");
    const profileSelect = profileRow.querySelector<HTMLSelectElement>("select");
    expect(profileSelect?.value).toBe("5");
    expect(profileSelect?.selectedOptions[0]?.textContent).toBe("Work profile");

    // `.lp-seg`/`is-on` → `.dk-seg`/`on`, plus the aria-pressed the segment
    // now carries.
    const popoutButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".dk-seg button"),
    ).find((b) => b.textContent === "Popout window");
    expect(popoutButton?.className).toContain("on");
    expect(popoutButton?.getAttribute("aria-pressed")).toBe("true");
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
    expect(paneTiles()).toHaveLength(9);
    expect(launchButton().disabled).toBe(true);
    expect(launchButton().getAttribute("title")).toContain(
      "at most 8 panes",
    );
  });
});

describe("LaunchComposer — preset delete (task #35)", () => {
  it("deleting a saved preset calls useDeleteLaunchPreset and not applyPreset", () => {
    // The delete was a `.lp-recipe__x` button on the chip; Deck puts a
    // destructive row action in the row's overflow instead, so it takes two
    // clicks — open the menu, then pick Delete.
    const preset = fakePreset({ name: "My Preset" });
    mockUseLaunchPresets.mockReturnValue({ data: [preset] });
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);

    const chip = recipeButton("My Preset");
    fireEvent.click(presetMenuTrigger("My Preset"));
    fireEvent.click(presetDeleteItem("My Preset"));

    expect(deletePresetMutateAsync).toHaveBeenCalledTimes(1);
    expect(deletePresetMutateAsync).toHaveBeenCalledWith(preset.id);
    // stopPropagation proof: the row's own onOpen (applyPreset) never fired —
    // the built-in "Agent + shell" recipe is still the active one. `is-on`
    // became Deck's `on`.
    expect(recipeButton("Agent + shell").className).toContain("on");
    expect(chip.className).not.toContain("on");
  });

  it("Enter/Space reaches the preset's overflow delete instead of applying it", async () => {
    // Regression test for the keydown-bubbling race, re-pointed at the new
    // control. The row is a `DeckLine`, whose own onKeyDown calls
    // `preventDefault()` and applies the row on Enter/Space. Without the
    // actions cell stopping that key, it would bubble from the overflow
    // trigger, apply the preset, and suppress the trigger's own activation —
    // so the menu would never open and the delete would never happen.
    const preset = fakePreset({ name: "My Preset" });
    mockUseLaunchPresets.mockReturnValue({ data: [preset] });
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);

    const chip = recipeButton("My Preset");

    presetMenuTrigger("My Preset").focus();
    await userEvent.keyboard("{Enter}");
    presetDeleteItem("My Preset").focus();
    await userEvent.keyboard("{Enter}");

    expect(deletePresetMutateAsync).toHaveBeenCalledTimes(1);
    expect(deletePresetMutateAsync).toHaveBeenCalledWith(preset.id);
    expect(recipeButton("Agent + shell").className).toContain("on");
    expect(chip.className).not.toContain("on");

    presetMenuTrigger("My Preset").focus();
    await userEvent.keyboard(" ");
    presetDeleteItem("My Preset").focus();
    await userEvent.keyboard(" ");

    expect(deletePresetMutateAsync).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Deck conversion (#283)
//
// The composer's selectors were portalled `LpSelect` popovers and are real
// `<select>`s in `.dk-sel` now. `lp-popover.test.tsx` went with the component;
// eight of its nine tests covered that widget's own portal/flip/outside-click
// mechanics, which no longer exist. The ninth — the provider swatch and its
// neutral fallback — is kept below, and the rest of this block covers each
// composer capability *through its new control*, which the popover suite never
// did: every one of these drives a `<select>` and asserts the composed plan or
// the rendered pane.
// ---------------------------------------------------------------------------

describe("LaunchComposer — Deck controls (#283)", () => {
  /** Launch and return the plan the composer handed to `onLaunch`. */
  function launchedPlan(onLaunch: ReturnType<typeof vi.fn>): LaunchComposerPlan {
    fireEvent.click(launchButton());
    return onLaunch.mock.calls[0]?.[0] as LaunchComposerPlan;
  }

  it("portals inside a .deck scope, so Deck's tokens resolve through the portal", () => {
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);
    const modal = document.querySelector(".dk-modal");
    expect(modal).not.toBeNull();
    expect(modal?.closest(".deck")).not.toBeNull();
    // ...and it is still a portal to the body, not a child of the test root.
    expect(document.body.contains(modal!)).toBe(true);
  });

  it("picking a provider resets the model to that provider's own default", () => {
    useAgentCatalogStore.setState({
      providers: [
        provider({ id: 1, displayName: "Anthropic", defaultModel: "opus" }),
        provider({ id: 2, displayName: "OpenAI", defaultModel: "gpt" }),
      ],
      loaded: true,
      loading: false,
    });
    const onLaunch = vi.fn();
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={onLaunch} />);
    expect(paneBodies()[0]).toContain("opus");

    fireEvent.change(selectFor("Provider"), { target: { value: "2" } });

    expect(paneBodies()[0]).toContain("gpt");
    const pane = launchedPlan(onLaunch).panes.find((p) => p.kind === "agent");
    expect(pane).toMatchObject({ providerId: 2, model: "gpt" });
  });

  it("picking a model reaches the pane and the launched plan", () => {
    useAgentCatalogStore.setState({
      providers: [
        provider({
          id: 1,
          displayName: "Anthropic",
          defaultModel: "opus",
          models: [
            providerModel({ id: 1, model_name: "opus", display_name: "Opus" }),
            providerModel({ id: 2, model_name: "haiku", display_name: "Haiku" }),
          ],
        }),
      ],
      loaded: true,
      loading: false,
    });
    const onLaunch = vi.fn();
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={onLaunch} />);

    fireEvent.change(selectFor("Model"), { target: { value: "haiku" } });

    expect(paneBodies()[0]).toContain("haiku");
    expect(
      launchedPlan(onLaunch).panes.find((p) => p.kind === "agent"),
    ).toMatchObject({ model: "haiku" });
  });

  it("picking a permission mode shows its label on the pane and ships it in the plan", () => {
    const onLaunch = vi.fn();
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={onLaunch} />);
    expect(paneBodies()[0]).toContain("CLI default");

    fireEvent.change(selectFor("Mode"), { target: { value: "plan" } });

    expect(paneBodies()[0]).toContain("plan");
    expect(
      launchedPlan(onLaunch).panes.find((p) => p.kind === "agent"),
    ).toMatchObject({ permissionMode: "plan" });
  });

  it("the Mode row carries the chosen mode's explanatory title", () => {
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);
    fireEvent.change(selectFor("Mode"), { target: { value: "plan" } });
    expect(sessionRow("Mode").getAttribute("title")).toContain("Plan mode");
  });

  it("a provider with no colour still renders a swatch, with the neutral fallback", () => {
    // The one capability assertion kept from `lp-popover.test.tsx`: the swatch
    // moved from each menu row to the `.dk-sel` trigger, because a native
    // listbox cannot carry one.
    useAgentCatalogStore.setState({
      providers: [provider({ id: 1, color: null })],
      loaded: true,
      loading: false,
    });
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);

    const swatch = selectFor("Provider").previousElementSibling as HTMLElement;
    expect(swatch).not.toBeNull();
    expect(swatch.style.background).toBe("var(--fg-4)");
  });

  it("a provider's colour reaches both its swatch and the pane tile's border", () => {
    useAgentCatalogStore.setState({
      providers: [provider({ id: 1, color: "rgb(1, 2, 3)" })],
      loaded: true,
      loading: false,
    });
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);

    const swatch = selectFor("Provider").previousElementSibling as HTMLElement;
    expect(swatch.style.background).toBe("rgb(1, 2, 3)");
    // The selected tile shows selection instead; the unselected agent tile
    // carries the provider colour.
    fireEvent.click(recipeButton("Compare 3"));
    const unselected = paneTiles().filter((t) => !t.className.includes("on"));
    expect(unselected.length).toBeGreaterThan(0);
    expect(unselected[0]!.style.borderColor).toBe("rgb(1, 2, 3)");
  });

  it("the shell inspector's Shell and Run controls drive the tile and the plan", () => {
    const onLaunch = vi.fn();
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={onLaunch} />);
    fireEvent.click(recipeButton("Single agent"));
    fireEvent.click(paneKindToggle("Shell"));

    expect(paneBodies()[0]).toContain("$SHELL");
    fireEvent.change(selectFor("Shell"), { target: { value: "/bin/zsh" } });
    expect(paneBodies()[0]).toContain("/bin/zsh");

    const run = document.querySelector<HTMLInputElement>(
      'input[aria-label="Run"]',
    );
    if (!run) throw new Error("expected the Run command input");
    fireEvent.change(run, { target: { value: "npm run dev" } });
    expect(paneBodies()[0]).toContain("npm run dev");

    expect(launchedPlan(onLaunch).panes[0]).toMatchObject({
      kind: "shell",
      shell: "/bin/zsh",
      command: "npm run dev",
    });
  });

  it("Duplicate adds a second pane and Remove takes it away again", () => {
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={vi.fn()} />);
    fireEvent.click(recipeButton("Single agent"));
    expect(paneTiles()).toHaveLength(1);

    fireEvent.click(ghostButton("Duplicate"));
    expect(paneTiles()).toHaveLength(2);
    expect(launchButton().textContent).toContain("Launch 2 panes");

    const remove = document.querySelector<HTMLButtonElement>(
      'button[aria-label^="Remove "]',
    );
    if (!remove) throw new Error("expected a remove button");
    fireEvent.click(remove);
    expect(paneTiles()).toHaveLength(1);
  });

  it("the send-prompt toggle moves the prompt count and the pane's prompt tag", () => {
    const onLaunch = vi.fn();
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={onLaunch} />);
    fireEvent.click(recipeButton("Single agent"));
    expect(groupMeta("prompt")).toBe("1 of 1 agent panes");
    expect(paneBodies()[0]).toContain("prompt");

    const toggle = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).at(-1);
    if (!toggle) throw new Error("expected the send-prompt checkbox");
    fireEvent.click(toggle);

    expect(groupMeta("prompt")).toBe("0 of 1 agent panes");
    expect(paneBodies()[0]).not.toContain("prompt");
    expect(launchedPlan(onLaunch).panes[0]).toMatchObject({
      sendPrompt: false,
    });
  });

  it("the split segments reach the footer summary and the launched plan", () => {
    const onLaunch = vi.fn();
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={onLaunch} />);
    expect(footerText()).toContain("cols");

    const rows = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".dk-seg button"),
    ).find((b) => b.textContent === "Rows");
    if (!rows) throw new Error("expected the Rows split segment");
    fireEvent.click(rows);

    expect(footerText()).toContain("rows");
    expect(launchedPlan(onLaunch).split).toBe("rows");
  });

  it("the Project and Open-in controls reach the launched plan", () => {
    mockUseProjects.mockReturnValue({
      data: [project(), project({ id: 2, name: "other", path: "/repo/other" })],
    });
    const onLaunch = vi.fn();
    render(<LaunchComposer open onClose={vi.fn()} onLaunch={onLaunch} />);

    fireEvent.change(selectFor("Project"), { target: { value: "2" } });
    const popout = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".dk-seg button"),
    ).find((b) => b.textContent === "Popout window");
    if (!popout) throw new Error("expected the Popout segment");
    fireEvent.click(popout);

    const plan = launchedPlan(onLaunch);
    expect(plan.projectId).toBe(2);
    expect(plan.target).toBe("popout");
  });

  it("the Profile select reaches the launched plan, and None clears it", () => {
    mockUseLookups.mockReturnValue({
      data: { profiles: [{ id: 5, name: "Work profile" }] },
    });
    const onLaunch = vi.fn();
    const { unmount } = render(
      <LaunchComposer open onClose={vi.fn()} onLaunch={onLaunch} />,
    );
    fireEvent.change(selectFor("Profile"), { target: { value: "5" } });
    expect(launchedPlan(onLaunch).profileId).toBe(5);
    unmount();

    const onLaunch2 = vi.fn();
    render(
      <LaunchComposer
        open
        onClose={vi.fn()}
        onLaunch={onLaunch2}
        initialProfileId={5}
      />,
    );
    fireEvent.change(selectFor("Profile"), { target: { value: "" } });
    expect(launchedPlan(onLaunch2).profileId).toBeNull();
  });

  it("Copy puts the prompt on the clipboard without closing the view", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(
      <LaunchComposer
        open
        onClose={vi.fn()}
        onLaunch={vi.fn()}
        initialPrompt="copy me"
      />,
    );

    fireEvent.click(ghostButton("Copy"));

    expect(writeText).toHaveBeenCalledWith("copy me");
    expect(promptText()).toBe("copy me");
  });

  it("the recipe and ticket-context lists are real grids, named for assistive tech", () => {
    render(
      <LaunchComposer
        open
        onClose={vi.fn()}
        onLaunch={vi.fn()}
        sections={[promptSection()]}
      />,
    );
    const recipes = document.querySelector(
      '[aria-label="Recipes and saved presets"]',
    );
    const context = document.querySelector(
      '[aria-label="Ticket context sections"]',
    );
    expect(recipes?.getAttribute("role")).toBe("grid");
    expect(context?.getAttribute("role")).toBe("grid");
    // The active recipe is the one carrying the `run` glyph.
    expect(
      recipeButton("Agent + shell").querySelector(".dk-s")?.getAttribute("data-s"),
    ).toBe("run");
  });
});
