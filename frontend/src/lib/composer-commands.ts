/**
 * The slash-command registry — `/clear`, `/compact`, `/help`. A mirror of the
 * CLI TUI's own command menu (Design decision 1), kept as a single data array
 * rather than a dispatch switch (Design decision 2): `SLASH_COMMANDS` is the
 * one source for the menu, argument completion, `/help` content, the "is this
 * a command" check, and execution. Adding a command is appending one object
 * literal here — no other file changes.
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

/** Everything the menu needs. Pure data, so the component can memoize it and
 *  arrow-key navigation survives a re-render. */
export interface CommandData {
  /** Whether a session is running for this pane. */
  live: boolean;
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
  return {
    kind: "ok",
    note: `commands: ${SLASH_COMMANDS.map((c) => "/" + c.name).join(" ")}`,
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
  },
  {
    name: "compact",
    summary: "Ask claude to compact the conversation (sent as text).",
    argHint: "[instructions]",
    runsBare: true,
    complete: null,
    run: runCompactCommand,
  },
  {
    name: "help",
    summary: "List the available commands.",
    argHint: null,
    runsBare: true,
    complete: null,
    run: runHelpCommand,
  },
];

export function findCommand(name: string): SlashCommand | undefined {
  const needle = name.toLowerCase();
  return SLASH_COMMANDS.find((c) => c.name.toLowerCase() === needle);
}

/**
 * An exact (case-insensitive) name match wins outright, rather than sharing
 * the row list with other commands it happens to prefix — so a bare, complete
 * command name can never have a longer one steal its Enter. No two registered
 * names prefix each other today (`/model` and `/mode` did, and are gone), but
 * this is a property of the registry's contents, not of the lookup, so the
 * exact-match tier stays.
 */
export function matchCommands(prefix: string): SlashCommand[] {
  const needle = prefix.toLowerCase();
  const exact = SLASH_COMMANDS.find((c) => c.name.toLowerCase() === needle);
  if (exact) return [exact];
  return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(needle));
}

/** One row per registered command — the `/help` panel's whole content. */
export function helpRows(): { name: string; argHint: string | null; summary: string }[] {
  return SLASH_COMMANDS.map((c) => ({ name: c.name, argHint: c.argHint, summary: c.summary }));
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
  const command = findCommand(cl.name);
  if (command === undefined) return { kind: "unregistered", name: cl.name };
  const outcome = await command.run(cl.arg, ctx);
  return { kind: "ran", outcome };
}

export type SlashRow =
  | { kind: "command"; command: SlashCommand }
  | { kind: "arg"; command: SlashCommand; option: CommandOption };

/** Menu rows for the text between the `/` and the caret — i.e.
 *  `trigger.query`, never the whole draft. */
export function buildSlashRows(query: string, data: CommandData): SlashRow[] {
  const gap = /[ \t]/.exec(query);
  if (!gap) {
    return matchCommands(query).map((command) => ({ kind: "command", command }));
  }
  const name = query.slice(0, gap.index);
  const argQuery = query.slice(gap.index).replace(/^[ \t]+/, "");
  const command = findCommand(name);
  if (!command || !command.complete) return [];
  return command.complete(argQuery, data).map((option) => ({ kind: "arg", command, option }));
}
