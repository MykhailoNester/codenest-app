import { describe, it, expect } from "vitest";
import {
  composerReducer,
  composeSectionPrompt,
  defaultEnabledSectionIds,
  formatTokenTotal,
  initialComposerState,
  previewGridStyle,
  sectionTokenTotal,
  summarizeComposer,
  type AgentPane,
  type ComposerCatalogProvider,
  type ComposerPane,
  type ComposerState,
} from "../launch-composer";
import type { LaunchPromptSection } from "../launch-seed";

/** Minimal shell panes — `previewGridStyle` only reads `panes.length`. */
function dummyPanes(n: number): ComposerPane[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `x${i}`,
    kind: "shell",
    shell: "",
    command: "",
  }));
}

function provider(overrides: Partial<ComposerCatalogProvider> = {}): ComposerCatalogProvider {
  return {
    id: 1,
    displayName: "Provider 1",
    color: null,
    models: [],
    defaultModel: null,
    ...overrides,
  };
}

function agentPaneAt(state: ComposerState, index: number): AgentPane {
  const pane = state.panes[index];
  if (!pane || pane.kind !== "agent") throw new Error(`panes[${index}] is not an agent pane`);
  return pane;
}

describe("initialComposerState", () => {
  it("yields the devpair recipe: two panes [agent, shell], split cols, selected first", () => {
    const state = initialComposerState([]);
    expect(state.recipe).toBe("devpair");
    expect(state.panes.map((p) => p.kind)).toEqual(["agent", "shell"]);
    expect(state.split).toBe("cols");
    expect(state.selectedId).toBe(state.panes[0]?.id);
  });
});

describe("applyRecipe", () => {
  it("compare with three providers lands on three distinct providerIds", () => {
    const catalog = [provider({ id: 1 }), provider({ id: 2 }), provider({ id: 3 })];
    const state = composerReducer(initialComposerState([]), {
      type: "applyRecipe",
      recipe: "compare",
      catalog,
    });
    const ids = state.panes.map((p) => (p.kind === "agent" ? p.providerId : null));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(state.panes.every((p) => p.kind === "agent")).toBe(true);
  });

  it("compare with one provider that has three models lands on one providerId, three distinct models", () => {
    const catalog = [
      provider({
        id: 1,
        defaultModel: "m1",
        models: [
          { name: "m1", label: "Model 1" },
          { name: "m2", label: "Model 2" },
          { name: "m3", label: "Model 3" },
        ],
      }),
    ];
    const state = composerReducer(initialComposerState([]), {
      type: "applyRecipe",
      recipe: "compare",
      catalog,
    });
    expect(state.panes).toHaveLength(3);
    const providerIds = new Set(state.panes.map((p) => (p.kind === "agent" ? p.providerId : null)));
    expect(providerIds).toEqual(new Set([1]));
    const models = state.panes.map((p) => (p.kind === "agent" ? p.model : null));
    expect(new Set(models).size).toBe(3);
  });

  it("compare with an empty catalog yields three agent panes with providerId null, no throw", () => {
    const state = composerReducer(initialComposerState([]), {
      type: "applyRecipe",
      recipe: "compare",
      catalog: [],
    });
    expect(state.panes).toHaveLength(3);
    expect(state.panes.every((p) => p.kind === "agent" && p.providerId === null)).toBe(true);
  });

  it("devsetup yields split grid, one agent + two shells with non-empty commands", () => {
    const state = composerReducer(initialComposerState([]), {
      type: "applyRecipe",
      recipe: "devsetup",
      catalog: [],
    });
    expect(state.split).toBe("grid");
    expect(state.panes.filter((p) => p.kind === "agent")).toHaveLength(1);
    const shells = state.panes.filter((p) => p.kind === "shell");
    expect(shells).toHaveLength(2);
    for (const shell of shells) {
      expect(shell.kind === "shell" && shell.command.length > 0).toBe(true);
    }
  });
});

