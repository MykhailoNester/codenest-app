import { useState, useRef, useCallback, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { useCompleteOnboarding } from "../../lib/api";
import { ReactorProgress, type ReactorStep } from "./reactor-progress";
import { WelcomeStep } from "./welcome-step";
import { ImportFirstProjectStep } from "./import-first-project-step";
import { ProviderSetupStep } from "./provider-setup-step";
import { AgentsReviewStep } from "./agents-review-step";
import { HooksStep } from "./hooks-step";
import { BudgetsStep } from "./budgets-step";
import { DoneStep } from "./done-step";
import styles from "./onboarding-page.module.css";

const STEPS: ReactorStep[] = [
  { code: "01", title: "Welcome" },
  { code: "02", title: "Import projects" },
  { code: "03", title: "AI provider" },
  { code: "04", title: "Agents & skills" },
  { code: "05", title: "Connect hooks" },
  { code: "06", title: "Budgets", optional: true },
  { code: "07", title: "Launch" },
];

const STEP_CRUMB = [
  "Welcome",
  "Import Projects",
  "AI Provider",
  "Agents & Skills",
  "Connect Hooks",
  "Budgets",
  "Launch",
];

export function OnboardingPage(): ReactElement {
  const [index, setIndex] = useState(0);
  const [maxReached, setMaxReached] = useState(0);
  const [committing, setCommitting] = useState(false);
  const navigate = useNavigate();
  const complete = useCompleteOnboarding();

  // The current step stores its commit fn here. The shell calls it on Continue.
  // Using a ref avoids stale-closure issues — steps always write the latest fn.
  const commitRef = useRef<() => Promise<void>>(async () => undefined);

  // Stable callback passed to each step. Steps call this once on mount (in a
  // useEffect with empty deps) to register their commit logic. The fn they pass
  // should throw on error (the shell stays put + step has already toasted) or
  // return normally to advance.
  const registerCommit = useCallback((fn: () => Promise<void>): void => {
    commitRef.current = fn;
  }, []);

  const go = (i: number): void => {
    const clamped = Math.max(0, Math.min(i, STEPS.length - 1));
    setIndex(clamped);
    setMaxReached((m) => Math.max(m, clamped));
    // Scroll the stage back to top on step change.
    const scroll = document.getElementById("ob-scroll");
    if (scroll) scroll.scrollTop = 0;
  };
  const next = (): void => go(index + 1);
  const back = (): void => go(index - 1);

  const isLastStep = index === STEPS.length - 1;
  const isSecondToLast = index === STEPS.length - 2;

  const finish = async (): Promise<void> => {
    try {
      await complete.mutateAsync();
      navigate("/command", { replace: true });
    } catch {
      // mutateAsync already sets complete.isError; the button re-enables
      // via isPending going false so the user can retry. Do not navigate —
      // letting finish() throw would bounce through OnboardingGate back here.
    }
  };

  const handleContinue = async (): Promise<void> => {
    if (isLastStep) {
      await finish();
      return;
    }
    setCommitting(true);
    try {
      await commitRef.current();
      next();
    } catch {
      // The step already toasted the error — stay on the current step.
    } finally {
      setCommitting(false);
    }
  };

  const isPending = committing || complete.isPending;

  const nextLabel = isPending
    ? "Working…"
    : isLastStep
      ? "✓ Enter Command Center"
      : isSecondToLast
        ? "Finish →"
        : "Continue →";

  return (
    <div className={styles.shell}>
      {/* Ambient backdrop */}
      <div className={`${styles.bgOrb} ${styles.bgOrbBlue}`} />
      <div className={`${styles.bgOrb} ${styles.bgOrbViolet}`} />
      <div className={`${styles.bgOrb} ${styles.bgOrbCyan}`} />
      <div className={styles.bgGrid} />

      {/* Mission rail */}
      <aside className={styles.railCol}>
        <div className={styles.brand}>
          {/* Use the same SVG icon as the sidebar */}
          <div className={styles.brandMark}>
            <svg viewBox="0 0 32 32" width="20" height="20" aria-hidden="true">
              <defs>
                <linearGradient id="ob-brand-g" x1="0" x2="1" y1="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" />
                  <stop offset="100%" stopColor="#a855f7" />
                </linearGradient>
              </defs>
              <path
                d="M4 9l12-6 12 6v14l-12 6-12-6V9z"
                fill="url(#ob-brand-g)"
                opacity="0.9"
              />
              <path
                d="M4 9l12 6 12-6M16 15v14"
                stroke="#fff"
                strokeWidth="1.2"
                fill="none"
                opacity="0.85"
              />
            </svg>
          </div>
          <div>
            <div className={styles.brandName}>Codenest</div>
            <div className={styles.brandSub}>Command Center</div>
          </div>
        </div>
        <ReactorProgress
          steps={STEPS}
          current={index}
          maxReached={maxReached}
          onSelect={go}
        />
        <div className={styles.railFoot}>
          Workspace&nbsp;&middot;&nbsp;
          <span className={styles.railMono}>
            ~/Library/&hellip;/com.codenest.dashboard/workspace
          </span>
          <br />
          <span className={styles.railMono}>v1 &middot; single workspace</span>
        </div>
      </aside>

      {/* Stage */}
      <main className={styles.stage}>
        <div className={styles.stageTop}>
          <div className={styles.stageCrumb}>
            First-Run Setup&nbsp;/&nbsp;
            <b>{STEP_CRUMB[index]}</b>
          </div>
        </div>

        <div className={styles.scroll} id="ob-scroll">
          <div className={styles.panel}>
            {index === 0 && <WelcomeStep registerCommit={registerCommit} />}
            {index === 1 && (
              <ImportFirstProjectStep registerCommit={registerCommit} />
            )}
            {index === 2 && (
              <ProviderSetupStep registerCommit={registerCommit} />
            )}
            {index === 3 && (
              <AgentsReviewStep registerCommit={registerCommit} />
            )}
            {index === 4 && <HooksStep registerCommit={registerCommit} />}
            {index === 5 && <BudgetsStep registerCommit={registerCommit} />}
            {index === 6 && <DoneStep registerCommit={registerCommit} />}
          </div>
        </div>

        {/* Footer nav — position:absolute per prototype */}
        <nav className={styles.stageNav}>
          <div className={styles.navLeft}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnGhost}`}
              onClick={back}
              disabled={index === 0 || isPending}
            >
              &larr; Back
            </button>
            <span className={styles.navHint}>
              Step {STEPS[index]?.code ?? "01"} / 07
            </span>
          </div>
          <div className={styles.navRight}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={() => void handleContinue()}
              disabled={isPending}
            >
              {nextLabel}
            </button>
          </div>
        </nav>
      </main>
    </div>
  );
}
