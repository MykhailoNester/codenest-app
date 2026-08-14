/**
 * launch-composer.ts — the launch composer's pane-list reducer, recipe
 * factories and footer/preview helpers.
 *
 * A plain `.ts` module on purpose: `eslint-plugin-react-refresh`'s
 * `only-export-components` rule is an **error** in this repo's config
 * (`eslint.config.js:16`) and rejects a plain function exported beside a
 * component from a `.tsx` file (`taskboard/composer-modal.tsx:75-82`,
 * `task-detail/properties-card.tsx:26-28`). The reducer must be exported to
 * be unit-tested, so it lives here instead of in `launch-composer.tsx`.
 *
 * Pane ids are minted deterministically (`"p1"`, `"p2"`, …, tracked by
 * `ComposerState.nextId`) rather than with `Math.random()`
 * (contrast `d3-launch.jsx:17`) so reducer tests can assert on ids without a
 * seed or a mock, and so `catalogResolved` (see below) can re-derive a
 * recipe's panes while keeping their ids — which is what lets the current
 * selection survive a catalog that resolves after the reducer was seeded.
 */

import type { CSSProperties } from "react";
import type { SourceKind, LaunchTarget } from "./launch-seed";

// ---------------------------------------------------------------------------
// Pane types
// ---------------------------------------------------------------------------

export type SplitMode = "cols" | "rows" | "grid";
export type RecipeId = "single" | "devpair" | "compare" | "devsetup" | "custom";

export interface AgentPane {
  id: string;
  kind: "agent";
  /** null only while the catalog is empty (or the pane has not been
   *  resolved onto it yet — see `catalogResolved`). */
  providerId: number | null;
  /** null = CLI default. */
  model: string | null;
  /** A `LIVE_PERMISSION_MODES` value; `""` = CLI default. */
  permissionMode: string;
  /** "send the shared prompt on open". */
  sendPrompt: boolean;
}

export interface ShellPane {
  id: string;
  kind: "shell";
  /** `""` = `$SHELL`, else an absolute path (`src-tauri/src/pty/mod.rs:159-170`
   *  rejects anything else — see the plan's D7). */
  shell: string;
  /** `""` = interactive. */
  command: string;
}

export type ComposerPane = AgentPane | ShellPane;

/**
 * `Omit` is **not** distributive: `Omit<ComposerPane, "id">` collapses to
 * `{ kind: "agent" | "shell" }` (keyof a union is the *shared* keys), which
 * makes every recipe's pane literal trip the excess-property check.
 * Distribute it by hand.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** A pane before it is given an id — what a recipe (or a pane factory)
 *  returns. */
export type PaneDraft = DistributiveOmit<ComposerPane, "id">;

/** The subset of `CatalogProvider` (`stores/agent-catalog-store.ts`) the
 *  reducer needs — keeps it store-free and trivially constructible in a
 *  test. */
export interface ComposerCatalogProvider {
  id: number;
  displayName: string;
  color: string | null;
  models: { name: string; label: string }[];
  defaultModel: string | null;
}

export interface ComposerState {
  recipe: RecipeId;
  panes: ComposerPane[];
  split: SplitMode;
  selectedId: string | null;
  nextId: number;
}

export type ComposerAction =
  | {
      type: "applyRecipe";
      recipe: Exclude<RecipeId, "custom">;
      catalog: ComposerCatalogProvider[];
    }
  | { type: "addPane"; kind: ComposerPane["kind"]; catalog: ComposerCatalogProvider[] }
  | { type: "removePane"; id: string }
  | { type: "duplicatePane"; id: string }
  | { type: "patchPane"; pane: ComposerPane }
  | {
      type: "setPaneKind";
      id: string;
      kind: ComposerPane["kind"];
      catalog: ComposerCatalogProvider[];
    }
  | { type: "selectPane"; id: string }
  | { type: "setSplit"; split: SplitMode }
  | { type: "catalogResolved"; catalog: ComposerCatalogProvider[] };

// ---------------------------------------------------------------------------
// Pane factories
// ---------------------------------------------------------------------------

