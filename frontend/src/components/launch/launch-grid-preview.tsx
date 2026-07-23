/**
 * launch-grid-preview.tsx
 *
 * CSS-grid mini-preview of the (rows × cols) layout that will be launched.
 * Uses only dashboard design tokens — no hard-coded hex values.
 */
import type { ReactElement } from "react";

interface LaunchGridPreviewProps {
  rows: number;
  cols: number;
}

export function LaunchGridPreview({
  rows,
  cols,
}: LaunchGridPreviewProps): ReactElement {
  const totalCells = rows * cols;
  const isOverBudget = totalCells > 8;

  return (
    <div
      aria-label={`${rows} row${rows !== 1 ? "s" : ""} × ${cols} column${cols !== 1 ? "s" : ""} grid preview`}
      style={{
        display: "grid",
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gap: 3,
        width: 80,
        height: 60,
        padding: 4,
        background: "var(--bg-3)",
        border: `1px solid ${isOverBudget ? "var(--err)" : "var(--line-2)"}`,
        borderRadius: "var(--r-2)",
        flexShrink: 0,
      }}
    >
      {Array.from({ length: totalCells }).map((_, i) => (
        <div
          key={i}
          style={{
            background: isOverBudget ? "var(--err-soft)" : "var(--bg-5)",
            border: `1px solid ${isOverBudget ? "var(--err)" : "var(--line-2)"}`,
            borderRadius: 2,
          }}
        />
      ))}
    </div>
  );
}
