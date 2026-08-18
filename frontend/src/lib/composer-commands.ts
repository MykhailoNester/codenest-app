/**
 * The slash-command registry — the three built-ins (`/clear`, `/compact`,
 * `/help`) plus whatever commands the pane's `.claude/commands/` actually ships.
 * A mirror of the CLI TUI's own command menu (Design decision 1), kept as a
 * single data array rather than a dispatch switch (Design decision 2):
 * `allCommands` is the one source for the menu, argument completion, `/help`
 * content, the "is this a command" check, and execution. Adding a built-in is
 * appending one object literal to `SLASH_COMMANDS` — no other file changes.
 *
 * A *discovered* command is not written here at all: it arrives as a
 * `CommandSource` on `CommandData` (from the sidecar's invocables catalog, via
 * `MentionSourceProbe`) and is turned into an ordinary `SlashCommand` by
 * `projectCommand`, so every consumer keeps reading one flat array (#47). Before
 * that, typing `/ship` in a repo that ships `.claude/commands/ship.md` drew
 * "`/ship` is not a Codenest command" — the forward to the CLI was right, the
 * warning was wrong. What such a command *does* is deliberately not modelled:
 * Codenest routes the line verbatim and the CLI owns the semantics.
 *
 * `/model` and `/mode` deliberately do not live here. Both duplicated the
 * MODEL and MODE dropdowns that sit in the composer header, and `/mode` could
 * not even express a choice — bare, it cycled to the next entry in the list.
 * A dropdown that shows the current value and every alternative is strictly
 * better than a command that advances blindly, so the commands were removed
 * rather than kept as a second, worse way in. The argument-completion
 * machinery below (`complete`, `SlashRow`'s `"arg"` variant) is retained for
 * future commands even though no registered command uses it today.
 *
 * Imports `parseCommandLine` (and its `CommandLine` type) from
 * `./prompt-intent`, and nothing else. No store imports, no `ipc.ts` import —
 * everything a command *does* reaches the outside through caller-supplied
 * effects (`SlashCommandEffects`), which is what makes this whole file
 * unit-testable with plain objects.
 */

import { parseCommandLine } from "./prompt-intent";

export interface CommandOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * One command discovered in the pane's `.claude/` — the composer's projection of
 * a catalog row (`InvocableItem`, `lib/api.ts`). Deliberately not that type:
 * this module is pure and must not reach into the query layer, and a menu needs
 * only what to show, what to send, and what to match. The same split
 * `InvocableSource` makes for the `@`-menu, with the arg hint a command adds.
 */
export interface CommandSource {
  /** The stem the CLI resolves — `<project-slug>--<name>` when two projects
   *  contest one name, which is why matching is not prefix-only below. */
  name: string;
  /** Row label from the catalog: `project:name`. */
  label: string;
  /** Exactly what a bare invocation sends (`/name`), straight from the catalog. */
  insertText: string;
  /** Owning project, or null for an app-owned command. */
  projectName: string | null;
  description: string | null;
  /** The file's frontmatter `argument-hint:`, or null when it declares none. */
  argHint: string | null;
}

/** Everything the menu needs. Pure data, so the component can memoize it and
 *  arrow-key navigation survives a re-render. */
export interface CommandData {
  /** Whether a session is running for this pane. */
  live: boolean;
  /** Commands a session in this pane's cwd can invoke, in catalog order.
   *  Empty while the catalog is loading, or when nothing is discovered. */
  commands: readonly CommandSource[];
}

/** Everything a command may *do*. Built fresh at execution time. */
export interface SlashCommandEffects {
  /** Empty this pane's context — transcript, pills, and the CLI's own history
   *  — *without* ending the session. Rejects if the forward to the CLI fails. */
  clearContext: () => Promise<void>;
  sendRaw: (text: string) => Promise<void>;
  showHelp: () => void;
}

export type SlashCommandContext = CommandData & SlashCommandEffects;

export type CommandOutcome =
  | { kind: "ok"; note: string }
  | { kind: "error"; note: string };

