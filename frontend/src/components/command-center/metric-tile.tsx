import type { ReactElement } from "react";

interface MetricTileProps {
  label: string;
  value: number | string;
  unit?: string;
  delta?: string;
  deltaOk?: boolean;
  wide?: boolean;
}

export function MetricTile({
  label,
  value,
  unit,
  delta,
  deltaOk,
  wide = false,
}: MetricTileProps): ReactElement {
  return (
    <div className={`d3-metric${wide ? " d3-metric--big" : ""}`}>
      <div className="d3-metric__label">{label}</div>
      <div className="d3-metric__value tabular">
        {value}
        {unit && <span className="d3-metric__u">{unit}</span>}
      </div>
      {delta !== undefined && (
        <div
          className="d3-metric__delta"
          style={{ color: deltaOk ? "var(--ok)" : "var(--fg-3)" }}
        >
          {delta}
        </div>
      )}
    </div>
  );
}
