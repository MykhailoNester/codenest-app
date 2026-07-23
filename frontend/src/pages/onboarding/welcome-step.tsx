import { useEffect, type ReactElement } from "react";
import styles from "./onboarding-page.module.css";

interface Props {
  registerCommit: (fn: () => Promise<void>) => void;
}

export function WelcomeStep({ registerCommit }: Props): ReactElement {
  // Purely informational — no commit work needed.
  useEffect(() => {
    registerCommit(() => Promise.resolve());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <div className={styles.kicker}>Initialize</div>
      <h1 className={styles.title}>Your command center workspace</h1>
      <p className={styles.lead}>
        Codenest runs every AI session from a single{" "}
        <strong>app-managed workspace</strong> — a control room that knows about
        all your projects, agents, and skills. We&apos;ll set it up in a few
        steps. The workspace is one unit today, built to grow into many later.
      </p>

      <div className={styles.modes}>
        <div className={styles.mode}>
          <h3 className={styles.modeTitle}>
            <span className={`${styles.modeBadge} ${styles.modeBadge1}`}>
              Mode 01
            </span>{" "}
            Workspace session
          </h3>
          <p className={styles.modeDesc}>
            Launch from the workspace root with access to{" "}
            <strong>every imported project</strong>, all promoted agents, and
            the full project path registry.
          </p>
          <div className={styles.modePath}>
            cwd &rarr; /workspace &middot; all agents visible
          </div>
        </div>
        <div className={`${styles.mode} ${styles.modeViolet}`}>
          <h3 className={styles.modeTitle}>
            <span className={`${styles.modeBadge} ${styles.modeBadge2}`}>
              Mode 02
            </span>{" "}
            Project session
          </h3>
          <p className={styles.modeDesc}>
            Launch scoped to a single project. Only{" "}
            <strong>that project&apos;s</strong> agents load; cwd is the project
            folder for exact context.
          </p>
          <div className={styles.modePath}>
            cwd &rarr; /project &middot; scoped agents
          </div>
        </div>
      </div>

      <div className={`${styles.infoBar} ${styles.infoBarViol}`}>
        <span className={styles.infoBarIc} aria-hidden="true">
          ◇
        </span>
        <div>
          Your projects are treated as <strong>read-only sources</strong>.
          Nothing is ever written into their folders — their git history stays
          clean. All links live inside the workspace.
        </div>
      </div>
    </>
  );
}

