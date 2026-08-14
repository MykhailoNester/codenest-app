/**
 * The provider + model catalog an agent pane picks from, and the "last used"
 * pair a *new* pane inherits.
 *
 * Deliberately a zustand store fed by a bare `fetchSidecar` call rather than
 * `useProviders()` / `useProviderModels()` (`lib/api.ts`): those are
 * react-query hooks, and the pane tree must stay renderable with no
 * `QueryClientProvider` — `terminal-tab-persistence.test.tsx` and
 * `agent-pane-render.test.tsx` both render `<TerminalsLayout/>` bare, and after
 * the composer became the default pane kind those renders now always reach
 * `<AgentComposer/>`. Same constraint the deleted `lib/composer-feature.ts`
 * documented, solved the same way: read the data without dragging in the query
 * layer.
 *
 * The catalog is loaded once per app session, lazily, by the first agent pane
 * that mounts. A failure is not an error state: `providers` stays empty, the
 * composer renders its selectors as a single disabled "claude" entry, and the
 * session starts with no `--model` flag, i.e. exactly the CLI's own default.
 */

import { create } from "zustand";
import { fetchSidecar, type Provider, type ProviderModel } from "../lib/api";
import {
  AGENT_CATALOG_RESET_EVENT,
  AGENT_CATALOG_STORAGE_KEY,
  AGENT_SELECTION_STORAGE_KEY,
} from "../lib/agent-storage-keys";

/** One selectable provider plus the models registered against it. */
export interface CatalogProvider {
  id: number;
  name: string;
  displayName: string;
  /** `command_template` — only its first token reaches a duplex spawn. */
  command: string;
  env: Record<string, string>;
  models: ProviderModel[];
  /** The provider's own default model, or `null` when it registers none. */
  defaultModel: string | null;
  /** The provider's Settings colour (`providers.color`), or null when unset.
   *  Carried here so a surface that renders a provider swatch does not need a
   *  second `/api/v1/providers` fetch beside this store. */
  color: string | null;
}

/** The provider/model pair a pane runs (or will run) with. */
export interface AgentSelection {
  providerId: number | null;
  model: string | null;
}

const SELECTION_STORAGE_KEY = AGENT_SELECTION_STORAGE_KEY;

interface AgentCatalogStore {
  providers: CatalogProvider[];
  /**
   * True once the *sidecar* has answered — not merely "we tried".
   *
   * A failed fetch must never set this. It used to, and that single line was a
   * 401 generator: an agent pane mounting while the sidecar was still starting
   * cached "this install has no providers" for the rest of the app session, so
   * the session spawned with no `CLAUDE_CONFIG_DIR` and authenticated against
   * the default `~/.claude` config instead of the provider's. An empty list from
   * a *successful* fetch is authoritative and does set it — that install really
   * has no providers, and plain `claude` is then the right thing to spawn.
   */
  loaded: boolean;
  loading: boolean;
  /** The pair a newly created agent pane inherits — the last one the user
   *  picked, persisted so it survives a relaunch. */
  lastUsed: AgentSelection;

  /** Idempotent: concurrent callers share one in-flight fetch, and a load that
   *  already succeeded is a no-op. A previous *failure* is always retried. */
  load: () => Promise<void>;
  /**
   * Wait for a definitive answer from the sidecar, retrying while it is still
   * coming up. Resolves as soon as `loaded` is true or the attempts run out —
   * never throws, so a caller can simply proceed with whatever is known.
   */
  loadWithRetry: (attempts?: number, delayMs?: number) => Promise<void>;
  /** Records a pick as the default for future panes. */
  rememberSelection: (selection: AgentSelection) => void;
  /** Resolves the pair a pane should start with, given what it already has
   *  persisted on its leaf (both may be undefined for a fresh pane). */
  resolveSelection: (leaf: Partial<AgentSelection>) => AgentSelection;
  /** Look up one provider, or `null` when the catalog has no such row. */
  providerById: (id: number | null) => CatalogProvider | null;
}

function loadLastUsed(): AgentSelection {
  try {
    const raw = localStorage.getItem(SELECTION_STORAGE_KEY);
    if (!raw) return { providerId: null, model: null };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return { providerId: null, model: null };
    }
    const rec = parsed as Record<string, unknown>;
    return {
      providerId: typeof rec["providerId"] === "number" ? rec["providerId"] : null,
      model: typeof rec["model"] === "string" ? rec["model"] : null,
    };
  } catch {
    return { providerId: null, model: null };
  }
}

