// Shared formatting helpers for the budget UI (page + widget).

export function budgetBarColor(percent: number): string {
  if (percent >= 100) return "rgba(239, 68, 68, 0.85)";
  if (percent >= 80) return "rgba(234, 179, 8, 0.85)";
  if (percent >= 50) return "rgba(245, 158, 11, 0.7)";
  return "rgba(59, 130, 246, 0.7)";
}

export function budgetBarPct(percent: number): number {
  return Math.min(Math.max(percent, 0), 100);
}
