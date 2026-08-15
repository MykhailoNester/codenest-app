import { describe, it, expect } from "vitest";
import {
  buildPaneLayout,
  mergeEnv,
  resolvePromptTargets,
  MAX_LAUNCH_PANES,
  type LaunchAgentPane,
  type LaunchShellPane,
  type LaunchPane,
} from "../launch";
import { collectLeaves } from "../layout-tree";

// =============================================================================
// mergeEnv
// =============================================================================

describe("mergeEnv", () => {
  it("returns empty object when all layers are undefined", () => {
    expect(mergeEnv()).toEqual({});
  });

  it("returns provider env when only provider is supplied", () => {
    const result = mergeEnv({ default_env: { FOO: "bar" } });
    expect(result).toEqual({ FOO: "bar" });
  });

  it("profile env_json (object) overrides provider env for same key", () => {
    const result = mergeEnv(
      { default_env: { KEY: "from-provider", EXTRA: "provider-only" } },
      { env_json: { KEY: "from-profile" } },
    );
    expect(result).toEqual({ KEY: "from-profile", EXTRA: "provider-only" });
  });

  it("profile env_json (JSON string) is parsed and overrides provider", () => {
    const result = mergeEnv(
      { default_env: { KEY: "from-provider" } },
      { env_json: JSON.stringify({ KEY: "from-profile-string" }) },
    );
    expect(result).toEqual({ KEY: "from-profile-string" });
  });

  it("cell envOverlay overrides both provider and profile", () => {
    const result = mergeEnv(
      { default_env: { KEY: "provider", ONLY_PROVIDER: "yes" } },
      { env_json: { KEY: "profile", ONLY_PROFILE: "yes" } },
      { envOverlay: { KEY: "cell", ONLY_CELL: "yes" } },
    );
    expect(result).toEqual({
      KEY: "cell",
      ONLY_PROVIDER: "yes",
      ONLY_PROFILE: "yes",
      ONLY_CELL: "yes",
    });
  });

  it("null layers are treated as empty", () => {
    const result = mergeEnv(null, null, null);
    expect(result).toEqual({});
  });

  it("missing default_env in provider is a no-op", () => {
    const result = mergeEnv(
      { default_env: undefined },
      { env_json: { X: "1" } },
    );
    expect(result).toEqual({ X: "1" });
  });

  it("invalid JSON string for profile env_json is treated as empty", () => {
    const result = mergeEnv(
      { default_env: { A: "1" } },
      { env_json: "not-valid-json" },
    );
    // Invalid JSON → empty profile layer → only provider survives
    expect(result).toEqual({ A: "1" });
  });

  // E5.1 — CLAUDE_CONFIG_DIR flows from provider.default_env through mergeEnv
  // into spec.env, which is then passed as the env overlay to open_terminal.
  it("CLAUDE_CONFIG_DIR from provider.default_env survives the merge into spec.env", () => {
    const provider = {
      default_env: { CLAUDE_CONFIG_DIR: "~/.claude-alt", OTHER: "kept" },
    };
    const result = mergeEnv(provider);
    expect(result["CLAUDE_CONFIG_DIR"]).toBe("~/.claude-alt");
    expect(result["OTHER"]).toBe("kept");
  });

  it("CLAUDE_CONFIG_DIR is not clobbered by CLAUDE_PROJECT_DIR from a cell overlay", () => {
    // E5.4: provider sets CLAUDE_CONFIG_DIR, session sets CLAUDE_PROJECT_DIR.
    // Both must survive in the merged map — neither overwrites the other.
    const provider = {
      default_env: { CLAUDE_CONFIG_DIR: "/home/user/.claude-alt" },
    };
    const sessionOverlay = { CLAUDE_PROJECT_DIR: "/repos/my-project" };
    const result = mergeEnv(provider, null, { envOverlay: sessionOverlay });
    expect(result["CLAUDE_CONFIG_DIR"]).toBe("/home/user/.claude-alt");
    expect(result["CLAUDE_PROJECT_DIR"]).toBe("/repos/my-project");
  });

  it("per-cell overlay can override CLAUDE_CONFIG_DIR for a session-level override", () => {
    // A user explicitly sets CLAUDE_CONFIG_DIR in the cell env textarea —
    // that override must win over the provider default.
    const provider = {
      default_env: { CLAUDE_CONFIG_DIR: "~/.claude-alt" },
    };
    const cellOverride = { CLAUDE_CONFIG_DIR: "~/.claude-alt2" };
    const result = mergeEnv(provider, null, { envOverlay: cellOverride });
    expect(result["CLAUDE_CONFIG_DIR"]).toBe("~/.claude-alt2");
  });
});

// =============================================================================
// buildPaneLayout
// =============================================================================

