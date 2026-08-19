/**
 * The launch session composer — a heterogeneous pane-list dialog (N agent
 * panes and N shell panes, each configured independently) that expresses
 * every section of `styles/d3-launch.css`: the recipe row, the editable pane
 * list with a live layout preview, the per-pane inspector, the prompt
 * view/edit pair and the session block.
 *
 * Fires `onLaunch(plan)` with the composed `LaunchComposerPlan` and stops
 * there — no `PaneLaunchSpec`, no PTY, no navigation. That wiring —
 * `lib/launch-composer.ts`'s `composerPlanToSpec` plus `applyPaneLayout` /
 * the popout queue — lives in `components/launch/launch-composer-dialog.tsx`,
 * the wrapper every launch entry point in the app now mounts (task #35).
 *
 * Every selector here (`LpSelect`, `components/launch/lp-popover.tsx`) opens
 * a portalled, fixed-position menu rather than an in-flow absolute one,
 * because `.lp-left`/`.lp-right` scroll independently and a menu opened from
 * a pane at the bottom of a scrolled column would otherwise be clipped —
 * see D1 in the plan and the header comment in `styles/d3-launch.css`.
 */

import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import {
  useProjects,
  useLookups,
  useLaunchPresets,
  useCreateLaunchPreset,
  useDeleteLaunchPreset,
  SidecarError,
} from "../../lib/api";
import type { LaunchTarget, LaunchPromptSection } from "../../lib/launch-seed";
import { useAgentCatalogStore } from "../../stores/agent-catalog-store";
import { useEscapeKey } from "../../hooks/use-escape-key";
import { Icon } from "../icon";
import { LpSelect, type LpSelectItem } from "./lp-popover";
import { LIVE_PERMISSION_MODES } from "../../lib/permission-modes";
import { MAX_LAUNCH_PANES } from "../../lib/launch";
import {
  RECIPES,
  composeSectionPrompt,
  composerPanesToPresetPanes,
  composerReducer,
  defaultEnabledSectionIds,
  describePreset,
  formatTokenTotal,
  initialComposerStateFrom,
  paneLabel,
  presetToDrafts,
  previewGridStyle,
  sectionTokenTotal,
  summarizeComposer,
  unresolvedPaneIds,
  type AgentPane,
  type BuiltinRecipeId,
  type ComposerAction,
  type ComposerCatalogProvider,
  type ComposerPane,
  type LaunchComposerPlan,
  type LaunchComposerSource,
  type PaneDraft,
  type ShellPane,
  type SplitMode,
} from "../../lib/launch-composer";

/** Stable identity so an unspecified `sections` prop does not change per
 *  render — the lazy `useState` initialisers below read it once (D7). */
const NO_SECTIONS: readonly LaunchPromptSection[] = [];

const SPLIT_OPTIONS: ReadonlyArray<{ id: SplitMode; label: string }> = [
  { id: "cols", label: "Columns" },
  { id: "rows", label: "Rows" },
  { id: "grid", label: "Grid" },
];

const SHELL_OPTIONS: readonly LpSelectItem[] = [
  { id: "", label: "Default ($SHELL)" },
  { id: "/bin/zsh", label: "/bin/zsh" },
  { id: "/bin/bash", label: "/bin/bash" },
  { id: "/bin/sh", label: "/bin/sh" },
];

/** Twelve of the mockup's fifteen icon names are absent from `icon.tsx`'s
 *  `PATHS` (D6 in the plan) — `bot` among them. A text glyph inside an
 *  `aria-hidden` span stands in wherever the design puts an agent-pane icon;
 *  the shell equivalent (`terminal`) does exist, so it renders the real
 *  icon. */
function PaneKindIcon({
  kind,
  size,
}: {
  kind: ComposerPane["kind"];
  size: number;
}): ReactElement {
  if (kind === "shell") return <Icon name="terminal" size={size} />;
  return <span aria-hidden="true">▸</span>;
}

function RecipeIcon({ id }: { id: BuiltinRecipeId }): ReactElement {
  if (id === "devpair") return <Icon name="terminal" size={14} />;
  return <span aria-hidden="true">{id === "single" ? "▸" : "▦"}</span>;
}

