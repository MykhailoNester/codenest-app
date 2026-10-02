import { useEffect, type ReactElement } from "react";
import {
  useWorkspace,
  useWorkspaceProjects,
  useHookStatus,
  useProviders,
} from "../../lib/api";
import { StepHead, StepNote, Lit } from "./step-chrome";

/** Step 7 — summary + single hand-off to the command center. */
export function DoneStep({
  registerCommit,
}: {
  registerCommit: (fn: () => Promise<void>) => void;
}): ReactElement {
  // The shell handles the last-step Continue by calling finish() directly.
  // Register a no-op so the shape is consistent.
  useEffect(() => {
    registerCommit(() => Promise.resolve());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wsQ = useWorkspace();
  const projectsQ = useWorkspaceProjects();
  const hookStatusQ = useHookStatus(null, true);
  const providersQ = useProviders(false);

  const projects = projectsQ.data ?? [];
  const count = projects.length;
  const providers = providersQ.data ?? [];
  const providerLabel =
    providers.length === 1
      ? (providers[0]?.display_name ?? "1 provider")
      : providers.length > 1
        ? `${providers.length} providers`
        : "No provider";

  // Count promoted workspace agents.
  const enabledAgents = projects.reduce(
    (sum, p) => sum + (p.enabled_count ?? 0),
    0,
  );
  const totalAgents = projects.reduce((sum, p) => sum + (p.agent_count ?? 0), 0);

  const connected = hookStatusQ.data?.connected ?? false;

  return (
    <>
      <StepHead kicker="ready" title="Workspace armed">
        Your command center is configured. Here&apos;s what we set up — you can
        change any of it in Settings.
      </StepHead>

      <div className="dk-bigs">
        <div className="dk-big">
          <div className="v">{count}</div>
          <div className="l">Projects imported</div>
        </div>
        <div className="dk-big">
          <div className={`v${providers.length === 0 ? " na" : ""}`}>
            {providerLabel}
          </div>
          <div className="l">
            {wsQ.data?.root_path != null
              ? wsQ.data.root_path.replace(/.*\//, "~/…/")
              : "AI provider configured"}
          </div>
        </div>
        <div className="dk-big">
          <div className="v">
            {enabledAgents}
            {totalAgents > 0 && <span className="dim"> / {totalAgents}</span>}
          </div>
          <div className="l">Agents promoted to workspace</div>
        </div>
        <div className="dk-big">
          <div className="v">{connected ? "Connected" : "Pending"}</div>
          <div className={`l${connected ? "" : " warn"}`}>
            Hooks · telemetry
          </div>
        </div>
      </div>

      <StepNote glyph="≡">
        A managed <Lit>CLAUDE.md</Lit> project registry was generated at the
        workspace root, so workspace sessions know every project&apos;s path.
        Say <em>&ldquo;work on web-app&rdquo;</em> and Claude resolves it
        automatically.
      </StepNote>

      <StepNote glyph="⬢">
        <strong>Launch lives in the command center.</strong> Hit{" "}
        <strong>Enter Command Center</strong> below — its <Lit>Launch</Lit>{" "}
        button starts either a <strong>workspace session</strong> (all projects ·
        all promoted agents) or a <strong>project session</strong> (pick one ·
        scoped context). We keep a single place to start sessions so navigation
        stays consistent.
      </StepNote>
    </>
  );
}
