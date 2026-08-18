/**
 * Mount point for the workspace catalog change feed (#48).
 *
 * A null component for the same reason `<ToastHost/>` is one: the subscription
 * is app-wide and has no UI, but it needs a `QueryClient` to invalidate against,
 * so it has to be mounted *inside* the provider rather than called from the
 * component that installs it. Rendered once per webview root in `App.tsx`,
 * which is also what keeps `<TerminalWindowRoot/>` renderable on its own.
 */

import { useCatalogChangeFeed } from "../hooks/use-catalog-feed";

export function CatalogFeedHost(): null {
  useCatalogChangeFeed();
  return null;
}