function agentPaneWith(providerId: number | null, model: string | null): PaneDraft {
  return { kind: "agent", providerId, model, permissionMode: "", sendPrompt: true };
}

function defaultAgentPane(catalog: ComposerCatalogProvider[]): PaneDraft {
  const first = catalog[0] ?? null;
  return agentPaneWith(first?.id ?? null, first?.defaultModel ?? null);
}

function shellPaneWith(command: string): PaneDraft {
  return { kind: "shell", shell: "", command };
}

function defaultShellPane(): PaneDraft {
  return shellPaneWith("");
}

/**
 * `compare`'s three panes, resolved deterministically from the real catalog
 * (there is no mock provider list to fall back to — D3): the first three
 * distinct providers; if fewer than three providers exist, the remainder is
 * filled with the first provider's next distinct models; if that too runs
 * out, the first provider's default model is repeated. With an empty
 * catalog every pane gets `providerId: null, model: null` (D4) — the dialog
 * degrades rather than throwing, and `catalogResolved` converges it once a
 * real catalog arrives (D13).
 */
function makeCompareAgentPanes(catalog: ComposerCatalogProvider[]): PaneDraft[] {
  const panes: PaneDraft[] = [];
  const distinctProviders = catalog.slice(0, 3);
  for (const provider of distinctProviders) {
    panes.push(agentPaneWith(provider.id, provider.defaultModel));
  }

  const first = catalog[0] ?? null;
  if (first === null) {
    while (panes.length < 3) panes.push(agentPaneWith(null, null));
    return panes;
  }

  const usedModels = new Set<string>();
  const firstPane = panes[0];
  if (firstPane && firstPane.kind === "agent" && firstPane.model !== null) {
    usedModels.add(firstPane.model);
  }
  const modelPool = first.models.map((m) => m.name);
  let poolIndex = 0;
  while (panes.length < 3) {
    let nextModel: string | null = null;
    while (poolIndex < modelPool.length) {
      const candidate = modelPool[poolIndex];
      poolIndex += 1;
      if (candidate !== undefined && !usedModels.has(candidate)) {
        nextModel = candidate;
        break;
      }
    }
    if (nextModel !== null) {
      usedModels.add(nextModel);
      panes.push(agentPaneWith(first.id, nextModel));
    } else {
      // The model pool ran out too — repeat the first provider on its
      // default model rather than leaving the pane unresolved.
      panes.push(agentPaneWith(first.id, first.defaultModel));
    }
  }
  return panes;
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

/**
 * Every recipe's pane count is a constant (single 1, devpair 2, compare 3,
 * devsetup 3) — nothing about the count depends on the catalog. That
 * invariant is what lets `catalogResolved` re-derive a recipe's panes onto
 * the existing ids by index (D13).
 */
export const RECIPES: ReadonlyArray<{
  id: Exclude<RecipeId, "custom">;
  label: string;
  desc: string;
  make: (catalog: ComposerCatalogProvider[]) => { panes: PaneDraft[]; split: SplitMode };
}> = [
  {
    id: "single",
    label: "Single agent",
    desc: "One conversation pane",
    make: (catalog) => ({ panes: [defaultAgentPane(catalog)], split: "cols" }),
  },
  {
    id: "devpair",
    label: "Agent + shell",
    desc: "Agent left, terminal right",
    make: (catalog) => ({
      panes: [defaultAgentPane(catalog), defaultShellPane()],
      split: "cols",
    }),
  },
  {
    id: "compare",
    label: "Compare 3",
    desc: "Same prompt, three models",
    make: (catalog) => ({ panes: makeCompareAgentPanes(catalog), split: "cols" }),
  },
  {
    id: "devsetup",
    label: "Dev setup",
    desc: "Agent + build + logs terminals",
    make: (catalog) => ({
      panes: [
        defaultAgentPane(catalog),
        shellPaneWith("npm run dev"),
        shellPaneWith("tail -f .codenest/logs/app.log"),
      ],
      split: "grid",
    }),
  },
];

// ---------------------------------------------------------------------------
// Id minting
// ---------------------------------------------------------------------------

function mintOne(nextId: number): { id: string; nextId: number } {
  return { id: `p${nextId}`, nextId: nextId + 1 };
}

/**
 * Assigns each draft the id already at its index in `existingIds`, minting a
 * fresh one (and bumping `nextId`) for any index beyond it. Called with
 * `existingIds: []` this simply mints every pane fresh (`applyRecipe`,
 * `initialComposerState`); called from `catalogResolved`'s recipe-rebuild
 * branch with the current pane ids, it re-derives the recipe's panes while
 * preserving them — minting only runs there if the recipe's pane count grew,
 * which is defensive: pane count is catalog-independent (see `RECIPES`), so
 * it is unreachable in practice.
 */
function zipDraftsOntoIds(
  drafts: readonly PaneDraft[],
  existingIds: readonly string[],
  startNextId: number,
): { panes: ComposerPane[]; nextId: number } {
  let nextId = startNextId;
  const panes = drafts.map((draft, i) => {
    const existing = existingIds[i];
    if (existing !== undefined) {
      return { ...draft, id: existing } as ComposerPane;
    }
    const minted = mintOne(nextId);
    nextId = minted.nextId;
    return { ...draft, id: minted.id } as ComposerPane;
  });
  return { panes, nextId };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function initialComposerState(catalog: ComposerCatalogProvider[]): ComposerState {
  const def = RECIPES.find((r) => r.id === "devpair");
  const made = def?.make(catalog) ?? { panes: [] as PaneDraft[], split: "cols" as SplitMode };
  const { panes, nextId } = zipDraftsOntoIds(made.panes, [], 1);
  return {
    recipe: "devpair",
    panes,
    split: made.split,
    selectedId: panes[0]?.id ?? null,
    nextId,
  };
}

/**
 * `catalogResolved` (D13): fills in the catalog dependencies a pane could
 * not resolve at the time it was created — the reducer's lazy initialiser
 * runs once, on first render, which may be before the sidecar's catalog
 * fetch has answered. Never rewrites a non-null `providerId`, so a pane the
 * user already pointed at a provider is never clobbered — and never changes
 * `recipe`, because late data is not a user edit (D8).
 *
 * Returns `state` unchanged (reference equality) both when the catalog is
 * still empty and when every agent pane already has a provider — the second
 * case is what makes the render-body dispatch that calls this action
 * terminate rather than loop.
 */
function applyCatalogResolved(
  state: ComposerState,
  catalog: readonly ComposerCatalogProvider[],
): ComposerState {
  if (catalog.length === 0) return state;
  const hasUnresolved = state.panes.some(
    (p) => p.kind === "agent" && p.providerId === null,
  );
  if (!hasUnresolved) return state;

  if (state.recipe !== "custom") {
    const def = RECIPES.find((r) => r.id === state.recipe);
    if (!def) return state;
    const made = def.make(catalog as ComposerCatalogProvider[]);
    const existingIds = state.panes.map((p) => p.id);
    const { panes, nextId } = zipDraftsOntoIds(made.panes, existingIds, state.nextId);
    return { ...state, panes, nextId };
  }

  const first = catalog[0];
  if (!first) return state;
  const panes = state.panes.map((p) =>
    p.kind === "agent" && p.providerId === null
      ? { ...p, providerId: first.id, model: first.defaultModel }
      : p,
  );
  return { ...state, panes };
}

export function composerReducer(
  state: ComposerState,
  action: ComposerAction,
): ComposerState {
  switch (action.type) {
    case "applyRecipe": {
      const def = RECIPES.find((r) => r.id === action.recipe);
      if (!def) return state;
      const made = def.make(action.catalog);
      const { panes, nextId } = zipDraftsOntoIds(made.panes, [], state.nextId);
      return {
        recipe: action.recipe,
        panes,
        split: made.split,
        selectedId: panes[0]?.id ?? null,
        nextId,
      };
    }

    case "addPane": {
      const draft =
        action.kind === "agent" ? defaultAgentPane(action.catalog) : defaultShellPane();
      const { id, nextId } = mintOne(state.nextId);
      const pane = { ...draft, id } as ComposerPane;
      return {
        ...state,
        panes: [...state.panes, pane],
        selectedId: id,
        recipe: "custom",
        nextId,
      };
    }

    case "removePane": {
      // Never remove the last pane.
      if (state.panes.length <= 1) return state;
      const idx = state.panes.findIndex((p) => p.id === action.id);
      if (idx === -1) return state;
      const next = state.panes.filter((p) => p.id !== action.id);
      const selectedId =
        state.selectedId === action.id
          ? (next[Math.min(idx, next.length - 1)]?.id ?? null)
          : state.selectedId;
      return { ...state, panes: next, selectedId, recipe: "custom" };
    }

    case "duplicatePane": {
      const pane = state.panes.find((p) => p.id === action.id);
      if (!pane) return state;
      const { id, nextId } = mintOne(state.nextId);
      const copy = { ...pane, id } as ComposerPane;
      return {
        ...state,
        panes: [...state.panes, copy],
        selectedId: id,
        recipe: "custom",
        nextId,
      };
    }

    case "patchPane": {
      const idx = state.panes.findIndex((p) => p.id === action.pane.id);
      if (idx === -1) return state;
      const panes = state.panes.slice();
      panes[idx] = action.pane;
      return { ...state, panes, recipe: "custom" };
    }

    case "setPaneKind": {
      const idx = state.panes.findIndex((p) => p.id === action.id);
      if (idx === -1) return state;
      const current = state.panes[idx];
      if (!current || current.kind === action.kind) return state;
      const draft =
        action.kind === "agent" ? defaultAgentPane(action.catalog) : defaultShellPane();
      const panes = state.panes.slice();
      panes[idx] = { ...draft, id: action.id } as ComposerPane;
      return { ...state, panes, recipe: "custom" };
    }

    case "selectPane":
      // `recipe` is untouched — selecting a pane is not an edit (D8).
      return { ...state, selectedId: action.id };

    case "setSplit":
      return { ...state, split: action.split, recipe: "custom" };

    case "catalogResolved":
      return applyCatalogResolved(state, action.catalog);

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Derived helpers — single sources so the preview, the inspector and the
// footer cannot drift from each other.
// ---------------------------------------------------------------------------

export function summarizeComposer(state: ComposerState): {
  agents: number;
  shells: number;
  total: number;
  split: SplitMode;
} {
  const agents = state.panes.filter((p) => p.kind === "agent").length;
  const shells = state.panes.filter((p) => p.kind === "shell").length;
  return { agents, shells, total: state.panes.length, split: state.split };
}

export function previewGridStyle(
  panes: readonly ComposerPane[],
  split: SplitMode,
): CSSProperties {
  const n = Math.max(panes.length, 1);
  if (split === "cols") return { gridTemplateColumns: `repeat(${n},1fr)` };
  if (split === "rows") return { gridTemplateRows: `repeat(${n},1fr)` };
  return { gridTemplateColumns: `repeat(${Math.ceil(Math.sqrt(n))},1fr)` };
}

export function paneLabel(panes: readonly ComposerPane[], pane: ComposerPane): string {
  const sameKind = panes.filter((p) => p.kind === pane.kind);
  const idx = sameKind.findIndex((p) => p.id === pane.id);
  const n = idx === -1 ? sameKind.length : idx + 1;
  return pane.kind === "agent" ? `Agent ${n}` : `Shell ${n}`;
}

// ---------------------------------------------------------------------------
// The composed plan `onLaunch` receives
// ---------------------------------------------------------------------------

/**
 * What `onLaunch` receives. Deliberately not a `LaunchSpec`
 * (`lib/launch.ts:121-186`): building one needs `renderProviderCommand`,
 * project path resolution, `mergeEnv` and `pathsExist` — all of which is the
 * wiring ticket that switches an entry point to this dialog.
 */
export interface LaunchComposerPlan {
  panes: ComposerPane[];
  split: SplitMode;
  prompt: string;
  projectId: number | null;
  profileId: number | null;
  target: LaunchTarget;
  source: { kind: SourceKind; id: number } | null;
}

export interface LaunchComposerSource {
  kind: SourceKind;
  id: number;
  title: string;
}
