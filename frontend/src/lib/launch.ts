/**
 * launch.ts — helpers for the agent-launcher feature.
 *
 * This module is the home for:
 *   - `renderProviderCommand`  — substitutes placeholders in a provider's
 *     command_template and produces the string written to the PTY input.
 *   - `LaunchSpec`             — the payload that drives a programmatic launch.
 *   - `buildGridLayout`        — builds a binary-split LayoutNode tree from
 *     (rows, cols) dimensions using existing Split/PaneLeaf shapes.
 *
 * Placeholder reference:
 *   {extra_args}    — concatenation of provider.default_args and the modal's
 *                     per-launch "Extra args" field (defaultArgs first,
 *                     extraArgs second, separated by a single space, trimmed).
 *   {cwd}           — resolved project path
 *   {project_name}  — project display name
 *   {project_id}    — numeric project id (stringified)
 *   {profile_name}  — selected profile name, or "" when none selected
 *   {mcp_config}    — absolute path to the materialized per-launch MCP config
 *                     file (e.g. "--mcp-config /tmp/codenest-mcp/project-1-….json").
 *                     When mcpConfigPath is empty/absent the placeholder and
 *                     any surrounding "--mcp-config " flag are removed, the
 *                     same way {model} is removed when empty.
 *
 * Unknown placeholders pass through verbatim and emit a console.warn so
 * operators who fat-finger a template get visible feedback.
 */

import type {
  Direction,
  LayoutNode,
  PaneLeaf,
  PaneLaunchSeed,
  Split,
} from "./layout-tree";
import type { LaunchSource, PromptFanout } from "./launch-seed";

// ---------------------------------------------------------------------------
// LaunchCell
// ---------------------------------------------------------------------------

/**
 * Per-cell configuration for workspace (heterogeneous) mode.
 * Mirrors `app/models/launch.py:LaunchCell`.
 */
export interface LaunchCell {
  row: number;
  col: number;
  /** Numeric project id. */
  projectId: number;
  /** Resolved absolute path for this cell's project. */
  cwd: string;
  /** Numeric provider id. */
  providerId: number;
  /**
   * Pre-rendered provider command string including trailing `\n`,
   * ready to write directly to a PTY via `terminal_input`.
   */
  providerCommand: string;
  /** Extra args already baked into `providerCommand`; retained for reference. */
  extraArgs: string;
  /** Profile id, or null when none selected. */
  profileId: number | null;
  /** Environment variable overlay applied only to this cell's PTY. */
  envOverlay: Record<string, string>;
}

// ---------------------------------------------------------------------------
// mergeEnv
// ---------------------------------------------------------------------------

/**
 * Merge environment variable maps from provider, profile, and cell overlays.
 *
 * Precedence (last wins): provider.default_env < profile.env_json < cell.envOverlay
 *
 * Any undefined/null layer is treated as an empty map; the function always
 * returns a plain object.
 */
export function mergeEnv(
  provider?: { default_env?: Record<string, string> } | null,
  profile?: { env_json?: Record<string, string> | string | null } | null,
  cell?: { envOverlay?: Record<string, string> } | null,
): Record<string, string> {
  const out: Record<string, string> = {};

  // Layer 1: provider defaults
  if (provider?.default_env) {
    Object.assign(out, provider.default_env);
  }

  // Layer 2: profile env_json (may be a JSON string or already parsed object)
  if (profile?.env_json) {
    let parsed: unknown = profile.env_json;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        parsed = {};
      }
    }
    if (parsed !== null && typeof parsed === "object") {
      Object.assign(out, parsed as Record<string, string>);
    }
  }

  // Layer 3: per-cell overlay (highest priority)
  if (cell?.envOverlay) {
    Object.assign(out, cell.envOverlay);
  }

  return out;
}

// ---------------------------------------------------------------------------
// LaunchSpec
// ---------------------------------------------------------------------------

/**
 * Fully-resolved description of a programmatic launch.
 * Built by the modal at submit time and consumed by `applyGridLayout`.
 *
 * When `cells` is present the per-cell values win over the uniform
 * `cwd` / `providerCommand` / `profileId`.  `rows` and `cols` are always
 * present (derived from the max cell coordinates when cells is supplied).
 */
