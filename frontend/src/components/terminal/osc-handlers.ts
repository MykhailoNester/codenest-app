/**
 * Pure OSC handler functions extracted from terminal-pane.tsx for testability.
 * These have no React dependencies and no side effects.
 */

/** Decode an OSC 7 `file://host/path` payload into the path component. */
export function decodeOsc7(payload: string): string | null {
  try {
    // Strip the scheme + host; path is percent-encoded.
    const withoutScheme = payload.replace(/^file:\/\/[^/]*/, "");
    if (!withoutScheme.startsWith("/")) return null;
    return decodeURIComponent(withoutScheme);
  } catch {
    return null;
  }
}

/** Return the OSC 0/2 title, or null if the payload is empty. */
export function decodeOscTitle(payload: string): string | null {
  const trimmed = payload.trim();
  return trimmed.length > 0 ? trimmed : null;
}
