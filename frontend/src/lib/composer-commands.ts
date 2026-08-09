/**
 * The slash-command registry — `/model`, `/mode`, `/clear`, `/compact`,
 * `/help`. A mirror of the CLI TUI's own command menu (Design decision 1),
 * kept as a single data array rather than a dispatch switch (Design
 * decision 2): `SLASH_COMMANDS` is the one source for the menu, argument
 * completion, `/help` content, the "is this a command" check, and
 * execution. Adding a command is appending one object literal here — no
 * other file changes.
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
  /** Registered models for the pane's active provider, menu order. Empty = CLI default. */
  models: readonly CommandOption[];
  /** Live-switchable permission modes, menu order (LIVE_PERMISSION_MODES). */
  modes: readonly CommandOption[];
  /** The mode the session reports, normalised through `modeSelectValue`; "" when unknown. */
  currentMode: string;
  /** Whether a session is running for this pane. */
  live: boolean;
}

/** Everything a command may *do*. Built fresh at execution time. */
export interface SlashCommandEffects {
  setModel: (model: string) => Promise<void>;
  setPermissionMode: (mode: string) => Promise<void>;
  clearSession: () => void;
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

/** `value` alone when the label says nothing extra, else both — a `/mode`
 *  list has to show both spellings, since the user may type either. */
function optionText(o: CommandOption): string {
  return o.label === o.value ? o.value : `${o.value} (${o.label})`;
}

function filterOptions(
  options: readonly CommandOption[],
  query: string,
): CommandOption[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...options];
  return options.filter(
    (o) =>
      o.value.toLowerCase().includes(needle) ||
      o.label.toLowerCase().includes(needle),
  );
}

export type ArgResolution = { ok: true; value: string } | { ok: false; note: string };

/**
 * Five tiers, all case-insensitive, each candidate set de-duplicated per
 * option (an option matching by both value and label counts once):
 *
 * 1. exact value.
 * 2. exact label.
 * 3. unique prefix of value or label. Two or more candidates is ambiguous —
 *    never widens to tier 4, since a substring set can only be larger.
 * 4. unique substring of value or label. Two or more is ambiguous.
 * 5. no candidate — unknown, listing every option.
 *
 * `options` empty → the arg passes through verbatim (no catalog: the CLI
 * validates). An empty `arg` is not this function's problem — callers check
 * that first and return the missing-argument error.
 */
export function resolveOption(
  arg: string,
  options: readonly CommandOption[],
  noun: string,
): ArgResolution {
  if (options.length === 0) return { ok: true, value: arg };
  const needle = arg.toLowerCase();

  const exactValue = options.find((o) => o.value.toLowerCase() === needle);
  if (exactValue) return { ok: true, value: exactValue.value };

  const exactLabel = options.find((o) => o.label.toLowerCase() === needle);
  if (exactLabel) return { ok: true, value: exactLabel.value };

  const prefixMatches = options.filter(
    (o) =>
      o.value.toLowerCase().startsWith(needle) ||
      o.label.toLowerCase().startsWith(needle),
  );
  if (prefixMatches.length === 1) return { ok: true, value: prefixMatches[0]!.value };
  if (prefixMatches.length > 1) {
    return {
      ok: false,
      note: `ambiguous ${noun} "${arg}" — matches: ${prefixMatches.map(optionText).join(", ")}`,
    };
  }

  const substringMatches = options.filter(
    (o) =>
      o.value.toLowerCase().includes(needle) ||
      o.label.toLowerCase().includes(needle),
  );
  if (substringMatches.length === 1) return { ok: true, value: substringMatches[0]!.value };
  if (substringMatches.length > 1) {
    return {
      ok: false,
      note: `ambiguous ${noun} "${arg}" — matches: ${substringMatches.map(optionText).join(", ")}`,
    };
  }

  return {
    ok: false,
    note: `unknown ${noun} "${arg}" — try: ${options.map(optionText).join(", ")}`,
  };
}

/** Next entry after `currentMode` in `modes`, wrapping. Unknown/"" starts
 *  from `"manual"`, so the first `/mode` yields `acceptEdits` — the TUI's
 *  first Shift+Tab. */
export function cycleMode(currentMode: string, modes: readonly CommandOption[]): string {
  if (modes.length === 0) return currentMode;
  const known = modes.findIndex((m) => m.value === currentMode);
  const base = known !== -1 ? known : modes.findIndex((m) => m.value === "manual");
  const nextIndex = (base + 1 + modes.length) % modes.length;
  return modes[nextIndex]?.value ?? currentMode;
}

async function runModelCommand(
  arg: string,
  ctx: SlashCommandContext,
): Promise<CommandOutcome> {
  const trimmed = arg.trim();
  if (trimmed.length === 0) {
    return { kind: "error", note: "/model needs an argument: /model <model>" };
  }
  const resolved = resolveOption(trimmed, ctx.models, "model");
  if (!resolved.ok) return { kind: "error", note: resolved.note };
  try {
    await ctx.setModel(resolved.value);
  } catch (err) {
    return { kind: "error", note: `model failed: ${describeError(err)}` };
  }
  return {
    kind: "ok",
    note: ctx.live
      ? `model → ${resolved.value}`
      : `model → ${resolved.value} (recorded — applies on next start)`,
  };
}

async function runModeCommand(
  arg: string,
  ctx: SlashCommandContext,
): Promise<CommandOutcome> {
  const trimmed = arg.trim();
  const resolved: ArgResolution =
    trimmed.length === 0
      ? { ok: true, value: cycleMode(ctx.currentMode, ctx.modes) }
      : resolveOption(trimmed, ctx.modes, "mode");
  if (!resolved.ok) return { kind: "error", note: resolved.note };
  const label = ctx.modes.find((m) => m.value === resolved.value)?.label ?? resolved.value;
  try {
    await ctx.setPermissionMode(resolved.value);
  } catch (err) {
    return { kind: "error", note: `mode failed: ${describeError(err)}` };
  }
  return {
    kind: "ok",
    note: ctx.live
      ? `mode → ${label} (the CLI confirms or refuses)`
      : `mode → ${label} (recorded — applies on next start)`,
  };
}

async function runClearCommand(
  _arg: string,
  ctx: SlashCommandContext,
): Promise<CommandOutcome> {
  try {
    ctx.clearSession();
  } catch (err) {
    return { kind: "error", note: `clear failed: ${describeError(err)}` };
  }
  return { kind: "ok", note: "cleared — restarting with an empty context" };
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
    name: "model",
    summary: "Switch the live session's model over the control channel.",
    argHint: "<model>",
    runsBare: false,
    complete: (argQuery, data) => filterOptions(data.models, argQuery),
    run: runModelCommand,
  },
  {
    name: "mode",
    summary: "Cycle the permission mode — the Shift+Tab equivalent.",
    argHint: "[mode]",
    runsBare: true,
    complete: (argQuery, data) => filterOptions(data.modes, argQuery),
    run: runModeCommand,
  },
  {
    name: "clear",
    summary: "Restart the session with an empty context.",
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
 * An exact (case-insensitive) name match wins outright — same tiering as
 * `resolveOption` above — rather than sharing the row list with other
 * commands it happens to prefix. Without this, "mode" is a `startsWith`
 * match for both "mode" and "model", so a bare, complete `/mode` would list
 * `/model` first and let it steal Enter.
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