export interface LaunchSpec {
  /** Numeric project id (from the `projects` table). */
  projectId: number;
  /** Resolved absolute path for the project — used as PTY cwd. */
  cwd: string;
  /** Numeric provider id (from the `providers` table). */
  providerId: number;
  /**
   * Pre-rendered provider command string including trailing `\n`,
   * ready to write directly to a PTY via `terminal_input`.
   */
  providerCommand: string;
  /** Number of grid rows (1..4). */
  rows: number;
  /** Number of grid columns (1..4). */
  cols: number;
  /** Where the layout should be rendered. */
  target: "embedded" | "popout";
  /** Profile id, or null when none selected. */
  profileId: number | null;
  /**
   * Profile name string (e.g. "work", "personal") corresponding to
   * ``profileId``.  Sent in launch telemetry so the sidecar can stamp the
   * ``agent_runs.profile`` column without a DB lookup.
   */
  profileName?: string;
  /**
   * Merged environment variables for uniform-mode launches.
   * Built from `mergeEnv(provider, profile)` at submit time.
   * Ignored when `cells` is present (each cell carries its own `envOverlay`).
   */
  env?: Record<string, string>;
  /**
   * Per-cell overrides for workspace mode.  When present, `applyGridLayout`
   * uses each cell's own `cwd`, `providerCommand`, and `envOverlay` instead
   * of the uniform values above.  Cells not listed in this array produce an
   * empty-pane placeholder (no PTY allocated).
   */
  cells?: LaunchCell[];

  // ── task-launch extensions ─────────────────────────────────────────────────

  /**
   * Seeded prompt to deliver to the primary pane after the provider REPL
   * initialises.  Empty / absent means no prompt delivery.
   */
  prompt?: string;
  /**
   * Controls which pane(s) receive the prompt.
   * - "primary": only the (0,0) / is_primary cell.
   * - "every": all successfully-opened panes in parallel.
   * - "none": no prompt delivery (user types manually).
   * Defaults to "primary" when absent.
   */
  promptFanout?: PromptFanout;
  /**
   * Selected model string (e.g. "claude-sonnet-5").
   * Absent when the provider has a single "default" model.
   */
  model?: string;
  /**
   * Source attribution — the task or inbox item this launch was seeded from.
   * Stamped into the `agent_event.payload_json` for Command Center display.
   */
  source?: LaunchSource;
}

// ---------------------------------------------------------------------------
// Known placeholder keys
// ---------------------------------------------------------------------------

const KNOWN_PLACEHOLDERS = new Set([
  "extra_args",
  "cwd",
  "project_name",
  "project_id",
  "profile_name",
  "model",
  "mcp_config",
  "session_id",
]);

// ---------------------------------------------------------------------------
// renderProviderCommand
// ---------------------------------------------------------------------------

export interface RenderProviderCommandArgs {
  /** The provider's raw `command_template` string, e.g. `"claude {extra_args}"`. */
  template: string;
  /**
   * Provider-level default arguments (from `provider.default_args`).
   * Prepended to `extraArgs` when computing the `{extra_args}` substitution.
   * Trimmed before use; an empty or omitted value contributes nothing.
   */
  defaultArgs?: string;
  /**
   * Per-launch extra arguments from the modal's "Extra args" field.
   * Appended after `defaultArgs`; trimmed before use.
   * The effective `{extra_args}` substitution is:
   *   `[defaultArgs.trim(), extraArgs.trim()].filter(Boolean).join(" ")`
   */
  extraArgs?: string;
  /** Value for `{cwd}` — the resolved project working directory. */
  cwd?: string;
  /** Value for `{project_name}`. */
  projectName?: string;
  /** Value for `{project_id}` — numeric id, will be stringified. */
  projectId?: number;
  /** Value for `{profile_name}` — empty string when no profile is selected. */
  profileName?: string;
  /**
   * Value for `{model}` — the selected model string.
   * When undefined or empty, the placeholder is removed and surrounding
   * whitespace is collapsed so no double-spaces remain.
   */
  model?: string;
  /**
   * Absolute path to the materialized per-launch ``--mcp-config`` file.
   * When present and non-empty the template's ``{mcp_config}`` placeholder
   * is replaced with ``--mcp-config <path>``.
   * When absent or empty, ``{mcp_config}`` and any surrounding flag text
   * are removed (same collapse logic as ``{model}``).
   * Templates that omit ``{mcp_config}`` entirely are unaffected.
   */
  mcpConfigPath?: string;
  /**
   * Dashboard-generated session UUID for deterministic Claude enrichment.
   * When present and non-empty the template's ``{session_id}`` placeholder
   * is replaced with ``--session-id <uuid>``.
   * When absent or empty (non-Claude providers), ``{session_id}`` is removed
   * cleanly — same collapse logic as ``{model}``.
   * Templates that omit ``{session_id}`` entirely are unaffected.
   */
  sessionId?: string;
}

