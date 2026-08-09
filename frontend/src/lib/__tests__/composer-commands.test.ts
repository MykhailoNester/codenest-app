import { describe, it, expect, vi } from "vitest";
import {
  SLASH_COMMANDS,
  findCommand,
  helpRows,
  runCommandLine,
  buildSlashRows,
  resolveOption,
  cycleMode,
  type CommandData,
  type SlashCommandContext,
  type SlashCommandEffects,
} from "../composer-commands";

function effects(over: Partial<SlashCommandEffects> = {}): SlashCommandEffects {
  return {
    setModel: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    clearSession: vi.fn(),
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
    models: [],
    modes: [],
    currentMode: "",
    live: true,
    ...data,
    ...effects(fx),
  };
}

const MODEL_OPTIONS = [{ value: "claude-opus-4-6", label: "Opus 4.6" }];
const MODE_OPTIONS = [
  { value: "plan", label: "plan" },
  { value: "manual", label: "ask" },
  { value: "acceptEdits", label: "auto-edit" },
  { value: "auto", label: "auto" },
  { value: "dontAsk", label: "don't ask (deny)" },
];

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
    expect(findCommand("MODEL")).toBe(findCommand("model"));
  });
});

describe("/model", () => {
  it("resolves a unique prefix of the label (tier 3)", async () => {
    const setModel = vi.fn(async () => undefined);
    const c = ctx({ models: MODEL_OPTIONS }, { setModel });
    await runCommandLine("/model opus", c);
    expect(setModel).toHaveBeenCalledWith("claude-opus-4-6");
  });

  it("resolves a unique substring of the value (tier 4)", async () => {
    const setModel = vi.fn(async () => undefined);
    const c = ctx({ models: MODEL_OPTIONS }, { setModel });
    await runCommandLine("/model 4-6", c);
    expect(setModel).toHaveBeenCalledWith("claude-opus-4-6");
  });

  it("reports ambiguity rather than guessing, and never widens past the prefix tier", async () => {
    const setModel = vi.fn(async () => undefined);
    const twoOpus = [
      { value: "claude-opus-4-6", label: "Opus 4.6" },
      { value: "claude-opus-4-5", label: "Opus 4.5" },
    ];
    const c = ctx({ models: twoOpus }, { setModel });
    const result = await runCommandLine("/model opus", c);
    expect(result?.kind).toBe("ran");
    if (result?.kind !== "ran") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("error");
    expect(result.outcome.note).toContain('ambiguous model "opus"');
    expect(result.outcome.note).toContain("claude-opus-4-6 (Opus 4.6)");
    expect(result.outcome.note).toContain("claude-opus-4-5 (Opus 4.5)");
    expect(setModel).not.toHaveBeenCalled();
  });

  it("passes an arbitrary model straight through when there is no catalog", async () => {
    const setModel = vi.fn(async () => undefined);
    const c = ctx({ models: [] }, { setModel });
    await runCommandLine("/model whatever", c);
    expect(setModel).toHaveBeenCalledWith("whatever");
  });

  it("refuses a missing argument without touching the IPC call", async () => {
    const setModel = vi.fn(async () => undefined);
    const c = ctx({ models: MODEL_OPTIONS }, { setModel });
    const result = await runCommandLine("/model", c);
    expect(result?.kind).toBe("ran");
    if (result?.kind !== "ran") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("error");
    expect(result.outcome.note).toContain("/model <model>");
    expect(setModel).not.toHaveBeenCalled();
  });
});