describe("recipe -> custom transitions (D8)", () => {
  const base = initialComposerState([]);

  it("addPane flips recipe to custom", () => {
    const state = composerReducer(base, { type: "addPane", kind: "shell", catalog: [] });
    expect(state.recipe).toBe("custom");
  });

  it("removePane flips recipe to custom", () => {
    const withThird = composerReducer(base, { type: "addPane", kind: "shell", catalog: [] });
    const state = composerReducer(withThird, {
      type: "removePane",
      id: agentPaneAt(withThird, 0).id,
    });
    expect(state.recipe).toBe("custom");
  });

  it("duplicatePane flips recipe to custom", () => {
    const state = composerReducer(base, {
      type: "duplicatePane",
      id: agentPaneAt(base, 0).id,
    });
    expect(state.recipe).toBe("custom");
  });

  it("patchPane flips recipe to custom", () => {
    const pane = agentPaneAt(base, 0);
    const state = composerReducer(base, {
      type: "patchPane",
      pane: { ...pane, sendPrompt: false },
    });
    expect(state.recipe).toBe("custom");
  });

  it("setPaneKind flips recipe to custom", () => {
    const pane = agentPaneAt(base, 0);
    const state = composerReducer(base, {
      type: "setPaneKind",
      id: pane.id,
      kind: "shell",
      catalog: [],
    });
    expect(state.recipe).toBe("custom");
  });

  it("setSplit flips recipe to custom", () => {
    const state = composerReducer(base, { type: "setSplit", split: "grid" });
    expect(state.recipe).toBe("custom");
  });

  it("selectPane leaves recipe unchanged", () => {
    const shellPane = base.panes[1];
    if (!shellPane) throw new Error("expected a second pane");
    const state = composerReducer(base, { type: "selectPane", id: shellPane.id });
    expect(state.recipe).toBe("devpair");
    expect(state.selectedId).toBe(shellPane.id);
  });
});

describe("removePane", () => {
  it("never removes the last pane", () => {
    const single = composerReducer(initialComposerState([]), {
      type: "applyRecipe",
      recipe: "single",
      catalog: [],
    });
    expect(single.panes).toHaveLength(1);
    const onlyId = single.panes[0]?.id;
    if (!onlyId) throw new Error("expected a pane");
    const state = composerReducer(single, { type: "removePane", id: onlyId });
    expect(state.panes).toHaveLength(1);
  });

  it("re-selects a surviving pane when the removed pane was selected (middle of three)", () => {
    const three = composerReducer(initialComposerState([]), {
      type: "applyRecipe",
      recipe: "compare",
      catalog: [],
    });
    const middle = three.panes[1];
    if (!middle) throw new Error("expected three panes");
    const selected = composerReducer(three, { type: "selectPane", id: middle.id });
    const state = composerReducer(selected, { type: "removePane", id: middle.id });
    expect(state.selectedId).not.toBeNull();
    expect(state.panes.some((p) => p.id === state.selectedId)).toBe(true);
  });
});

describe("duplicatePane", () => {
  it("appends a pane with a fresh id and identical config, and selects the copy", () => {
    const base = initialComposerState([]);
    const original = agentPaneAt(base, 0);
    const state = composerReducer(base, { type: "duplicatePane", id: original.id });
    expect(state.panes).toHaveLength(3);
    const copy = state.panes[state.panes.length - 1];
    if (!copy) throw new Error("expected a copy");
    expect(copy.id).not.toBe(original.id);
    expect(copy).toMatchObject({
      kind: original.kind,
      providerId: original.providerId,
      model: original.model,
      permissionMode: original.permissionMode,
      sendPrompt: original.sendPrompt,
    });
    expect(state.selectedId).toBe(copy.id);
  });
});

