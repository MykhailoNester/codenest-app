import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAgentCatalogStore } from "../agent-catalog-store";
import type { AgentSelection, CatalogProvider } from "../agent-catalog-store";

// `resolveSelection` is the whole of the "which provider/model does this pane
// start with?" policy, so it is worth pinning on its own: a pane's persisted
// pick wins, then the last pair the user chose, then the provider's registered
// default. The last rule is the one the user asked for explicitly — Settings →
// Providers stays the source of truth for the default model, rather than a model
// name hardcoded in the UI.

function provider(over: Partial<CatalogProvider> = {}): CatalogProvider {
  return {
    id: 1,
    name: "claude-work",
    displayName: "claude-work",
    command: "claude-work {session_id}",
    env: { CLAUDE_CONFIG_DIR: "/Users/test/.claude-work" },
    models: [
      {
        id: 4,
        provider_id: 1,
        model_name: "claude-opus-5",
        display_name: "Opus",
        is_default: true,
        is_enabled: true,
      },
      {
        id: 5,
        provider_id: 1,
        model_name: "claude-sonnet-5",
        display_name: "Sonnet",
        is_default: false,
        is_enabled: true,
      },
    ],
    defaultModel: "claude-opus-5",
    color: "#d97757",
    ...over,
  };
}

function seed(
  providers: CatalogProvider[],
  lastUsed: AgentSelection = { providerId: null, model: null },
): void {
  useAgentCatalogStore.setState({
    providers,
    loaded: true,
    loading: false,
    lastUsed,
  });
}

/** Map-backed localStorage, so the catalog cache can actually be read back. */
function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  } as Storage);
  return store;
}