function modelItemsFor(
  provider: ComposerCatalogProvider | null,
): LpSelectItem[] {
  if (provider === null) return [];
  if (provider.models.length > 0) {
    return provider.models.map((m) => ({ id: m.name, label: m.label }));
  }
  if (provider.defaultModel !== null) {
    return [{ id: provider.defaultModel, label: provider.defaultModel }];
  }
  return [];
}

function modeLabelFor(mode: string): string {
  if (mode === "") return "CLI default";
  return (
    LIVE_PERMISSION_MODES.find((m) => m.value === mode)?.label ?? "CLI default"
  );
}

function AgentPaneBody({
  pane,
  catalog,
}: {
  pane: AgentPane;
  catalog: ComposerCatalogProvider[];
}): ReactElement {
  const provider =
    pane.providerId !== null
      ? (catalog.find((p) => p.id === pane.providerId) ?? null)
      : null;
  // Unreachable with a non-empty catalog once `catalogResolved` has
  // converged (D13) — reachable only with an empty catalog (`providerId`
  // stays null, D4) or a stale id no longer in the catalog (see the plan's
  // Edge cases).
  if (!provider) {
    return <span className="lp-pane__body mono">Unknown provider</span>;
  }
  return (
    <span className="lp-pane__body mono">
      {pane.model ?? "CLI default"}
      <br />
      <span className="lp-pane__dim">{modeLabelFor(pane.permissionMode)}</span>
      {pane.sendPrompt ? (
        <>
          <br />
          <span className="lp-pane__tag">prompt</span>
        </>
      ) : null}
    </span>
  );
}

function ShellPaneBody({ pane }: { pane: ShellPane }): ReactElement {
  const text =
    pane.command.trim() !== ""
      ? pane.command
      : `${pane.shell || "$SHELL"} — interactive`;
  return <span className="lp-pane__body mono">{text}</span>;
}