describe("setPaneKind", () => {
  it("keeps the pane's id and its index in the list", () => {
    const base = initialComposerState([]);
    const shellPane = base.panes[1];
    if (!shellPane) throw new Error("expected a second pane");
    const state = composerReducer(base, {
      type: "setPaneKind",
      id: shellPane.id,
      kind: "agent",
      catalog: [],
    });
    expect(state.panes[1]?.id).toBe(shellPane.id);
    expect(state.panes[1]?.kind).toBe("agent");
  });
});

describe("summarizeComposer", () => {
  it("matches panes after a scripted sequence: recipe -> add shell -> remove agent -> duplicate", () => {
    let state = composerReducer(initialComposerState([]), {
      type: "applyRecipe",
      recipe: "devpair",
      catalog: [],
    });
    state = composerReducer(state, { type: "addPane", kind: "shell", catalog: [] });
    const agentId = state.panes.find((p) => p.kind === "agent")?.id;
    if (!agentId) throw new Error("expected an agent pane");
    state = composerReducer(state, { type: "removePane", id: agentId });
    const someId = state.panes[0]?.id;
    if (!someId) throw new Error("expected a pane");
    state = composerReducer(state, { type: "duplicatePane", id: someId });

    const summary = summarizeComposer(state);
    expect(summary.agents + summary.shells).toBe(summary.total);
    expect(summary.total).toBe(state.panes.length);
  });
});

describe("previewGridStyle", () => {
  it("cols/rows map to N tracks", () => {
    const panes = dummyPanes(3);
    expect(previewGridStyle(panes, "cols")).toEqual({ gridTemplateColumns: "repeat(3,1fr)" });
    expect(previewGridStyle(panes, "rows")).toEqual({ gridTemplateRows: "repeat(3,1fr)" });
  });

  it("grid maps 3 panes to 2 columns and 4 panes to 2 columns", () => {
    expect(previewGridStyle(dummyPanes(3), "grid")).toEqual({
      gridTemplateColumns: "repeat(2,1fr)",
    });
    expect(previewGridStyle(dummyPanes(4), "grid")).toEqual({
      gridTemplateColumns: "repeat(2,1fr)",
    });
  });
});

describe("catalogResolved (D13)", () => {
  it("is an identity on an empty catalog (render-loop termination proof)", () => {
    const state = initialComposerState([]);
    const next = composerReducer(state, { type: "catalogResolved", catalog: [] });
    expect(next).toBe(state);
  });

  it("is an identity when every agent pane already has a provider", () => {
    const catalog = [provider({ id: 1 })];
    const state = composerReducer(initialComposerState(catalog), {
      type: "applyRecipe",
      recipe: "devpair",
      catalog,
    });
    const next = composerReducer(state, { type: "catalogResolved", catalog });
    expect(next).toBe(state);
  });

  it("recipe rebuild keeps pane ids and selection, resolving providers onto them", () => {
    const state = initialComposerState([]); // devpair, providerId null
    const catalog = [provider({ id: 5, defaultModel: "d5" }), provider({ id: 6 })];
    const before = state.panes.map((p) => p.id);
    const next = composerReducer(state, { type: "catalogResolved", catalog });

    expect(next.panes.map((p) => p.id)).toEqual(before);
    expect(next.selectedId).toBe(state.selectedId);
    expect(next.recipe).toBe("devpair");
    expect(next.split).toBe(state.split);
    const agent = next.panes[0];
    expect(agent?.kind === "agent" && agent.providerId).toBe(5);
    expect(agent?.kind === "agent" && agent.model).toBe("d5");
  });

  it("compare on a cold start still lands on three distinct providers", () => {
    const cold = composerReducer(initialComposerState([]), {
      type: "applyRecipe",
      recipe: "compare",
      catalog: [],
    });
    const catalog = [provider({ id: 1 }), provider({ id: 2 }), provider({ id: 3 })];
    const resolved = composerReducer(cold, { type: "catalogResolved", catalog });
    const ids = resolved.panes.map((p) => (p.kind === "agent" ? p.providerId : null));
    expect(new Set(ids).size).toBe(3);
  });

  it("custom mode fills only the null providerIds, leaving an edited pane untouched", () => {
    let state = initialComposerState([]); // devpair: [agent(providerId null), shell]
    const original = agentPaneAt(state, 0);
    state = composerReducer(state, {
      type: "patchPane",
      pane: { ...original, providerId: 42, model: "custom-model" },
    });
    expect(state.recipe).toBe("custom");
    state = composerReducer(state, { type: "addPane", kind: "agent", catalog: [] });
    const addedId = state.selectedId;
    if (!addedId) throw new Error("expected the added pane to be selected");

    const catalog = [provider({ id: 7, defaultModel: "d7" }), provider({ id: 8 })];
    const resolved = composerReducer(state, { type: "catalogResolved", catalog });

    const editedPane = resolved.panes.find((p) => p.id === original.id);
    expect(editedPane).toMatchObject({ providerId: 42, model: "custom-model" });

    const addedPane = resolved.panes.find((p) => p.id === addedId);
    expect(addedPane).toMatchObject({ providerId: 7, model: "d7" });

    expect(resolved.recipe).toBe("custom");
  });
});

