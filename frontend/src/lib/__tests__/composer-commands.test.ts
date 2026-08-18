import { describe, it, expect, vi } from "vitest";
import {
  SLASH_COMMANDS,
  allCommands,
  findCommand,
  helpRows,
  matchCommands,
  runCommandLine,
  buildSlashRows,
  type CommandData,
  type CommandSource,
  type SlashCommandContext,
  type SlashCommandEffects,
} from "../composer-commands";

/** A catalog row as the probe projects one (`composer-suggest.tsx`). */
function source(over: Partial<CommandSource> & { name: string }): CommandSource {
  return {
    label: `codenest-app:${over.name}`,
    insertText: `/${over.name}`,
    projectName: "codenest-app",
    description: null,
    argHint: null,
    ...over,
  };
}

const SHIP = source({
  name: "ship",
  description: "Autonomous delivery pipeline, two lanes.",
  argHint: "<#24 #25 …>",
});
const COMMIT = source({
  name: "commit-message",
  description: "Generates a git commit message in project format.",
});

function effects(over: Partial<SlashCommandEffects> = {}): SlashCommandEffects {
  return {
    clearContext: vi.fn(async () => undefined),
    sendRaw: vi.fn(async () => undefined),
    showHelp: vi.fn(),
    ...over,
  };
}

function ctx(
  data: Partial<CommandData> = {},
  fx: Partial<SlashCommandEffects> = {},
): SlashCommandContext {
  return {
    live: true,
    commands: [],
    ...data,
    ...effects(fx),
  };
}

describe("SLASH_COMMANDS registry — decision 2", () => {
  it("has every entry findable, documented, listed and dispatchable", async () => {
    for (const command of SLASH_COMMANDS) {
      expect(findCommand(command.name, [])).toBe(command);
      expect(command.summary.length).toBeGreaterThan(0);
      expect(helpRows([]).map((r) => r.name)).toContain(command.name);

      const c = ctx();
      const result = await runCommandLine(`/${command.name}`, c);
      expect(result?.kind).toBe("ran");
    }
  });

  it("findCommand is case-insensitive", () => {
    expect(findCommand("CLEAR", [])).toBe(findCommand("clear", []));
  });
});

describe("/clear — decision 6", () => {
  it("clears context alone — no sendRaw, and the note promises the session survives", async () => {
    const clearContext = vi.fn(async () => undefined);
    const sendRaw = vi.fn(async () => undefined);
    const c = ctx({ live: true }, { clearContext, sendRaw });
    const result = await runCommandLine("/clear", c);
    expect(clearContext).toHaveBeenCalledTimes(1);
    // The forward to the CLI is `clearContext`'s own business — routing it
    // through `sendRaw` would record an optimistic user turn and re-populate
    // the transcript the command just emptied.
    expect(sendRaw).not.toHaveBeenCalled();
    expect(result?.kind).toBe("ran");
    if (result?.kind !== "ran") throw new Error("unreachable");
    expect(result.outcome).toEqual({
      kind: "ok",
      note: "context cleared — same session, keep going",
    });
  });

  it("still clears the transcript on an ended session, and says so", async () => {
    const clearContext = vi.fn(async () => undefined);
    const c = ctx({ live: false }, { clearContext });
    const result = await runCommandLine("/clear", c);
    expect(clearContext).toHaveBeenCalledTimes(1);
    if (result?.kind !== "ran") throw new Error("unreachable");
    expect(result.outcome).toEqual({
      kind: "ok",
      note: "transcript cleared — the session had already ended",
    });
  });

  it("surfaces a failed forward as an error instead of claiming success", async () => {
    const clearContext = vi.fn(async () => {
      throw new Error("stdin closed");
    });
    const c = ctx({ live: true }, { clearContext });
    const result = await runCommandLine("/clear", c);
    if (result?.kind !== "ran") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("error");
    expect(result.outcome.note).toContain("stdin closed");
  });
});

