import type { ReactElement } from "react";

export interface ReactorStep {
  code: string;
  title: string;
  optional?: boolean;
}

interface Props {
  steps: ReactorStep[];
  /** Index of the current step. */
  current: number;
  /** Highest step index reached (controls which rows are clickable). */
  maxReached: number;
  onSelect?: (index: number) => void;
}

/**
 * Deck has no rail-width gauge: `.dk-meter` is a 46px row gauge, deliberately
 * fixed so forty of them align in a column. The setup rail needs one that
 * spans the rail, which is a width override and nothing else.
 */
const RAIL_METER_STYLE: React.CSSProperties = { width: "100%" };

/** Glyph + word per step state. `.dk-s` draws the character from `data-s`. */
const STEP_STATE = {
  done: { s: "done", word: "done" },
  current: { s: "run", word: "current step" },
  pending: { s: "todo", word: "pending" },
} as const;

type StepState = keyof typeof STEP_STATE;

/**
 * Setup progress rail: a proportional `.dk-meter` plus the step list as rail
 * rows. Replaces the segmented SVG "reactor" ring — the ring, its gradients
 * and both of its pulse animations are gone, so there is no motion left for
 * `prefers-reduced-motion` to suppress.
 */
export function ReactorProgress({
  steps,
  current,
  maxReached,
  onSelect,
}: Props): ReactElement {
  const n = steps.length;
  const pct = n > 1 ? Math.round((current / (n - 1)) * 100) : 0;
  const total = String(n).padStart(2, "0");

  return (
    <div className="dk-grp">
      <div className="dk-grp__h">Setup</div>

      <div style={{ padding: "0 var(--u2) var(--u2)" }}>
        <span
          className="dk-meter"
          style={RAIL_METER_STYLE}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Setup progress"
        >
          <i style={{ width: `${pct}%` }} />
        </span>
        <div className="dk-meta" style={{ marginTop: "var(--u)" }}>
          {pct}% &middot; {steps[current]?.code ?? "--"} / {total}
        </div>
      </div>

      <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {steps.map((s, i) => {
          const state: StepState =
            i < current ? "done" : i === current ? "current" : "pending";
          const { s: glyph, word } = STEP_STATE[state];
          const reachable = i <= maxReached && onSelect != null;
          return (
            <li key={s.code}>
              <button
                type="button"
                className={`dk-nav${state === "current" ? " on" : ""}`}
                disabled={!reachable}
                aria-current={state === "current" ? "step" : undefined}
                onClick={reachable ? () => onSelect(i) : undefined}
                style={reachable ? undefined : { opacity: 0.55 }}
              >
                <span className="dk-s" data-s={glyph} role="img" aria-label={word} />
                <span className="trunc">
                  <span className="dim">{s.code}</span> {s.title}
                </span>
                {s.optional === true && <span className="dk-tag">opt</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