export interface SlashCommand {
  name: string;
  summary: string;
  argHint: string | null;
  /** True when picking the bare command from the menu executes it. */
  runsBare: boolean;
  /** Argument suggestions for the text left of the caret. Reads data only. */
  complete: ((argQuery: string, data: CommandData) => CommandOption[]) | null;
  run: (arg: string, ctx: SlashCommandContext) => Promise<CommandOutcome>;
  /** Which registry it came from — this file, or a project's own
   *  `.claude/commands/`. What the menu groups on. */
  origin: "builtin" | "project";
  /** Discovered commands only: the catalog row behind it. */
  source?: CommandSource;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `/clear` empties the context and keeps the session — the CLI's own
 * behaviour, and what the pane needs in order to stay usable.
 *
 * It used to restart instead: report the run as exited, drop the pane's
 * session state, then ask for a respawn. That was wrong twice over. The exit
 * report made the sidecar announce "Session … finished successfully" and put
 * the pane into its `Session ended (exit 0)` state behind a Restart button,
 * for a process that was still very much alive; and the respawn raced that
 * still-live process, so `agent_start` refused with "agent session already
 * running" and left the pane wedged with no way back.
 */
async function runClearCommand(
  _arg: string,
  ctx: SlashCommandContext,
): Promise<CommandOutcome> {
  try {
    await ctx.clearContext();
  } catch (err) {
    return { kind: "error", note: `clear failed: ${describeError(err)}` };
  }
  return {
    kind: "ok",
    note: ctx.live
      ? "context cleared — same session, keep going"
      : "transcript cleared — the session had already ended",
  };
}

async function runCompactCommand(
  arg: string,
  ctx: SlashCommandContext,
): Promise<CommandOutcome> {
  if (!ctx.live) {
    return { kind: "error", note: "session ended — Restart before /compact" };
  }
  const line = arg.length > 0 ? `/compact ${arg}` : "/compact";
  try {
    await ctx.sendRaw(line);
  } catch (err) {
    return { kind: "error", note: `compact failed: ${describeError(err)}` };
  }
  return {
    kind: "ok",
    note: "/compact sent to claude as a command line (context pills not included)",
  };
}

async function runHelpCommand(
  _arg: string,
  ctx: SlashCommandContext,
): Promise<CommandOutcome> {
  try {
    ctx.showHelp();
  } catch (err) {
    return { kind: "error", note: `help failed: ${describeError(err)}` };
  }
  // The built-ins are named; discovered commands are counted. Naming all of
  // them would put a workspace's whole `.claude/commands/` into a one-line note,
  // and the panel this command just opened lists every one of them anyway.
  const discovered = projectCommands(ctx.commands).length;
  const builtins = SLASH_COMMANDS.map((c) => "/" + c.name).join(" ");
  return {
    kind: "ok",
    note:
      discovered === 0
        ? `commands: ${builtins}`
        : `commands: ${builtins} · ${discovered} project command${discovered === 1 ? "" : "s"}`,
  };
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "clear",
    summary: "Clear the context and keep working in this session.",
    argHint: null,
    runsBare: true,
    complete: null,
    run: runClearCommand,
    origin: "builtin",
  },
  {
    name: "compact",
    summary: "Ask claude to compact the conversation (sent as text).",
    argHint: "[instructions]",
    runsBare: true,
    complete: null,
    run: runCompactCommand,
    origin: "builtin",
  },
  {
    name: "help",
    summary: "List the available commands.",
    argHint: null,
    runsBare: true,
    complete: null,
    run: runHelpCommand,
    origin: "builtin",
  },
];

// ---------------------------------------------------------------------------
// Discovered commands — a project's own `.claude/commands/`
// ---------------------------------------------------------------------------

/** One line, `\n` escapes and runs of whitespace collapsed. A frontmatter
 *  `description:` is a whole sentence or three; a row is one line. */
function oneLine(text: string): string {
  return text.replace(/\\n|\s+/g, " ").trim();
}

/** What a discovered command's row says about itself. Falls back to the owning
 *  project — the next most useful thing to say about a file with no
 *  `description:` — so a summary is never empty. */