function PanePreview({
  panes,
  split,
  selectedId,
  catalog,
  onSelect,
  onRemove,
}: {
  panes: ComposerPane[];
  split: SplitMode;
  selectedId: string | null;
  catalog: ComposerCatalogProvider[];
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}): ReactElement {
  return (
    <div className="lp-prev" style={previewGridStyle(panes, split)}>
      {panes.map((pane) => {
        const provider =
          pane.kind === "agent" && pane.providerId !== null
            ? (catalog.find((p) => p.id === pane.providerId) ?? null)
            : null;
        const style: CSSProperties | undefined =
          provider?.color != null
            ? ({ "--pc": provider.color } as CSSProperties)
            : undefined;
        return (
          <div
            key={pane.id}
            role="button"
            tabIndex={0}
            data-pane-id={pane.id}
            className={`lp-pane lp-pane--${pane.kind}${selectedId === pane.id ? " is-sel" : ""}`}
            style={style}
            onClick={() => onSelect(pane.id)}
            // The mockup nests the remove control inside a `<button>`
            // (`d3-launch.jsx:101`) — invalid HTML and a hydration hazard.
            // This renders the pane as a `role="button"` div that also
            // handles Enter/Space, with a real nested `<button>` for remove.
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onSelect(pane.id);
            }}
          >
            <span className="lp-pane__head">
              <PaneKindIcon kind={pane.kind} size={11} />
              <span className="lp-pane__n">{paneLabel(panes, pane)}</span>
              {panes.length > 1 ? (
                <button
                  type="button"
                  className="lp-pane__x"
                  aria-label={`Remove ${paneLabel(panes, pane)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(pane.id);
                  }}
                >
                  <span aria-hidden="true">✕</span>
                </button>
              ) : null}
            </span>
            {pane.kind === "agent" ? (
              <AgentPaneBody pane={pane} catalog={catalog} />
            ) : (
              <ShellPaneBody pane={pane} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function AgentInspectorRows({
  pane,
  catalog,
  dispatch,
}: {
  pane: AgentPane;
  catalog: ComposerCatalogProvider[];
  dispatch: (action: ComposerAction) => void;
}): ReactElement {
  const providerItems: LpSelectItem[] = catalog.map((p) => ({
    id: String(p.id),
    label: p.displayName,
    dot: p.color,
  }));
  const provider = catalog.find((p) => p.id === pane.providerId) ?? null;
  const modeTitle =
    LIVE_PERMISSION_MODES.find((m) => m.value === pane.permissionMode)?.title ??
    "How much the session will do without asking, once it starts.";

  return (
    <>
      <div className="lp-row">
        <span className="lp-row__l">Provider</span>
        <LpSelect
          label="Provider"
          value={pane.providerId !== null ? String(pane.providerId) : ""}
          items={providerItems}
          width={250}
          placeholder={
            catalog.length === 0
              ? "No providers configured"
              : "Select a provider"
          }
          onPick={(id) => {
            // Picking a provider resets `model` to that provider's own
            // default (`d3-launch.jsx:139`) — a model registered against
            // the previous provider is not necessarily valid for this one.
            const next = catalog.find((p) => String(p.id) === id) ?? null;
            dispatch({
              type: "patchPane",
              pane: {
                ...pane,
                providerId: next?.id ?? null,
                model: next?.defaultModel ?? null,
              },
            });
          }}
        />
      </div>
      <div className="lp-row">
        <span className="lp-row__l">Model</span>
        <LpSelect
          label="Model"
          value={pane.model ?? ""}
          items={modelItemsFor(provider)}
          width={200}
          placeholder="CLI default"
          onPick={(id) =>
            dispatch({ type: "patchPane", pane: { ...pane, model: id } })
          }
        />
      </div>
      <div className="lp-row">
        <span className="lp-row__l">Mode</span>
        <div title={modeTitle}>
          <LpSelect
            label="Mode"
            value={pane.permissionMode}
            items={LIVE_PERMISSION_MODES.map((m) => ({
              id: m.value,
              label: m.label,
            }))}
            width={210}
            placeholder="CLI default"
            onPick={(id) =>
              dispatch({
                type: "patchPane",
                pane: { ...pane, permissionMode: id },
              })
            }
          />
        </div>
      </div>
      <div className="lp-row">
        <span className="lp-row__l">Prompt</span>
        <label className="lp-toggle">
          <input
            type="checkbox"
            checked={pane.sendPrompt}
            onChange={(e) =>
              dispatch({
                type: "patchPane",
                pane: { ...pane, sendPrompt: e.currentTarget.checked },
              })
            }
          />
          <span className="lp-toggle__t" />
          <span className="lp-toggle__l">Send the shared prompt on open</span>
        </label>
      </div>
    </>
  );
}

function ShellInspectorRows({
  pane,
  dispatch,
}: {
  pane: ShellPane;
  dispatch: (action: ComposerAction) => void;
}): ReactElement {
  return (
    <>
      <div className="lp-row">
        <span className="lp-row__l">Shell</span>
        <LpSelect
          label="Shell"
          value={pane.shell}
          items={SHELL_OPTIONS}
          width={150}
          onPick={(id) =>
            dispatch({ type: "patchPane", pane: { ...pane, shell: id } })
          }
        />
      </div>
      <div className="lp-row">
        <span className="lp-row__l">Run</span>
        <input
          className="lp-input mono"
          placeholder="optional command, e.g. npm run dev"
          value={pane.command}
          onChange={(e) =>
            dispatch({
              type: "patchPane",
              pane: { ...pane, command: e.currentTarget.value },
            })
          }
        />
      </div>
    </>
  );
}

function handleCopy(prompt: string): void {
  try {
    // jsdom (and a WebView without clipboard permission) has no
    // `navigator.clipboard` — the failure is silent, matching
    // `launch-modal.tsx:1061-1063`.
    void navigator.clipboard.writeText(prompt);
  } catch {
    // See above.
  }
}

export interface LaunchComposerProps {
  open: boolean;
  onClose: () => void;
  /** Present when opened from a task/inbox item; null from the top bar. */
  source?: LaunchComposerSource | null;
  /** Seeded prompt text; the composer owns edits from there. */
  initialPrompt?: string;
  /** Seeded project; falls back to the first launchable project. */
  initialProjectId?: number | null;
  /** Seeded prompt sections; read once at mount (see D7). Empty from the top
   *  bar, where there is no ticket. */
  sections?: readonly LaunchPromptSection[];
  /** Seeded profile id; read once at mount (`useState` initialiser). Absent
   *  or null → CLI default / no profile. */
  initialProfileId?: number | null;
  /** Seeded target; read once at mount. Defaults to `"embedded"`. */
  initialTarget?: LaunchTarget;
  /** A pre-built pane list (a seed's `rows`×`cols`, or a restored draft) to
   *  seed the reducer with instead of the `devpair` recipe. `null` — the
   *  default — is today's cold-start behaviour. Read once at mount. */
  initialLayout?: { panes: PaneDraft[]; split: SplitMode } | null;
  /** Fired by the Launch button and by Cmd/Ctrl+Enter. */
  onLaunch: (plan: LaunchComposerPlan) => void;
}

export function LaunchComposer({
  open,
  onClose,
  source = null,
  initialPrompt = "",
  initialProjectId = null,
  sections = NO_SECTIONS,
  initialProfileId = null,
  initialTarget = "embedded",
  initialLayout = null,
  onLaunch,
}: LaunchComposerProps): ReactElement | null {
  const providers = useAgentCatalogStore((s) => s.providers);
  const load = useAgentCatalogStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);

  // D3 in the plan: the catalog comes from `useAgentCatalogStore`, not
  // `useProviders()` + `useProviderModels()` — the latter is one query per
  // provider, which cannot serve an N-pane composer.
  const catalog = useMemo<ComposerCatalogProvider[]>(
    () =>
      providers.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        color: p.color,
        models: p.models.map((m) => ({
          name: m.model_name,
          label: m.display_name,
        })),
        defaultModel: p.defaultModel,
      })),
    [providers],
  );

  const { data: projectsData = [] } = useProjects();
  const launchableProjects = useMemo(
    () => projectsData.filter((p) => p.path !== null && p.path !== ""),
    [projectsData],
  );
  const { data: lookups } = useLookups();
  const profiles = lookups?.profiles ?? [];

  const { data: presets = [] } = useLaunchPresets();
  const createPreset = useCreateLaunchPreset();
  const deletePreset = useDeleteLaunchPreset();

  const [state, dispatch] = useReducer(
    composerReducer,
    { catalog, layout: initialLayout },
    initialComposerStateFrom,
  );

  const hasSections = sections.length > 0;
  const [enabledSections, setEnabledSections] = useState<Set<string>>(
    () => new Set(defaultEnabledSectionIds(sections)),
  );
  const [prompt, setPrompt] = useState(() =>
    sections.length > 0
      ? composeSectionPrompt(
          sections,
          new Set(defaultEnabledSectionIds(sections)),
        )
      : initialPrompt,
  );
  const [promptEditing, setPromptEditing] = useState(false);
  const [promptDirty, setPromptDirty] = useState(false);
  const [projectId, setProjectId] = useState<number | null>(initialProjectId);
  const [profileId, setProfileId] = useState<number | null>(initialProfileId);
  const [target, setTarget] = useState<LaunchTarget>(initialTarget);

  const [saveBarOpen, setSaveBarOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleLaunchRef = useRef<() => void>(() => {});
  useEscapeKey(onClose, open);

  const selectedPane =
    state.panes.find((p) => p.id === state.selectedId) ?? null;
  const summary = summarizeComposer(state);
  const hasAgentPane = state.panes.some((p) => p.kind === "agent");
  const unresolvedIds = unresolvedPaneIds(state.panes, catalog);
  const overPaneCap = state.panes.length > MAX_LAUNCH_PANES;
  const canLaunch =
    state.panes.length > 0 &&
    !overPaneCap &&
    projectId !== null &&
    !(hasAgentPane && catalog.length === 0) &&
    unresolvedIds.length === 0;

  const presetPanes = composerPanesToPresetPanes(state.panes);
  const canSavePreset =
    saveName.trim() !== "" &&
    projectId !== null &&
    presetPanes !== null &&
    state.panes.length > 0 &&
    state.panes.length <= 8;
  const saveDisabledReason = (): string | undefined => {
    if (saveName.trim() === "") return "Name the preset first";
    if (projectId === null)
      return "Pick a project with a path to save a preset";
    if (state.panes.length === 0) return "A preset needs at least one pane";
    if (state.panes.length > 8) return "A preset can hold at most 8 panes";
    if (presetPanes === null)
      return "A pane uses a provider that no longer exists";
    return undefined;
  };

  function handleLaunch(): void {
    if (!open || !canLaunch) return;
    onLaunch({
      panes: state.panes,
      split: state.split,
      prompt,
      projectId,
      profileId,
      target,
      source: source !== null ? { kind: source.kind, id: source.id } : null,
    });
  }

  function toggleSection(id: string): void {
    if (promptDirty) return; // belt and braces; the inputs are disabled
    const next = new Set(enabledSections);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setEnabledSections(next);
    setPrompt(composeSectionPrompt(sections, next));
  }

  function resetPromptFromSections(): void {
    setPrompt(composeSectionPrompt(sections, enabledSections));
    setPromptDirty(false);
  }

  function handleSavePreset(): void {
    const panes = composerPanesToPresetPanes(state.panes);
    if (projectId === null || panes === null) return;
    setSaveError(null);
    void createPreset
      .mutateAsync({
        name: saveName.trim(),
        project_id: projectId,
        target,
        profile_id: profileId,
        extra_args: "",
        split: state.split,
        panes,
      })
      .then(() => {
        setSaveBarOpen(false);
        setSaveName("");
      })
      .catch((err: unknown) => {
        if (err instanceof SidecarError && err.status === 409) {
          setSaveError(`A preset called “${saveName.trim()}” already exists.`);
        } else if (
          err instanceof SidecarError &&
          (err.status === 400 || err.status === 422)
        ) {
          setSaveError("This composition can't be saved as a preset.");
        } else {
          setSaveError("Could not save the preset.");
        }
      });
  }

  // D13.3 — assigning `handleLaunchRef.current` in the render body would be
  // a `react-hooks/refs` error; the assignment lives in a deps-less effect
  // instead (`taskboard/composer-modal.tsx:204-225`'s shape, including its
  // comment about why a *no-deps* keydown registration — as opposed to a
  // no-deps ref assignment — would be a bug).
  useEffect(() => {
    handleLaunchRef.current = handleLaunch;
  });
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleLaunchRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Promote sentinels in the render body, `launch-modal.tsx:303-309`'s
  // idiom rather than an effect: both guards are false immediately after
  // the corresponding `setState`/`dispatch`, so neither can loop, and a
  // mounted-but-closed composer converges too (this runs before the
  // `if (!open) return null` below), so opening it is never the first
  // moment either becomes correct.
  if (projectId === null && launchableProjects[0] !== undefined) {
    setProjectId(launchableProjects[0].id);
  }
  // D13 — the reducer's lazy initialiser ran once, on first render, from
  // whatever the catalog store held at that instant; on a cold cache or a
  // fresh install that is `[]`. This dispatch converges the panes once a
  // real catalog arrives — see `catalogResolved` in `lib/launch-composer.ts`.
  if (
    catalog.length > 0 &&
    state.panes.some((p) => p.kind === "agent" && p.providerId === null)
  ) {
    dispatch({ type: "catalogResolved", catalog });
  }

  if (!open) return null;

  const promptPanes = state.panes.filter(
    (p) => p.kind === "agent" && p.sendPrompt,
  ).length;

  return createPortal(
    <div
      className="lp-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="lp-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Launch session"
      >
        <header className="lp-head">
          <div className="lp-head__l">
            <span className="lp-head__icon">
              <Icon name="zap" size={14} />
            </span>
            <div>
              <h2 className="lp-head__t">Launch session</h2>
              {source !== null ? (
                <span className="lp-head__s">
                  from <span className="mono lp-head__ref">#{source.id}</span>
                  <span>— {source.title}</span>
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            className="lp-x"
            aria-label="Close"
            onClick={onClose}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </header>

        <div className="lp-body">
          <div className="lp-left">
            <section>
              <div className="lp-h">Recipe</div>
              <div className="lp-recipes">
                {RECIPES.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={`lp-recipe${state.recipe === r.id ? " is-on" : ""}`}
                    onClick={() =>
                      dispatch({ type: "applyRecipe", recipe: r.id, catalog })
                    }
                  >
                    <RecipeIcon id={r.id} />
                    <b>{r.label}</b>
                    <span>{r.desc}</span>
                  </button>
                ))}
                {presets.map((p) => {
                  const applyThisPreset = (): void =>
                    dispatch({
                      type: "applyPreset",
                      presetId: p.id,
                      ...presetToDrafts(p),
                    });
                  return (
                    // A saved preset chip is no longer a bare `<button>`: it
                    // now nests a real `<button>` for delete (below), and a
                    // `<button>` cannot contain another interactive control
                    // (the same nesting fix `PanePreview` above already
                    // documents for panes). `role="button"` + a matching
                    // `onKeyDown` keeps it keyboard-operable.
                    <div
                      key={`preset:${p.id}`}
                      role="button"
                      tabIndex={0}
                      className={`lp-recipe${state.recipe === `preset:${p.id}` ? " is-on" : ""}`}
                      onClick={applyThisPreset}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        applyThisPreset();
                      }}
                    >
                      <span aria-hidden="true">☆</span>
                      <b>{p.name}</b>
                      <span>{describePreset(p)}</span>
                      {p.unresolved.length > 0 ? (
                        <span
                          className="lp-recipe__warn"
                          title={`Missing or disabled provider: ${p.unresolved
                            .map((u) => `#${u.provider_id} (${u.reason})`)
                            .join(", ")}`}
                        >
                          ⚠ unresolved
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="lp-recipe__x"
                        aria-label={`Delete preset ${p.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void deletePreset
                            .mutateAsync(p.id)
                            .catch(() => undefined);
                        }}
                        onKeyDown={(e) => {
                          // Without this, Enter/Space bubbles to the outer
                          // `role="button"` div's onKeyDown, which calls
                          // `applyThisPreset()` instead of deleting — and
                          // that handler's `preventDefault()` suppresses
                          // this button's own native Enter/Space click.
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.stopPropagation();
                        }}
                      >
                        <span aria-hidden="true">✕</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>

            <section>
              <div className="lp-h lp-h--row">
                <span>
                  Layout
                  {state.recipe === "custom" ? (
                    <em className="lp-custom">custom</em>
                  ) : null}
                </span>
                <div className="lp-layoutctl">
                  <div className="lp-seg lp-seg--sm">
                    {SPLIT_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={state.split === opt.id ? "is-on" : ""}
                        onClick={() =>
                          dispatch({ type: "setSplit", split: opt.id })
                        }
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="lp-ghost"
                    onClick={() =>
                      dispatch({ type: "addPane", kind: "agent", catalog })
                    }
                  >
                    <span aria-hidden="true">＋</span> Agent
                  </button>
                  <button
                    type="button"
                    className="lp-ghost"
                    onClick={() =>
                      dispatch({ type: "addPane", kind: "shell", catalog })
                    }
                  >
                    <span aria-hidden="true">＋</span> Shell
                  </button>
                </div>
              </div>
              <PanePreview
                panes={state.panes}
                split={state.split}
                selectedId={state.selectedId}
                catalog={catalog}
                onSelect={(id) => dispatch({ type: "selectPane", id })}
                onRemove={(id) => dispatch({ type: "removePane", id })}
              />
              <div className="lp-prevhint">
                Click a pane to configure it — drag handles adjust size after
                launch
              </div>
            </section>

            {selectedPane ? (
              <div className="lp-insp">
                <div className="lp-insp__head">
                  <div className="lp-insp__title">
                    <PaneKindIcon kind={selectedPane.kind} size={13} />
                    {selectedPane.kind === "agent"
                      ? "Agent pane"
                      : "Shell pane"}
                  </div>
                  <div className="lp-insp__acts">
                    <div className="lp-seg lp-seg--sm">
                      <button
                        type="button"
                        className={selectedPane.kind === "agent" ? "is-on" : ""}
                        onClick={() =>
                          dispatch({
                            type: "setPaneKind",
                            id: selectedPane.id,
                            kind: "agent",
                            catalog,
                          })
                        }
                      >
                        Agent
                      </button>
                      <button
                        type="button"
                        className={selectedPane.kind === "shell" ? "is-on" : ""}
                        onClick={() =>
                          dispatch({
                            type: "setPaneKind",
                            id: selectedPane.id,
                            kind: "shell",
                            catalog,
                          })
                        }
                      >
                        Shell
                      </button>
                    </div>
                    <button
                      type="button"
                      className="lp-ghost"
                      onClick={() =>
                        dispatch({ type: "duplicatePane", id: selectedPane.id })
                      }
                    >
                      <span aria-hidden="true">⧉</span> Duplicate
                    </button>
                  </div>
                </div>
                <div className="lp-rows">
                  {selectedPane.kind === "agent" ? (
                    <AgentInspectorRows
                      pane={selectedPane}
                      catalog={catalog}
                      dispatch={dispatch}
                    />
                  ) : (
                    <ShellInspectorRows
                      pane={selectedPane}
                      dispatch={dispatch}
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="lp-insp lp-insp--empty">
                Select a pane to configure it.
              </div>
            )}
          </div>

          <div className="lp-right">
            <section>
              <div className="lp-h lp-h--row">
                <span>Prompt</span>
                <span className="lp-h__meta">
                  {promptPanes} of {summary.agents} agent panes
                </span>
              </div>
              {promptEditing ? (
                <textarea
                  className="lp-prompt mono"
                  value={prompt}
                  onChange={(e) => {
                    const next = e.currentTarget.value;
                    setPrompt(next);
                    if (hasSections) {
                      setPromptDirty(
                        next !==
                          composeSectionPrompt(sections, enabledSections),
                      );
                    }
                  }}
                  rows={7}
                  // This text is executed by an agent — never substituted,
                  // corrected or expanded on the way in.
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  autoComplete="off"
                />
              ) : (
                <div
                  className="lp-promptview"
                  onClick={() => setPromptEditing(true)}
                >
                  <pre className="mono">{prompt}</pre>
                  <div className="lp-promptview__foot">
                    <button
                      type="button"
                      className="lp-ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPromptEditing(true);
                      }}
                    >
                      <Icon name="settings" size={11} /> Edit
                    </button>
                    <button
                      type="button"
                      className="lp-ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCopy(prompt);
                      }}
                    >
                      <span aria-hidden="true">⧉</span> Copy
                    </button>
                  </div>
                </div>
              )}
            </section>

            {hasSections ? (
              <section>
                <div className="lp-h lp-h--row">
                  <span>Ticket context</span>
                  <span className="lp-h__meta tabular">
                    {formatTokenTotal(
                      sectionTokenTotal(sections, enabledSections),
                    )}
                  </span>
                </div>
                <div className={`lp-ctx${promptDirty ? " is-locked" : ""}`}>
                  {sections.map((s) => (
                    <label
                      key={s.id}
                      className={`lp-ctxrow${enabledSections.has(s.id) ? " is-on" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={enabledSections.has(s.id)}
                        disabled={promptDirty}
                        onChange={() => toggleSection(s.id)}
                      />
                      <span className="lp-ctxrow__box" aria-hidden="true">
                        ✓
                      </span>
                      <span className="lp-ctxrow__l">{s.label}</span>
                      <span className="lp-ctxrow__t tabular">~{s.tokens}</span>
                    </label>
                  ))}
                </div>
                {promptDirty ? (
                  <div className="lp-ctx__note">
                    <span className="lp-h__meta">
                      Prompt edited — toggles paused
                    </span>
                    <button
                      type="button"
                      className="lp-ghost"
                      onClick={resetPromptFromSections}
                    >
                      Reset from ticket
                    </button>
                  </div>
                ) : null}
              </section>
            ) : null}

            <section>
              <div className="lp-h">Session</div>
              <div className="lp-rows">
                <div className="lp-row">
                  <span className="lp-row__l">Project</span>
                  <LpSelect
                    label="Project"
                    value={projectId !== null ? String(projectId) : ""}
                    items={launchableProjects.map((p) => ({
                      id: String(p.id),
                      label: p.name,
                    }))}
                    width={250}
                    placeholder="No project with a path"
                    onPick={(id) => setProjectId(Number(id))}
                  />
                </div>
                <div className="lp-row">
                  <span className="lp-row__l">Profile</span>
                  <LpSelect
                    label="Profile"
                    value={profileId !== null ? String(profileId) : ""}
                    items={[
                      { id: "", label: "None" },
                      ...profiles.map((p) => ({
                        id: String(p.id),
                        label: p.name,
                      })),
                    ]}
                    width={190}
                    onPick={(id) => setProfileId(id === "" ? null : Number(id))}
                  />
                </div>
                <div className="lp-row">
                  <span className="lp-row__l">Open in</span>
                  <div className="lp-seg lp-seg--sm">
                    <button
                      type="button"
                      className={target === "embedded" ? "is-on" : ""}
                      onClick={() => setTarget("embedded")}
                    >
                      Sessions tab
                    </button>
                    <button
                      type="button"
                      className={target === "popout" ? "is-on" : ""}
                      onClick={() => setTarget("popout")}
                    >
                      Popout window
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>

        <footer className="lp-foot">
          <div className="lp-summary">
            <span className="lp-sum">
              <PaneKindIcon kind="agent" size={12} />
              <span>
                {summary.agents} agent{summary.agents !== 1 ? "s" : ""}
              </span>
            </span>
            <span className="lp-sum">
              <PaneKindIcon kind="shell" size={12} />
              <span>
                {summary.shells} shell{summary.shells !== 1 ? "s" : ""}
              </span>
            </span>
            <span className="lp-sum">
              <span aria-hidden="true">▦</span>
              <span>{summary.split}</span>
            </span>
            {!saveBarOpen ? (
              <button
                type="button"
                className="lp-ghost"
                onClick={() => {
                  setSaveError(null);
                  setSaveBarOpen(true);
                }}
              >
                <span aria-hidden="true">＋</span> Save as preset
              </button>
            ) : null}
          </div>
          {saveBarOpen ? (
            <div className="lp-savebar">
              <input
                className="lp-input"
                autoFocus
                placeholder="Preset name"
                value={saveName}
                onChange={(e) => setSaveName(e.currentTarget.value)}
                // Escape closes the save bar, not the whole dialog —
                // `useEscapeKey` listens on `document`, so this must stop
                // the keydown from bubbling there.
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && canSavePreset) handleSavePreset();
                  if (e.key === "Escape") {
                    setSaveBarOpen(false);
                    setSaveError(null);
                  }
                }}
              />
              <button
                type="button"
                className="lp-btn"
                disabled={!canSavePreset}
                title={canSavePreset ? undefined : saveDisabledReason()}
                onClick={handleSavePreset}
              >
                Save
              </button>
              <button
                type="button"
                className="lp-ghost"
                onClick={() => {
                  setSaveBarOpen(false);
                  setSaveError(null);
                }}
              >
                Cancel
              </button>
              {saveError !== null ? (
                <span className="lp-saveerr">{saveError}</span>
              ) : null}
            </div>
          ) : null}
          <div className="lp-foot__r">
            <span className="lp-kbd">
              <kbd>esc</kbd>
              <span>cancel</span>
              <kbd>Cmd</kbd>
              <kbd>Enter</kbd>
              <span>launch</span>
            </span>
            <button type="button" className="lp-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="lp-btn lp-btn--primary"
              onClick={handleLaunch}
              disabled={!canLaunch}
              title={
                canLaunch
                  ? undefined
                  : overPaneCap
                    ? `A launch can hold at most ${MAX_LAUNCH_PANES} panes — remove one`
                    : projectId === null
                      ? "Pick a project with a path to launch"
                      : hasAgentPane && catalog.length === 0
                        ? "Add a provider in Settings to launch an agent pane"
                        : "A pane uses a provider that no longer exists — pick another"
              }
            >
              <Icon name="zap" size={13} />
              <span>
                Launch {summary.total} pane{summary.total !== 1 ? "s" : ""}
              </span>
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
