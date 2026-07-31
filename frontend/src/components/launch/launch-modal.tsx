/**
 * launch-modal.tsx
 *
 * Full launch configuration modal.  On submit:
 *   - embedded: builds LaunchSpec, calls terminalStore.applyGridLayout, navigates to /terminal
 *   - popout:   builds LaunchSpec, enqueues via pendingLaunchStore, calls openTerminalsWindow
 *
 * Sticky defaults stored at localStorage key `codenest.launch.defaults`.
 * Grid preview updates live; submit disabled when rows*cols > 8.
 *
 * In Workspace mode each grid cell has its own project, provider, extra-args,
 * profile, and env overlay.  Cells with unresolved references (deleted project
 * or disabled/removed provider) are highlighted in red and block submit.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  useProjects,
  useProviders,
  useLookups,
  useCreateLaunchPreset,
  useUpsertLaunchOverride,
  useEffectiveMcpServers,
  materializeMcpConfig,
  type LaunchPreset,
  type LaunchCellCreate,
  type EffectiveMcpServer,
} from "../../lib/api";
import { renderProviderCommand, mergeEnv } from "../../lib/launch";
import {
  GRID_MAX_PANES,
  GRID_MAX_DIM,
  GRID_MIN_DIM,
  type LaunchCell,
} from "../../lib/launch";
import { useTerminalStore } from "../../stores/terminal-store";
import * as pendingLaunchStore from "../../stores/pending-launch-store";
import { openTerminalsWindow, pathsExist } from "../../lib/ipc";
import { LaunchGridPreview } from "./launch-grid-preview";
import { LaunchPresetStrip } from "./launch-preset-strip";
import type { LaunchSeed } from "../../lib/launch-seed";

// ---------------------------------------------------------------------------
// Defaults persistence
// ---------------------------------------------------------------------------

const DEFAULTS_KEY = "codenest.launch.defaults";

interface StoredDefaults {
  provider_id?: number;
  target?: "embedded" | "popout";
  rows?: number;
  cols?: number;
  profile_id?: number | null;
}

function loadDefaults(): StoredDefaults {
  try {
    const raw = localStorage.getItem(DEFAULTS_KEY);
    if (raw) return JSON.parse(raw) as StoredDefaults;
  } catch {
    // ignore corrupt storage
  }
  return {};
}

function saveDefaults(d: StoredDefaults): void {
  try {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d));
  } catch {
    // ignore quota errors
  }
}

// ---------------------------------------------------------------------------
// Workspace cell state
// ---------------------------------------------------------------------------

interface CellState {
  row: number;
  col: number;
  projectId: number | "";
  providerId: number | "";
  /** Selected model for this cell. "" means use provider's default_model. */
  model: string;
  extraArgs: string;
  profileId: number | null;
  envOverlay: string; // raw textarea text: "KEY=VALUE\nKEY2=VALUE2"
}