describe("buildPaneLayout", () => {
  function agentPane(
    overrides: Partial<LaunchAgentPane> = {},
  ): LaunchAgentPane {
    return { kind: "agent", ...overrides };
  }
  function shellPane(
    overrides: Partial<LaunchShellPane> = {},
  ): LaunchShellPane {
    return { kind: "shell", ...overrides };
  }

  it("1 pane produces a bare PaneLeaf, not a split", () => {
    const layout = buildPaneLayout({ panes: [agentPane()], split: "cols" });
    expect(layout.type).toBe("leaf");
  });

  it("cols split of 3 chains horizontal splits with 1/3 then 1/2 ratios", () => {
    const layout = buildPaneLayout({
      panes: [agentPane(), agentPane(), agentPane()],
      split: "cols",
    });
    expect(layout.type).toBe("split");
    if (layout.type !== "split") return;
    expect(layout.direction).toBe("h");
    expect(layout.ratio).toBeCloseTo(1 / 3);
    const inner = layout.children[1];
    expect(inner.type).toBe("split");
    if (inner.type !== "split") return;
    expect(inner.direction).toBe("h");
    expect(inner.ratio).toBeCloseTo(1 / 2);
  });

  it("rows split of 3 chains vertical splits", () => {
    const layout = buildPaneLayout({
      panes: [agentPane(), agentPane(), agentPane()],
      split: "rows",
    });
    expect(layout.type).toBe("split");
    if (layout.type !== "split") return;
    expect(layout.direction).toBe("v");
    const inner = layout.children[1];
    expect(inner.type).toBe("split");
    if (inner.type !== "split") return;
    expect(inner.direction).toBe("v");
  });

  it("grid split of 4 is two rows of two", () => {
    const layout = buildPaneLayout({
      panes: [agentPane(), agentPane(), agentPane(), agentPane()],
      split: "grid",
    });
    expect(layout.type).toBe("split");
    if (layout.type !== "split") return;
    expect(layout.direction).toBe("v");
    for (const child of layout.children) {
      expect(child.type).toBe("split");
      if (child.type === "split") expect(child.direction).toBe("h");
    }
  });

  it("grid split of 5 uses ceil(sqrt(5)) = 3 columns and a ragged last row of 2", () => {
    const layout = buildPaneLayout({
      panes: [agentPane(), agentPane(), agentPane(), agentPane(), agentPane()],
      split: "grid",
    });
    expect(layout.type).toBe("split");
    if (layout.type !== "split") return;
    expect(layout.direction).toBe("v");
    const [row0, row1] = layout.children;
    expect(collectLeaves(row0)).toHaveLength(3);
    expect(collectLeaves(row1)).toHaveLength(2);
  });

  it("leaves come back in pane-list order", () => {
    const panes: LaunchPane[] = [
      agentPane({ providerId: 1 }),
      shellPane({ command: "npm run dev" }),
      agentPane({ providerId: 2 }),
    ];
    const layout = buildPaneLayout({ panes, split: "cols" });
    const leaves = collectLeaves(layout);
    expect(leaves.map((l) => l.title)).toEqual(["claude", "zsh", "claude"]);
    expect(leaves[0]?.providerId).toBe(1);
    expect(leaves[2]?.providerId).toBe(2);
  });

  it("an agent pane's leaf carries kind/providerId/model/permissionMode and no initCommand", () => {
    const layout = buildPaneLayout({
      panes: [
        agentPane({
          providerId: 3,
          model: "claude-sonnet-5",
          permissionMode: "plan",
          cwd: "/tmp/proj",
        }),
      ],
      split: "cols",
    });
    const leaf = collectLeaves(layout)[0]!;
    expect(leaf.kind).toBe("agent");
    expect(leaf.providerId).toBe(3);
    expect(leaf.model).toBe("claude-sonnet-5");
    expect(leaf.permissionMode).toBe("plan");
    expect(leaf.cwd).toBe("/tmp/proj");
    expect(leaf.initCommand).toBeUndefined();
  });

  it("a shell pane's leaf carries no kind, and its command with exactly one trailing newline", () => {
    const layoutNoNewline = buildPaneLayout({
      panes: [shellPane({ command: "npm run dev" })],
      split: "cols",
    });
    const leafNoNewline = collectLeaves(layoutNoNewline)[0]!;
    expect(leafNoNewline.kind).toBeUndefined();
    expect(leafNoNewline.initCommand).toBe("npm run dev\n");

    const layoutWithNewline = buildPaneLayout({
      panes: [shellPane({ command: "npm run dev\n" })],
      split: "cols",
    });
    const leafWithNewline = collectLeaves(layoutWithNewline)[0]!;
    expect(leafWithNewline.initCommand).toBe("npm run dev\n");
  });

  it("sendPrompt and spec.prompt never reach a leaf; only promptPreview does", () => {
    const prompt = "x".repeat(300);
    const layout = buildPaneLayout({
      panes: [
        agentPane({ sendPrompt: true }),
        agentPane({ sendPrompt: false }),
      ],
      split: "cols",
      prompt,
    });
    const [leafA, leafB] = collectLeaves(layout);
    expect(leafA?.seed?.promptPreview).toBe(prompt.slice(0, 120));
    expect(leafB?.seed?.promptPreview).toBe(prompt.slice(0, 120));
    for (const leaf of [leafA, leafB]) {
      expect(leaf !== undefined && "sendPrompt" in leaf).toBe(false);
      expect(leaf !== undefined && "prompt" in leaf).toBe(false);
    }
  });

  it("a shell pane never gets a seed, even under a spec with a prompt and a source", () => {
    const layout = buildPaneLayout({
      panes: [shellPane({ command: "npm run dev" })],
      split: "cols",
      prompt: "hello",
      projectId: 1,
      source: { kind: "task", id: 5 },
    });
    const leaf = collectLeaves(layout)[0]!;
    expect(leaf.seed).toBeUndefined();
  });

  it("a pane with no project/profile/source/prompt gets no seed key", () => {
    const layout = buildPaneLayout({ panes: [agentPane()], split: "cols" });
    const leaf = collectLeaves(layout)[0]!;
    expect("seed" in leaf).toBe(false);
  });

  it("throws RangeError for 0 panes and for MAX_LAUNCH_PANES + 1, and accepts exactly MAX_LAUNCH_PANES", () => {
    expect(() => buildPaneLayout({ panes: [], split: "cols" })).toThrow(
      RangeError,
    );
    expect(() =>
      buildPaneLayout({
        panes: Array.from({ length: MAX_LAUNCH_PANES + 1 }, () => agentPane()),
        split: "grid",
      }),
    ).toThrow(RangeError);
    expect(() =>
      buildPaneLayout({
        panes: Array.from({ length: MAX_LAUNCH_PANES }, () => agentPane()),
        split: "grid",
      }),
    ).not.toThrow();
  });
});

