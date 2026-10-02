/**
 * The launch session composer — a heterogeneous pane-list dialog (N agent
 * panes and N shell panes, each configured independently), drawn on Deck
 * (#283): `.dk-scrim`/`.dk-modal` for the shell, `DeckGroup` per section,
 * `DeckGrid`/`DeckLine` for the recipe row and the ticket-context list,
 * `.dk-pane` tiles for the layout preview, `.dk-kv` for the inspector and
 * session rows.
 *
 * Fires `onLaunch(plan)` with the composed `LaunchComposerPlan` and stops
 * there — no `PaneLaunchSpec`, no PTY, no navigation. That wiring —
 * `lib/launch-composer.ts`'s `composerPlanToSpec` plus `applyPaneLayout` /
 * the popout queue — lives in `components/launch/launch-composer-dialog.tsx`,
 * the wrapper every launch entry point in the app now mounts (task #35).
 *
 * Every selector is a real `<select>` inside `.dk-sel`, the same move #298
 * made when the task detail went to Deck. That deletes the portalled
 * `lp-popover.tsx` outright: a native listbox is drawn by the OS above
 * everything, so the clipping a scrolled column caused (D1 in the plan) is
 * no longer a problem that needs solving.
 */

import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
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
import { DeckGrid, DeckGroup, DeckLine } from "../deck/deck-grid";
import { DeckMenu } from "../deck/deck-menu";
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

/** The two `DeckGrid`s' accessible names. They are also how a test tells the
 *  recipe rows from the ticket-context rows without a class hook. */
const RECIPE_GRID_LABEL = "Recipes and saved presets";
const CONTEXT_GRID_LABEL = "Ticket context sections";

/* ── Local constants ─────────────────────────────────────────────────────
   The places Deck has no primitive yet. Declared here rather than in
   `components/deck/*` or `design/deck/*`, which #283 does not touch — the
   precedent is `pages/attention.tsx`'s `ATTENTION_COLS` and
   `components/sessions/run-cols.ts`. */

/** `.dk-scrim` is z-index 60, enough for a scrim raised inside a Deck page.
 *  This one portals to `document.body` over the whole app — including the
 *  terminal pane's own portals — so it keeps `.lp-scrim`'s z-index verbatim.
 *  A restyle must not reorder what covers what. */
const SCRIM_STYLE: CSSProperties = { zIndex: 200 };

/** Deck's widest modal is `.dk-modal.wide` at 900px, sized for a one-column
 *  form. The composer is two columns — panes on the left, prompt and session
 *  on the right — and there is no size between `wide` and full-bleed. */
const MODAL_STYLE: CSSProperties = { width: "min(1040px, 100%)" };

/** The two-column body. `.dk-form__grid` is the nearest primitive but it is
 *  an even 1fr/1fr for label-over-control pairs; the pane column needs the
 *  larger share. */
const BODY_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1.15fr) minmax(0, 1fr)",
  gap: "var(--u6)",
  alignItems: "start",
};

/** `DECK_COLS` stops at 6 data columns and has no name/description/overflow
 *  shape; a recipe row is its name, what it builds, and its menu. */
const RECIPE_COLS = "14px minmax(0, 1fr) minmax(0, 1.5fr) auto";

/** Checkbox, label, token count — `subtasks-card.tsx`'s shape. */
const CTX_COLS = "14px 18px minmax(0, 1fr) auto";

/** The preview is a scale model of the pane grid, so it needs a box to be a
 *  model *of*: `.dk-pane` is `height: 100%` and collapses without one. */
const PREVIEW_STYLE: CSSProperties = {
  display: "grid",
  gap: "var(--u2)",
  minHeight: 150,
  padding: "0 var(--u3)",
};

const SPLIT_OPTIONS: ReadonlyArray<{ id: SplitMode; label: string }> = [
  { id: "cols", label: "Columns" },
  { id: "rows", label: "Rows" },
  { id: "grid", label: "Grid" },
];

interface SelectItem {
  id: string;
  label: string;
  /** A CSS colour for the swatch beside the selected value. */
  dot?: string | null;
}

const SHELL_OPTIONS: readonly SelectItem[] = [
  { id: "", label: "Default ($SHELL)" },
  { id: "/bin/zsh", label: "/bin/zsh" },
  { id: "/bin/bash", label: "/bin/bash" },
  { id: "/bin/sh", label: "/bin/sh" },
];

