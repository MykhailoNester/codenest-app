/**
 * launch.ts — helpers for the ordered-pane-list launch path (task #31,
 * wired up end-to-end by task #35).
 *
 * This module is the home for:
 *   - `mergeEnv`          — merges provider/profile env layers for a shell
 *     pane's PTY environment.
 *   - `buildPaneLayout`   — builds a `LayoutNode` tree from an ordered list
 *     of typed (`agent` | `shell`) panes.
 *   - `resolvePromptTargets` — which pane indices in a spec receive the
 *     shared prompt.
 *   - `isPaneLaunchSpec`  — the pending-launch slot's shape guard.
 *
 * The rows×cols grid launch path this module used to also carry — a
 * placeholder-substituting provider-command renderer, its safety-net flag
 * injector, the per-cell spec type and the binary-split grid builder — is
 * gone along with the modal that was its only caller (deleted in task #35);
 * the launch composer's pane list supersedes it.
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
// buildPaneLayout — ordered typed pane list
// ---------------------------------------------------------------------------
//
// Introduced by ticket #31 beside the rows×cols grid launch path's binary-
// split builder that used to live in this module (deleted in task #35 along
// with the modal that was its only caller). `buildPaneLayout` takes an
// ordered list of *individually typed* panes — some native `<AgentPane/>`
// sessions with their own provider/model/permission mode, some PTY shells
// with their own command — and lays them out under a `cols` / `rows` /
// `grid` split.

/** How a `PaneLaunchSpec`'s pane list is arranged. A pane list has no
 *  dimensions to bound, only a total count (`MAX_LAUNCH_PANES` below);
 *  `"grid"` derives its own column count from that count. */
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
   *  string — actually delivering it into a pane is
   *  `stores/pending-prompt-store.ts` + `<AgentPane/>` (#32). */
  prompt?: string;
  /** Legacy fallback for a spec whose panes declare no `sendPrompt` — the
   *  value read off `launch_source_overrides.prompt_fanout` via
   *  `GET /api/v1/launch/seed` (`launch-seed.ts:50`). Never consulted when any
   *  agent pane states its own flag (see `resolvePromptTargets`). */
  promptFanout?: PromptFanout;
}

/**
 * Maximum number of panes allowed in a single `buildPaneLayout` spec. A pane
 * list has no `rows`/`cols` dimensions to bound (the deleted grid launch
 * path's `GRID_MAX_DIM`/`GRID_MIN_DIM`), so this is the only cap the pane
 * list needs.
 */
export const MAX_LAUNCH_PANES = 8;

/**
 * Guards the one shape `pending-launch-store`'s localStorage slot can hold.
 * Takes `unknown` (not a union with the deleted grid launch path's
 * `LaunchSpec`) because a pre-upgrade build of the app can still have left a
 * `LaunchSpec` — or any other garbage — sitting in that slot across the
 * upgrade; `pending-launch-store.ts` is this guard's only caller, and drops
 * anything that fails it.
 */
export function isPaneLaunchSpec(spec: unknown): spec is PaneLaunchSpec {
  return Array.isArray((spec as { panes?: unknown } | null)?.panes);
}

/**
 * Build the leaf for one `LaunchPane`, at its list index `i`.
 *
 * The placeholder id (`pending-${i}`) is what ties this leaf back to
 * `spec.panes[i]` after the tree is flattened by `collectLeaves` — both
 * splits below are built left/top-first, so `collectLeaves(tree)[i]` is
 * always `panes[i]`.
 *
 * None of the deleted grid launch path's PTY command machinery (provider
 * template substitution, `{session_id}` injection) applies here: an agent
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
 * Right-nested chain of binary splits over `nodes`, in list order
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

// ---------------------------------------------------------------------------
// resolvePromptTargets
// ---------------------------------------------------------------------------

/**
 * Which panes in `spec.panes` receive `spec.prompt`, as ascending indices
 * into that array. Pure — no imports beyond the existing types.
 *
 * Rules, in order:
 *   1. No prompt (absent or empty) → `[]`.
 *   2. A shell pane is never a target — this is the "shell panes never
 *      receive the prompt" acceptance criterion, enforced in the one place
 *      every caller goes through.
 *   3. If *any* agent pane in the spec declares `sendPrompt`, every agent
 *      pane is resolved from its own flag (absent means `false`); the legacy
 *      `promptFanout` is not consulted at all. This is Design decision 8:
 *      the alternative — a per-pane `pane.sendPrompt ?? fanoutDefault(i)` —
 *      makes "I ticked one box, two panes got it" reachable from a
 *      half-populated spec.
 *   4. Otherwise (no pane states its own flag) fall back to
 *      `spec.promptFanout ?? "primary"`: `"none"` targets nothing, `"every"`
 *      targets every agent pane, `"primary"` targets the *first agent pane*
 *      — not leaf index 0, which may be a shell. `"primary"` is the default
 *      when neither is stated, matching the sidecar
 *      (`app/models/launch.py:232`).
 */
export function resolvePromptTargets(
  spec: Pick<PaneLaunchSpec, "panes" | "prompt" | "promptFanout">,
): number[] {
  if (spec.prompt === undefined || spec.prompt.length === 0) return [];

  const agentIndices = spec.panes
    .map((pane, i) => ({ pane, i }))
    .filter(({ pane }) => pane.kind === "agent");

  const anyExplicit = agentIndices.some(
    ({ pane }) => (pane as LaunchAgentPane).sendPrompt !== undefined,
  );
  if (anyExplicit) {
    return agentIndices
      .filter(({ pane }) => (pane as LaunchAgentPane).sendPrompt === true)
      .map(({ i }) => i);
  }

  const fanout = spec.promptFanout ?? "primary";
  if (fanout === "none") return [];
  if (fanout === "every") return agentIndices.map(({ i }) => i);
  // "primary": the first agent pane only.
  const first = agentIndices[0];
  return first !== undefined ? [first.i] : [];
}