describe("resolvePromptTargets", () => {
  function agentPane(
    overrides: Partial<LaunchAgentPane> = {},
  ): LaunchAgentPane {
    return { kind: "agent", ...overrides };
  }
  function shellPane(
    overrides: Partial<LaunchShellPane> = {},
  ): LaunchShellPane {
    return { kind: "shell", ...overrides };
  }

  it("three agent panes with the toggle on for two target exactly those two", () => {
    const targets = resolvePromptTargets({
      panes: [
        agentPane({ sendPrompt: true }),
        agentPane({ sendPrompt: false }),
        agentPane({ sendPrompt: true }),
      ],
      prompt: "do the thing",
    });
    expect(targets).toEqual([0, 2]);
  });

  it("a shell pane is never a target, even under promptFanout 'every'", () => {
    const targets = resolvePromptTargets({
      panes: [shellPane(), agentPane(), shellPane()],
      prompt: "do the thing",
      promptFanout: "every",
    });
    expect(targets).toEqual([1]);
  });

  it("an absent or empty prompt targets nothing", () => {
    const panes: LaunchPane[] = [agentPane({ sendPrompt: true })];
    expect(resolvePromptTargets({ panes })).toEqual([]);
    expect(resolvePromptTargets({ panes, prompt: "" })).toEqual([]);
  });

  it("legacy 'primary' targets the first agent pane, not leaf 0", () => {
    const targets = resolvePromptTargets({
      panes: [shellPane(), agentPane(), agentPane()],
      prompt: "do the thing",
      promptFanout: "primary",
    });
    expect(targets).toEqual([1]);
  });

  it("legacy 'every' targets every agent pane and 'none' targets none", () => {
    const panes: LaunchPane[] = [agentPane(), shellPane(), agentPane()];
    expect(
      resolvePromptTargets({ panes, prompt: "x", promptFanout: "every" }),
    ).toEqual([0, 2]);
    expect(
      resolvePromptTargets({ panes, prompt: "x", promptFanout: "none" }),
    ).toEqual([]);
  });

  it("an explicit sendPrompt disables the legacy fallback entirely", () => {
    const targets = resolvePromptTargets({
      panes: [
        agentPane({ sendPrompt: true }),
        agentPane(),
        agentPane(),
      ],
      prompt: "do the thing",
      promptFanout: "every",
    });
    // Only the one pane that stated its own flag — the other two, with no
    // flag of their own, are excluded even though `promptFanout` says
    // "every" (Design decision 8).
    expect(targets).toEqual([0]);
  });
});