function parseEnvOverlay(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function buildCellGrid(
  rows: number,
  cols: number,
  defaultProjectId: number | "",
  defaultProviderId: number | "",
): CellState[] {
  const cells: CellState[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        row: r,
        col: c,
        projectId: defaultProjectId,
        providerId: defaultProviderId,
        model: "",
        extraArgs: "",
        profileId: null,
        envOverlay: "",
      });
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface LaunchModalProps {
  open: boolean;
  onClose: () => void;
  /** Optional seed from a task or inbox item.  When provided, the modal
   *  pre-fills project, prompt, model, etc. and shows the prompt section. */
  seed?: LaunchSeed | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LaunchModal({
  open,
  onClose,
  seed,
}: LaunchModalProps): ReactElement | null {
  const navigate = useNavigate();

  const { data: projects = [] } = useProjects();
  const { data: providers = [] } = useProviders();
  const { data: lookups } = useLookups();
  const createPreset = useCreateLaunchPreset();
  const upsertOverride = useUpsertLaunchOverride();
  const terminalStore = useTerminalStore();

  // Only projects with a non-null path can be launched.
  const pathProjects = useMemo(
    () => projects.filter((p) => p.path !== null && p.path !== ""),
    [projects],
  );
  const enabledProviders = useMemo(
    () => providers.filter((p) => p.is_enabled),
    [providers],
  );
  const profiles = lookups?.profiles ?? [];

  // ── Derive defaults from stored values + available data ──────────────────
  const storedDefaults = useMemo(() => loadDefaults(), []);

  const initialProjectId = useMemo((): number | "" => {
    // Seed project wins; then first path-project.
    if (seed?.project?.id !== undefined) {
      const found = pathProjects.find((p) => p.id === seed.project!.id);
      if (found) return found.id;
    }
    return pathProjects[0]?.id ?? "";
  }, [seed, pathProjects]);

  const initialProviderId = useMemo((): number | "" => {
    // Precedence: seed.provider_id > stored defaults > project default_provider_id > first enabled.
    if (seed?.provider_id !== undefined) {
      const found = enabledProviders.find((p) => p.id === seed.provider_id);
      if (found) return found.id;
    }
    if (storedDefaults.provider_id !== undefined) {
      const found = enabledProviders.find(
        (p) => p.id === storedDefaults.provider_id,
      );
      if (found) return found.id;
    }
    // Use the project's configured default provider when available.
    const initialProject = pathProjects.find((p) => p.id === initialProjectId);
    if (initialProject?.default_provider_id != null) {
      const found = enabledProviders.find(
        (p) => p.id === initialProject.default_provider_id,
      );
      if (found) return found.id;
    }
    return enabledProviders[0]?.id ?? "";
  }, [seed, storedDefaults.provider_id, enabledProviders, pathProjects, initialProjectId]);

  // ── Form state — uniform mode ──────────────────────────────────────────────
  const [projectId, setProjectId] = useState<number | "">(initialProjectId);
  const [providerId, setProviderId] = useState<number | "">(initialProviderId);
  const [rows, setRows] = useState<number>(
    seed?.rows ?? storedDefaults.rows ?? 1,
  );
  const [cols, setCols] = useState<number>(
    seed?.cols ?? storedDefaults.cols ?? 1,
  );
  const [target, setTarget] = useState<"embedded" | "popout">(
    seed?.target ?? storedDefaults.target ?? "embedded",
  );
  const [profileId, setProfileId] = useState<number | null>(
    seed?.profile_id ?? storedDefaults.profile_id ?? null,
  );
  const [extraArgs, setExtraArgs] = useState<string>(seed?.extra_args ?? "");
  const [savePresetName, setSavePresetName] = useState<string>("");
  const [showSavePreset, setShowSavePreset] = useState<boolean>(false);

  // ── Model state (task-launch: model dropdown) ─────────────────────────────
  // Derived from the currently-selected provider's models list.
  const selectedProvider = useMemo(
    () => enabledProviders.find((p) => p.id === providerId) ?? null,
    [enabledProviders, providerId],
  );
  const providerModels = useMemo(
    () => selectedProvider?.models ?? ["default"],
    [selectedProvider],
  );
  const showModelDropdown =
    providerModels.length > 1 || providerModels[0] !== "default";

  const initialModel = useMemo((): string => {
    if (seed?.model !== null && seed?.model !== undefined) return seed.model;
    if (selectedProvider?.default_model) return selectedProvider.default_model;
    return providerModels[0] ?? "default";
  }, [seed?.model, selectedProvider?.default_model, providerModels]);

  const [model, setModel] = useState<string>(initialModel);

  // Keep model in sync when the provider selection changes (reset to new provider's default).
  // We use a ref to track the previous provider so we don't reset on first render.
  const prevProviderIdRef = useRef<number | "">(providerId);
  useEffect(() => {
    if (prevProviderIdRef.current !== providerId) {
      prevProviderIdRef.current = providerId;
      const defaultModel =
        selectedProvider?.default_model ?? providerModels[0] ?? "default";
      setModel(defaultModel);
    }
  }, [providerId, selectedProvider, providerModels]);

  // ── Prompt state (task-launch: seeded prompt) ─────────────────────────────
  const seedPrompt = seed?.prompt ?? null;
  const [promptText, setPromptText] = useState<string>(seedPrompt ?? "");
  const [promptExpanded, setPromptExpanded] = useState<boolean>(false);
  // Fan-out is always "primary" — UI selector removed.
  const promptFanout: "primary" | "every" | "none" =
    seed?.prompt_fanout ?? "primary";
  const hasPrompt = promptText.length > 0;
  const promptPreview =
    promptText.length > 200 ? promptText.slice(0, 200) + "…" : promptText;

  // 404 source guard — when the seed could not be loaded (e.g. source deleted).
  const sourceNotFound = seed === null && open;

  // ── Workspace mode ─────────────────────────────────────────────────────────
  const [launchMode, setLaunchMode] = useState<"uniform" | "workspace">(
    "uniform",
  );
  // Cell overrides keyed by "row,col".  Only cells the user has touched live
  // here; the rest fall back to the uniform project/provider values.
  const [cellOverrides, setCellOverrides] = useState<
    Map<string, Partial<CellState>>
  >(new Map());

  // Compute the effective cell grid purely from state — no effects needed.
  const workspaceCells: CellState[] = useMemo(() => {
    if (launchMode !== "workspace") return [];
    return buildCellGrid(rows, cols, projectId, providerId).map((fresh) => {
      const key = `${fresh.row},${fresh.col}`;
      const override = cellOverrides.get(key);
      return override !== undefined ? { ...fresh, ...override } : fresh;
    });
  }, [launchMode, rows, cols, projectId, providerId, cellOverrides]);

  // Promote sentinels on first data load.
  if (projectId === "" && initialProjectId !== "") {
    setProjectId(initialProjectId);
  }
  if (providerId === "" && initialProviderId !== "") {
    setProviderId(initialProviderId);
  }

  // ── Persist sticky defaults ───────────────────────────────────────────────
  useEffect(() => {
    saveDefaults({
      provider_id: providerId !== "" ? providerId : undefined,
      target,
      rows,
      cols,
      profile_id: profileId,
    });
  }, [providerId, target, rows, cols, profileId]);

  // ── MCP capability disclosure ───────────────────────────
  // Fetch effective servers for the selected project so we can show the
  // pre-launch capability panel.  project_id="" suppresses the query.
  const { data: effectiveMcpData } = useEffectiveMcpServers(projectId);
  const effectiveServers: EffectiveMcpServer[] =
    effectiveMcpData?.servers ?? [];

  // Per-launch exclusion set: slugs the user has unchecked for this run.
  const [excludedSlugs, setExcludedSlugs] = useState<Set<string>>(new Set());

  function toggleExclude(slug: string): void {
    setExcludedSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        next.add(slug);
      }
      return next;
    });
  }

  // Reset exclusions when the project changes so stale excludes don't carry over.
  const prevProjectIdRef = useRef<number | "">(projectId);
  useEffect(() => {
    if (prevProjectIdRef.current !== projectId) {
      prevProjectIdRef.current = projectId;
      setExcludedSlugs(new Set());
    }
  }, [projectId]);

  // ── Inline error and submitting ───────────────────────────────────────────
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  // ── Validation ────────────────────────────────────────────────────────────
  const totalPanes = rows * cols;
  const overBudget = totalPanes > GRID_MAX_PANES;
  const noProjectsWithPath = pathProjects.length === 0;

  // Workspace-mode cell validation: detect cells with stale references.
  const cellErrors = useMemo((): Map<string, string> => {
    const errs = new Map<string, string>();
    if (launchMode !== "workspace") return errs;
    for (const cell of workspaceCells) {
      const key = `${cell.row},${cell.col}`;
      if (
        cell.projectId === "" ||
        !pathProjects.some((p) => p.id === cell.projectId)
      ) {
        errs.set(key, "Project no longer exists — pick another");
      } else if (
        cell.providerId === "" ||
        !enabledProviders.some((p) => p.id === cell.providerId)
      ) {
        errs.set(key, "Provider disabled or removed");
      }
    }
    return errs;
  }, [launchMode, workspaceCells, pathProjects, enabledProviders]);

  const canSubmit =
    !overBudget &&
    !noProjectsWithPath &&
    !submitting &&
    projectId !== "" &&
    providerId !== "" &&
    (launchMode === "uniform" || cellErrors.size === 0);

  // ── Preset apply ─────────────────────────────────────────────────────────
  const handleApplyPreset = useCallback((preset: LaunchPreset) => {
    setProjectId(preset.project_id);
    setProviderId(preset.provider_id);
    setRows(preset.rows);
    setCols(preset.cols);
    setTarget(preset.target);
    setProfileId(preset.profile_id);

    if (preset.cells && preset.cells.length > 0) {
      setLaunchMode("workspace");
      // Load saved cell values directly into overrides.
      const newOverrides = new Map<string, Partial<CellState>>();
      for (const c of preset.cells) {
        newOverrides.set(`${c.row},${c.col}`, {
          row: c.row,
          col: c.col,
          projectId: c.project_id,
          providerId: c.provider_id,
          extraArgs: c.extra_args,
          profileId: c.profile_id,
          envOverlay: Object.entries(c.env_overlay)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n"),
        });
      }
      setCellOverrides(newOverrides);
    } else {
      setLaunchMode("uniform");
      setCellOverrides(new Map());
    }
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────
  function clampDim(v: number): number {
    return Math.min(GRID_MAX_DIM, Math.max(GRID_MIN_DIM, v));
  }

  function stepperChange(
    current: number,
    delta: number,
    setter: (v: number) => void,
  ): void {
    setter(clampDim(current + delta));
  }

  function updateCell(
    row: number,
    col: number,
    patch: Partial<CellState>,
  ): void {
    const key = `${row},${col}`;
    setCellOverrides((prev) => {
      const existing = prev.get(key) ?? {};
      const updated = new Map(prev);
      updated.set(key, { ...existing, ...patch });
      return updated;
    });
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;

    const provider = providers.find((p) => p.id === providerId);
    const project = projects.find((p) => p.id === projectId);
    const profile = profiles.find((p) => p.id === profileId);

    if (!provider || !project || !project.path) {
      setErrorBanner("Selected project or provider is no longer available.");
      return;
    }

    // Capture the narrowed path as a local const so closures below see `string`.
    const projectPath: string = project.path;

    // Effective model: only pass to renderProviderCommand when not "default".
    const effectiveModel =
      showModelDropdown && model && model !== "default" ? model : undefined;

    // ── MCP config materialization ────────────────
    // Only materialize when the template has the {mcp_config} placeholder.
    // Pass excludedSlugs to the endpoint so the written file is the
    // authoritative record of what the agent can reach — the disclosure panel
    // cannot lie about capabilities.  Failure is non-fatal.
    let mcpConfigPath: string | undefined;
    const templateWantsMcp = provider.command_template.includes("{mcp_config}");
    if (templateWantsMcp && typeof projectId === "number") {
      try {
        const activeServers = effectiveServers.filter(
          (s) => !excludedSlugs.has(s.slug),
        );
        if (activeServers.length > 0) {
          // excludedSlugs is passed server-side so the config file matches
          // exactly what the capability panel showed the user.
          const result = await materializeMcpConfig(projectId, excludedSlugs);
          mcpConfigPath = result.path;
        }
      } catch (err) {
        console.error("[LaunchModal] mcp config materialization failed:", err);
        // Non-fatal: continue without --mcp-config injection.
      }
    }

    const providerCommand = renderProviderCommand({
      template: provider.command_template,
      defaultArgs: provider.default_args,
      extraArgs,
      cwd: projectPath,
      projectName: project.name,
      projectId: project.id,
      profileName: profile?.name,
      model: effectiveModel,
      mcpConfigPath,
    });

    // Build per-cell LaunchCell array for workspace mode.
    let specCells: LaunchCell[] | undefined;
    let apiCells: LaunchCellCreate[] | undefined;

    if (launchMode === "workspace" && workspaceCells.length > 0) {
      specCells = workspaceCells.map((cell) => {
        const cellProject = projects.find((p) => p.id === cell.projectId);
        const cellProvider = providers.find((p) => p.id === cell.providerId);
        const cellProfile = profiles.find((p) => p.id === cell.profileId);
        // Fall back to the top-level project path (already narrowed to string).
        // cellProject?.path can be null; use explicit null/undefined guard.
        const rawCellPath = cellProject?.path;
        const cellCwd: string =
          rawCellPath !== null && rawCellPath !== undefined
            ? rawCellPath
            : projectPath;
        // Resolve the cell's effective model: explicit cell.model wins, else
        // the provider's default_model, else undefined (collapses the {model}
        // placeholder for single-default providers).
        const cellModels = cellProvider?.models ?? [];
        const cellHasMultiModels =
          cellModels.length > 1 ||
          (cellModels.length === 1 && cellModels[0] !== "default");
        const cellEffectiveModel = cellHasMultiModels
          ? cell.model ||
            cellProvider?.default_model ||
            cellModels[0] ||
            undefined
          : undefined;
        const cellProviderCommand = cellProvider
          ? renderProviderCommand({
              template: cellProvider.command_template,
              defaultArgs: cellProvider.default_args,
              extraArgs: cell.extraArgs,
              cwd: cellCwd,
              projectName: cellProject?.name,
              projectId: cellProject?.id,
              profileName: cellProfile?.name,
              model: cellEffectiveModel,
            })
          : providerCommand;
        const cellTextAreaEnv = parseEnvOverlay(cell.envOverlay);
        // Merge: provider.default_env ⊕ profile.env_json ⊕ textarea (last wins)
        const envOverlay = mergeEnv(cellProvider, cellProfile, {
          envOverlay: cellTextAreaEnv,
        });
        return {
          row: cell.row,
          col: cell.col,
          projectId: cellProject?.id ?? project.id,
          cwd: cellCwd,
          providerId: cellProvider?.id ?? provider.id,
          providerCommand: cellProviderCommand,
          extraArgs: cell.extraArgs,
          profileId: cell.profileId,
          envOverlay,
        } satisfies LaunchCell;
      });

      apiCells = workspaceCells.map((cell) => ({
        row: cell.row,
        col: cell.col,
        project_id:
          typeof cell.projectId === "number" ? cell.projectId : project.id,
        provider_id:
          typeof cell.providerId === "number" ? cell.providerId : provider.id,
        extra_args: cell.extraArgs,
        profile_id: cell.profileId,
        env_overlay: parseEnvOverlay(cell.envOverlay),
      }));
    }

    // Uniform-mode merged env: provider.default_env ⊕ profile.env_json
    const uniformEnv = mergeEnv(provider, profile);

    const spec = {
      projectId: project.id,
      cwd: projectPath,
      providerId: provider.id,
      providerCommand,
      rows,
      cols,
      target,
      profileId: profileId ?? null,
      ...(profile?.name ? { profileName: profile.name } : {}),
      ...(specCells !== undefined
        ? { cells: specCells }
        : Object.keys(uniformEnv).length > 0
          ? { env: uniformEnv }
          : {}),
      // task-launch extensions
      ...(hasPrompt ? { prompt: promptText, promptFanout } : {}),
      ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
      ...(seed !== null && seed !== undefined
        ? { source: { kind: seed.source.kind, id: seed.source.id } }
        : {}),
    };

    // D8/D9: persist the per-source override BEFORE launching (but failure
    // must not block the launch).
    if (seed !== null && seed !== undefined) {
      try {
        await upsertOverride.mutateAsync({
          kind: seed.source.kind,
          id: seed.source.id,
          payload: {
            project_id: project.id,
            provider_id: provider.id,
            model: effectiveModel ?? null,
            rows,
            cols,
            target,
            profile_id: profileId ?? null,
            extra_args: extraArgs || null,
            prompt_fanout: hasPrompt ? promptFanout : null,
            prompt_override: hasPrompt ? promptText : null,
          },
        });
      } catch (err) {
        console.error("[LaunchModal] override upsert failed:", err);
        toast("Could not save launch preferences for this source.");
      }
    }

    // Optionally save as preset before launching.
    if (showSavePreset && savePresetName.trim()) {
      try {
        await createPreset.mutateAsync({
          name: savePresetName.trim(),
          project_id: project.id,
          provider_id: provider.id,
          rows,
          cols,
          extra_args: extraArgs,
          target,
          profile_id: profileId,
          ...(apiCells !== undefined ? { cells: apiCells } : {}),
        });
      } catch {
        toast("Preset could not be saved (name may already exist).");
      }
    }

    // ── Pre-flight: verify every cwd exists on disk before opening any window.
    //
    // Collects the top-level projectPath plus each workspace cell's cwd into a
    // deduplicated set, discarding blanks.  Calls the `paths_exist` Tauri
    // command (synchronous stat, no network).  Any path that does not exist or
    // is not a directory blocks the launch with an inline error banner so the
    // user can fix the project config before a blank pane ever appears.
    try {
      const cwdsToCheck = new Set<string>();
      if (projectPath.trim()) cwdsToCheck.add(projectPath.trim());
      if (specCells !== undefined) {
        for (const cell of specCells) {
          if (cell.cwd.trim()) cwdsToCheck.add(cell.cwd.trim());
        }
      }
      if (cwdsToCheck.size > 0) {
        const checks = await pathsExist([...cwdsToCheck]);
        const bad = checks.filter((c) => !c.exists || !c.is_dir);
        if (bad.length > 0) {
          const listed = bad
            .map(
              (c) =>
                `${c.path}${!c.exists ? " (not found)" : " (not a directory)"}`,
            )
            .join(", ");
          setErrorBanner(
            `Project path${bad.length === 1 ? "" : "s"} not found — update the project or pick another: ${listed}`,
          );
          return;
        }
      }
    } catch (err) {
      // If the Tauri shell is not yet reachable, fail safe: show a banner and
      // do not open a blank window.
      console.error("[LaunchModal] paths_exist check failed:", err);
      setErrorBanner(
        "Cannot verify project paths — the shell is not reachable. " +
          "Try again in a moment.",
      );
      return;
    }

    setSubmitting(true);
    setErrorBanner(null);

    try {
      if (target === "embedded") {
        const result = await terminalStore.applyGridLayout(spec);
        if (result.failedCount > 0 && result.openedCount === 0) {
          setErrorBanner(
            `All ${result.failedCount} pane${result.failedCount === 1 ? "" : "s"} failed to open. ` +
              `Check that the Tauri shell is running.`,
          );
          setSubmitting(false);
          return;
        }
        if (result.failedCount > 0) {
          toast(
            `Launched ${result.openedCount} of ${totalPanes} panes — ${result.failedCount} failed.`,
          );
        }
        onClose();
        navigate("/terminal");
      } else {
        pendingLaunchStore.enqueue(spec);
        await openTerminalsWindow();
        setSubmitting(false);
        onClose();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorBanner(`Launch failed: ${msg}`);
      console.error("[LaunchModal] launch error", err);
      setSubmitting(false);
    }
  }

  // ── Backdrop close ────────────────────────────────────────────────────────
  function handleBackdropClick(): void {
    if (!submitting) onClose();
  }

  // 404 source empty-state — render a minimal cancel-only shell.
  if (open && sourceNotFound) {
    return createPortal(
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.65)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 100,
        }}
        onClick={onClose}
      >
        <div
          style={{
            background: "var(--bg-1)",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--r-4)",
            padding: "24px 28px",
            minWidth: 320,
            boxShadow: "var(--shadow-3)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{
              fontWeight: 600,
              fontSize: "15px",
              marginBottom: 12,
              color: "var(--fg-0)",
            }}
          >
            Source no longer exists
          </div>
          <div
            style={{ fontSize: "13px", color: "var(--fg-3)", marginBottom: 20 }}
          >
            The task or inbox item this launch was seeded from has been deleted.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button className="d3-btn" type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Launch Agent sessions"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={handleBackdropClick}
    >
      <div
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--line-2)",
          borderRadius: "var(--r-4)",
          padding: "24px 28px",
          minWidth: 420,
          maxWidth: launchMode === "workspace" ? 720 : 560,
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "var(--shadow-3)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span
            style={{ fontWeight: 600, fontSize: "15px", color: "var(--fg-0)" }}
          >
            Launch Agent
          </span>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
            disabled={submitting}
            style={{
              background: "none",
              border: "none",
              color: "var(--fg-3)",
              cursor: "pointer",
              fontSize: "18px",
              lineHeight: 1,
              padding: "2px 4px",
            }}
          >
            ×
          </button>
        </div>

        {/* Presets */}
        <div>
          <div
            style={{
              fontSize: "11px",
              color: "var(--fg-3)",
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Presets
          </div>
          <LaunchPresetStrip onApply={handleApplyPreset} />
        </div>

        {/* Mode toggle */}
        <div style={{ display: "flex", gap: 0, alignSelf: "flex-start" }}>
          {(["uniform", "workspace"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setLaunchMode(mode)}
              style={{
                padding: "4px 14px",
                fontSize: "12px",
                fontFamily: "inherit",
                background:
                  launchMode === mode ? "var(--accent)" : "var(--bg-3)",
                color: launchMode === mode ? "var(--bg-0)" : "var(--fg-2)",
                border: "1px solid var(--line-2)",
                borderRadius:
                  mode === "uniform"
                    ? "var(--r-2) 0 0 var(--r-2)"
                    : "0 var(--r-2) var(--r-2) 0",
                cursor: "pointer",
                transition: "background 0.15s, color 0.15s",
              }}
            >
              {mode === "uniform" ? "Uniform" : "Workspace"}
            </button>
          ))}
        </div>

        {/* Empty-state when no projects have a path */}
        {noProjectsWithPath ? (
          <div
            style={{
              padding: "16px",
              background: "var(--warn-soft)",
              border: "1px solid var(--warn)",
              borderRadius: "var(--r-3)",
              fontSize: "13px",
              color: "var(--fg-1)",
            }}
          >
            No projects have a path configured.{" "}
            <Link
              to="/settings?section=projects"
              onClick={onClose}
              style={{ color: "var(--accent)" }}
            >
              Configure projects
            </Link>{" "}
            to enable launching.
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              void handleSubmit(e);
            }}
            style={{ display: "flex", flexDirection: "column", gap: 14 }}
          >
            {/* Project select (always shown; in workspace mode it sets the fallback) */}
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={labelStyle}>
                {launchMode === "workspace" ? "Fallback project" : "Project"}
              </span>
              <select
                value={projectId}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  const newProjectId = Number(e.target.value);
                  setProjectId(newProjectId);
                  // When the newly selected project has a configured default
                  // provider, pre-select it.  The user can still change the
                  // provider dropdown afterwards for a per-session override.
                  const newProject = pathProjects.find(
                    (p) => p.id === newProjectId,
                  );
                  if (newProject?.default_provider_id != null) {
                    const defaultProv = enabledProviders.find(
                      (p) => p.id === newProject.default_provider_id,
                    );
                    if (defaultProv !== undefined) {
                      setProviderId(defaultProv.id);
                    }
                  }
                }}
                required
                style={selectStyle}
              >
                {pathProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>

            {/* Provider select */}
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={labelStyle}>
                {launchMode === "workspace" ? "Fallback provider" : "Provider"}
              </span>
              <select
                value={providerId}
                onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                  setProviderId(Number(e.target.value))
                }
                required
                style={selectStyle}
              >
                {enabledProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </select>
            </label>

            {/* Model dropdown — shown when provider has multiple selectable models */}
            {showModelDropdown && (
              <label
                style={{ display: "flex", flexDirection: "column", gap: 4 }}
              >
                <span style={labelStyle}>Model</span>
                <select
                  value={model}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                    setModel(e.target.value)
                  }
                  style={selectStyle}
                >
                  {providerModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {/* Prompt section — shown when seeded OR when user expands "Add prompt" */}
            {seedPrompt !== null || hasPrompt ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ ...labelStyle }}>Prompt</div>
                {!promptExpanded ? (
                  <div
                    style={{
                      background: "var(--bg-2)",
                      border: "1px solid var(--line-2)",
                      borderRadius: "var(--r-2)",
                      padding: "8px 10px",
                      fontSize: "12px",
                      color: "var(--fg-1)",
                      fontFamily: "var(--font-mono)",
                      lineHeight: 1.5,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {promptPreview}
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        marginTop: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <button
                        type="button"
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          color: "var(--accent)",
                          cursor: "pointer",
                          fontSize: "11px",
                          fontFamily: "inherit",
                        }}
                        onClick={() => setPromptExpanded(true)}
                      >
                        Edit prompt
                      </button>
                      <button
                        type="button"
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          color: "var(--fg-3)",
                          cursor: "pointer",
                          fontSize: "11px",
                          fontFamily: "inherit",
                        }}
                        onClick={() =>
                          void navigator.clipboard.writeText(promptText)
                        }
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 4 }}
                  >
                    <textarea
                      value={promptText}
                      onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                        setPromptText(e.target.value)
                      }
                      rows={8}
                      style={{
                        ...inputStyle,
                        fontFamily: "var(--font-mono)",
                        fontSize: "12px",
                        resize: "vertical",
                        lineHeight: 1.5,
                      }}
                    />
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          color: "var(--accent)",
                          cursor: "pointer",
                          fontSize: "11px",
                          fontFamily: "inherit",
                        }}
                        onClick={() => setPromptExpanded(false)}
                      >
                        Collapse
                      </button>
                      {seedPrompt !== null && (
                        <button
                          type="button"
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            color: "var(--fg-3)",
                            cursor: "pointer",
                            fontSize: "11px",
                            fontFamily: "inherit",
                          }}
                          onClick={() => {
                            setPromptText(seedPrompt);
                          }}
                        >
                          Reset to source
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: "var(--accent)",
                  cursor: "pointer",
                  fontSize: "12px",
                  fontFamily: "inherit",
                  textAlign: "left",
                }}
                onClick={() => {
                  setPromptText("");
                  setPromptExpanded(true);
                }}
              >
                + Add prompt
              </button>
            )}

            {/* Grid dimensions */}
            <div>
              <div style={{ ...labelStyle, marginBottom: 8 }}>Grid</div>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <LaunchGridPreview rows={rows} cols={cols} />
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 8 }}
                >
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <span
                      style={{
                        fontSize: "12px",
                        color: "var(--fg-2)",
                        width: 32,
                      }}
                    >
                      Rows
                    </span>
                    <Stepper
                      value={rows}
                      min={GRID_MIN_DIM}
                      max={GRID_MAX_DIM}
                      onDecrement={() => stepperChange(rows, -1, setRows)}
                      onIncrement={() => stepperChange(rows, +1, setRows)}
                    />
                  </div>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <span
                      style={{
                        fontSize: "12px",
                        color: "var(--fg-2)",
                        width: 32,
                      }}
                    >
                      Cols
                    </span>
                    <Stepper
                      value={cols}
                      min={GRID_MIN_DIM}
                      max={GRID_MAX_DIM}
                      onDecrement={() => stepperChange(cols, -1, setCols)}
                      onIncrement={() => stepperChange(cols, +1, setCols)}
                    />
                  </div>
                </div>
                {overBudget && (
                  <span
                    style={{
                      fontSize: "11px",
                      color: "var(--err)",
                      maxWidth: 140,
                    }}
                  >
                    Max {GRID_MAX_PANES} panes ({rows}×{cols} = {totalPanes})
                  </span>
                )}
              </div>
            </div>

            {/* Workspace cell editor — only shown in workspace mode */}
            {launchMode === "workspace" && (
              <WorkspaceCellEditor
                cells={workspaceCells}
                cellErrors={cellErrors}
                rows={rows}
                cols={cols}
                pathProjects={pathProjects}
                enabledProviders={enabledProviders}
                profiles={profiles}
                onUpdateCell={updateCell}
              />
            )}

            {/* Target radio */}
            <div>
              <div style={{ ...labelStyle, marginBottom: 8 }}>Target</div>
              <div style={{ display: "flex", gap: 10 }}>
                {(["embedded", "popout"] as const).map((t) => (
                  <label
                    key={t}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      cursor: "pointer",
                      fontSize: "13px",
                      color: target === t ? "var(--fg-0)" : "var(--fg-3)",
                    }}
                  >
                    <input
                      type="radio"
                      name="target"
                      value={t}
                      checked={target === t}
                      onChange={() => setTarget(t)}
                      style={{ accentColor: "var(--accent)" }}
                    />
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </label>
                ))}
              </div>
            </div>

            {/* Profile select — uniform mode only */}
            {launchMode === "uniform" && (
              <label
                style={{ display: "flex", flexDirection: "column", gap: 4 }}
              >
                <span style={labelStyle}>Profile</span>
                <select
                  value={profileId ?? ""}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                    const v = e.target.value;
                    setProfileId(v === "" ? null : Number(v));
                  }}
                  style={selectStyle}
                >
                  <option value="">None</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {/* Extra args — uniform mode only */}
            {launchMode === "uniform" && (
              <label
                style={{ display: "flex", flexDirection: "column", gap: 4 }}
              >
                <span style={labelStyle}>Extra args</span>
                <input
                  type="text"
                  value={extraArgs}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setExtraArgs(e.target.value)
                  }
                  placeholder="e.g. --model claude-opus-5"
                  style={inputStyle}
                />
              </label>
            )}

            {/* Save as preset */}
            <div>
              <button
                type="button"
                onClick={() => setShowSavePreset((v) => !v)}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: "var(--accent)",
                  cursor: "pointer",
                  fontSize: "12px",
                  fontFamily: "inherit",
                }}
              >
                {showSavePreset ? "↓ Hide preset save" : "+ Save as preset"}
              </button>
              {showSavePreset && (
                <input
                  type="text"
                  value={savePresetName}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setSavePresetName(e.target.value)
                  }
                  placeholder="Preset name"
                  style={{ ...inputStyle, marginTop: 8 }}
                />
              )}
            </div>

            {/* Capability disclosure panel */}
            {effectiveServers.length > 0 && (
              <CapabilityDisclosurePanel
                servers={effectiveServers}
                excludedSlugs={excludedSlugs}
                onToggle={toggleExclude}
              />
            )}

            {/* Error banner */}
            {errorBanner !== null && (
              <div
                role="alert"
                style={{
                  padding: "10px 12px",
                  background: "var(--err-soft)",
                  border: "1px solid var(--err)",
                  borderRadius: "var(--r-2)",
                  fontSize: "12px",
                  color: "var(--err)",
                }}
              >
                {errorBanner}
              </div>
            )}

            {/* Actions */}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 4,
              }}
            >
              <button
                type="button"
                className="d3-btn"
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="d3-btn d3-btn--primary"
                disabled={!canSubmit}
                title={
                  overBudget
                    ? `Max ${GRID_MAX_PANES} panes — reduce rows or cols`
                    : cellErrors.size > 0
                      ? "Fix cell errors before launching"
                      : undefined
                }
              >
                {submitting ? "Launching…" : "Launch"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// WorkspaceCellEditor sub-component
// ---------------------------------------------------------------------------

interface Project {
  id: number;
  name: string;
  path: string | null;
}

interface ProviderItem {
  id: number;
  display_name: string;
  models: string[];
  default_model: string | null;
}

interface ProfileItem {
  id: number;
  name: string;
}

interface WorkspaceCellEditorProps {
  cells: CellState[];
  cellErrors: Map<string, string>;
  rows: number;
  cols: number;
  pathProjects: Project[];
  enabledProviders: ProviderItem[];
  profiles: ProfileItem[];
  onUpdateCell: (row: number, col: number, patch: Partial<CellState>) => void;
}

function WorkspaceCellEditor({
  cells,
  cellErrors,
  rows,
  cols,
  pathProjects,
  enabledProviders,
  profiles,
  onUpdateCell,
}: WorkspaceCellEditorProps): ReactElement {
  return (
    <div>
      <div style={{ ...labelStyle, marginBottom: 8 }}>Workspace cells</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap: 8,
        }}
      >
        {Array.from({ length: rows }, (_, r) =>
          Array.from({ length: cols }, (_, c) => {
            const cell = cells.find((ce) => ce.row === r && ce.col === c);
            if (!cell) return null;
            const errKey = `${r},${c}`;
            const error = cellErrors.get(errKey);
            return (
              <CellCard
                key={errKey}
                cell={cell}
                error={error}
                pathProjects={pathProjects}
                enabledProviders={enabledProviders}
                profiles={profiles}
                onUpdate={(patch) => onUpdateCell(r, c, patch)}
              />
            );
          }),
        )}
      </div>
    </div>
  );
}

