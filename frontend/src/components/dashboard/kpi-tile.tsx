/**
 * KpiTile — the single KPI tile used by every surface that shows one
 * (epic #153 / #166).
 *
 * Extracted from `overview/kpi-stack.module.css`, which owned the only copy of
 * the §2 tile box until Mission Control needed the same box for its record-zone
 * row. Two copies of the 96px floor would have been two
 * places for the design to drift, so `mission-control.test.tsx` pins that rule
 * at exactly one definition and this is the component that holds it.
 *
 * The one piece of behaviour here rather than in the caller is `UNAVAILABLE`.
 * §2's honesty rule — "a value whose lane is not built renders —, never 0" —
 * is a rule about a *rendering*, so the tile is where it can actually be
 * enforced: pass `KPI_UNAVAILABLE` and the tile greys the dash and refuses the
 * unit, instead of every caller hand-writing an em dash and eventually one of
 * them writing `0` because the variable happened to be a number. A zero is a
 * claim ("I looked, there is nothing"); a dash is the truth ("nothing looked").
 */

import type { CSSProperties, ReactElement, ReactNode } from "react";
import styles from "./kpi-tile.module.css";

/**
 * The value to pass for a row whose lane does not exist yet — P2 and P3 rows in
 * the design's "Data behind this screen" table. Exported as a constant so the
 * intent is greppable and so no caller has to remember which dash character §2
 * means (em dash, not en dash, not a hyphen).
 */
export const KPI_UNAVAILABLE = "—";

export interface KpiTileProps {
  /** Small caps label, e.g. "Sessions · 24h". */
  label: string;
  /**
   * The figure. `KPI_UNAVAILABLE` renders the muted em dash; omit entirely when
   * the tile's body is `children` instead (a chip row, a bar).
   */
  value?: ReactNode;
  /** Trailing unit inside the value line, e.g. "running". Dropped for a dash. */
  unit?: ReactNode;
  /** Qualifier beside the label: "est" for an estimate, "P2"/"P3" for a lane. */
  tag?: string;
  /** The bottom line — context for the figure, pinned to the tile's foot. */
  foot?: ReactNode;
  /** Corner glow colour. Severity only, per §2's colour discipline. */
  glow?: string;
  /** Extra body between value and foot (chips, a progress bar). */
  children?: ReactNode;
}

export function KpiTile({
  label,
  value,
  unit,
  tag,
  foot,
  glow,
  children,
}: KpiTileProps): ReactElement {
  const unavailable = value === KPI_UNAVAILABLE;
  return (
    <div
      className={styles.tile}
      style={glow ? ({ "--kpi-glow": glow } as CSSProperties) : undefined}
    >
      <div className={styles.label}>
        {label}
        {tag && <span className={styles.tag}>{tag}</span>}
      </div>
      {value !== undefined && (
        <div className={`${styles.value} ${unavailable ? styles.dash : ""}`}>
          {value}
          {/* A unit on an em dash would describe a measurement that was never
              taken — "— running" reads as a reading of zero with a unit. */}
          {unit && !unavailable && <span className={styles.unit}>{unit}</span>}
        </div>
      )}
      {children}
      {foot && <div className={styles.foot}>{foot}</div>}
    </div>
  );
}