/**
 * Render a provider command template by substituting all known placeholders.
 *
 * The result is the template with placeholders replaced by their runtime
 * values, followed by a `\n` newline — ready to write directly to a PTY via
 * `terminal_input`.
 *
 * **Sequencing contract for {session_id}:**
 * `renderProviderCommand` is called at modal-submit time.  The per-pane session
 * UUID does not exist yet at that point — it is generated inside
 * `applyGridLayout` (one UUID per pane).  Therefore:
 *
 * - When `sessionId` is **absent or empty**, `{session_id}` is deliberately
 *   left **verbatim** in the output so that `applyGridLayout` can substitute
 *   it per-pane immediately before writing to the PTY.
 * - When `sessionId` is **supplied** (e.g. in tests or when the caller
 *   generates the UUID up front), `{session_id}` is replaced with
 *   `--session-id <uuid>` as usual.
 *
 * This means the intermediate string returned for Claude templates will still
 * contain the literal `{session_id}` token when called from the modal — that
 * is intentional and expected.
 *
 * Unknown placeholders (anything that is not in the known set above) are left
 * verbatim and a single `console.warn` is emitted per unique unknown key so
 * operators catch typos without silently losing template content.
 */
export function renderProviderCommand(args: RenderProviderCommandArgs): string {
  const {
    template,
    defaultArgs = "",
    extraArgs = "",
    cwd = "",
    projectName = "",
    projectId,
    profileName = "",
    model = "",
    mcpConfigPath = "",
    sessionId,
  } = args;

  // Effective {extra_args}: provider defaults first, per-launch extras second.
  const effectiveExtraArgs = [defaultArgs.trim(), extraArgs.trim()]
    .filter(Boolean)
    .join(" ");

  // {mcp_config} expands to "--mcp-config <path>" when a path is available,
  // or to an empty string when absent (the collapse step below then removes
  // the empty flag).
  const effectiveMcpConfig = mcpConfigPath?.trim()
    ? `--mcp-config ${mcpConfigPath.trim()}`
    : "";

  // {session_id} sequencing: only substitute when the caller explicitly
  // provides a UUID.  An absent/empty sessionId means the per-pane UUID has
  // not been generated yet — leave {session_id} verbatim so applyGridLayout
  // can inject it later.  When a UUID IS provided (tests, pre-generated id),
  // expand it to '--session-id <uuid>' as normal.
  const sessionIdProvided = sessionId !== undefined && sessionId.trim() !== "";
  const effectiveSessionId = sessionIdProvided
    ? `--session-id ${sessionId!.trim()}`
    : null;

  // Build the substitution map.  When effectiveSessionId is null we omit
  // 'session_id' from the map so the replace callback leaves {session_id}
  // verbatim (falls through to the unknown-placeholder guard, but since
  // 'session_id' IS in KNOWN_PLACEHOLDERS, no warn is emitted and the match
  // is returned as-is).
  const substitutions: Record<string, string> = {
    extra_args: effectiveExtraArgs,
    cwd,
    project_name: projectName,
    project_id: projectId !== undefined ? String(projectId) : "",
    profile_name: profileName,
    model: model.trim(),
    mcp_config: effectiveMcpConfig,
    ...(effectiveSessionId !== null ? { session_id: effectiveSessionId } : {}),
  };

  const warnedUnknown = new Set<string>();

  let rendered = template.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    if (key in substitutions) {
      return substitutions[key] ?? "";
    }
    if (!KNOWN_PLACEHOLDERS.has(key) && !warnedUnknown.has(key)) {
      console.warn(
        `[launch] Unknown placeholder "{${key}}" in provider template — left verbatim. ` +
          `Known placeholders: ${[...KNOWN_PLACEHOLDERS].map((k) => `{${k}}`).join(", ")}`,
      );
      warnedUnknown.add(key);
    }
    return _match;
  });

  // When the template contained {model} but the model resolved to an empty
  // string, remove any dangling CLI flag argument (e.g. "--model ") that
  // the substitution left behind and collapse multiple spaces.
  const templateHadModel = template.includes("{model}");
  if (templateHadModel && model.trim() === "") {
    // Remove "--flag <spaces>" patterns followed by whitespace or end-of-string.
    rendered = rendered.replace(/\s+--[\w-]+(=|\s+)(?=\s|$)/g, " ");
    // Collapse multiple spaces and strip leading/trailing whitespace.
    rendered = rendered.replace(/\s{2,}/g, " ").trim();
  }

  // Collapse {mcp_config} when it resolved to empty (path was absent).
  const templateHadMcpConfig = template.includes("{mcp_config}");
  if (templateHadMcpConfig && effectiveMcpConfig === "") {
    rendered = rendered.replace(/\s+--[\w-]+(=|\s+)(?=\s|$)/g, " ");
    rendered = rendered.replace(/\s{2,}/g, " ").trim();
  }

  // Collapse {session_id} only when the caller DID provide a sessionId but it
  // was empty (explicit empty string means "not a Claude provider — strip the
  // placeholder").  When sessionId was absent (undefined), the placeholder was
  // left verbatim above and must not be touched here.
  const templateHadSessionId = template.includes("{session_id}");
  if (templateHadSessionId && sessionId !== undefined && !sessionIdProvided) {
    // Caller passed an empty string — treat as "no session id, collapse".
    rendered = rendered.replace(/\{session_id\}/g, "");
    rendered = rendered.replace(/\s+--[\w-]+(=|\s+)(?=\s|$)/g, " ");
    rendered = rendered.replace(/\s{2,}/g, " ").trim();
  }

  return rendered + "\n";
}