interface CellCardProps {
  cell: CellState;
  error?: string;
  pathProjects: Project[];
  enabledProviders: ProviderItem[];
  profiles: ProfileItem[];
  onUpdate: (patch: Partial<CellState>) => void;
}

function CellCard({
  cell,
  error,
  pathProjects,
  enabledProviders,
  profiles,
  onUpdate,
}: CellCardProps): ReactElement {
  const [showEnv, setShowEnv] = useState(false);

  return (
    <div
      style={{
        background: "var(--bg-2)",
        border: `1px solid ${error !== undefined ? "var(--err)" : "var(--line-2)"}`,
        borderRadius: "var(--r-3)",
        padding: "10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontSize: "12px",
      }}
    >
      <div
        style={{
          fontSize: "10px",
          color: "var(--fg-4)",
          fontFamily: "var(--font-mono)",
        }}
      >
        [{cell.row},{cell.col}]
      </div>

      {error !== undefined && (
        <div
          style={{
            fontSize: "11px",
            color: "var(--err)",
            lineHeight: 1.3,
          }}
        >
          {error}
        </div>
      )}

      {/* Project */}
      <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ ...labelStyle, fontSize: "10px" }}>Project</span>
        <select
          value={cell.projectId}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            onUpdate({ projectId: Number(e.target.value) })
          }
          style={{ ...selectStyle, fontSize: "12px", padding: "4px 6px" }}
        >
          {pathProjects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      {/* Provider */}
      <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ ...labelStyle, fontSize: "10px" }}>Provider</span>
        <select
          value={cell.providerId}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => {
            // Changing provider invalidates a model picked for the old one.
            onUpdate({ providerId: Number(e.target.value), model: "" });
          }}
          style={{ ...selectStyle, fontSize: "12px", padding: "4px 6px" }}
        >
          {enabledProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.display_name}
            </option>
          ))}
        </select>
      </label>

      {/* Model — shown when this cell's provider exposes multiple models. */}
      {(() => {
        const cellProvider = enabledProviders.find(
          (p) => p.id === cell.providerId,
        );
        const models = cellProvider?.models ?? [];
        const showModel =
          models.length > 1 || (models.length === 1 && models[0] !== "default");
        if (!showModel) return null;
        const currentModel =
          cell.model || cellProvider?.default_model || models[0] || "";
        return (
          <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ ...labelStyle, fontSize: "10px" }}>Model</span>
            <select
              value={currentModel}
              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                onUpdate({ model: e.target.value })
              }
              style={{ ...selectStyle, fontSize: "12px", padding: "4px 6px" }}
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        );
      })()}

      {/* Extra args */}
      <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ ...labelStyle, fontSize: "10px" }}>Extra args</span>
        <input
          type="text"
          value={cell.extraArgs}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            onUpdate({ extraArgs: e.target.value })
          }
          placeholder="--model …"
          style={{ ...inputStyle, fontSize: "12px", padding: "4px 6px" }}
        />
      </label>

      {/* Profile */}
      <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ ...labelStyle, fontSize: "10px" }}>Profile</span>
        <select
          value={cell.profileId ?? ""}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => {
            const v = e.target.value;
            onUpdate({ profileId: v === "" ? null : Number(v) });
          }}
          style={{ ...selectStyle, fontSize: "12px", padding: "4px 6px" }}
        >
          <option value="">None</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      {/* Env overlay toggle */}
      <button
        type="button"
        onClick={() => setShowEnv((v) => !v)}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          color: "var(--accent)",
          cursor: "pointer",
          fontSize: "11px",
          fontFamily: "inherit",
          textAlign: "left",
        }}
      >
        {showEnv ? "↓ Hide env" : "+ Env overlay"}
      </button>
      {showEnv && (
        <textarea
          value={cell.envOverlay}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
            onUpdate({ envOverlay: e.target.value })
          }
          placeholder={"KEY=VALUE\nANOTHER_KEY=another_value"}
          rows={3}
          style={{
            ...inputStyle,
            fontSize: "11px",
            padding: "4px 6px",
            fontFamily: "var(--font-mono)",
            resize: "vertical",
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Style constants
// ---------------------------------------------------------------------------

const labelStyle: React.CSSProperties = {
  fontSize: "11px",
  color: "var(--fg-3)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

const selectStyle: React.CSSProperties = {
  background: "var(--bg-3)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--r-2)",
  color: "var(--fg-1)",
  fontSize: "13px",
  padding: "6px 8px",
  width: "100%",
  fontFamily: "inherit",
};

const inputStyle: React.CSSProperties = {
  background: "var(--bg-3)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--r-2)",
  color: "var(--fg-1)",
  fontSize: "13px",
  padding: "6px 8px",
  width: "100%",
  fontFamily: "inherit",
  outline: "none",
};

// ---------------------------------------------------------------------------
// CapabilityDisclosurePanel sub-component
// ---------------------------------------------------------------------------

// High-blast-radius integrations that warrant a warning icon.
const HIGH_BLAST_RADIUS_SLUGS = new Set([
  "atlassian",
  "integration-atlassian",
  "github",
  "integration-github",
  "slack",
  "integration-slack",
]);

interface CapabilityDisclosurePanelProps {
  servers: EffectiveMcpServer[];
  excludedSlugs: Set<string>;
  onToggle: (slug: string) => void;
}

function CapabilityDisclosurePanel({
  servers,
  excludedSlugs,
  onToggle,
}: CapabilityDisclosurePanelProps): ReactElement {
  const included = servers.filter((s) => !excludedSlugs.has(s.slug));

  return (
    <div
      style={{
        background: "var(--bg-2)",
        border: "1px solid var(--line-2)",
        borderRadius: "var(--r-3)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          ...labelStyle,
          marginBottom: 2,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span>Agent capabilities</span>
        {included.length === 0 && (
          <span
            style={{
              color: "var(--fg-4)",
              fontWeight: "normal",
              textTransform: "none",
              letterSpacing: 0,
            }}
          >
            — no MCP servers active
          </span>
        )}
      </div>
      {servers.map((srv) => {
        const isExcluded = excludedSlugs.has(srv.slug);
        const isHighRisk = HIGH_BLAST_RADIUS_SLUGS.has(srv.slug);
        return (
          <label
            key={srv.slug}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
              fontSize: "12px",
              color: isExcluded ? "var(--fg-4)" : "var(--fg-1)",
              textDecoration: isExcluded ? "line-through" : "none",
            }}
          >
            <input
              type="checkbox"
              checked={!isExcluded}
              onChange={() => onToggle(srv.slug)}
              style={{ accentColor: "var(--accent)", cursor: "pointer" }}
            />
            {isHighRisk && !isExcluded && (
              <span
                title="High blast-radius integration — can read/write external services"
                style={{ fontSize: "13px", lineHeight: 1 }}
              >
                &#9888;
              </span>
            )}
            <span>{srv.name}</span>
            <span
              style={{
                fontSize: "11px",
                color: "var(--fg-4)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {srv.slug}
            </span>
          </label>
        );
      })}
      {included.length > 0 && (
        <div style={{ fontSize: "11px", color: "var(--fg-4)", marginTop: 2 }}>
          This agent will be able to reach {included.length} MCP server
          {included.length !== 1 ? "s" : ""}.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stepper sub-component
// ---------------------------------------------------------------------------

interface StepperProps {
  value: number;
  min: number;
  max: number;
  onDecrement: () => void;
  onIncrement: () => void;
}

function Stepper({
  value,
  min,
  max,
  onDecrement,
  onIncrement,
}: StepperProps): ReactElement {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        border: "1px solid var(--line-2)",
        borderRadius: "var(--r-2)",
        overflow: "hidden",
        background: "var(--bg-3)",
      }}
    >
      <button
        type="button"
        aria-label="Decrease"
        disabled={value <= min}
        onClick={onDecrement}
        style={{
          background: "none",
          border: "none",
          color: value <= min ? "var(--fg-4)" : "var(--fg-1)",
          cursor: value <= min ? "default" : "pointer",
          padding: "4px 10px",
          fontSize: "14px",
          lineHeight: 1,
        }}
      >
        −
      </button>
      <span
        style={{
          minWidth: 24,
          textAlign: "center",
          fontSize: "13px",
          color: "var(--fg-0)",
          fontFamily: "var(--font-mono)",
          userSelect: "none",
        }}
      >
        {value}
      </span>
      <button
        type="button"
        aria-label="Increase"
        disabled={value >= max}
        onClick={onIncrement}
        style={{
          background: "none",
          border: "none",
          color: value >= max ? "var(--fg-4)" : "var(--fg-1)",
          cursor: value >= max ? "default" : "pointer",
          padding: "4px 10px",
          fontSize: "14px",
          lineHeight: 1,
        }}
      >
        +
      </button>
    </div>
  );
}
