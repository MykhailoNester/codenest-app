import { describe, it, expect, vi } from "vitest";
import {
  SLASH_COMMANDS,
  findCommand,
  helpRows,
  runCommandLine,
  buildSlashRows,
  type CommandData,
  type SlashCommandContext,
  type SlashCommandEffects,
} from "../composer-commands";

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
    ...data,
    ...effects(fx),
  };
}

describe("SLASH_COMMANDS registry — decision 2", () => {
  it("has every entry findable, documented, listed and dispatchable", async () => {
    for (const command of SLASH_COMMANDS) {
      expect(findCommand(command.name)).toBe(command);
      expect(command.summary.length).toBeGreaterThan(0);
      expect(helpRows().map((r) => r.name)).toContain(command.name);

      const c = ctx();
      const result = await runCommandLine(`/${command.name}`, c);
      expect(result?.kind).toBe("ran");
    }
  });

  it("findCommand is case-insensitive", () => {
    expect(findCommand("CLEAR")).toBe(findCommand("clear"));
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
  const data: CommandData = { live: true };

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
    expect(findCommand("model")).toBeUndefined();
    expect(findCommand("mode")).toBeUndefined();
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
