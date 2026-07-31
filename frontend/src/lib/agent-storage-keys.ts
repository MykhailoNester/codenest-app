/**
 * localStorage keys and the reset signal for the agent provider/model catalog.
 *
 * A leaf module with **no imports**, on purpose. `stores/agent-catalog-store.ts`
 * owns the data and imports `fetchSidecar` from `lib/api.ts`; `lib/api.ts` needs
 * to clear that data on factory reset. Importing the store from `api.ts` would
 * close that loop into an import cycle (see `lib/__tests__/module-load-order.test.ts`),
 * so both sides depend on this instead, and the store→api direction stays the
 * only edge between them.
 */

/** Cached provider catalog — see `stores/agent-catalog-store.ts`. */
export const AGENT_CATALOG_STORAGE_KEY = "codenest.agent.catalog";

/** Last provider/model pair the user picked, inherited by new agent panes. */
export const AGENT_SELECTION_STORAGE_KEY = "codenest.agent.selection";

/**
 * Dispatched on `window` when the catalog's backing data is gone and every
 * cached copy must be dropped — today only a factory reset does this.
 *
 * The event exists because clearing localStorage is not sufficient: the store
 * also holds the catalog in memory with `loaded: true`, and a factory reset
 * navigates to onboarding *without* reloading the webview, so that in-memory
 * copy would otherwise outlive the database it describes. A pane opened after
 * re-onboarding would then spawn against the pre-reset provider — wrong binary,
 * wrong `CLAUDE_CONFIG_DIR`, and a model dropdown listing models that no longer
 * exist.
 */
export const AGENT_CATALOG_RESET_EVENT = "codenest:agent-catalog-reset";