// ---------------------------------------------------------------------------
// safeInjectClaudeArgs
// ---------------------------------------------------------------------------

/**
 * Safety-net for the final PTY command string (after per-pane substitution).
 *
 * If the command invokes `claude` but is missing `--session-id` or
 * `--mcp-config` even though the relevant values are available, this function
 * appends them before the trailing newline.  This handles:
 *   1. User-created providers whose templates never had the placeholders.
 *   2. Rows in existing DBs that were not reached by migration 053.
 *   3. Any future template regression.
 *
 * The check is intentionally conservative: it only fires for commands whose
 * first token is `claude`.  Non-Claude providers are untouched.
 *
 * @param command  The command string as it will be written to the PTY
 *                 (includes the trailing `\n`).
 * @param sessionId  Dashboard-minted UUID for this pane (non-empty).
 * @param mcpConfigPath  Absolute path to the materialized MCP config file, or
 *                       empty/undefined when no project MCP is configured.
 * @returns The command string, possibly with flags appended before the `\n`.
 */
export function safeInjectClaudeArgs(
  command: string,
  sessionId: string,
  mcpConfigPath?: string,
): string {
  // Only touch commands that invoke the Claude CLI as the first token.
  // Accept:
  //   "claude"        — the canonical binary name
  //   "claude-work"   — Anthropic alias configured via onboarding
  //   "claude_work"   — underscore variant (less common but supported)
  // Reject everything else (e.g. "claude-code", "openai", unrelated tools).
  const trimmed = command.trimStart();
  if (!trimmed.startsWith("claude")) {
    return command;
  }
  const firstSpace = trimmed.indexOf(" ");
  const firstToken =
    firstSpace === -1
      ? trimmed.replace(/\n$/, "")
      : trimmed.slice(0, firstSpace);
  // Allow "claude" exactly, or "claude" followed by "-" or "_" (aliased binaries
  // that wrap the Anthropic Claude CLI, e.g. claude-work, claude-personal).
  // Reject tokens like "claude-code" that are unrelated programs: specifically
  // exclude the suffix "code" (and "codes") to avoid injecting into claude-code
  // sessions which are a different program entirely.
  const isClaudeAlias =
    firstToken === "claude" ||
    (/^claude[-_][a-zA-Z0-9]+$/.test(firstToken) && !/^claude[-_]codes?$/i.test(firstToken));
  if (!isClaudeAlias) {
    return command;
  }

  // Strip the trailing newline so we can append cleanly.
  const hasTrailingNewline = command.endsWith("\n");
  let base = hasTrailingNewline ? command.slice(0, -1) : command;

  if (sessionId && !base.includes("--session-id")) {
    base = `${base} --session-id ${sessionId}`;
  }

  if (mcpConfigPath?.trim() && !base.includes("--mcp-config")) {
    base = `${base} --mcp-config ${mcpConfigPath.trim()}`;
  }

  return hasTrailingNewline ? `${base}\n` : base;
}

