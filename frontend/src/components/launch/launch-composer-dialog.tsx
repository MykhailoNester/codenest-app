/**
 * launch-composer-dialog.tsx — the only component that knows how to *run* a
 * launch (task #35).
 *
 * `LaunchComposer` (`./launch-composer.tsx`) is presentation only: it
 * composes a `LaunchComposerPlan` and hands it to `onLaunch`, then stops.
 * This wrapper maps a `LaunchSeed` onto the composer's seed props, and on
 * `onLaunch` converts the plan to a `PaneLaunchSpec`
 * (`composerPlanToSpec`, `lib/launch-composer.ts`) and actually launches it —
 * through `terminalStore.applyPaneLayout` for an embedded target, or
 * `pendingLaunchStore.enqueue` + `openTerminalsWindow` for a popout.
 *
 * Kept separate from `LaunchComposer` itself so that component's 800-line
 * test suite can keep rendering it bare, with no router and no terminal
 * store (`components/launch/__tests__/launch-composer.test.tsx`).
 *
 * Every entry point in the app mounts this wrapper: `layout/shell.tsx` (the
 * top bar and the OmniBar's `OMNI_EVENT_OPEN_LAUNCH`) with no source, and
 * `launch-from-source-button.tsx` (five of the six task/inbox entry points)
 * with a seeded one.
 */

import { useMemo, useRef, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  useProjects,
  useLookups,
  useUpsertLaunchOverride,
} from "../../lib/api";
import type { LaunchSeed, LaunchSource } from "../../lib/launch-seed";
import { mergeEnv } from "../../lib/launch";
import {
  composerPlanToSpec,
  seedPanesFromGrid,
  type AgentPane,
  type ComposerPane,
  type LaunchComposerPlan,
} from "../../lib/launch-composer";
import {
  loadLaunchDefaults,
  saveLaunchDefaults,
} from "../../lib/launch-defaults";
import { useTerminalStore } from "../../stores/terminal-store";
import * as pendingLaunchStore from "../../stores/pending-launch-store";
import { openTerminalsWindow, pathsExist } from "../../lib/ipc";
import { TERMINAL_ROUTE } from "../../lib/nav-items";
import { LaunchComposer } from "./launch-composer";

export interface LaunchComposerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Null for the top-bar/OmniBar launch. */
  source?: LaunchSource | null;
  /** The fetched seed; null when a source was given but the fetch failed. */
  seed?: LaunchSeed | null;
}

/** The first agent pane in a composed plan, or `null` for an all-shell
 *  composition. Feeds the per-source override's `provider_id`/`model`
 *  columns — the override table has one provider/model slot, not one per
 *  pane, so the "primary" pane is what stands in for it (the same notion of
 *  primary `resolvePromptTargets`, `lib/launch.ts`, uses for a legacy
 *  `prompt_fanout: "primary"`). */
function firstAgentPane(panes: readonly ComposerPane[]): AgentPane | null {
  for (const pane of panes) {
    if (pane.kind === "agent") return pane;
  }
  return null;
}