describe("/mode", () => {
  it("resolves an exact value (tier 1) even though it also collides with a label prefix", async () => {
    const setPermissionMode = vi.fn(async () => undefined);
    const c = ctx({ modes: MODE_OPTIONS }, { setPermissionMode });
    await runCommandLine("/mode auto", c);
    expect(setPermissionMode).toHaveBeenCalledWith("auto");
  });

  it("resolves an exact label (tier 2) — round-1 gap 3", async () => {
    const setPermissionMode = vi.fn(async () => undefined);
    const c = ctx({ modes: MODE_OPTIONS }, { setPermissionMode });
    await runCommandLine("/mode ask", c);
    expect(setPermissionMode).toHaveBeenCalledWith("manual");

    setPermissionMode.mockClear();
    await runCommandLine("/mode auto-edit", c);
    expect(setPermissionMode).toHaveBeenCalledWith("acceptEdits");
  });

  it("resolves a unique prefix without tripping over the apostrophe in the deny label", async () => {
    const setPermissionMode = vi.fn(async () => undefined);
    const c = ctx({ modes: MODE_OPTIONS }, { setPermissionMode });
    await runCommandLine("/mode dont", c);
    expect(setPermissionMode).toHaveBeenCalledWith("dontAsk");
  });

  it("names both spellings in an unknown-mode error", async () => {
    const setPermissionMode = vi.fn(async () => undefined);
    const c = ctx({ modes: MODE_OPTIONS }, { setPermissionMode });
    const result = await runCommandLine("/mode zzz", c);
    expect(result?.kind).toBe("ran");
    if (result?.kind !== "ran") throw new Error("unreachable");
    expect(result.outcome.note).toContain('unknown mode "zzz"');
    expect(result.outcome.note).toContain("acceptEdits (auto-edit)");
    expect(setPermissionMode).not.toHaveBeenCalled();
  });

  it("cycles bare, wrapping — the TUI's Shift+Tab", async () => {
    expect(cycleMode("", MODE_OPTIONS)).toBe("acceptEdits");
    expect(cycleMode("plan", MODE_OPTIONS)).toBe("manual");
    expect(cycleMode("dontAsk", MODE_OPTIONS)).toBe("plan");
  });

  it("runs the cycle through the registry when the argument is empty", async () => {
    const setPermissionMode = vi.fn(async () => undefined);
    const c = ctx({ modes: MODE_OPTIONS, currentMode: "plan" }, { setPermissionMode });
    await runCommandLine("/mode", c);
    expect(setPermissionMode).toHaveBeenCalledWith("manual");
  });
});

describe("/clear — decision 6", () => {
  it("calls clearSession alone, no sendRaw, no IPC", async () => {
    const clearSession = vi.fn();
    const sendRaw = vi.fn(async () => undefined);
    const c = ctx({}, { clearSession, sendRaw });
    const result = await runCommandLine("/clear", c);
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(sendRaw).not.toHaveBeenCalled();
    expect(result?.kind).toBe("ran");
    if (result?.kind !== "ran") throw new Error("unreachable");
    expect(result.outcome).toEqual({ kind: "ok", note: "cleared — restarting with an empty context" });
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
      note: "commands: /model /mode /clear /compact /help",
    });
  });
});

describe("runCommandLine — failure and non-execution outcomes", () => {
  it("converts a rejected effect into an error outcome rather than throwing", async () => {
    const setModel = vi.fn(async () => {
      throw new Error("no live session");
    });
    const c = ctx({ models: [] }, { setModel });
    const result = await runCommandLine("/model x", c);
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
  const data: CommandData = { models: MODEL_OPTIONS, modes: MODE_OPTIONS, currentMode: "", live: true };

  it("lists every command for an empty query", () => {
    expect(buildSlashRows("", data).map((r) => (r.kind === "command" ? r.command.name : null))).toEqual(
      SLASH_COMMANDS.map((c) => c.name),
    );
  });

  it("narrows to commands whose name starts with the query", () => {
    const rows = buildSlashRows("mo", data);
    expect(rows.map((r) => (r.kind === "command" ? r.command.name : null))).toEqual(["model", "mode"]);
  });

  it("lists every model for a trailing-space query", () => {
    const rows = buildSlashRows("model ", data);
    expect(rows).toHaveLength(MODEL_OPTIONS.length);
    expect(rows.every((r) => r.kind === "arg")).toBe(true);
  });

  it("filters the argument rows by the text after the space", () => {
    const rows = buildSlashRows("model op", data);
    expect(rows).toHaveLength(1);
  });

  it("is empty for a command with no completion", () => {
    expect(buildSlashRows("clear ", data)).toEqual([]);
    expect(buildSlashRows("compact focus on X", data)).toEqual([]);
  });

  it("is empty for an unregistered command", () => {
    expect(buildSlashRows("zzz", data)).toEqual([]);
  });
});

describe("resolveOption", () => {
  it("passes an arg through verbatim with no options", () => {
    expect(resolveOption("anything", [], "model")).toEqual({ ok: true, value: "anything" });
  });
});