function section(overrides: Partial<LaunchPromptSection> = {}): LaunchPromptSection {
  return {
    id: "title",
    label: "Title + ref",
    text: "You are working on task #7: Investigate CI",
    tokens: 11,
    default_on: true,
    ...overrides,
  };
}

describe("prompt sections", () => {
  const title = section({ id: "title", text: "title text", tokens: 3 });
  const description = section({
    id: "description",
    label: "Description",
    text: "description text",
    tokens: 5,
    default_on: true,
  });
  const labels = section({
    id: "labels",
    label: "Labels",
    text: "Labels: Bug",
    tokens: 4,
    default_on: false,
  });
  const all = [title, description, labels];

  it("composeSectionPrompt joins enabled sections in section order with a blank line", () => {
    const enabled = new Set(["labels", "title", "description"]);
    expect(composeSectionPrompt(all, enabled)).toBe(
      "title text\n\ndescription text\n\nLabels: Bug",
    );
  });

  it("reordering `enabled` does not reorder the output", () => {
    const forward = new Set(["title", "description"]);
    const backward = new Set(["description", "title"]);
    expect(composeSectionPrompt(all, forward)).toBe(
      composeSectionPrompt(all, backward),
    );
  });

  it("unchecking a section removes exactly its text", () => {
    const withAll = new Set(["title", "description"]);
    const withoutDescription = new Set(["title"]);
    const full = composeSectionPrompt(all, withAll);
    const reduced = composeSectionPrompt(all, withoutDescription);
    expect(full).toBe(reduced + "\n\ndescription text");
  });

  it("sectionTokenTotal drops by exactly the unchecked row's tokens", () => {
    const withAll = new Set(["title", "description"]);
    const withoutDescription = new Set(["title"]);
    const before = sectionTokenTotal(all, withAll);
    const after = sectionTokenTotal(all, withoutDescription);
    expect(before - after).toBe(description.tokens);
  });

  it("defaultEnabledSectionIds honours default_on", () => {
    expect(defaultEnabledSectionIds(all)).toEqual(["title", "description"]);
  });

  it("formatTokenTotal(540) === '~0.54k tokens'", () => {
    expect(formatTokenTotal(540)).toBe("~0.54k tokens");
  });

  it("formatTokenTotal(0) === '~0.00k tokens'", () => {
    expect(formatTokenTotal(0)).toBe("~0.00k tokens");
  });

  it("composeSectionPrompt([], new Set()) === ''", () => {
    expect(composeSectionPrompt([], new Set())).toBe("");
  });

  it("sectionTokenTotal([], …) === 0", () => {
    expect(sectionTokenTotal([], new Set())).toBe(0);
  });
});
