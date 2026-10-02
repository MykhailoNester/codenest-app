import type { ReactElement, ReactNode } from "react";

/**
 * The pieces every onboarding step repeats, on Deck primitives. Before the
 * conversion each of these was a class in `onboarding-page.module.css` that
 * all seven steps imported; they are the same seven shapes, so they stay one
 * module rather than being inlined seven times.
 */

/** Step heading. `.dk-title` is the same bar every converted page uses. */
export function StepHead({
  kicker,
  title,
  children,
}: {
  kicker: string;
  title: ReactNode;
  children?: ReactNode;
}): ReactElement {
  return (
    <>
      <div className="dk-title">
        <h1>{title}</h1>
        <span className="sub">{kicker}</span>
      </div>
      {children != null && (
        <p className="dk-note sans" style={{ paddingTop: 0 }}>
          {children}
        </p>
      )}
    </>
  );
}

/** A titled block. Deck has no card — a section is a heading plus its rows. */
export function StepSection({
  label,
  note,
  actions,
  children,
}: {
  label: string;
  note?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="dk-group">
      <h2 className="dk-group__h">
        <span>{label}</span>
        {note != null && <span className="note">{note}</span>}
        {actions != null && (
          <>
            <span className="sp" />
            <span className="dk-actions">{actions}</span>
          </>
        )}
      </h2>
      {children}
    </div>
  );
}

/** A labelled control plus its hint, on `.dk-form__row`. */
export function StepField({
  label,
  hint,
  htmlFor,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className={`dk-form__row${className != null ? ` ${className}` : ""}`}>
      <label className="dk-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint != null && <StepHint>{hint}</StepHint>}
    </div>
  );
}

/** Sub-control helper text. Was `.hint`. */
export function StepHint({
  tone,
  children,
}: {
  tone?: "ok" | "warn" | "err";
  children: ReactNode;
}): ReactElement {
  const color =
    tone === "ok"
      ? "var(--ok)"
      : tone === "warn"
        ? "var(--warn)"
        : tone === "err"
          ? "var(--err)"
          : undefined;
  return (
    <span className="dk-meta" style={{ whiteSpace: "normal", color }}>
      {children}
    </span>
  );
}

/**
 * The explanatory bars the flow leans on heavily (was `.infoBar`). Prose, so
 * `.sans`; the glyph stays a text character per Deck's rule 3.
 */
export function StepNote({
  glyph,
  tone,
  children,
}: {
  glyph: string;
  tone?: "warn";
  children: ReactNode;
}): ReactElement {
  return (
    <div
      className="dk-note sans"
      style={{
        display: "flex",
        gap: "var(--u2)",
        color: tone === "warn" ? "var(--warn)" : undefined,
      }}
    >
      <span aria-hidden="true" className="dim">
        {glyph}
      </span>
      <div>{children}</div>
    </div>
  );
}

/**
 * Inline literal. The whole surface is already mono, so a code span only needs
 * to be set apart — which is exactly what `.dk-tag` draws.
 */
export function Lit({ children }: { children: ReactNode }): ReactElement {
  return <code className="dk-tag">{children}</code>;
}
