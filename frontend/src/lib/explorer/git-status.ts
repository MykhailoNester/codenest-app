// Shared between `<ExplorerTree>` (the `.gs` letter on a file row) and
// `<ChangedList>` (the same letter in Changed mode) — one mapping so the
// two views never disagree about which colour a status letter gets.

import type { GitFileStatus, GitRootStatus } from "../ipc";

/** The four tones the prototype actually styles (CSS line 126:
 *  `.gs.m/.a/.d/.u`). `status` values come from `git.rs`'s
 *  `status_letter` (the porcelain XY columns collapsed to one letter) plus
 *  the fixed `"?"` (untracked) and `"U"` (unmerged) records. */
export type GitStatusTone = "m" | "a" | "d" | "u";

export function gitStatusTone(status: string): GitStatusTone {
  switch (status) {
    case "A":
    case "C": // copied — treated as an addition
      return "a";
    case "D":
      return "d";
    case "?":
    case "U":
      return "u";
    case "M":
    case "R": // renamed — content moved, closest to "modified"
    case "T": // type change (e.g. file <-> symlink)
    default:
      return "m";
  }
}

/**
 * Find the `GitFileStatus` for an absolute `path` within `git`, joining on
 * `repoRoot + "/" + file.path` — `GitFileStatus.path` is repo-relative, NOT
 * relative to the requested root (`git.rs:258-259`). Returns `undefined`
 * for a non-repo root, a root whose status hasn't resolved yet, or a path
 * that git doesn't consider changed.
 */
export function findFileStatus(
  git: GitRootStatus | undefined,
  path: string,
): GitFileStatus | undefined {
  if (!git?.repoRoot) return undefined;
  const prefix = `${git.repoRoot}/`;
  if (!path.startsWith(prefix)) return undefined;
  const relative = path.slice(prefix.length);
  return git.files.find((f) => f.path === relative);
}

/**
 * Resolve the `.gs.*` CSS-module class for a status letter. Shared by
 * `<ExplorerTree>` and `<ChangedList>` — both were carrying byte-identical
 * copies of this switch before it moved here. Takes the caller's own CSS
 * module object rather than importing one here, so this stays a pure
 * module with no CSS-module/React dependency of its own.
 */
export function gsClassFor(
  status: string,
  classes: { readonly [key: string]: string },
): string {
  switch (gitStatusTone(status)) {
    case "a":
      return classes.gsA ?? "";
    case "d":
      return classes.gsD ?? "";
    case "u":
      return classes.gsU ?? "";
    default:
      return classes.gsM ?? "";
  }
}
