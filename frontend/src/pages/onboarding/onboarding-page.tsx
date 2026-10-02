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

/**
 * Deck's `.dk-app` has no footer row — every converted surface puts its one
 * primary action in the title bar. Onboarding cannot: Back/Continue are the
 * flow's spine and have to stay reachable below a scrolling step, which is the
 * behaviour the pre-Deck shell had and the brief says to keep. This is the
 * footer band, drawn from Deck tokens only.
 */
const NAV_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--u3)",
  flex: "none",
  padding: "var(--u3) var(--gut)",
  borderTop: "1px solid var(--line)",
  background: "var(--bg-1)",
};

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
    <div className="deck">
      <div className="dk-app">
        {/* Setup rail */}
        <aside className="dk-rail">
          <div className="dk-rail__top">
            <span className="dk-s" data-s="run" role="img" aria-label="running" />
            <b style={{ fontWeight: 400 }}>codenest</b>
            <span className="dim">setup</span>
          </div>
          <div className="dk-rail__nav">
            <ReactorProgress
              steps={STEPS}
              current={index}
              maxReached={maxReached}
              onSelect={go}
            />
          </div>
          <div className="dk-rail__foot">
            <div className="dk-meta" style={{ whiteSpace: "normal" }}>
              workspace · ~/Library/…/com.codenest.dashboard/workspace
            </div>
            <div className="dk-meta">v1 · single workspace</div>
          </div>
        </aside>

        {/* Stage */}
        <main className="dk-main">
          <div className="dk-status">
            <span>First-Run Setup</span>
            <span className="sep">/</span>
            <b>{STEP_CRUMB[index]}</b>
          </div>

          <div className="dk-page" id="ob-scroll">
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

          <nav style={NAV_STYLE}>
            <span className="dk-actions">
              <button
                type="button"
                className="dk-btn"
                onClick={back}
                disabled={index === 0 || isPending}
              >
                ← Back
              </button>
            </span>
            <span className="dk-meta">
              Step {STEPS[index]?.code ?? "01"} / 07
            </span>
            <span className="sp" style={{ marginLeft: "auto" }} />
            <span className="dk-actions">
              <button
                type="button"
                className="dk-btn pri"
                onClick={() => void handleContinue()}
                disabled={isPending}
              >
                {nextLabel}
              </button>
            </span>
          </nav>
        </main>
      </div>
    </div>
  );
}