function commandSummary(source: CommandSource): string {
  const flat = oneLine(source.description ?? "");
  if (flat.length > 0) return flat;
  return source.projectName !== null
    ? `command from ${source.projectName}`
    : "project command";
}

/**
 * The one argument row a discovered command can offer: the text typed so far,
 * labelled with its frontmatter hint.
 *
 * There is nothing to enumerate — Codenest has never read a command's body and
 * the CLI owns its semantics — so this confirms the hint and hands Enter a
 * verbatim forward rather than pretending to know the valid values. Empty until
 * something is typed: a row that runs `/ship` for a draft reading `/ship ` is
 * the bare command with extra steps.
 */
function argCompletion(source: CommandSource, argQuery: string): CommandOption[] {
  if (argQuery.trim().length === 0) return [];
  return [{ value: argQuery, label: source.argHint ?? "sent verbatim" }];
}

/**
 * Forwards the whole line to the CLI and reports what it did. Nothing else:
 * "the CLI owns the semantics, Codenest only routes" is the entire contract of a
 * discovered command.
 *
 * The line is built from the catalog's own `invoke_token`, never from the name —
 * only the sidecar knows what the CLI resolves for each kind (#44), and for a
 * command contested by two projects that token carries a project slug the
 * display name has no trace of.
 */
async function runProjectCommand(
  source: CommandSource,
  arg: string,
  ctx: SlashCommandContext,
): Promise<CommandOutcome> {
  if (!ctx.live) {
    return {
      kind: "error",
      note: `session ended — Restart before ${source.insertText}`,
    };
  }
  const line = arg.length > 0 ? `${source.insertText} ${arg}` : source.insertText;
  try {
    await ctx.sendRaw(line);
  } catch (err) {
    return {
      kind: "error",
      note: `${source.insertText} failed: ${describeError(err)}`,
    };
  }
  return {
    kind: "ok",
    note: `${source.insertText} sent to claude as a command line (context pills not included)`,
  };
}

/** A catalog row as an ordinary `SlashCommand`, so every consumer below reads
 *  one flat array whether a command was written here or found on disk. */
export function projectCommand(source: CommandSource): SlashCommand {
  return {
    name: source.name,
    summary: commandSummary(source),
    argHint: source.argHint,
    // A command declaring an `argument-hint` expects an argument, so picking it
    // from the menu completes to `/name ` and leaves the caret there rather than
    // firing it bare — the CLI's own behaviour. One declaring none has nothing
    // to wait for and runs on pick, like every built-in.
    runsBare: source.argHint === null,
    complete:
      source.argHint === null
        ? null
        : (argQuery) => argCompletion(source, argQuery),
    run: (arg, ctx) => runProjectCommand(source, arg, ctx),
    origin: "project",
    source,
  };
}

/**
 * The discovered half of the registry, with anything a built-in already answers
 * to dropped: a bare `/help` runs *this file's* `/help` whatever a project
 * ships, so offering the shadowed row would be offering a row that cannot run.
 * The same first-claim rule the sidecar applies to a contested agent name, and
 * it needs no surface of its own — only three names can be shadowed, and the
 * command stays perfectly invocable from the CLI's own menu.
 */
export function projectCommands(
  commands: readonly CommandSource[],
): SlashCommand[] {
  const builtin = new Set(SLASH_COMMANDS.map((c) => c.name.toLowerCase()));
  return commands
    .filter((source) => !builtin.has(source.name.toLowerCase()))
    .map(projectCommand);
}

/** Every command this pane can run: built-ins first, then discovered, which is
 *  the order the menu and `/help` both present. */
export function allCommands(
  commands: readonly CommandSource[],
): SlashCommand[] {
  return [...SLASH_COMMANDS, ...projectCommands(commands)];
}

export function findCommand(
  name: string,
  commands: readonly CommandSource[],
): SlashCommand | undefined {
  const needle = name.toLowerCase();
  return allCommands(commands).find((c) => c.name.toLowerCase() === needle);
}

