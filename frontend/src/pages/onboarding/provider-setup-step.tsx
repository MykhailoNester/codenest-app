import { useState, useEffect, useRef, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateProvider,
  useUpdateProvider,
  useSetProviderModels,
  useValidateProjectPath,
  updateProfile,
  fetchProfiles,
  type PathValidationResult,
  type ProviderModelInput,
  type ProviderModel,
  type SidecarError,
  type Provider,
} from "../../lib/api";
import { useQuery } from "@tanstack/react-query";
import { fetchSidecar } from "../../lib/api";
import { pickDirectory } from "../../lib/ipc";
import { TIERS, DEFAULT_MODELS, tiersFromModels } from "./provider-tiers";
import styles from "./onboarding-page.module.css";

/** Extract the leading binary token from a command_template string. */
function commandAlias(template: string): string {
  return template.trim().split(/\s+/)[0] ?? "claude";
}

/**
 * Rewrite the leading token in a command_template while preserving the rest
 * of the template (placeholders included).
 */
function replaceCommandAlias(template: string, alias: string): string {
  const trimmed = template.trim();
  const spaceIdx = trimmed.search(/\s/);
  if (spaceIdx === -1) return alias;
  return alias + trimmed.slice(spaceIdx);
}

/** One Anthropic alias entry in the multi-provider list. */
interface ProviderEntry {
  /** Stable client-side key for React list rendering. */
  key: string;
  /** The `providers.id` once persisted; null for unsaved entries. */
  savedId: number | null;
  alias: string;
  configHome: string;
  models: Record<string, string>;
  /**
   * What `provider_models` actually holds for this provider, per tier — `""`
   * for a tier with no row. Only PUT when `models` differs from this, which
   * avoids clobbering user-edited model IDs on revisit.
   *
   * `null` means "unknown, treat as unsaved" and always PUTs: a brand-new entry,
   * a provider with no rows at all, or a lookup that failed. It must never be
   * seeded from {@link DEFAULT_MODELS} — that made the two sides equal for a
   * provider with an empty table and silently skipped the only write that would
   * have populated it.
   */
  originalModels: Record<string, string> | null;
  defaultTier: string;
  /** Path validation state. */
  pathValid: boolean | null;
  pathChecking: boolean;
  /** Inline error from a 409 / network failure during save. */
  saveError: string | null;
}

function makeEntry(overrides?: Partial<ProviderEntry>): ProviderEntry {
  return {
    key: crypto.randomUUID(),
    savedId: null,
    alias: "",
    configHome: "",
    models: { ...DEFAULT_MODELS },
    originalModels: null,
    defaultTier: "opus",
    pathValid: null,
    pathChecking: false,
    saveError: null,
    ...overrides,
  };
}

/** True when entry still has the untouched initial blank state. */
function isBlankEntry(entry: ProviderEntry): boolean {
  return entry.savedId === null && entry.alias === "" && entry.configHome === "";
}

/** An existing provider plus the `provider_models` rows it actually has.
 *  `models` is null when the lookup failed — distinct from an empty array,
 *  which is a provider genuinely registered with no models. */
interface ExistingProvider {
  provider: Provider;
  models: ProviderModel[] | null;
}

interface Props {
  registerCommit: (fn: () => Promise<void>) => void;
}

