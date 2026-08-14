/**
 * launch-preset-strip.tsx
 *
 * Horizontal strip of preset chips. Each chip shows the preset name and
 * exposes apply / delete affordances. Uses `useLaunchPresets` and
 * `useDeleteLaunchPreset` from the API layer.
 *
 * A preset saved from the launch composer (`preset.shape === "panes"`) can
 * carry a shell pane or a per-pane model — none of which a `rows x cols`
 * grid modal can express (`handleApplyPreset`, `launch-modal.tsx:392-422`
 * only ever sets header rows/cols/provider and, at most, a `cells_json`
 * override). Applying one through this strip would silently drop those, so
 * Apply is disabled for a pane-shaped preset; Delete still works for both
 * shapes.
 */
import type { ReactElement } from "react";
import type { LaunchPreset, LaunchPresetCreate } from "../../lib/api";
import { useLaunchPresets, useDeleteLaunchPreset } from "../../lib/api";

interface LaunchPresetStripProps {
  /**
   * Called when the user clicks a preset chip to apply it.
   * The parent modal should populate its form fields from this value.
   */
  onApply: (preset: LaunchPreset) => void;
}

export function LaunchPresetStrip({
  onApply,
}: LaunchPresetStripProps): ReactElement {
  const { data: presets = [], isLoading } = useLaunchPresets();
  const deleteMutation = useDeleteLaunchPreset();

  if (isLoading) {
    return (
      <div
        style={{
          fontSize: "11px",
          color: "var(--fg-4)",
          padding: "4px 0",
        }}
      >
        Loading presets…
      </div>
    );
  }

  if (presets.length === 0) {
    return (
      <div
        style={{
          fontSize: "11px",
          color: "var(--fg-4)",
          padding: "4px 0",
          fontStyle: "italic",
        }}
      >
        No saved presets yet. Fill in the form and save one.
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        padding: "4px 0",
      }}
      role="list"
      aria-label="Saved launch presets"
    >
      {presets.map((preset) => {
        const isPanes = preset.shape === "panes";
        return (
          <div
            key={preset.id}
            role="listitem"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: "var(--bg-4)",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--r-2)",
              padding: "3px 8px",
              fontSize: "11px",
              color: "var(--fg-1)",
            }}
          >
            <button
              type="button"
              onClick={() => onApply(preset)}
              disabled={isPanes}
              title={
                isPanes
                  ? "Saved from the launch composer — open the composer to use this preset."
                  : `Apply preset: ${preset.name} (${preset.rows}×${preset.cols}, ${preset.target})`
              }
              style={{
                background: "none",
                border: "none",
                padding: 0,
                color: isPanes ? "var(--fg-4)" : "var(--fg-1)",
                cursor: isPanes ? "not-allowed" : "pointer",
                fontSize: "11px",
                fontFamily: "inherit",
              }}
            >
              {preset.name}
            </button>
            <span
              style={{
                color: "var(--fg-4)",
                fontSize: "10px",
                fontFamily: "var(--font-mono)",
              }}
            >
              {isPanes
                ? `${preset.panes.length} panes`
                : `${preset.rows}×${preset.cols}`}
            </span>
            <button
              type="button"
              aria-label={`Delete preset ${preset.name}`}
              title={`Delete preset: ${preset.name}`}
              disabled={deleteMutation.isPending}
              onClick={() => {
                void deleteMutation.mutateAsync(preset.id).catch(() => {
                  // mutation error is surfaced via isPending state only; parent
                  // can react via the mutation result if needed.
                });
              }}
              style={{
                background: "none",
                border: "none",
                padding: "0 0 0 2px",
                color: "var(--fg-4)",
                cursor: "pointer",
                fontSize: "11px",
                lineHeight: 1,
                opacity: deleteMutation.isPending ? 0.4 : 1,
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

// Re-export the type so the parent modal doesn't need a separate import.
export type { LaunchPreset, LaunchPresetCreate };