describe("/compact — decision 5", () => {
  it("sends the bare command line while live", async () => {
    const sendRaw = vi.fn(async () => undefined);
    const c = ctx({ live: true }, { sendRaw });
    await runCommandLine("/compact", c);
    expect(sendRaw).toHaveBeenCalledWith("/compact");
  });

  it("keeps the instructions on the same line", async () => {
    const sendRaw = vi.fn(async () => undefined);
    const c = ctx({ live: true }, { sendRaw });
    await runCommandLine("/compact focus on X", c);
    expect(sendRaw).toHaveBeenCalledWith("/compact focus on X");
  });

  it("refuses on an exited session rather than queuing a doomed send", async () => {
    const sendRaw = vi.fn(async () => undefined);
    const c = ctx({ live: false }, { sendRaw });
    const result = await runCommandLine("/compact", c);
    expect(sendRaw).not.toHaveBeenCalled();
    expect(result?.kind).toBe("ran");
    if (result?.kind !== "ran") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("error");
  });
});

describe("/help — decision 2", () => {
  it("calls showHelp and derives the note from the registry", async () => {
    const showHelp = vi.fn();
    const c = ctx({}, { showHelp });
    const result = await runCommandLine("/help", c);
    expect(showHelp).toHaveBeenCalledTimes(1);
    expect(result?.kind).toBe("ran");
    if (result?.kind !== "ran") throw new Error("unreachable");
    expect(result.outcome).toEqual({
      kind: "ok",
      note: "commands: /clear /compact /help",
    });
  });
});

describe("runCommandLine — failure and non-execution outcomes", () => {
  it("converts a rejected effect into an error outcome rather than throwing", async () => {
    const sendRaw = vi.fn(async () => {
      throw new Error("no live session");
    });
    const c = ctx({ live: true }, { sendRaw });
    const result = await runCommandLine("/compact", c);
    expect(result?.kind).toBe("ran");
    if (result?.kind !== "ran") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("error");
    expect(result.outcome.note).toContain("no live session");
  });

  it("distinguishes unregistered from not-a-command-line", async () => {
    const c = ctx();
    expect(await runCommandLine("/nope x", c)).toEqual({ kind: "unregistered", name: "nope" });
    expect(await runCommandLine("hello", c)).toBeNull();
    expect(await runCommandLine("/model opus\nmore", c)).toBeNull();
  });
});

describe("buildSlashRows — consumes the trigger's query, never the whole draft", () => {
  const data: CommandData = { live: true, commands: [] };

  it("lists every command for an empty query", () => {
    expect(buildSlashRows("", data).map((r) => (r.kind === "command" ? r.command.name : null))).toEqual(
      SLASH_COMMANDS.map((c) => c.name),
    );
  });

  it("narrows to commands whose name starts with the query", () => {
    const rows = buildSlashRows("c", data);
    expect(rows.map((r) => (r.kind === "command" ? r.command.name : null))).toEqual([
      "clear",
      "compact",
    ]);
  });

  // No registered command carries a `complete` callback now that `/model` and
  // `/mode` are gone, so every argument query is empty. The `"arg"` row path
  // itself is still exercised by `buildSlashRows` returning `[]` through it.
  it("is empty for a command with no completion", () => {
    expect(buildSlashRows("clear ", data)).toEqual([]);
    expect(buildSlashRows("compact focus on X", data)).toEqual([]);
  });

  it("is empty for an unregistered command", () => {
    expect(buildSlashRows("zzz", data)).toEqual([]);
  });
});

describe("the removed /model and /mode commands", () => {
  it("are not registered, so the composer dropdowns are the only way in", () => {
    expect(findCommand("model", [])).toBeUndefined();
    expect(findCommand("mode", [])).toBeUndefined();
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual(["clear", "compact", "help"]);
  });

  it("are treated as ordinary unregistered command lines", async () => {
    expect(await runCommandLine("/mode", ctx())).toEqual({ kind: "unregistered", name: "mode" });
    expect(await runCommandLine("/model opus", ctx())).toEqual({
      kind: "unregistered",
      name: "model",
    });
  });
});

