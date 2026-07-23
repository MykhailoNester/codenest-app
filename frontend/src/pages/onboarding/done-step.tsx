import { useEffect, type ReactElement } from "react";
import { useWorkspace, useWorkspaceProjects, useHookStatus, useProviders } from "../../lib/api";
import styles from "./onboarding-page.module.css";

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
  const totalAgents = projects.reduce(
    (sum, p) => sum + (p.agent_count ?? 0),
    0,
  );

  const connected = hookStatusQ.data?.connected ?? false;

  return (
    <>
      <div className={styles.kicker}>Ready</div>
      <h1 className={styles.title}>Workspace armed</h1>
      <p className={styles.lead}>
        Your command center is configured. Here&apos;s what we set up — you can
        change any of it in Settings.
      </p>

      <div className={styles.summary}>
        {/* Projects imported */}
        <div className={styles.sumCard}>
          <div className={styles.sumIc} aria-hidden="true">
            ▦
          </div>
          <div>
            <div
              className={styles.sumBig}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {count}
            </div>
            <div className={styles.sumLabel}>Projects imported</div>
          </div>
        </div>

        {/* Provider info */}
        <div className={styles.sumCard}>
          <div
            className={styles.sumIc}
            style={{
              background: "rgba(168,85,247,.12)",
              color: "var(--violet, #a855f7)",
            }}
            aria-hidden="true"
          >
            ✳
          </div>
          <div>
            <div className={styles.sumBig} style={{ fontSize: 14 }}>
              {providerLabel}
            </div>
            <div className={styles.sumLabel}>
              {wsQ.data?.root_path
                ? wsQ.data.root_path.replace(/.*\//, "~/…/")
                : "AI provider configured"}
            </div>
          </div>
        </div>

        {/* Agents promoted */}
        <div className={styles.sumCard}>
          <div
            className={styles.sumIc}
            style={{
              background: "rgba(34,197,94,.12)",
              color: "var(--ok, #22c55e)",
            }}
            aria-hidden="true"
          >
            ⬡
          </div>
          <div>
            <div
              className={styles.sumBig}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {enabledAgents}
              {totalAgents > 0 && (
                <span className={styles.muted} style={{ fontSize: 13 }}>
                  {" "}
                  / {totalAgents}
                </span>
              )}
            </div>
            <div className={styles.sumLabel}>Agents promoted to workspace</div>
          </div>
        </div>

        {/* Hook status */}
        <div className={styles.sumCard}>
          <div
            className={styles.sumIc}
            style={{
              background: connected
                ? "rgba(34,197,94,.12)"
                : "rgba(245,158,11,.12)",
              color: connected ? "var(--ok, #22c55e)" : "var(--warn, #f59e0b)",
            }}
            aria-hidden="true"
          >
            ⟲
          </div>
          <div>
            <div
              className={styles.sumBig}
              style={{
                fontSize: 14,
                color: connected ? "var(--ok, #22c55e)" : "var(--fg-2)",
              }}
            >
              {connected ? "Connected" : "Pending"}
            </div>
            <div className={styles.sumLabel}>Hooks &middot; telemetry</div>
          </div>
        </div>
      </div>

      <div className={styles.infoBar}>
        <span className={styles.infoBarIc} aria-hidden="true">
          ≡
        </span>
        <div>
          A managed{" "}
          <code
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              background: "rgba(255,255,255,.06)",
              border: "1px solid var(--line-2)",
              borderRadius: 4,
              padding: "1px 5px",
            }}
          >
            CLAUDE.md
          </code>{" "}
          project registry was generated at the workspace root, so workspace
          sessions know every project&apos;s path. Say{" "}
          <em>&ldquo;work on web-app&rdquo;</em> and Claude resolves it
          automatically.
        </div>
      </div>

      <div className={`${styles.infoBar} ${styles.infoBarViol}`}>
        <span className={styles.infoBarIc} aria-hidden="true">
          ⬢
        </span>
        <div>
          <strong>Launch lives in the command center.</strong> Hit{" "}
          <strong>Enter Command Center</strong> below — its{" "}
          <code
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              background: "rgba(255,255,255,.06)",
              border: "1px solid var(--line-2)",
              borderRadius: 4,
              padding: "1px 5px",
            }}
          >
            Launch
          </code>{" "}
          button starts either a <strong>workspace session</strong> (all
          projects &middot; all promoted agents) or a{" "}
          <strong>project session</strong> (pick one &middot; scoped context).
          We keep a single place to start sessions so navigation stays
          consistent.
        </div>
      </div>
    </>
  );
}