/**
 * An exact (case-insensitive) name match wins outright, rather than sharing
 * the row list with other commands it happens to prefix — so a bare, complete
 * command name can never have a longer one steal its Enter. No two registered
 * names prefix each other today (`/model` and `/mode` did, and are gone), but
 * this is a property of the registry's contents, not of the lookup, so the
 * exact-match tier stays — and a discovered command absolutely can prefix
 * another (`/ship` and `/ship-docs` are one file each).
 *
 * Otherwise the two groups are matched separately and concatenated, never
 * interleaved by score: they carry a header apiece in the menu, so a project row
 * sorting above a built-in would split a group in two and print its header
 * twice. Built-ins match by prefix only, as they always have. A discovered
 * command also matches on a substring, because the workspace links a name two
 * projects both claim as `<project-slug>--<name>` — prefix-only would make
 * `/ship` find nothing and demand `/miragold--ship`, a name nobody types.
 */
export function matchCommands(
  prefix: string,
  commands: readonly CommandSource[],
): SlashCommand[] {
  const needle = prefix.toLowerCase();
  const exact = allCommands(commands).find((c) => c.name.toLowerCase() === needle);
  if (exact) return [exact];
  const builtins = SLASH_COMMANDS.filter((c) =>
    c.name.toLowerCase().startsWith(needle),
  );
  const discovered = projectCommands(commands)
    .map((command) => ({ command, rank: commandRank(command, needle) }))
    .filter((scored): scored is { command: SlashCommand; rank: number } =>
      scored.rank !== null,
    )
    // Stable, so equal ranks keep catalog order: by project, in the order the
    // sidecar links them.
    .sort((a, b) => a.rank - b.rank)
    .map(({ command }) => command);
  // Uncapped, unlike the `@`-menu's groups: a bare `/` is the only way to see
  // what a pane can run, and a cap there would hide commands with nothing to say
  // so. The panel scrolls (`.suggest` is `max-height: 240px; overflow-y: auto`).
  return [...builtins, ...discovered];
}

/** How well a discovered command answers `needle`, lower being better, or null
 *  for no match. */
function commandRank(command: SlashCommand, needle: string): number | null {
  const name = command.name.toLowerCase();
  if (name.startsWith(needle)) return 0;
  if (name.includes(needle)) return 1;
  return null;
}

/** One row per command this pane can run — the `/help` panel's whole content. */
export function helpRows(
  commands: readonly CommandSource[],
): { name: string; argHint: string | null; summary: string }[] {
  return allCommands(commands).map((c) => ({
    name: c.name,
    argHint: c.argHint,
    summary: c.summary,
  }));
}

export type CommandLineResult =
  | { kind: "ran"; outcome: CommandOutcome }
  | { kind: "unregistered"; name: string }
  | null; // not a command line at all

export async function runCommandLine(
  draft: string,
  ctx: SlashCommandContext,
): Promise<CommandLineResult> {
  const cl = parseCommandLine(draft);
  if (cl === null) return null;
  const command = findCommand(cl.name, ctx.commands);
  if (command === undefined) return { kind: "unregistered", name: cl.name };
  const outcome = await command.run(cl.arg, ctx);
  return { kind: "ran", outcome };
}

export type SlashRow =
  | { kind: "command"; command: SlashCommand }
  | { kind: "arg"; command: SlashCommand; option: CommandOption };

/** Menu rows for the text between the `/` and the caret — i.e.
 *  `trigger.query`, never the whole draft. Two groups while a name is still
 *  being typed (built-ins, then the pane's discovered commands); one command's
 *  argument suggestions once a space has been typed. */
export function buildSlashRows(query: string, data: CommandData): SlashRow[] {
  const gap = /[ \t]/.exec(query);
  if (!gap) {
    return matchCommands(query, data.commands).map((command) => ({
      kind: "command",
      command,
    }));
  }
  const name = query.slice(0, gap.index);
  const argQuery = query.slice(gap.index).replace(/^[ \t]+/, "");
  const command = findCommand(name, data.commands);
  if (!command || !command.complete) return [];
  return command.complete(argQuery, data).map((option) => ({ kind: "arg", command, option }));
}