// ---------------------------------------------------------------------------
// Discovered commands — #47
//
// The regression: `.claude/commands/ship.md` existed, the sidecar's scanner
// found it, and typing `/ship` still drew "`/ship` is not a Codenest command".
// ---------------------------------------------------------------------------

describe("the discovered half of the registry", () => {
  it("registers a catalog row so it is findable, listed and dispatchable", async () => {
    const commands = [SHIP, COMMIT];
    const ship = findCommand("ship", commands);
    expect(ship).toBeDefined();
    expect(ship?.origin).toBe("project");
    expect(helpRows(commands).map((r) => r.name)).toEqual([
      "clear",
      "compact",
      "help",
      "ship",
      "commit-message",
    ]);
    // The whole point: no longer "unregistered", so no warning row.
    const result = await runCommandLine("/ship #47", ctx({ commands }));
    expect(result?.kind).toBe("ran");
  });

  it("keeps built-ins first and never lets a project shadow one", () => {
    const rogue = source({ name: "clear", description: "not this one" });
    const names = allCommands([rogue, SHIP]).map((c) => c.name);
    expect(names).toEqual(["clear", "compact", "help", "ship"]);
    // `/clear` still empties the context rather than forwarding a line.
    expect(findCommand("clear", [rogue])).toBe(SLASH_COMMANDS[0]);
  });

  it("takes its summary from the description, falling back to the project", () => {
    expect(findCommand("ship", [SHIP])?.summary).toBe(
      "Autonomous delivery pipeline, two lanes.",
    );
    const bare = source({ name: "bare" });
    expect(findCommand("bare", [bare])?.summary).toBe("command from codenest-app");
    // Frontmatter descriptions arrive with literal `\n` escapes from the scan.
    const wrapped = source({ name: "wrapped", description: "one\\ntwo   three" });
    expect(findCommand("wrapped", [wrapped])?.summary).toBe("one two three");
  });
});

describe("matchCommands — two groups, never interleaved", () => {
  it("lists built-ins then discovered for a bare `/`, uncapped", () => {
    const many = Array.from({ length: 12 }, (_v, i) => source({ name: `cmd-${i}` }));
    const rows = matchCommands("", many);
    expect(rows.slice(0, 3).map((c) => c.name)).toEqual(["clear", "compact", "help"]);
    expect(rows).toHaveLength(3 + 12);
    // Contiguous runs are what lets the menu print one header per group.
    expect(rows.map((c) => c.origin).join(" ")).toBe(
      `${"builtin ".repeat(3)}${"project ".repeat(12)}`.trim(),
    );
  });

  it("puts a matching built-in above a better-matching project command", () => {
    // `clear` only contains "c"; `code-review-pr` starts with it. Group order
    // still wins, or the menu would print "project commands" twice.
    const rows = matchCommands("c", [source({ name: "code-review-pr" }), COMMIT]);
    expect(rows.map((c) => c.name)).toEqual([
      "clear",
      "compact",
      "code-review-pr",
      "commit-message",
    ]);
  });

  it("matches a discovered command on a substring, so a slug prefix is findable", () => {
    // Two projects both shipping `ship` are linked as `<slug>--ship`, and
    // `/miragold--ship` is not a name anyone types.
    const contested = source({
      name: "miragold--ship",
      label: "miragold:ship",
      insertText: "/miragold--ship",
      projectName: "miragold",
    });
    expect(matchCommands("ship", [contested]).map((c) => c.name)).toEqual([
      "miragold--ship",
    ]);
    expect(matchCommands("zzz", [contested])).toEqual([]);
  });

  it("still lets an exact name win outright over the commands it prefixes", () => {
    const docs = source({ name: "ship-docs" });
    expect(matchCommands("ship", [SHIP, docs]).map((c) => c.name)).toEqual(["ship"]);
  });
});