// ---------------------------------------------------------------------------
// buildGridLayout
// ---------------------------------------------------------------------------

/** Maximum number of panes allowed per launch (design decision D6). */
export const GRID_MAX_PANES = 8;
/** Maximum value for the rows or cols dimension. */
export const GRID_MAX_DIM = 4;
/** Minimum value for the rows or cols dimension. */
export const GRID_MIN_DIM = 1;

function makeLeaf(index: number): PaneLeaf {
  return {
    type: "leaf",
    terminalId: `pending-${index}`,
    title: "zsh",
  };
}

/**
 * Build a binary-split LayoutNode tree representing an (rows × cols) grid.
 *
 * Layout strategy (matches design.md D2):
 * - For a single row, chain horizontal splits: leaf | leaf | leaf …
 * - For multiple rows, build each row as a horizontal chain, then chain the
 *   rows together with vertical splits.
 *
 * All leaves carry placeholder `terminalId` values (`pending-N`). The caller
 * (applyGridLayout in terminal-store.ts) replaces them with real PTY ids after
 * `open_terminal` resolves.
 *
 * @throws {RangeError} when `rows*cols > GRID_MAX_PANES` or either dimension
 *   is outside `[GRID_MIN_DIM, GRID_MAX_DIM]`.
 */
export function buildGridLayout({
  rows,
  cols,
  cwd,
  initCommand,
}: {
  rows: number;
  cols: number;
  cwd?: string;
  initCommand?: string;
}): LayoutNode {
  if (rows < GRID_MIN_DIM || rows > GRID_MAX_DIM) {
    throw new RangeError(
      `rows must be between ${GRID_MIN_DIM} and ${GRID_MAX_DIM}, got ${rows}`,
    );
  }
  if (cols < GRID_MIN_DIM || cols > GRID_MAX_DIM) {
    throw new RangeError(
      `cols must be between ${GRID_MIN_DIM} and ${GRID_MAX_DIM}, got ${cols}`,
    );
  }
  if (rows * cols > GRID_MAX_PANES) {
    throw new RangeError(
      `rows*cols (${rows * cols}) exceeds the maximum of ${GRID_MAX_PANES} panes per launch`,
    );
  }

  let leafIndex = 0;

  function makeLeafWithMeta(): PaneLeaf {
    const leaf = makeLeaf(leafIndex++);
    return {
      ...leaf,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(initCommand !== undefined ? { initCommand } : {}),
    };
  }

  // Build a single horizontal row of `count` panes as a binary-split chain.
  // count=1 → PaneLeaf
  // count=2 → Split(h, [leaf, leaf], 0.5)
  // count=3 → Split(h, [leaf, Split(h, [leaf, leaf], 0.5)], 0.5)
  function buildRow(count: number): LayoutNode {
    if (count === 1) return makeLeafWithMeta();
    const right = buildRow(count - 1);
    const left = makeLeafWithMeta();
    const split: Split = {
      type: "split",
      direction: "h",
      children: [left, right],
      ratio: 1 / count,
    };
    return split;
  }

  // Chain row nodes with vertical splits.
  // rows=1 → buildRow(cols)
  // rows=2 → Split(v, [buildRow(cols), buildRow(cols)], 0.5)
  // rows=3 → Split(v, [buildRow(cols), Split(v, [buildRow, buildRow], 0.5)], 0.5)
  function buildRows(count: number): LayoutNode {
    if (count === 1) return buildRow(cols);
    const bottom = buildRows(count - 1);
    const top = buildRow(cols);
    const split: Split = {
      type: "split",
      direction: "v",
      children: [top, bottom],
      ratio: 1 / count,
    };
    return split;
  }

  return buildRows(rows);
}

