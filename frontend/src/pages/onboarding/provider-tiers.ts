/**
 * The four model tiers onboarding offers per provider, and the mapping between
 * them and the `provider_models` rows that actually get persisted.
 *
 * Separate from `provider-setup-step.tsx` because these are values and a pure
 * function, and a file that exports components may export nothing else without
 * breaking Fast Refresh (`react-refresh/only-export-components`).
 */

import type { ProviderModel } from "../../lib/api";

export interface Tier {
  key: string;
  label: string;
  dotColor: string;
}

export const TIERS: Tier[] = [
  { key: "fable", label: "Fable", dotColor: "var(--warn, #f59e0b)" },
  { key: "opus", label: "Opus", dotColor: "var(--violet, #a855f7)" },
  { key: "sonnet", label: "Sonnet", dotColor: "var(--accent, #3b82f6)" },
  { key: "haiku", label: "Haiku", dotColor: "var(--info, #38bdf8)" },
];

/**
 * Seeded model IDs, matching the aliases Claude Code 2.1.220 documents for
 * `--model` ("Provide an alias for the latest model (e.g. 'fable', 'opus', or
 * 'sonnet') or a model's full name (e.g. 'claude-fable-5')").
 *
 * Two rules these have to follow, both verified against the installed CLI
 * rather than assumed:
 *
 * 1. **Dashes, never dots.** `claude-haiku-4.5` does not appear anywhere in the
 *    CLI binary; `claude-haiku-4-5` appears throughout. A dotted ID is rejected
 *    at the API, and the failure surfaces as an opaque error inside the pane.
 * 2. **No date suffix on an alias.** `claude-haiku-4-5` is the alias that
 *    tracks the latest Haiku 4.5 build; the dated `claude-haiku-4-5-20251001`
 *    is a pinned snapshot. Seeding the alias means a user who never revisits
 *    this screen keeps following the current build.
 *
 * The user maintains these as new models ship — the onboarding inputs are
 * editable and the values land in `provider_models`, which is what the agent
 * pane's model dropdown reads.
 */
export const DEFAULT_MODELS: Record<string, string> = {
  fable: "claude-fable-5",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};

/** What {@link tiersFromModels} resolved a provider's persisted rows into. */
export interface SeededTiers {
  /** Every tier input's value: persisted where a row exists, the seeded default
   *  where it does not, so no input is ever left blank. */
  models: Record<string, string>;
  /** Only what is persisted — a tier with no row is `""`. This is what the
   *  commit loop diffs against, so a missing tier reads as "not saved yet" and
   *  gets written rather than being assumed present. */
  persisted: Record<string, string>;
  defaultTier: string;
}

/**
 * Map persisted `provider_models` rows back onto the four tier inputs.
 *
 * Rows are matched on `display_name` (the commit loop writes each tier's label
 * there), falling back to matching the model id against {@link DEFAULT_MODELS}
 * so rows written by Settings → Providers or by hand still land in the right
 * slot.
 *
 * Returns null when there is nothing to map — no rows, or a failed lookup. Both
 * mean "we do not know what this provider has", and the caller must then treat
 * the models as unsaved. Seeding `originalModels` with {@link DEFAULT_MODELS}
 * instead — which is what the onboarding step used to do — made its
 * `modelsChanged` check false for a provider whose `provider_models` table was
 * empty, so the PUT was skipped: the four inputs showed Opus/Sonnet/Haiku/Fable,
 * Next was clicked, and nothing was ever written. The agent pane then had no
 * models to offer and its dropdown sat disabled on "CLI default", with no way to
 * fix it from that screen no matter how many times it was re-run.
 */
export function tiersFromModels(models: ProviderModel[] | null): SeededTiers | null {
  if (models === null || models.length === 0) return null;
  const persisted: Record<string, string> = {};
  let defaultTier: string | null = null;
  for (const row of models) {
    const tier =
      TIERS.find(
        (t) => t.label.toLowerCase() === row.display_name.trim().toLowerCase(),
      )?.key ?? TIERS.find((t) => DEFAULT_MODELS[t.key] === row.model_name)?.key;
    if (tier === undefined) continue;
    persisted[tier] = row.model_name;
    if (row.is_default) defaultTier = tier;
  }
  // Rows exist but none of them map onto a tier this screen offers (a
  // hand-registered model id under a custom label). Reporting "unknown" is the
  // safe answer: it keeps the tier inputs at their defaults and PUTs them.
  if (Object.keys(persisted).length === 0) return null;
  return {
    models: { ...DEFAULT_MODELS, ...persisted },
    persisted: Object.fromEntries(TIERS.map((t) => [t.key, persisted[t.key] ?? ""])),
    defaultTier: defaultTier ?? "opus",
  };
}
