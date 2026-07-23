/**
 * StartupSplash — full-screen branded loader shown while the sidecar boots and
 * the onboarding state is still unknown. Replaces the plain spinner so the
 * unavoidable cold-start wait feels intentional and on-brand. Pure CSS
 * animation (honors prefers-reduced-motion); no JS timers.
 *
 * When `slow` is set (the gate's soft deadline elapsed without a definitive
 * answer), the copy changes and a `Retry` affordance is offered so a genuinely
 * stuck/slow start surfaces a visible action instead of an indefinite silent
 * splash. The underlying readiness poll keeps running regardless.
 */
import type { ReactElement } from "react";
import styles from "./startup-splash.module.css";

export interface StartupSplashProps {
  /** Soft deadline elapsed — show the "taking longer" copy + Retry button. */
  slow?: boolean;
  /** Invoked when the user clicks Retry (re-checks readiness + onboarding). */
  onRetry?: () => void;
}

export function StartupSplash({
  slow = false,
  onRetry,
}: StartupSplashProps = {}): ReactElement {
  return (
    <div className={styles.root} role="status" aria-label="Starting Codenest">
      <div className={styles.center}>
        <div className={styles.logoWrap}>
          <span className={styles.halo} aria-hidden="true" />
          <img
            src="/favicon.svg"
            alt=""
            className={styles.logo}
            width={60}
            height={58}
          />
        </div>
        <div className={styles.wordmark}>Codenest</div>
        <div className={styles.caption}>
          {slow ? "Still starting the workspace engine…" : "Initializing workspace…"}
        </div>
        <div className={styles.bar} aria-hidden="true">
          <span className={styles.barFill} />
        </div>
        {slow && (
          <div className={styles.slowNote}>
            <p className={styles.slowText}>
              This is taking longer than usual — the local engine may still be
              warming up. Your setup is safe; nothing is lost.
            </p>
            {onRetry && (
              <button type="button" className={styles.retryBtn} onClick={onRetry}>
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