function persistLastUsed(selection: AgentSelection): void {
  try {
    localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // localStorage unavailable in some WebView contexts — the selection still
    // works for this session, it just does not survive a relaunch.
  }
}

// ---------------------------------------------------------------------------
// Catalog cache
//
// The catalog is cached in localStorage and read back synchronously at module
// load, so the very first agent pane of a cold launch can spawn with the right
// binary and env *before* the sidecar has answered — the same "cache known-good
// state so the first render is correct" pattern `FEATURE_CACHE_KEY` already uses
// for `enabled_features` (`lib/nav-items.ts`). Without it, every cold start
// races the sidecar's boot, and losing that race means a session authenticated
// against the wrong config dir.
//
// The cache is a head start, never the authority: `load()` still refreshes from
// the sidecar and overwrites it.
// ---------------------------------------------------------------------------

const CATALOG_STORAGE_KEY = AGENT_CATALOG_STORAGE_KEY;

/** Defensive parse — a hand-edited or truncated blob must degrade to "no
 *  cache", never crash the pane tree that reads this at import time. */
function readCachedProviders(): CatalogProvider[] {
  try {
    const raw = localStorage.getItem(CATALOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: CatalogProvider[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      const id = rec["id"];
      const command = rec["command"];
      if (typeof id !== "number" || typeof command !== "string") continue;
      const env = rec["env"];
      const models = rec["models"];
      out.push({
        id,
        name: typeof rec["name"] === "string" ? rec["name"] : String(id),
        displayName:
          typeof rec["displayName"] === "string" ? rec["displayName"] : String(id),
        command,
        env:
          typeof env === "object" && env !== null && !Array.isArray(env)
            ? Object.fromEntries(
                Object.entries(env as Record<string, unknown>)
                  .filter(([, v]) => typeof v === "string")
                  .map(([k, v]) => [k, v as string]),
              )
            : {},
        models: Array.isArray(models) ? (models as CatalogProvider["models"]) : [],
        defaultModel:
          typeof rec["defaultModel"] === "string" ? rec["defaultModel"] : null,
        color: typeof rec["color"] === "string" ? rec["color"] : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function persistProviders(providers: CatalogProvider[]): void {
  try {
    localStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify(providers));
  } catch {
    // Same as above — a cache miss only costs the next cold start a wait.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shared by concurrent `load()` callers so two panes mounting together make
 *  one request, not two. */
let inflight: Promise<void> | null = null;

/**
 * `is_default` first, then the provider's own `default_model` column, then
 * nothing. Answers "which model does this provider start on?" — the user chose
 * this resolution order over hardcoding a model name so Settings → Providers
 * stays the single source of truth for it.
 */
function resolveProviderDefaultModel(
  provider: Provider,
  models: ProviderModel[],
): string | null {
  const starred = models.find((m) => m.is_default && m.is_enabled);
  if (starred) return starred.model_name;
  const fromColumn = provider.default_model?.trim();
  if (fromColumn) return fromColumn;
  return null;
}

export const useAgentCatalogStore = create<AgentCatalogStore>((set, get) => ({
  // Seeded from the cache, so a cold launch already knows the provider before
  // the sidecar is up. `loaded` stays false: cached is not authoritative.
  providers: typeof window === "undefined" ? [] : readCachedProviders(),
  loaded: false,
  loading: false,
  lastUsed: typeof window === "undefined" ? { providerId: null, model: null } : loadLastUsed(),

  load: async () => {
    if (get().loaded) return;
    if (inflight) return inflight;

    const run = async (): Promise<void> => {
      set({ loading: true });
      try {
        const providers = await fetchSidecar<Provider[]>("/api/v1/providers");
        const withModels = await Promise.all(
          providers
            .filter((p) => p.is_enabled)
            .map(async (p) => {
              // A provider with no `provider_models` rows is normal (the model
              // dropdown then offers only the CLI default) — a failed lookup
              // must not lose the provider itself, so it degrades to no models.
              const models = await fetchSidecar<ProviderModel[]>(
                `/api/v1/providers/${p.id}/models`,
              ).catch(() => [] as ProviderModel[]);
              const enabled = models.filter((m) => m.is_enabled);
              return {
                id: p.id,
                name: p.name,
                displayName: p.display_name,
                command: p.command_template,
                env: p.default_env,
                models: enabled,
                defaultModel: resolveProviderDefaultModel(p, enabled),
                color: p.color,
              } satisfies CatalogProvider;
            }),
        );
        // Authoritative — including an empty list, which really does mean "no
        // providers configured" and should stop the retry loop.
        set({ providers: withModels, loaded: true, loading: false });
        persistProviders(withModels);
      } catch {
        // Could not ask (sidecar still starting, or no HTTP at all as in
        // jsdom). Deliberately leaves `loaded` false so the next caller
        // retries, and leaves any cached providers in place — dropping them
        // here would throw away the only correct answer we have.
        set({ loading: false });
      }
    };

    inflight = run().finally(() => {
      inflight = null;
    });
    return inflight;
  },

  loadWithRetry: async (attempts = 10, delayMs = 400) => {
    for (let i = 0; i < attempts; i += 1) {
      await get().load();
      if (get().loaded) return;
      if (i < attempts - 1) await sleep(delayMs);
    }
  },

  rememberSelection: (selection) => {
    set({ lastUsed: selection });
    persistLastUsed(selection);
  },

  resolveSelection: (leaf) => {
    const { providers, lastUsed } = get();
    // A pane's own persisted pick wins; then the last pair the user chose;
    // then the first enabled provider.
    const isAvailable = (id: number | null | undefined): boolean =>
      id != null && providers.some((p) => p.id === id);
    const lastUsedIsAvailable = isAvailable(lastUsed.providerId);
    // A leaf's persisted provider is only honoured while that provider is still
    // registered and enabled. Honouring a stale id would resolve to no catalog
    // row at all, so the session would start with no command and no env — i.e.
    // against the default `~/.claude` config, which is the 401 this whole path
    // exists to avoid. Falling back to a real provider is the safe reading of
    // "the provider this pane wanted is gone".
    const providerId =
      (isAvailable(leaf.providerId) ? leaf.providerId : null) ??
      (lastUsedIsAvailable ? lastUsed.providerId : null) ??
      providers[0]?.id ??
      null;
    const provider = providers.find((p) => p.id === providerId) ?? null;

    // A model is only carried over if the resolved provider actually offers
    // it — switching provider (or falling back to another one because the
    // last-used provider was deleted or disabled in Settings) must never
    // smuggle a foreign model name into `--model`.
    const offers = (model: string | null): boolean =>
      model !== null && (provider?.models.some((m) => m.model_name === model) ?? false);

    // The last-used *model* is only inherited together with the last-used
    // *provider*. If we fell back to a different provider, its own default
    // wins, even in the case where both providers happen to register a model of
    // the same name — "same name" is not "same account or same entitlement".
    const inheritsLastUsedModel =
      leaf.model == null && lastUsedIsAvailable && providerId === lastUsed.providerId;

    const model = offers(leaf.model ?? null)
      ? (leaf.model ?? null)
      : inheritsLastUsedModel && offers(lastUsed.model)
        ? lastUsed.model
        : (provider?.defaultModel ?? null);

    return { providerId, model };
  },

  providerById: (id) => {
    if (id === null) return null;
    return get().providers.find((p) => p.id === id) ?? null;
  },
}));

export { AGENT_CATALOG_STORAGE_KEY, AGENT_SELECTION_STORAGE_KEY };

// A factory reset deletes the providers this catalog describes. Clearing
// localStorage is not enough on its own: the reset navigates to onboarding
// without reloading the webview, so the in-memory copy — `loaded: true`, which
// makes `load()` a no-op — would outlive the rows it came from and the next
// agent pane would spawn against the deleted provider. Dropping both here puts
// the store back in its cold-start state so the first pane after re-onboarding
// re-fetches. Module scope, guarded for jsdom/SSR, matching how
// `terminal-store.ts` registers its own global listener.
if (typeof window !== "undefined") {
  window.addEventListener(AGENT_CATALOG_RESET_EVENT, () => {
    useAgentCatalogStore.setState({
      providers: [],
      loaded: false,
      loading: false,
      lastUsed: { providerId: null, model: null },
    });
  });
}