beforeEach(() => {
  installLocalStorage();
  seed([]);
  useAgentCatalogStore.setState({ loaded: false, loading: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("agent-catalog-store.resolveSelection", () => {
  it("falls back to the provider's registered default model", () => {
    seed([provider()]);
    expect(
      useAgentCatalogStore.getState().resolveSelection({}),
    ).toEqual({ providerId: 1, model: "claude-opus-5" });
  });

  it("prefers the pane's own persisted pick over the default", () => {
    seed([provider()]);
    expect(
      useAgentCatalogStore
        .getState()
        .resolveSelection({ providerId: 1, model: "claude-sonnet-5" }),
    ).toEqual({ providerId: 1, model: "claude-sonnet-5" });
  });

  it("inherits the last-used pair for a pane that has no pick of its own", () => {
    seed([provider()], { providerId: 1, model: "claude-sonnet-5" });
    expect(
      useAgentCatalogStore.getState().resolveSelection({}),
    ).toEqual({ providerId: 1, model: "claude-sonnet-5" });
  });

  it("never carries a model the resolved provider does not offer", () => {
    // A model registered against another provider must not be smuggled into
    // `--model`: the CLI would reject it, or worse, silently bill a different
    // account's model name.
    seed([provider()]);
    expect(
      useAgentCatalogStore
        .getState()
        .resolveSelection({ providerId: 1, model: "gpt-nonsense" }),
    ).toEqual({ providerId: 1, model: "claude-opus-5" });
  });

  it("ignores a last-used provider that is no longer in the catalog", () => {
    // The provider was deleted or disabled in Settings since the last launch.
    seed([provider({ id: 7 })], { providerId: 99, model: "claude-sonnet-5" });
    expect(
      useAgentCatalogStore.getState().resolveSelection({}),
    ).toEqual({ providerId: 7, model: "claude-opus-5" });
  });

  it("falls back to a real provider when the pane's own one was deleted", () => {
    // Honouring the stale id would resolve to no catalog row, so the session
    // would start with no command and no env — back to the default `~/.claude`
    // config and its 401.
    seed([provider({ id: 7, defaultModel: "claude-opus-5" })]);
    expect(
      useAgentCatalogStore
        .getState()
        .resolveSelection({ providerId: 99, model: "claude-sonnet-5" }),
    ).toEqual({ providerId: 7, model: "claude-sonnet-5" });
  });

  it("resolves to no provider and no model when the catalog is empty", () => {
    // The sidecar is unreachable or nothing is registered — the pane must still
    // start, with the CLI's own defaults and no `--model` flag.
    expect(
      useAgentCatalogStore.getState().resolveSelection({}),
    ).toEqual({ providerId: null, model: null });
  });

  it("uses the default_model column when no model row is starred", () => {
    seed([
      provider({
        models: [
          {
            id: 5,
            provider_id: 1,
            model_name: "claude-sonnet-5",
            display_name: "Sonnet",
            is_default: false,
            is_enabled: true,
          },
        ],
        defaultModel: "claude-sonnet-5",
      }),
    ]);
    expect(useAgentCatalogStore.getState().resolveSelection({}).model).toBe(
      "claude-sonnet-5",
    );
  });
});

// ---------------------------------------------------------------------------
// load() — the 401 generator this suite exists to prevent
// ---------------------------------------------------------------------------

describe("agent-catalog-store.load", () => {
  /** Minimal `/api/v1/providers` + `/models` responses. */
  function mockFetchOk(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.includes("/models")
          ? [
              {
                id: 4,
                provider_id: 1,
                model_name: "claude-opus-5",
                display_name: "Opus",
                is_default: true,
                is_enabled: true,
              },
            ]
          : [
              {
                id: 1,
                name: "claude-work",
                display_name: "Anthropic (claude-work)",
                command_template: "claude-work {session_id}",
                default_args: "",
                is_enabled: true,
                color: null,
                default_env: { CLAUDE_CONFIG_DIR: "/Users/test/.claude-work" },
                models: ["default"],
                default_model: null,
                has_api_key: false,
                base_url: null,
              },
            ];
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  }

  it("a failed fetch is not authoritative — the next call retries", async () => {
    // The regression: an agent pane mounting while the sidecar is still coming
    // up used to cache "no providers" for the whole app session, so its session
    // spawned with no CLAUDE_CONFIG_DIR and every turn returned 401.
    const failing = vi.fn(async () => {
      throw new Error("connection refused");
    });
    vi.stubGlobal("fetch", failing);

    await useAgentCatalogStore.getState().load();
    expect(useAgentCatalogStore.getState().loaded).toBe(false);

    mockFetchOk();
    await useAgentCatalogStore.getState().load();

    const { loaded, providers } = useAgentCatalogStore.getState();
    expect(loaded).toBe(true);
    expect(providers[0]?.env).toEqual({
      CLAUDE_CONFIG_DIR: "/Users/test/.claude-work",
    });
  });

  it("an empty list from a successful fetch IS authoritative", async () => {
    // "This install has no providers" is a real answer: plain `claude` is then
    // the right thing to spawn, and the retry loop must stop.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await useAgentCatalogStore.getState().loadWithRetry(3, 0);
    expect(useAgentCatalogStore.getState().loaded).toBe(true);
    expect(useAgentCatalogStore.getState().providers).toEqual([]);
  });

  it("a failed fetch keeps cached providers rather than dropping them", async () => {
    seed([provider()]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );

    await useAgentCatalogStore.getState().load();
    // Dropping these would discard the only correct answer available on a cold
    // start, which is exactly what the cache exists to provide.
    expect(useAgentCatalogStore.getState().providers).toHaveLength(1);
  });

  it("persists the catalog so the next cold start can spawn before the sidecar answers", async () => {
    mockFetchOk();
    await useAgentCatalogStore.getState().load();

    const cached = localStorage.getItem("codenest.agent.catalog");
    expect(cached).not.toBeNull();
    const parsed = JSON.parse(cached!) as CatalogProvider[];
    expect(parsed[0]?.command).toBe("claude-work {session_id}");
    expect(parsed[0]?.env).toEqual({
      CLAUDE_CONFIG_DIR: "/Users/test/.claude-work",
    });
    expect(parsed[0]?.defaultModel).toBe("claude-opus-5");
  });

  it("concurrent callers share one request", async () => {
    mockFetchOk();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await Promise.all([
      useAgentCatalogStore.getState().load(),
      useAgentCatalogStore.getState().load(),
      useAgentCatalogStore.getState().load(),
    ]);

    // One providers call plus one models call for the single provider.
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("carries the provider's colour into the catalog row", async () => {
    // Its own fetch stub, not `mockFetchOk` — that one deliberately returns
    // `color: null` and is left alone (D12).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.includes("/models")
          ? []
          : [
              {
                id: 1,
                name: "claude-work",
                display_name: "Anthropic (claude-work)",
                command_template: "claude-work {session_id}",
                default_args: "",
                is_enabled: true,
                color: "#d97757",
                default_env: {},
                models: ["default"],
                default_model: null,
                has_api_key: false,
                base_url: null,
              },
            ];
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    await useAgentCatalogStore.getState().load();
    expect(useAgentCatalogStore.getState().providers[0]?.color).toBe("#d97757");
  });
});

// ---------------------------------------------------------------------------
// readCachedProviders() — the upgrade path for a cache written before `color`
// existed on the row (D12)
// ---------------------------------------------------------------------------

describe("agent-catalog-store readCachedProviders", () => {
  it("a cache written before the colour existed still parses, with color: null", async () => {
    // `readCachedProviders()` runs at module scope (`providers:` seeds from it
    // on import), so re-running it requires a fresh module instance — the
    // `composer-store.test.ts:340-341` / `session-hud-store.test.ts:40,61`
    // idiom.
    localStorage.setItem(
      "codenest.agent.catalog",
      JSON.stringify([
        {
          id: 1,
          name: "claude-work",
          displayName: "claude-work",
          command: "claude-work {session_id}",
          env: {},
          models: [],
          defaultModel: null,
          // no `color` key — an older build's cache blob.
        },
      ]),
    );
    vi.resetModules();
    const fresh = await import("../agent-catalog-store");
    expect(fresh.useAgentCatalogStore.getState().providers[0]?.color).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Factory reset
// ---------------------------------------------------------------------------

describe("agent-catalog-store reset signal", () => {
  it("drops the in-memory catalog so the next pane re-fetches", async () => {
    // A factory reset deletes the providers this catalog describes, and it
    // navigates to onboarding *without* reloading the webview — so an
    // in-memory catalog left at `loaded: true` would make `load()` a no-op and
    // the first pane after re-onboarding would spawn against the deleted
    // provider's binary and CLAUDE_CONFIG_DIR.
    seed([provider()], { providerId: 1, model: "claude-opus-5" });
    expect(useAgentCatalogStore.getState().loaded).toBe(true);

    const { AGENT_CATALOG_RESET_EVENT } = await import(
      "../../lib/agent-storage-keys"
    );
    window.dispatchEvent(new Event(AGENT_CATALOG_RESET_EVENT));

    const after = useAgentCatalogStore.getState();
    expect(after.providers).toEqual([]);
    expect(after.loaded).toBe(false);
    expect(after.lastUsed).toEqual({ providerId: null, model: null });
  });
});