// ---------------------------------------------------------------------------
// buildPaneLayout — ordered typed pane list
// ---------------------------------------------------------------------------
//
// The programmatic launch path this section adds sits beside `buildGridLayout`
// above, not in place of it: `buildGridLayout` stays the launch modal's path
// until the modal itself is replaced (see the plan for ticket #31, "ordered
// typed pane list"). Where `buildGridLayout` produces a rows×cols grid of PTYs
// each running one uniform provider CLI string, `buildPaneLayout` takes an
// ordered list of *individually typed* panes — some native `<AgentPane/>`
// sessions with their own provider/model/permission mode, some PTY shells with
// their own command — and lays them out under a `cols` / `rows` / `grid` split.

/** How a `PaneLaunchSpec`'s pane list is arranged. Unrelated to
 *  `buildGridLayout`'s `rows`/`cols`: a pane list has no dimensions to bound,
 *  only a total count (`MAX_LAUNCH_PANES` below); `"grid"` derives its own
 *  column count from that count. */
export type LaunchSplit = "cols" | "rows" | "grid";

export interface LaunchPaneBase {
  /** PTY / session working directory. Absent → the shell default for a shell
   *  pane; the Command Center workspace for an agent pane (`<AgentPane/>`
   *  resolves it, `agent-pane.tsx`). */
  cwd?: string;
  /** `profiles.id` this pane runs under. Carried for round-tripping and
   *  presets; the store does not write it onto the leaf (`PaneLeaf.profileId`
   *  is an unrelated `string` field, read by nobody today). */
  profileId?: number | null;
  /** Profile display name — what `agent_runs.profile` stores. */
  profileName?: string;
  /** Env overlay for this pane only. For a shell pane it is passed to
   *  `openTerminal({env})`; for an agent pane the provider's own env is
   *  applied Rust-side from the catalog, so this is currently unused there. */
  env?: Record<string, string>;
}

export interface LaunchAgentPane extends LaunchPaneBase {
  kind: "agent";
  providerId?: number;
  model?: string;
  /** One of `src-tauri/src/agent/mod.rs` `PERMISSION_MODES`; absent → no flag. */
  permissionMode?: string;
  /** The composer's per-pane "send the shared prompt on open" toggle
   *  (`feature/launch-composer-ui`, #30). Carried on the spec so #30 has a
   *  field to bind and `feature/launch-prompt-seed` (#32) has one to read;
   *  **this ticket never reads it** — prompt delivery is #32's, not this
   *  builder's. */
  sendPrompt?: boolean;
}

export interface LaunchShellPane extends LaunchPaneBase {
  kind: "shell";
  /** Shell binary override → `openTerminal({shell})`. */
  shell?: string;
  /** Written to stdin once the PTY is open. Verbatim apart from a trailing
   *  newline, which `buildPaneLayout` normalises onto `initCommand`. */
  command?: string;
}

/** A single leaf in a programmatic launch. Deliberately admits only `"agent"`
 *  and `"shell"` — `"agent-tui"` exists on `PaneKind` but renders exactly like
 *  a shell today, so admitting it here would be a launch-spec kind the
 *  composer UI would have to honour before it means anything. */
export type LaunchPane = LaunchAgentPane | LaunchShellPane;

