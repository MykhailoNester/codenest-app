// File-type icon mapping for the workspace navigator tree — a direct port
// of the prototype's `.ic.*` classes
// (warp-class-input-composer-prototype.html CSS lines 122-123):
//   .ic.dir → --info   .ic.py → --ok   .ic.ts → --t12
//   .ic.md  → --fg-3   .ic.rs → --warn .ic.sql → --violet
// `--t12` is the terminal palette's bright blue (`styles/tokens.css:98`,
// `--term-ansi-12`); the CSS module aliases it rather than adding a token.

export type IconTone = "dir" | "py" | "ts" | "md" | "rs" | "sql" | "plain";

export interface FileIcon {
  glyph: string;
  tone: IconTone;
}

const EXTENSION_TONE: Readonly<Record<string, IconTone>> = {
  py: "py",
  ts: "ts",
  tsx: "ts",
  js: "ts",
  jsx: "ts",
  md: "md",
  rs: "rs",
  sql: "sql",
};

const GLYPH_FOR_TONE: Readonly<Record<IconTone, string>> = {
  dir: "▸",
  py: "◈",
  ts: "◇",
  md: "▤",
  rs: "◈",
  sql: "◈",
  plain: "▪",
};

/** Rendered in place of the type glyph for a symlink — following it would
 *  mean re-implementing listing (`fs_list_dir` never resolves the link
 *  target's type, `fs_nav.rs:102-107`), so the row states what it is rather
 *  than guessing. */
const SYMLINK_GLYPH = "⇢";

function extensionOf(name: string): string | null {
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return null;
  return name.slice(idx + 1).toLowerCase();
}

export function iconForEntry(
  name: string,
  isDir: boolean,
  isSymlink: boolean,
): FileIcon {
  if (isSymlink) return { glyph: SYMLINK_GLYPH, tone: "plain" };
  if (isDir) return { glyph: GLYPH_FOR_TONE.dir, tone: "dir" };
  const ext = extensionOf(name);
  const tone: IconTone = (ext && EXTENSION_TONE[ext]) || "plain";
  return { glyph: GLYPH_FOR_TONE[tone], tone };
}

/**
 * Resolve the `.ic.*` CSS-module class for `tone`. Shared by
 * `<ExplorerTree>` and `<ExplorerFind>` — both were carrying byte-identical
 * copies of this switch before it moved here. Takes the caller's own CSS
 * module object (all three explorer components import the same
 * `workspace-navigator.module.css`) rather than importing one here, so this
 * stays a pure module with no CSS-module/React dependency of its own.
 */
export function iconClassFor(
  tone: IconTone,
  classes: { readonly [key: string]: string },
): string {
  switch (tone) {
    case "dir":
      return classes.icDir ?? "";
    case "py":
      return classes.icPy ?? "";
    case "ts":
      return classes.icTs ?? "";
    case "md":
      return classes.icMd ?? "";
    case "rs":
      return classes.icRs ?? "";
    case "sql":
      return classes.icSql ?? "";
    default:
      return classes.icPlain ?? "";
  }
}