describe("a discovered command forwards verbatim", () => {
  it("sends the catalog's own token, with the argument appended as typed", async () => {
    const sendRaw = vi.fn(async () => undefined);
    const result = await runCommandLine(
      "/ship #47 --dry-run",
      ctx({ commands: [SHIP] }, { sendRaw }),
    );
    expect(sendRaw).toHaveBeenCalledWith("/ship #47 --dry-run");
    expect(result?.kind).toBe("ran");
    if (result?.kind !== "ran") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("ok");
  });

  it("sends the token alone when there is no argument", async () => {
    const sendRaw = vi.fn(async () => undefined);
    await runCommandLine("/commit-message", ctx({ commands: [COMMIT] }, { sendRaw }));
    expect(sendRaw).toHaveBeenCalledWith("/commit-message");
  });

  it("sends the workspace's aliased token, never a token rebuilt from the label", async () => {
    const sendRaw = vi.fn(async () => undefined);
    const contested = source({
      name: "miragold--ship",
      label: "miragold:ship",
      insertText: "/miragold--ship",
      projectName: "miragold",
    });
    await runCommandLine("/miragold--ship", ctx({ commands: [contested] }, { sendRaw }));
    expect(sendRaw).toHaveBeenCalledWith("/miragold--ship");
  });

  it("refuses on a dead session rather than writing to a closed stdin", async () => {
    const sendRaw = vi.fn(async () => undefined);
    const result = await runCommandLine(
      "/ship",
      ctx({ live: false, commands: [SHIP] }, { sendRaw }),
    );
    expect(sendRaw).not.toHaveBeenCalled();
    if (result?.kind !== "ran") throw new Error("unreachable");
    expect(result.outcome).toEqual({
      kind: "error",
      note: "session ended — Restart before /ship",
    });
  });

  it("reports a failed forward as an error outcome", async () => {
    const sendRaw = vi.fn(async () => {
      throw new Error("pty gone");
    });
    const result = await runCommandLine("/ship", ctx({ commands: [SHIP] }, { sendRaw }));
    if (result?.kind !== "ran") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("error");
    expect(result.outcome.note).toContain("pty gone");
  });

  it("leaves a genuinely unknown command unregistered", async () => {
    expect(await runCommandLine("/nope", ctx({ commands: [SHIP, COMMIT] }))).toEqual({
      kind: "unregistered",
      name: "nope",
    });
  });
});

describe("argument rows for a discovered command", () => {
  const data: CommandData = { live: true, commands: [SHIP, COMMIT] };

  it("waits for an argument when the file declares an argument-hint", () => {
    const ship = findCommand("ship", data.commands);
    expect(ship?.argHint).toBe("<#24 #25 …>");
    // Picking it completes to `/ship ` instead of firing it bare.
    expect(ship?.runsBare).toBe(false);
    // One that declares none has nothing to wait for.
    expect(findCommand("commit-message", data.commands)?.runsBare).toBe(true);
  });

  it("offers the typed argument, labelled with the hint, once something is typed", () => {
    expect(buildSlashRows("ship ", data)).toEqual([]);
    const rows = buildSlashRows("ship #47 --dry-run", data);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row?.kind !== "arg") throw new Error("expected an arg row");
    expect(row.option).toEqual({ value: "#47 --dry-run", label: "<#24 #25 …>" });
  });

  it("offers nothing for a command with no hint to confirm", () => {
    expect(buildSlashRows("commit-message #47", data)).toEqual([]);
  });
});

describe("buildSlashRows with a catalog", () => {
  it("lists the built-ins and the discovered commands for a bare `/`", () => {
    const rows = buildSlashRows("", { live: true, commands: [SHIP, COMMIT] });
    expect(rows.map((r) => (r.kind === "command" ? r.command.name : null))).toEqual([
      "clear",
      "compact",
      "help",
      "ship",
      "commit-message",
    ]);
  });
});

describe("/help with discovered commands", () => {
  it("names the built-ins and counts the rest", async () => {
    const result = await runCommandLine("/help", ctx({ commands: [SHIP, COMMIT] }));
    if (result?.kind !== "ran") throw new Error("unreachable");
    expect(result.outcome.note).toBe(
      "commands: /clear /compact /help · 2 project commands",
    );
  });
});