export interface PaneLaunchSpec {
  panes: LaunchPane[];
  split: LaunchSplit;
  /** Routing only — which window consumes this spec. Agent panes derive their
   *  own `target` from the window they mount in
   *  (`window-target.ts:currentPaneTarget`), so this field is never stamped
   *  onto telemetry; it exists purely for `pending-launch-store` to route the
   *  spec to the right window. */
  target: "embedded" | "popout";
  /** Stamped onto each agent pane's `agent_runs` row via the leaf seed. */
  projectId?: number;
  source?: LaunchSource;
  /** The one prompt shared by the launch (the composer's right column). This
   *  builder uses it only to derive the 120-char `prompt_preview` telemetry
   *  string — delivering it into a pane is `feature/launch-prompt-seed` (#32).
   *  Mirrors `LaunchSpec.prompt` above. */
  prompt?: string;
}

/**
 * Maximum number of panes allowed in a single `buildPaneLayout` spec, matching
 * `GRID_MAX_PANES`'s value. Declared as its own constant rather than an alias
 * — a pane list has no `rows`/`cols` successor to `GRID_MAX_DIM`/
 * `GRID_MIN_DIM`, so this is the only cap the new path needs, and keeping it
 * separate means deleting the old modal's constants later doesn't touch it.
 */
export const MAX_LAUNCH_PANES = 8;

/**
 * Narrows the union `pending-launch-store` hands back from one localStorage
 * slot that can hold either shape. A `LaunchSpec` has no `panes` array, so
 * checking for one is enough to tell the two apart without a discriminant
 * field on either type.
 */
export function isPaneLaunchSpec(
  spec: LaunchSpec | PaneLaunchSpec,
): spec is PaneLaunchSpec {
  return Array.isArray((spec as { panes?: unknown }).panes);
}

/**
 * Build the leaf for one `LaunchPane`, at its list index `i`.
 *
 * The placeholder id (`pending-${i}`) is what ties this leaf back to
 * `spec.panes[i]` after the tree is flattened by `collectLeaves` — both
 * splits below are built left/top-first, so `collectLeaves(tree)[i]` is
 * always `panes[i]`.
 *
 * None of the PTY command machinery from `renderProviderCommand` /
 * `safeInjectClaudeArgs` / `{session_id}` substitution applies here: an agent
 * pane has no command string at all (`agent_start` assembles argv in Rust),
 * and a shell pane's command is opaque user text written verbatim apart from
 * the trailing-newline normalisation below.
 */
function buildPaneLeaf(
  pane: LaunchPane,
  i: number,
  spec: Pick<PaneLaunchSpec, "projectId" | "source" | "prompt">,
): PaneLeaf {
  const terminalId = `pending-${i}`;

  if (pane.kind === "agent") {
    const promptPreview =
      spec.prompt !== undefined && spec.prompt.length > 0
        ? spec.prompt.slice(0, 120)
        : undefined;
    // A seed is set only when there is attribution worth stamping — a pane
    // with none of these gets no `seed` key at all, keeping it byte-identical
    // to a hand-split agent leaf. `sendPrompt` is deliberately never copied
    // onto the leaf: the leaf has no field for it, and this builder delivers
    // no prompt (see `LaunchAgentPane.sendPrompt`'s own doc comment).
    const seed: PaneLaunchSeed | undefined =
      spec.projectId !== undefined ||
      pane.profileName !== undefined ||
      spec.source !== undefined ||
      promptPreview !== undefined
        ? {
            ...(spec.projectId !== undefined
              ? { projectId: spec.projectId }
              : {}),
            ...(pane.profileName !== undefined
              ? { profileName: pane.profileName }
              : {}),
            ...(spec.source !== undefined
              ? { sourceKind: spec.source.kind, sourceId: spec.source.id }
              : {}),
            ...(promptPreview !== undefined ? { promptPreview } : {}),
          }
        : undefined;
    return {
      type: "leaf",
      terminalId,
      // Matches `splitPane`'s agent sibling (`terminal-store.ts`).
      title: "claude",
      kind: "agent",
      ...(pane.cwd !== undefined ? { cwd: pane.cwd } : {}),
      ...(pane.providerId !== undefined ? { providerId: pane.providerId } : {}),
      ...(pane.model !== undefined ? { model: pane.model } : {}),
      ...(pane.permissionMode !== undefined
        ? { permissionMode: pane.permissionMode }
        : {}),
      ...(seed !== undefined ? { seed } : {}),
    };
  }

  // shell — no `kind` key: absent means shell (`paneKind`, `layout-tree.ts`),
  // which keeps this leaf byte-identical to what every other shell-creating
  // path produces. No `seed` either — a shell pane posts no telemetry.
  const initCommand =
    pane.command !== undefined && pane.command.length > 0
      ? pane.command.endsWith("\n")
        ? pane.command
        : `${pane.command}\n`
      : undefined;
  return {
    type: "leaf",
    terminalId,
    title: "zsh",
    ...(pane.cwd !== undefined ? { cwd: pane.cwd } : {}),
    ...(initCommand !== undefined ? { initCommand } : {}),
  };
}

