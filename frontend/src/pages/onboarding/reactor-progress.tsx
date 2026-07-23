import type { ReactElement } from "react";
import styles from "./reactor-progress.module.css";

export interface ReactorStep {
  code: string;
  title: string;
  optional?: boolean;
}

interface Props {
  steps: ReactorStep[];
  /** Index of the current step. */
  current: number;
  /** Highest step index reached (controls which tiles are clickable). */
  maxReached: number;
  onSelect?: (index: number) => void;
}

// Geometry for the segmented reactor ring (viewBox 188x188).
const CX = 94;
const CY = 94;
const R = 80;
const GAP_DEG = 7;

function polar(deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [CX + R * Math.cos(a), CY + R * Math.sin(a)];
}

function arcPath(startDeg: number, endDeg: number): string {
  const [sx, sy] = polar(startDeg);
  const [ex, ey] = polar(endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
}

/**
 * Mission-control progress rail: a segmented "reactor" ring that charges
 * blue→violet as the user advances, plus a hex-status mission list. Replaces a
 * conventional dot/line stepper.
 */
export function ReactorProgress({
  steps,
  current,
  maxReached,
  onSelect,
}: Props): ReactElement {
  const n = steps.length;
  const seg = 360 / n;
  const pct = n > 1 ? Math.round((current / (n - 1)) * 100) : 0;

  return (
    <div className={styles.rail}>
      <div className={styles.reactor}>
        <svg viewBox="0 0 188 188" aria-hidden="true">
          <defs>
            <linearGradient id="rp-done" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#3b82f6" />
              <stop offset="1" stopColor="#5b9bff" />
            </linearGradient>
            <linearGradient id="rp-active" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#a855f7" />
              <stop offset="1" stopColor="#3b82f6" />
            </linearGradient>
          </defs>
          {steps.map((s, i) => {
            const state =
              i < current ? "done" : i === current ? "active" : "pending";
            return (
              <path
                key={s.code}
                d={arcPath(i * seg + GAP_DEG / 2, (i + 1) * seg - GAP_DEG / 2)}
                className={`${styles.seg} ${styles[state]}`}
              />
            );
          })}
        </svg>
        <div className={styles.core}>
          <div className={styles.pct}>
            {pct}
            <small>%</small>
          </div>
          <div className={styles.coreLabel}>Setup</div>
          <div className={styles.phase}>
            {steps[current]?.code ?? "--"} / {String(n).padStart(2, "0")}
          </div>
        </div>
      </div>

      <div className={styles.missionsHead}>Mission Sequence</div>
      <ol className={styles.missions}>
        {steps.map((s, i) => {
          const state =
            i < current ? "done" : i === current ? "active" : "locked";
          const reachable = i <= maxReached && onSelect != null;
          return (
            <li
              key={s.code}
              className={`${styles.tile} ${styles[state]}`}
              {...(reachable
                ? {
                    role: "button",
                    tabIndex: 0,
                    onClick: () => onSelect(i),
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(i);
                      }
                    },
                  }
                : {})}
            >
              <span className={styles.hex} aria-hidden="true" />
              <span className={styles.code}>{s.code}</span>
              <span className={styles.tileTitle}>{s.title}</span>
              {s.optional && <span className={styles.opt}>opt</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
