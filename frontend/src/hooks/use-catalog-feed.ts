/**
 * App-wide subscription to the workspace catalog change stream (#48).
 *
 * The sidecar publishes `workspace.catalog.changed` at the end of every
 * `regenerate_workspace_links` — the single funnel behind an import, a rescan
 * (including the ones the shell's `.claude/` watcher fires), a promote, an
 * enable/disable and a project delete. This hook turns that event into
 * react-query invalidations, which is what makes an *already open* composer
 * picker re-render with the new rows: `useInvocables` is a live query, so
 * dropping it refetches in place without touching the caret or the typed query.
 *
 * Mounted once per webview (`AppInner` and `TerminalWindowRoot`, which are
 * separate documents with separate query caches). Cheap to mount twice in the
 * same document if it ever happens: `sseRegistry` ref-counts by stream key, so
 * N subscribers share one `EventSource`.
 *
 * Deliberately keyed by prefix rather than by exact key. A regeneration can
 * change any scope of the cwd-scoped catalog and every surface built from the
 * same rows (the Command Center's agent list, per-project asset lists,
 * workspace health), and react-query only refetches the queries that are
 * actually mounted — so the broad invalidation costs nothing for the surfaces
 * nobody is looking at.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  sseRegistry,
  WORKSPACE_SSE_EVENT_NAMES,
} from "../lib/sse-registry";

export function useCatalogChangeFeed(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    return sseRegistry.subscribe("workspace", WORKSPACE_SSE_EVENT_NAMES, () => {
      void queryClient.invalidateQueries({ queryKey: ["command-center"] });
      void queryClient.invalidateQueries({ queryKey: ["workspace"] });
    });
  }, [queryClient]);
}