/**
 * `.dk-sel` around a real `<select>`. The provider swatch rides the trigger
 * rather than each option — a native listbox is drawn by the OS and cannot
 * carry one — and the pane tile keeps the same colour on its border, so the
 * provider stays identifiable at a glance.
 */
function DkSelect({
  label,
  value,
  items,
  onPick,
  placeholder = "—",
  disabled = false,
  width,
}: {
  label: string;
  value: string;
  items: readonly SelectItem[];
  onPick: (id: string) => void;
  placeholder?: string;
  disabled?: boolean;
  width?: number;
}): ReactElement {
  const isDisabled = disabled || items.length === 0;
  const selected = items.find((it) => it.id === value) ?? null;
  return (
    <span className="dk-sel">
      {selected?.dot !== undefined ? (
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            flex: "none",
            borderRadius: "50%",
            background: selected.dot ?? "var(--fg-4)",
          }}
        />
      ) : null}
      <select
        aria-label={label}
        value={selected !== null ? value : ""}
        disabled={isDisabled}
        style={width !== undefined ? { maxWidth: width } : undefined}
        onChange={(e) => onPick(e.currentTarget.value)}
      >
        {selected === null ? <option value="">{placeholder}</option> : null}
        {items.map((it) => (
          <option key={it.id} value={it.id}>
            {it.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/** A `.dk-kv` row: label in column one, control in column two. */
function KvRow({
  label,
  children,
  title,
}: {
  label: string;
  children: ReactNode;
  title?: string;
}): ReactElement {
  return (
    <div className="dk-kv" title={title}>
      <span>{label}</span>
      <span>{children}</span>
    </div>
  );
}

/** A `.dk-seg` segmented control. Deck marks the live segment `.on`. */
function Seg<T extends string>({
  value,
  options,
  onPick,
}: {
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onPick: (id: T) => void;
}): ReactElement {
  return (
    <span className="dk-seg">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          className={value === opt.id ? "on" : undefined}
          aria-pressed={value === opt.id}
          onClick={() => onPick(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </span>
  );
}

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

function modelItemsFor(provider: ComposerCatalogProvider | null): SelectItem[] {
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
    return <span className="dim">Unknown provider</span>;
  }
  return (
    <>
      {pane.model ?? "CLI default"}
      <br />
      <span className="dim">{modeLabelFor(pane.permissionMode)}</span>
      {pane.sendPrompt ? (
        <>
          <br />
          <span className="dk-tag">prompt</span>
        </>
      ) : null}
    </>
  );
}

function ShellPaneBody({ pane }: { pane: ShellPane }): ReactElement {
  const text =
    pane.command.trim() !== ""
      ? pane.command
      : `${pane.shell || "$SHELL"} — interactive`;
  return <>{text}</>;
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
    <div style={{ ...PREVIEW_STYLE, ...previewGridStyle(panes, split) }}>
      {panes.map((pane) => {
        const provider =
          pane.kind === "agent" && pane.providerId !== null
            ? (catalog.find((p) => p.id === pane.providerId) ?? null)
            : null;
        // The provider's colour on the tile border is what replaces the
        // per-option swatch a native `<select>` cannot draw. `.dk-pane.on`
        // owns the border while the tile is selected.
        const style: CSSProperties | undefined =
          provider?.color != null && selectedId !== pane.id
            ? { borderColor: provider.color }
            : undefined;
        return (
          <div
            key={pane.id}
            role="button"
            tabIndex={0}
            data-pane-id={pane.id}
            data-pane-kind={pane.kind}
            className={`dk-pane${selectedId === pane.id ? " on" : ""}`}
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
            <span className="dk-pane__h">
              <PaneKindIcon kind={pane.kind} size={11} />
              <span className="w">{paneLabel(panes, pane)}</span>
              {panes.length > 1 ? (
                <button
                  type="button"
                  className="i"
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
            <span
              data-pane-body=""
              style={{
                padding: "var(--u2)",
                fontSize: "var(--fs-s)",
                overflow: "hidden",
              }}
            >
              {pane.kind === "agent" ? (
                <AgentPaneBody pane={pane} catalog={catalog} />
              ) : (
                <ShellPaneBody pane={pane} />
              )}
            </span>
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
  const providerItems: SelectItem[] = catalog.map((p) => ({
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
      <KvRow label="Provider">
        <DkSelect
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
      </KvRow>
      <KvRow label="Model">
        <DkSelect
          label="Model"
          value={pane.model ?? ""}
          items={modelItemsFor(provider)}
          width={200}
          placeholder="CLI default"
          onPick={(id) =>
            dispatch({ type: "patchPane", pane: { ...pane, model: id } })
          }
        />
      </KvRow>
      <KvRow label="Mode" title={modeTitle}>
        <DkSelect
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
      </KvRow>
      <KvRow label="Prompt">
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--u2)",
          }}
        >
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
          <span>Send the shared prompt on open</span>
        </label>
      </KvRow>
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
      <KvRow label="Shell">
        <DkSelect
          label="Shell"
          value={pane.shell}
          items={SHELL_OPTIONS}
          width={150}
          onPick={(id) =>
            dispatch({ type: "patchPane", pane: { ...pane, shell: id } })
          }
        />
      </KvRow>
      <KvRow label="Run">
        <input
          className="dk-ctl"
          aria-label="Run"
          placeholder="optional command, e.g. npm run dev"
          value={pane.command}
          onChange={(e) =>
            dispatch({
              type: "patchPane",
              pane: { ...pane, command: e.currentTarget.value },
            })
          }
        />
      </KvRow>
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
    // `deck` because this portals to `document.body`, outside the `.deck` the
    // page draws inside — without it every Deck token resolves to nothing.
    // `display: contents` keeps the wrapper out of layout
    // (`shortcuts-hint.tsx` sets the same precedent).
    <div className="deck" style={{ display: "contents" }}>
      <div
        className="dk-scrim"
        style={SCRIM_STYLE}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          className="dk-modal wide"
          style={MODAL_STYLE}
          role="dialog"
          aria-modal="true"
          aria-label="Launch session"
        >
          <div className="dk-modal__h">
            <Icon name="zap" size={14} />
            <h2>launch session</h2>
            {source !== null ? (
              <span className="dk-meta">
                from #{source.id} — {source.title}
              </span>
            ) : null}
            <span className="sp" />
            <button
              type="button"
              className="dk-btn bare icon"
              aria-label="Close"
              onClick={onClose}
            >
              ✕
            </button>
          </div>

          <div className="dk-modal__b" style={BODY_STYLE}>
            <div>
              <DeckGroup label="recipe">
                <DeckGrid cols={RECIPE_COLS} label={RECIPE_GRID_LABEL}>
                  {RECIPES.map((r) => (
                    <DeckLine
                      key={r.id}
                      state={state.recipe === r.id ? "run" : "idle"}
                      selected={state.recipe === r.id}
                      cells={[
                        {
                          v: (
                            <>
                              <RecipeIcon id={r.id} /> <b>{r.label}</b>
                            </>
                          ),
                          title: r.label,
                        },
                        { v: r.desc, cls: "dim" },
                        { v: null, cls: "r" },
                      ]}
                      onOpen={() =>
                        dispatch({ type: "applyRecipe", recipe: r.id, catalog })
                      }
                    />
                  ))}
                  {presets.map((p) => {
                    const on = state.recipe === `preset:${p.id}`;
                    return (
                      <DeckLine
                        key={`preset:${p.id}`}
                        // A preset whose provider is gone still applies, but
                        // it cannot launch — `wait`, the glyph for "wants
                        // you", rather than `fail`.
                        state={
                          p.unresolved.length > 0
                            ? "wait"
                            : on
                              ? "run"
                              : "idle"
                        }
                        selected={on}
                        cells={[
                          {
                            v: (
                              <>
                                <span aria-hidden="true">☆</span>{" "}
                                <b>{p.name}</b>
                              </>
                            ),
                            title: p.name,
                          },
                          { v: describePreset(p), cls: "dim" },
                          {
                            v: (
                              // `DeckLine`'s own onKeyDown calls
                              // `preventDefault()` and applies the row on
                              // Enter/Space, which would both suppress the
                              // menu trigger's native activation and apply
                              // the preset instead of opening its overflow.
                              // The cell stops the key before it gets there.
                              <span
                                className="dk-actions"
                                onKeyDown={(e) => e.stopPropagation()}
                              >
                                {p.unresolved.length > 0 ? (
                                  <span
                                    className="dk-tag"
                                    data-s="wait"
                                    title={`Missing or disabled provider: ${p.unresolved
                                      .map(
                                        (u) =>
                                          `#${u.provider_id} (${u.reason})`,
                                      )
                                      .join(", ")}`}
                                  >
                                    unresolved
                                  </span>
                                ) : null}
                                {/* Rule 3 in "Where an action goes": a
                                    destructive row action lives in the
                                    overflow, last, behind a separator. */}
                                <DeckMenu
                                  label={`Actions for preset ${p.name}`}
                                  items={[
                                    {
                                      label: `Delete preset ${p.name}`,
                                      danger: true,
                                      separated: true,
                                      onSelect: () => {
                                        void deletePreset
                                          .mutateAsync(p.id)
                                          .catch(() => undefined);
                                      },
                                    },
                                  ]}
                                />
                              </span>
                            ),
                            cls: "r",
                          },
                        ]}
                        onOpen={() =>
                          dispatch({
                            type: "applyPreset",
                            presetId: p.id,
                            ...presetToDrafts(p),
                          })
                        }
                      />
                    );
                  })}
                </DeckGrid>
              </DeckGroup>

              <DeckGroup
                label="layout"
                note={
                  state.recipe === "custom" ? (
                    <span className="dk-tag">custom</span>
                  ) : undefined
                }
                actions={
                  <>
                    <Seg
                      value={state.split}
                      options={SPLIT_OPTIONS}
                      onPick={(split) => dispatch({ type: "setSplit", split })}
                    />
                    <button
                      type="button"
                      className="dk-btn bare"
                      onClick={() =>
                        dispatch({ type: "addPane", kind: "agent", catalog })
                      }
                    >
                      <span aria-hidden="true">＋</span> Agent
                    </button>
                    <button
                      type="button"
                      className="dk-btn bare"
                      onClick={() =>
                        dispatch({ type: "addPane", kind: "shell", catalog })
                      }
                    >
                      <span aria-hidden="true">＋</span> Shell
                    </button>
                  </>
                }
              >
                <PanePreview
                  panes={state.panes}
                  split={state.split}
                  selectedId={state.selectedId}
                  catalog={catalog}
                  onSelect={(id) => dispatch({ type: "selectPane", id })}
                  onRemove={(id) => dispatch({ type: "removePane", id })}
                />
                <div className="dk-note">
                  Click a pane to configure it — drag handles adjust size after
                  launch
                </div>
              </DeckGroup>

              {selectedPane !== null ? (
                <DeckGroup
                  label={
                    selectedPane.kind === "agent" ? "agent pane" : "shell pane"
                  }
                  actions={
                    <>
                      <Seg
                        value={selectedPane.kind}
                        options={[
                          { id: "agent" as const, label: "Agent" },
                          { id: "shell" as const, label: "Shell" },
                        ]}
                        onPick={(kind) =>
                          dispatch({
                            type: "setPaneKind",
                            id: selectedPane.id,
                            kind,
                            catalog,
                          })
                        }
                      />
                      <button
                        type="button"
                        className="dk-btn bare"
                        onClick={() =>
                          dispatch({
                            type: "duplicatePane",
                            id: selectedPane.id,
                          })
                        }
                      >
                        <span aria-hidden="true">⧉</span> Duplicate
                      </button>
                    </>
                  }
                >
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
                </DeckGroup>
              ) : (
                <DeckGroup label="pane">
                  <div className="dk-note">Select a pane to configure it.</div>
                </DeckGroup>
              )}
            </div>

            <div>
              <DeckGroup
                label="prompt"
                actions={
                  <span className="dk-meta">
                    {promptPanes} of {summary.agents} agent panes
                  </span>
                }
              >
                {promptEditing ? (
                  <div style={{ padding: "0 var(--u3)" }}>
                    <textarea
                      className="dk-ctl"
                      aria-label="Prompt"
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
                  </div>
                ) : (
                  <div
                    style={{ padding: "0 var(--u3)" }}
                    onClick={() => setPromptEditing(true)}
                  >
                    <div className="dk-out" style={{ padding: "var(--u2)" }}>
                      <pre
                        style={{
                          margin: 0,
                          overflow: "auto",
                          whiteSpace: "pre-wrap",
                          fontSize: "var(--fs-s)",
                        }}
                      >
                        {prompt}
                      </pre>
                    </div>
                    <div
                      className="dk-actions"
                      style={{ marginTop: "var(--u2)" }}
                    >
                      <button
                        type="button"
                        className="dk-btn bare"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPromptEditing(true);
                        }}
                      >
                        <Icon name="settings" size={11} /> Edit
                      </button>
                      <button
                        type="button"
                        className="dk-btn bare"
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
              </DeckGroup>

              {hasSections ? (
                <DeckGroup
                  label="ticket context"
                  actions={
                    <span className="dk-meta">
                      {formatTokenTotal(
                        sectionTokenTotal(sections, enabledSections),
                      )}
                    </span>
                  }
                >
                  <DeckGrid cols={CTX_COLS} label={CONTEXT_GRID_LABEL}>
                    {sections.map((s) => (
                      <DeckLine
                        key={s.id}
                        state={enabledSections.has(s.id) ? "done" : "idle"}
                        cells={[
                          {
                            v: (
                              <input
                                type="checkbox"
                                checked={enabledSections.has(s.id)}
                                disabled={promptDirty}
                                aria-label={s.label}
                                onClick={(e) => e.stopPropagation()}
                                onChange={() => toggleSection(s.id)}
                              />
                            ),
                          },
                          { v: s.label, title: s.label },
                          { v: `~${s.tokens}`, cls: "r" },
                        ]}
                        onOpen={
                          promptDirty ? undefined : () => toggleSection(s.id)
                        }
                      />
                    ))}
                  </DeckGrid>
                  {promptDirty ? (
                    <div
                      className="dk-actions"
                      style={{ padding: "var(--u2) var(--u3) 0" }}
                    >
                      <span className="dk-meta">
                        Prompt edited — toggles paused
                      </span>
                      <button
                        type="button"
                        className="dk-btn bare"
                        onClick={resetPromptFromSections}
                      >
                        Reset from ticket
                      </button>
                    </div>
                  ) : null}
                </DeckGroup>
              ) : null}

              <DeckGroup label="session">
                <KvRow label="Project">
                  <DkSelect
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
                </KvRow>
                <KvRow label="Profile">
                  <DkSelect
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
                </KvRow>
                <KvRow label="Open in">
                  <Seg
                    value={target}
                    options={[
                      {
                        id: "embedded" as LaunchTarget,
                        label: "Sessions tab",
                      },
                      { id: "popout" as LaunchTarget, label: "Popout window" },
                    ]}
                    onPick={setTarget}
                  />
                </KvRow>
              </DeckGroup>
            </div>
          </div>

          <div className="dk-modal__f" style={{ flexWrap: "wrap" }}>
            <span data-summary="" className="dk-meta">
              <PaneKindIcon kind="agent" size={12} /> {summary.agents} agent
              {summary.agents !== 1 ? "s" : ""}
              {" · "}
              <PaneKindIcon kind="shell" size={12} /> {summary.shells} shell
              {summary.shells !== 1 ? "s" : ""}
              {" · "}
              <span aria-hidden="true">▦</span> {summary.split}
            </span>
            {!saveBarOpen ? (
              <button
                type="button"
                className="dk-btn bare"
                onClick={() => {
                  setSaveError(null);
                  setSaveBarOpen(true);
                }}
              >
                <span aria-hidden="true">＋</span> Save as preset
              </button>
            ) : (
              <span className="dk-actions">
                <input
                  className="dk-ctl"
                  autoFocus
                  aria-label="Preset name"
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
                  className="dk-btn"
                  disabled={!canSavePreset}
                  title={canSavePreset ? undefined : saveDisabledReason()}
                  onClick={handleSavePreset}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="dk-btn bare"
                  onClick={() => {
                    setSaveBarOpen(false);
                    setSaveError(null);
                  }}
                >
                  Cancel
                </button>
                {saveError !== null ? (
                  <span className="dk-comp__note err">{saveError}</span>
                ) : null}
              </span>
            )}
            <span className="sp" />
            <span className="dk-meta">
              <kbd>esc</kbd> cancel <kbd>Cmd</kbd>
              <kbd>Enter</kbd> launch
            </span>
            <button type="button" className="dk-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="dk-btn pri"
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
        </div>
      </div>
    </div>,
    document.body,
  );
}