export function ProviderSetupStep({ registerCommit }: Props): ReactElement {
  const qc = useQueryClient();

  // Load existing providers on mount so that revisiting the step doesn't
  // duplicate rows — together with each one's `provider_models` rows, which the
  // seed below needs to tell "already saved" from "never saved". Fetching the
  // provider alone is what let this screen assume the models were already there.
  const providersQ = useQuery<ExistingProvider[], SidecarError>({
    queryKey: ["providers", "include_disabled", "with-models"],
    queryFn: async () => {
      const providers = await fetchSidecar<Provider[]>(
        "/api/v1/providers?include_disabled=true",
      );
      return Promise.all(
        providers.map(async (provider) => ({
          provider,
          // A failed lookup degrades to null, never to `[]`: "we could not ask"
          // must not be mistaken for "this provider has no models", since the
          // latter is exactly the case that has to trigger a write.
          models: await fetchSidecar<ProviderModel[]>(
            `/api/v1/providers/${provider.id}/models`,
          ).catch(() => null),
        })),
      );
    },
    staleTime: 15_000,
    retry: false,
  });

  const [entries, setEntries] = useState<ProviderEntry[]>([makeEntry()]);
  const seededRef = useRef(false);

  // When the provider list arrives, reconcile: build one entry per existing
  // provider. Guard: only seed when entries are still the untouched initial
  // blank to avoid clobbering edits the user has already started.
  useEffect(() => {
    if (seededRef.current || !providersQ.data) return;
    const existing = providersQ.data;
    if (existing.length === 0) return;

    // Only proceed if every current entry is still blank (query resolved late).
    setEntries((prev) => {
      if (!prev.every(isBlankEntry)) return prev;
      seededRef.current = true;
      return existing.map(({ provider: p, models }) => {
        const seeded = tiersFromModels(models);
        return {
          key: `existing-${p.id}`,
          savedId: p.id,
          alias: commandAlias(p.command_template),
          configHome: p.default_env["CLAUDE_CONFIG_DIR"] ?? "",
          // The inputs show what is saved, filled out with the defaults for any
          // tier that has no row yet.
          models: seeded?.models ?? { ...DEFAULT_MODELS },
          // Only what is genuinely persisted. `null` — no rows, or the lookup
          // failed — makes the commit loop always PUT, which is what unsticks a
          // provider registered with an empty `provider_models` table.
          originalModels: seeded?.persisted ?? null,
          defaultTier: seeded?.defaultTier ?? "opus",
          pathValid: null,
          pathChecking: false,
          saveError: null,
        };
      });
    });
  }, [providersQ.data]);

  // ── Mutations ────────────────────────────────────────────────────────────

  const createProviderMut = useCreateProvider();
  const updateProviderMut = useUpdateProvider();
  const setModelsMut = useSetProviderModels();

  // ── Path validation ──────────────────────────────────────────────────────
  // One shared mutation; debounce per-entry via per-entry timer refs.

  const validateMut = useValidateProjectPath();
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  function scheduleValidate(entryKey: string, path: string, delay = 300): void {
    const existing = debounceTimers.current.get(entryKey);
    if (existing !== undefined) clearTimeout(existing);

    if (!path.trim()) {
      setEntries((prev) =>
        prev.map((e) =>
          e.key === entryKey
            ? { ...e, pathValid: null, pathChecking: false }
            : e,
        ),
      );
      return;
    }

    setEntries((prev) =>
      prev.map((e) =>
        e.key === entryKey ? { ...e, pathChecking: true } : e,
      ),
    );

    const timer = setTimeout(() => {
      debounceTimers.current.delete(entryKey);
      void validateMut
        .mutateAsync(path)
        .then((result: PathValidationResult) => {
          const valid = result.exists && result.is_dir;
          setEntries((prev) =>
            prev.map((e) =>
              e.key === entryKey
                ? { ...e, pathValid: valid, pathChecking: false }
                : e,
            ),
          );
        })
        .catch(() => {
          setEntries((prev) =>
            prev.map((e) =>
              e.key === entryKey
                ? { ...e, pathValid: null, pathChecking: false }
                : e,
            ),
          );
        });
    }, delay);

    debounceTimers.current.set(entryKey, timer);
  }

  // Clear all debounce timers on unmount.
  useEffect(() => {
    const timers = debounceTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
    };
  }, []);

  // ── Browse handler ────────────────────────────────────────────────────────

  async function handleBrowse(entryKey: string): Promise<void> {
    const dir = await pickDirectory();
    if (!dir) return;
    setEntries((prev) =>
      prev.map((e) =>
        e.key === entryKey ? { ...e, configHome: dir } : e,
      ),
    );
    // Picker result is already a real path — validate immediately (delay=0).
    scheduleValidate(entryKey, dir, 0);
  }

  // ── Entry field update helpers ────────────────────────────────────────────

  function updateEntry<K extends keyof ProviderEntry>(
    key: string,
    field: K,
    value: ProviderEntry[K],
  ): void {
    setEntries((prev) =>
      prev.map((e) => (e.key === key ? { ...e, [field]: value } : e)),
    );
  }

  function removeEntry(key: string): void {
    setEntries((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((e) => e.key !== key);
    });
  }

  function addEntry(): void {
    setEntries((prev) => [...prev, makeEntry()]);
  }

  // ── Save / commit ─────────────────────────────────────────────────────────

  const saveRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    registerCommit(() => saveRef.current());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    saveRef.current = async (): Promise<void> => {
      for (const entry of entries) {
        const aliasValue = entry.alias.trim() || "claude";
        const configHomeValue = entry.configHome.trim();

        const commandTemplate = replaceCommandAlias(
          "claude {session_id} {mcp_config} {extra_args}",
          aliasValue,
        );
        const defaultEnv: Record<string, string> = configHomeValue
          ? { CLAUDE_CONFIG_DIR: configHomeValue }
          : {};

        let savedId: number | null = entry.savedId;

        if (savedId === null) {
          try {
            const created = await createProviderMut.mutateAsync({
              name: aliasValue,
              display_name: `Anthropic (${aliasValue})`,
              command_template: commandTemplate,
              default_env: defaultEnv,
              color: "#a855f7",
              is_enabled: true,
            });
            savedId = created.id;
            setEntries((prev) =>
              prev.map((e) =>
                e.key === entry.key
                  ? { ...e, savedId: created.id, saveError: null }
                  : e,
              ),
            );
          } catch (err) {
            const sidecarErr = err as SidecarError;
            const msg =
              sidecarErr.status === 409
                ? `Alias "${aliasValue}" is already taken — choose a different name.`
                : `Failed to save "${aliasValue}": ${sidecarErr.message}`;
            setEntries((prev) =>
              prev.map((e) =>
                e.key === entry.key ? { ...e, saveError: msg } : e,
              ),
            );
            throw err;
          }
        } else {
          try {
            await updateProviderMut.mutateAsync({
              id: savedId,
              patch: {
                display_name: `Anthropic (${aliasValue})`,
                command_template: commandTemplate,
                default_env: defaultEnv,
                is_enabled: true,
              },
            });
            setEntries((prev) =>
              prev.map((e) =>
                e.key === entry.key ? { ...e, saveError: null } : e,
              ),
            );
          } catch (err) {
            const sidecarErr = err as SidecarError;
            setEntries((prev) =>
              prev.map((e) =>
                e.key === entry.key
                  ? {
                      ...e,
                      saveError: `Failed to update "${aliasValue}": ${sidecarErr.message}`,
                    }
                  : e,
              ),
            );
            throw err;
          }
        }

        // Only PUT models when the user actually changed them from the seeded
        // originals. Skips silent overwrites on revisit for existing providers.
        if (savedId !== null) {
          const modelsChanged =
            entry.originalModels === null ||
            TIERS.some((t) => entry.models[t.key] !== entry.originalModels?.[t.key]);

          if (modelsChanged) {
            const modelPayload: ProviderModelInput[] = TIERS.map((t) => ({
              model_name: (entry.models[t.key] ?? "").trim(),
              display_name: t.label,
              is_default: t.key === entry.defaultTier,
            })).filter((m) => m.model_name.length > 0);

            if (modelPayload.length > 0) {
              try {
                await setModelsMut.mutateAsync({
                  providerId: savedId,
                  models: modelPayload,
                });
                // After a successful models PUT, update originalModels so a
                // second commit doesn't re-PUT unchanged values.
                setEntries((prev) =>
                  prev.map((e) =>
                    e.key === entry.key
                      ? { ...e, originalModels: { ...entry.models } }
                      : e,
                  ),
                );
              } catch (err) {
                const sidecarErr = err as SidecarError;
                setEntries((prev) =>
                  prev.map((e) =>
                    e.key === entry.key
                      ? {
                          ...e,
                          saveError: `Saved provider but failed to update models for "${aliasValue}": ${sidecarErr.message}`,
                        }
                      : e,
                  ),
                );
                throw err;
              }
            }
          }
        }

        // Bind provider metadata onto an existing profile row so that Claude
        // hook sessions can be matched to a provider at session-start time.
        // The backend bootstrap (_reconcile_provider_profiles) is responsible
        // for creating provider-linked profile rows; we only update here if a
        // row already exists (matched by provider_id or alias name). We never
        // create a new grouping profile from the frontend — "Home Base" is
        // created by the backend and is the default grouping.
        if (savedId !== null && configHomeValue) {
          const defaultModel =
            (entry.models[entry.defaultTier] ?? "").trim() || null;
          try {
            const existingProfiles = await fetchProfiles();
            const matchById = existingProfiles.find(
              (p) => p.provider_id === savedId,
            );
            const matchByName = existingProfiles.find(
              (p) => p.name === aliasValue,
            );
            const match = matchById ?? matchByName;
            if (match) {
              await updateProfile(match.id, {
                name: aliasValue,
                claude_config_dir: configHomeValue,
                provider_id: savedId,
                ...(defaultModel ? { default_model: defaultModel } : {}),
              });
            }
            // If no existing profile matches, the backend bootstrap will create
            // the provider-binding row on next sidecar startup — no action needed.
          } catch {
            // Profile bind is best-effort; a failure must not break the
            // rest of onboarding. The bootstrap reconciler will retry on next
            // app restart.
          }
        }
      }

      // Ensure all provider caches are fresh for downstream steps.
      void qc.invalidateQueries({ queryKey: ["providers"] });
      void qc.invalidateQueries({ queryKey: ["profiles"] });
    };
  }, [entries, createProviderMut, updateProviderMut, setModelsMut, qc]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div className={styles.kicker}>
        Step 03 &middot; Connect &middot; Required
      </div>
      <h1 className={styles.title}>Configure an AI provider</h1>
      <p className={styles.lead}>
        Add one or more Anthropic aliases — each with its own config home and
        command name. Model IDs are{" "}
        <strong>entered manually</strong> — you own keeping them current.
      </p>

      {/* Provider picker grid — 4 columns */}
      <div className={styles.providers}>
        {/* Anthropic — active / selectable */}
        <div className={`${styles.prov} ${styles.provSel}`}>
          <div className={styles.provPick} aria-hidden>
            <svg viewBox="0 0 12 12" fill="none" width={9} height={9}>
              <path
                d="M2 6.5l2.5 2.5 5.5-6"
                stroke="#fff"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div
            className={styles.provLogo}
            style={{
              background: "linear-gradient(135deg, #a855f7, #3b82f6)",
            }}
          >
            ✳
          </div>
          <div className={styles.provName}>Anthropic</div>
          <div className={styles.provSoon} style={{ color: "var(--ok)" }}>
            Claude &middot; tested
          </div>
        </div>

        {/* OpenAI — coming soon */}
        <div className={`${styles.prov} ${styles.provDisabled}`}>
          <div
            className={styles.provLogo}
            style={{ background: "var(--bg-4, #1d2330)" }}
          >
            ○
          </div>
          <div className={styles.provName}>OpenAI</div>
          <div className={styles.provSoon}>Coming soon</div>
        </div>

        {/* Google — coming soon */}
        <div className={`${styles.prov} ${styles.provDisabled}`}>
          <div
            className={styles.provLogo}
            style={{ background: "var(--bg-4, #1d2330)" }}
          >
            ◐
          </div>
          <div className={styles.provName}>Google</div>
          <div className={styles.provSoon}>Coming soon</div>
        </div>

        {/* Local — coming soon */}
        <div className={`${styles.prov} ${styles.provDisabled}`}>
          <div
            className={styles.provLogo}
            style={{ background: "var(--bg-4, #1d2330)" }}
          >
            ⌂
          </div>
          <div className={styles.provName}>Local</div>
          <div className={styles.provSoon}>Coming soon</div>
        </div>
      </div>

      {providersQ.isError && (
        <p className={styles.muted} style={{ marginBottom: 12 }}>
          Could not load existing providers — you can configure them later in
          Settings.
        </p>
      )}

      {/* ── Multi-alias entry list ──────────────────────────────────── */}
      {entries.map((entry, idx) => (
        <div
          key={entry.key}
          className={styles.card}
          style={{ marginBottom: 16 }}
        >
          {/* Entry header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 14,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--fg-3)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              Account {idx + 1}
            </span>
            {entries.length > 1 && (
              <button
                type="button"
                onClick={() => removeEntry(entry.key)}
                style={{
                  fontSize: 11,
                  color: "var(--err, #f87171)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "2px 6px",
                }}
              >
                Remove
              </button>
            )}
          </div>

          {/* Alias + Config home */}
          <div className={styles.grid2} style={{ marginBottom: 16 }}>
            <div>
              <label className={styles.fieldLabel}>Alias / command</label>
              <input
                className={`${styles.fld} ${styles.fldMono}`}
                value={entry.alias}
                onChange={(e) =>
                  updateEntry(entry.key, "alias", e.target.value)
                }
                placeholder="claude"
                spellCheck={false}
              />
              <p className={styles.hint}>The CLI the session invokes.</p>
            </div>

            <div>
              <label className={styles.fieldLabel}>Config home</label>
              <div
                style={{ display: "flex", gap: 6, alignItems: "stretch" }}
              >
                <input
                  className={`${styles.fld} ${styles.fldMono}`}
                  style={{ flex: 1 }}
                  value={entry.configHome}
                  onChange={(e) => {
                    updateEntry(entry.key, "configHome", e.target.value);
                    scheduleValidate(entry.key, e.target.value);
                  }}
                  placeholder="/Users/you/.claude"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className={styles.btn}
                  style={{ whiteSpace: "nowrap", flexShrink: 0 }}
                  onClick={() => void handleBrowse(entry.key)}
                >
                  Browse…
                </button>
              </div>
              {entry.pathChecking && (
                <p className={styles.hint} style={{ marginTop: 4 }}>
                  Checking…
                </p>
              )}
              {!entry.pathChecking &&
                entry.pathValid === true &&
                entry.configHome && (
                  <p
                    className={styles.hint}
                    style={{ color: "var(--ok)", marginTop: 4 }}
                  >
                    Path exists.
                  </p>
                )}
              {!entry.pathChecking && entry.pathValid === false && (
                <p
                  className={styles.hint}
                  style={{ color: "var(--err, #f87171)", marginTop: 4 }}
                >
                  Path not found — the directory must exist.
                </p>
              )}
              <p className={styles.hint}>
                Selects which Claude config &amp; auth the session uses
                (<code>CLAUDE_CONFIG_DIR</code>).
              </p>
            </div>
          </div>

          {/* Save error */}
          {entry.saveError && (
            <p
              style={{
                fontSize: 12,
                color: "var(--err, #f87171)",
                marginBottom: 10,
              }}
            >
              {entry.saveError}
            </p>
          )}

          {/* Models */}
          <label className={styles.fieldLabel}>
            Models — manual IDs{" "}
            <span className={styles.muted}>(★ = workspace default)</span>
          </label>
          {TIERS.map((t) => (
            <div key={t.key} className={styles.modelRow}>
              <span className={styles.modelTier}>
                <span
                  className={styles.tierDot}
                  style={{ color: t.dotColor, background: t.dotColor }}
                />
                {t.label}
              </span>
              <input
                className={`${styles.fld} ${styles.fldMono}`}
                value={entry.models[t.key] ?? ""}
                onChange={(e) =>
                  updateEntry(entry.key, "models", {
                    ...entry.models,
                    [t.key]: e.target.value,
                  })
                }
              />
              <button
                type="button"
                aria-label={`Set ${t.label} as default for account ${idx + 1}`}
                onClick={() => updateEntry(entry.key, "defaultTier", t.key)}
                className={`${styles.star} ${entry.defaultTier === t.key ? styles.starOn : ""}`}
              >
                ★
              </button>
            </div>
          ))}
          <p className={styles.hint}>
            Enter the exact IDs you want available; you maintain them as new
            models ship. The ★ tier is the workspace default for this account.
            Clear a row to leave that tier out — Fable needs 30-day data
            retention, so remove it if your account is not eligible.
          </p>
        </div>
      ))}

      {/* Add another account */}
      <button
        type="button"
        className={`${styles.btn} ${styles.btnGhost}`}
        style={{ marginBottom: 20 }}
        onClick={addEntry}
      >
        + Add another Anthropic account
      </button>

      <div className={`${styles.infoBar} ${styles.infoBarViol}`}>
        <span className={styles.infoBarIc} aria-hidden="true">
          🔑
        </span>
        <div>
          <strong>Auth is handled by the config home.</strong> The command
          center just launches{" "}
          <code
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              background: "rgba(255,255,255,.06)",
              border: "1px solid var(--line-2)",
              borderRadius: 4,
              padding: "1px 5px",
            }}
          >
            claude
          </code>{" "}
          sessions — they sign in through the selected config home (run{" "}
          <code
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              background: "rgba(255,255,255,.06)",
              border: "1px solid var(--line-2)",
              borderRadius: 4,
              padding: "1px 5px",
            }}
          >
            claude /login
          </code>{" "}
          there once). <strong>No API key is collected.</strong>
        </div>
      </div>

      <div className={styles.infoBar}>
        <span className={styles.infoBarIc} aria-hidden="true">
          ℹ
        </span>
        <div>
          More providers (OpenAI, Google, local models) arrive in a later
          release — the registry is built to drop them in without rework.
        </div>
      </div>
    </>
  );
}