export function LaunchComposerDialog({
  open,
  onClose,
  source = null,
  seed = null,
}: LaunchComposerDialogProps): ReactElement | null {
  const navigate = useNavigate();
  const { data: projects = [] } = useProjects();
  const { data: lookups } = useLookups();
  const profiles = lookups?.profiles ?? [];
  const upsertOverride = useUpsertLaunchOverride();
  const terminalStore = useTerminalStore();

  // Read once per mount — matches the seed props below, which are also only
  // read once (the composer's `useState`/`useReducer` initialisers).
  const storedDefaults = useMemo(() => loadLaunchDefaults(), []);

  // Design decision 6 in the plan: `target`/`profile_id` come from the seed
  // only when it has a saved override — otherwise the seed's bare defaults
  // (`"embedded"`, `null`) would silently beat the user's sticky default.
  // `project_id`/`provider_id`/`model` (folded into `initialLayout` below)
  // are always taken from the seed: `build_seed` resolves them from the
  // assignee's agent override, the project default and the first enabled
  // provider even with no saved override, so they are useful regardless.
  const initialTarget = seed
    ? seed.has_override
      ? seed.target
      : (storedDefaults.target ?? "embedded")
    : (storedDefaults.target ?? "embedded");
  const initialProfileId = seed
    ? seed.has_override
      ? seed.profile_id
      : (storedDefaults.profile_id ?? null)
    : (storedDefaults.profile_id ?? null);

  const launchingRef = useRef(false);

  async function runLaunch(plan: LaunchComposerPlan): Promise<void> {
    try {
      const project = projects.find((p) => p.id === plan.projectId);
      if (!project || !project.path) {
        toast("Selected project is no longer available.");
        return;
      }
      const projectPath: string = project.path;
      const profile = profiles.find((p) => p.id === plan.profileId);

      const mergedEnv = mergeEnv(null, profile ?? null);
      const shellEnv =
        Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined;

      const spec = composerPlanToSpec(plan, {
        cwd: projectPath,
        ...(profile?.name !== undefined ? { profileName: profile.name } : {}),
        ...(shellEnv !== undefined ? { shellEnv } : {}),
      });

      // Persist the per-source override BEFORE launching (decision 5 in the
      // plan) — but a failure here must never block the launch.
      if (seed) {
        try {
          const primary = firstAgentPane(plan.panes);
          await upsertOverride.mutateAsync({
            kind: seed.source.kind,
            id: seed.source.id,
            payload: {
              project_id: plan.projectId,
              provider_id: primary?.providerId ?? null,
              model: primary?.model ?? null,
              // The override table's only grid memory — echoed back
              // unchanged, since the composer's pane list is not a grid.
              rows: seed.rows,
              cols: seed.cols,
              target: plan.target,
              profile_id: plan.profileId,
              extra_args: seed.extra_args,
              prompt_fanout: seed.prompt_fanout,
              prompt_override: plan.prompt.length > 0 ? plan.prompt : null,
            },
          });
        } catch (err) {
          console.error("[LaunchComposerDialog] override upsert failed:", err);
          toast("Could not save launch preferences for this source.");
        }
      }

      // Pre-flight: verify the project path still exists before opening any
      // window — the sole cwd every pane in the spec now shares.
      try {
        const checks = await pathsExist([projectPath]);
        const bad = checks.find((c) => !c.exists || !c.is_dir);
        if (bad) {
          toast(
            `Project path not found — update the project or pick another: ` +
              `${bad.path}${!bad.exists ? " (not found)" : " (not a directory)"}`,
          );
          return;
        }
      } catch (err) {
        console.error("[LaunchComposerDialog] paths_exist check failed:", err);
        toast(
          "Cannot verify the project path — the shell is not reachable. " +
            "Try again in a moment.",
        );
        return;
      }

      saveLaunchDefaults({ target: plan.target, profile_id: plan.profileId });

      if (plan.target === "embedded") {
        const result = await terminalStore.applyPaneLayout(spec);
        if (result.openedCount === 0 && result.failedCount > 0) {
          toast(
            `All ${result.failedCount} pane${result.failedCount === 1 ? "" : "s"} failed to open. ` +
              `Check that the Tauri shell is running.`,
          );
          return;
        }
        if (result.failedCount > 0) {
          toast(
            `Launched ${result.openedCount} of ${spec.panes.length} panes — ${result.failedCount} failed.`,
          );
        }
        onClose();
        navigate(TERMINAL_ROUTE);
      } else {
        pendingLaunchStore.enqueue(spec);
        await openTerminalsWindow();
        onClose();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(`Launch failed: ${msg}`);
      console.error("[LaunchComposerDialog] launch error", err);
    }
  }

  function handleLaunch(plan: LaunchComposerPlan): void {
    // Cmd+Enter can repeat before the first launch settles; the composer's
    // Launch button has no pending/disabled state of its own to prevent it.
    if (launchingRef.current) return;
    launchingRef.current = true;
    void runLaunch(plan).finally(() => {
      launchingRef.current = false;
    });
  }

  if (source != null && seed == null) {
    // The task/inbox item this launch was seeded from no longer exists —
    // ported verbatim from the deleted `launch-modal.tsx`'s dead code (it
    // was unreachable there; `LaunchFromSourceButton` now passes `null`
    // instead of `undefined` on a failed fetch specifically to make this
    // reachable).
    if (!open) return null;
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

  return (
    <LaunchComposer
      open={open}
      onClose={onClose}
      source={
        seed
          ? {
              kind: seed.source.kind,
              id: seed.source.id,
              title: seed.source.title,
            }
          : null
      }
      sections={seed?.sections ?? []}
      initialPrompt={seed?.prompt ?? ""}
      initialProjectId={seed?.project?.id ?? null}
      initialTarget={initialTarget}
      initialProfileId={initialProfileId}
      initialLayout={seed ? seedPanesFromGrid(seed) : null}
      onLaunch={handleLaunch}
    />
  );
}