/**
 * Right-nested chain of binary splits over `nodes`, in list order — the same
 * shape `buildGridLayout`'s `buildRow`/`buildRows` build for a uniform grid
 * (`Split.ratio` is always `1 / remaining`).
 */
function chainSplits(nodes: LayoutNode[], direction: Direction): LayoutNode {
  function build(from: number): LayoutNode {
    const remaining = nodes.length - from;
    const node = nodes[from];
    if (node === undefined) {
      throw new Error(`chainSplits: index ${from} out of range`);
    }
    if (remaining === 1) return node;
    const split: Split = {
      type: "split",
      direction,
      children: [node, build(from + 1)],
      ratio: 1 / remaining,
    };
    return split;
  }
  return build(0);
}

/**
 * Build a `LayoutNode` tree from an ordered pane list.
 *
 * - `n === 1` → the bare leaf, no split (the common composer case: no
 *   degenerate single-child split node).
 * - `"cols"` → a right-nested chain of horizontal (`"h"`) splits, leaves in
 *   list order.
 * - `"rows"` → the same, chained vertically (`"v"`).
 * - `"grid"` → `cols = ceil(sqrt(n))`, panes filled row-major; the last row is
 *   ragged when `n` isn't a multiple of `cols` (`n=5` → rows of 3 and 2). Each
 *   row is its own horizontal chain; rows are chained vertically. A short
 *   last row divides only its own row's width, so its panes are wider than
 *   the rows above — the alternative (padding with `empty` leaves so every
 *   row has the same column count) is rejected: a pane list of `n` panes must
 *   produce exactly `n` leaves, no placeholders.
 *
 * Emits placeholder ids (`pending-0`, `pending-1`, …) for every leaf — this is
 * a pure function in `lib/` and must not mint the UUIDs the store's `genId()`
 * does. The caller (`applyPaneLayout` in `stores/terminal-store.ts`) replaces
 * every one of them: a shell's with the real PTY handle id, an agent's with a
 * fresh `genId()` — never with a `pending-N` id, which is also the leaf's
 * session-registry key (`agent_frame:{leafId}`) and would collide across two
 * tabs launched from the same spec shape.
 *
 * @throws {RangeError} when `panes.length < 1` or `> MAX_LAUNCH_PANES`.
 */
export function buildPaneLayout(
  spec: Pick<
    PaneLaunchSpec,
    "panes" | "split" | "projectId" | "source" | "prompt"
  >,
): LayoutNode {
  const { panes, split } = spec;

  if (panes.length < 1) {
    throw new RangeError(
      `panes.length must be at least 1, got ${panes.length}`,
    );
  }
  if (panes.length > MAX_LAUNCH_PANES) {
    throw new RangeError(
      `panes.length (${panes.length}) exceeds the maximum of ${MAX_LAUNCH_PANES} panes per launch`,
    );
  }

  const leaves = panes.map((pane, i) => buildPaneLeaf(pane, i, spec));
  if (leaves.length === 1) return leaves[0]!;

  if (split === "cols" || split === "rows") {
    return chainSplits(leaves, split === "cols" ? "h" : "v");
  }

  // "grid": row-major fill, ceil(sqrt(n)) columns, ragged last row.
  const cols = Math.ceil(Math.sqrt(leaves.length));
  const rowNodes: LayoutNode[] = [];
  for (let i = 0; i < leaves.length; i += cols) {
    rowNodes.push(chainSplits(leaves.slice(i, i + cols), "h"));
  }
  return rowNodes.length === 1 ? rowNodes[0]! : chainSplits(rowNodes, "v");
}
