import { type ReactElement, type ReactNode } from "react";
import { useNavigate, useNavigationType } from "react-router-dom";
import styles from "./detail-header.module.css";

interface DetailHeaderProps {
  /** Breadcrumb string, e.g. "Workspace · Tasks · #12" */
  crumbs: string;
  /** Page title */
  title: string;
  /** Optional subtitle rendered below the title */
  subtitle?: string;
  /** Optional right-side action slot */
  actions?: ReactNode;
  /**
   * Override the back action entirely.
   * Use this for panels (e.g. ReplayPanel) where "back" means onClose,
   * not navigate(-1).
   */
  onBack?: () => void;
  /**
   * Route to navigate to when the MemoryRouter history stack is exhausted
   * (i.e. the user arrived directly without prior in-app navigation).
   * Defaults to "/".
   */
  fallbackRoute?: string;
}

export function DetailHeader({
  crumbs,
  title,
  subtitle,
  actions,
  onBack,
  fallbackRoute = "/",
}: DetailHeaderProps): ReactElement {
  const navigate = useNavigate();
  const navType = useNavigationType();

  function handleBack(): void {
    if (onBack) {
      onBack();
      return;
    }
    // useNavigationType() returns "POP" when the current entry is at the
    // top of the MemoryRouter stack with no history to go back to (direct
    // navigation, initial page load, or post-refresh). In that case
    // navigate(-1) is a no-op, so fall back to the parent route instead.
    if (navType === "POP") {
      navigate(fallbackRoute, { replace: true });
    } else {
      navigate(-1);
    }
  }

  return (
    <div className={styles.header}>
      <div className={styles.left}>
        <div className={styles.crumbs}>{crumbs}</div>
        <h1 className={styles.title}>{title}</h1>
        {subtitle !== undefined && (
          <div className={styles.subtitle}>{subtitle}</div>
        )}
      </div>
      <div className={styles.right}>
        <button
          className="d3-btn d3-btn--ghost"
          type="button"
          onClick={handleBack}
          aria-label="Go back"
        >
          ← Back
        </button>
        {actions}
      </div>
    </div>
  );
}
