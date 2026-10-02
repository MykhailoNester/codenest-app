/**
 * launch-from-source-button.tsx
 *
 * Reusable button that opens a seeded LaunchComposerDialog for a task or
 * inbox item. Fetches the LaunchSeed before opening so the composer has
 * full context.
 *
 * Usage:
 *   <LaunchFromSourceButton kind="task" id={task.id} />
 *   <LaunchFromSourceButton kind="inbox" id={item.id} label="Launch agent" />
 */

import { useState, type ReactElement, type CSSProperties } from "react";
import { useLaunchSeed } from "../../lib/launch-seed";
import { LaunchComposerDialog } from "./launch-composer-dialog";
import { Icon } from "../icon";

interface LaunchFromSourceButtonProps {
  kind: "task" | "inbox";
  id: number;
  /** Visible button text. Pass "" for an icon-only button (set `icon`). */
  label?: string;
  /** Leading icon name from <Icon> (e.g. "play"). */
  icon?: string;
  /** Tooltip / accessible name — required when rendering icon-only. */
  tooltip?: string;
  /** When true, renders a ghost-style secondary button. */
  variant?: "primary" | "secondary";
  /** "run" tints the button green, mirroring an IDE's run-triangle. */
  tone?: "default" | "run";
}

export function LaunchFromSourceButton({
  kind,
  id,
  label = "Launch agent",
  icon,
  tooltip,
  variant = "secondary",
  tone = "default",
}: LaunchFromSourceButtonProps): ReactElement {
  const [open, setOpen] = useState(false);

  // staleTime=0 so we always re-fetch when opened; disabled until user clicks.
  const seedQuery = useLaunchSeed(open ? { kind, id } : null);

  const isLoading = open && seedQuery.isLoading;
  const isError = open && seedQuery.isError && !seedQuery.isLoading;

  const iconOnly = !label;

  // In the normal state surface the caller's tooltip; on error, override it.
  const title = isError
    ? "Failed to load launch seed — click to retry"
    : tooltip;

  function handleClick(e: React.MouseEvent): void {
    e.stopPropagation();
    setOpen(true);
  }

  const className = ["dk-btn", variant === "primary" ? "pri" : "bare"]
    .filter(Boolean)
    .join(" ");

  // Deck has `.dk-btn.danger` for the error tone but no `ok` sibling, so the
  // "run" tone is a local override rather than a class. Reported as a gap.
  const toneStyle: CSSProperties =
    tone === "run" && !isError
      ? { color: "var(--ok)", borderColor: "var(--ok)" }
      : {};

  return (
    <>
      <button
        type="button"
        className={className}
        disabled={isLoading}
        title={title}
        aria-label={iconOnly ? (tooltip ?? "Launch agent") : undefined}
        onClick={handleClick}
        style={{
          fontSize: "12px",
          display: "inline-flex",
          alignItems: "center",
          gap: label ? 5 : 0,
          ...(iconOnly ? { padding: "5px 7px" } : {}),
          ...toneStyle,
          ...(isError
            ? { borderColor: "var(--err)", color: "var(--err)" }
            : {}),
        }}
      >
        {isLoading ? (
          <Spinner />
        ) : isError ? (
          <span aria-hidden="true">!</span>
        ) : icon ? (
          <Icon name={icon} size={14} />
        ) : null}
        {label ? <span>{label}</span> : null}
      </button>

      {open && !isLoading && (
        <LaunchComposerDialog
          open
          onClose={() => setOpen(false)}
          source={{ kind, id }}
          // `?? null` (not `undefined`): the composer dialog's
          // "Source no longer exists" panel is gated on `seed === null`, so
          // an errored fetch must produce `null` here rather than silently
          // opening an unattributed composer.
          seed={seedQuery.data ?? null}
        />
      )}
    </>
  );
}

// Deck states a condition as a character rather than a shape — the error
// branch beside this one already renders `!`. `~` is Deck's running glyph, so
// loading reads in the same vocabulary. That was the last consumer of
// `d3-creative.css`'s keyframes, and the stylesheet is gone with it.
function Spinner(): ReactElement {
  return <span aria-hidden="true">~</span>;
}
