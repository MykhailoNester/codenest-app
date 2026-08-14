import { describe, it, expect, vi, afterEach } from "vitest";
import {
  renderProviderCommand,
  safeInjectClaudeArgs,
  buildGridLayout,
  buildPaneLayout,
  mergeEnv,
  resolvePromptTargets,
  GRID_MAX_PANES,
  MAX_LAUNCH_PANES,
  type LaunchAgentPane,
  type LaunchShellPane,
  type LaunchPane,
} from "../launch";
import { collectLeaves } from "../layout-tree";

describe("renderProviderCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // {extra_args} substitution
  // -------------------------------------------------------------------------

  it("returns 'claude\\n' when template is 'claude {extra_args}' and extraArgs is empty", () => {
    const result = renderProviderCommand({
      template: "claude {extra_args}",
      extraArgs: "",
    });
    expect(result).toBe("claude \n");
  });

  it("appends extra args when provided", () => {
    const result = renderProviderCommand({
      template: "claude {extra_args}",
      extraArgs: "--continue",
    });
    expect(result).toBe("claude --continue\n");
  });

  it("trims leading/trailing whitespace from extraArgs", () => {
    const result = renderProviderCommand({
      template: "claude {extra_args}",
      extraArgs: "  --continue  ",
    });
    expect(result).toBe("claude --continue\n");
  });

  it("uses template verbatim when no {extra_args} placeholder is present", () => {
    const result = renderProviderCommand({
      template: "claude",
      extraArgs: "--ignored",
    });
    // No placeholder → extraArgs is irrelevant; template returned as-is + \n
    expect(result).toBe("claude\n");
  });

  // -------------------------------------------------------------------------
  // defaultArgs — provider-level defaults merged into {extra_args}
  // -------------------------------------------------------------------------

  it("uses defaultArgs alone when extraArgs is absent", () => {
    const result = renderProviderCommand({
      template: "claude {extra_args}",
      defaultArgs: "--dangerously-skip-permissions",
    });
    expect(result).toBe("claude --dangerously-skip-permissions\n");
  });

  it("concatenates defaultArgs and extraArgs with a single space", () => {
    const result = renderProviderCommand({
      template: "claude {extra_args}",
      defaultArgs: "--dangerously-skip-permissions",
      extraArgs: "--model opus",
    });
    expect(result).toBe("claude --dangerously-skip-permissions --model opus\n");
  });

  it("produces no stray whitespace when both defaultArgs and extraArgs are empty", () => {
    const result = renderProviderCommand({
      template: "claude {extra_args}",
      defaultArgs: "",
      extraArgs: "",
    });
    // Both empty → effectiveExtraArgs is "" → substitution leaves trailing space from template
    expect(result).toBe("claude \n");
  });

  it("trims whitespace from defaultArgs before merging", () => {
    const result = renderProviderCommand({
      template: "claude {extra_args}",
      defaultArgs: "  --dangerously-skip-permissions  ",
      extraArgs: "  --model opus  ",
    });
    expect(result).toBe("claude --dangerously-skip-permissions --model opus\n");
  });

  it("uses only extraArgs when defaultArgs is empty string", () => {
    const result = renderProviderCommand({
      template: "claude {extra_args}",
      defaultArgs: "",
      extraArgs: "--verbose",
    });
    expect(result).toBe("claude --verbose\n");
  });

  // -------------------------------------------------------------------------
  // {cwd} substitution
  // -------------------------------------------------------------------------

  it("substitutes {cwd} with the provided cwd", () => {
    const result = renderProviderCommand({
      template: "claude --add-dir {cwd} {extra_args}",
      cwd: "/Users/me/proj",
      extraArgs: "",
    });
    expect(result).toBe("claude --add-dir /Users/me/proj \n");
  });

  it("collapses {cwd} to empty string when cwd is not provided", () => {
    const result = renderProviderCommand({
      template: "cmd --dir {cwd}",
    });
    expect(result).toBe("cmd --dir \n");
  });

  // -------------------------------------------------------------------------
  // {project_name}, {project_id}, {profile_name}
  // -------------------------------------------------------------------------

  it("substitutes {project_name}", () => {
    const result = renderProviderCommand({
      template: "tool --project {project_name}",
      projectName: "my-project",
    });
    expect(result).toBe("tool --project my-project\n");
  });

  it("substitutes {project_id}", () => {
    const result = renderProviderCommand({
      template: "tool --id {project_id}",
      projectId: 42,
    });
    expect(result).toBe("tool --id 42\n");
  });

  it("substitutes {profile_name} with the given profile name", () => {
    const result = renderProviderCommand({
      template: "claude --profile {profile_name}",
      profileName: "work",
    });
    expect(result).toBe("claude --profile work\n");
  });

  it("collapses {profile_name} to empty string when no profile selected", () => {
    const result = renderProviderCommand({
      template: "claude --profile {profile_name}",
      profileName: "",
    });
    expect(result).toBe("claude --profile \n");
  });

  it("handles all placeholders together", () => {
    const result = renderProviderCommand({
      template:
        "{project_name}/{project_id} @ {cwd} | {profile_name} | {extra_args}",
      projectName: "MyProj",
      projectId: 7,
      cwd: "/tmp/myproj",
      profileName: "dev",
      extraArgs: "--verbose",
    });
    expect(result).toBe("MyProj/7 @ /tmp/myproj | dev | --verbose\n");
  });

  // -------------------------------------------------------------------------
  // Unknown placeholder handling
  // -------------------------------------------------------------------------

  it("leaves unknown placeholders verbatim", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = renderProviderCommand({
      template: "claude {bogus} {extra_args}",
      extraArgs: "",
    });
    expect(result).toBe("claude {bogus} \n");
    warnSpy.mockRestore();
  });

  it("emits console.warn for each unique unknown placeholder", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderProviderCommand({
      template: "cmd {unknown1} {unknown2} {unknown1}",
    });
    // unknown1 appears twice but warn fires only once per unique key
    const calls = warnSpy.mock.calls;
    const mentionsUnknown1 = calls.filter((args) =>
      String(args[0]).includes("{unknown1}"),
    );
    const mentionsUnknown2 = calls.filter((args) =>
      String(args[0]).includes("{unknown2}"),
    );
    expect(mentionsUnknown1).toHaveLength(1);
    expect(mentionsUnknown2).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("does NOT warn for known placeholders", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderProviderCommand({
      template:
        "cmd {extra_args} {cwd} {project_name} {project_id} {profile_name} {model}",
      extraArgs: "x",
      cwd: "/tmp",
      projectName: "P",
      projectId: 1,
      profileName: "w",
      model: "claude-sonnet-4-6",
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // {model} substitution (task-launch feature)
  // -------------------------------------------------------------------------

  it("substitutes {model} with the provided model string", () => {
    const result = renderProviderCommand({
      template: "claude --model {model} {extra_args}",
      model: "claude-opus-4-7",
      extraArgs: "--no-color",
    });
    expect(result).toBe("claude --model claude-opus-4-7 --no-color\n");
  });

  it("collapses whitespace when {model} resolves to empty string", () => {
    const result = renderProviderCommand({
      template: "claude --model {model} {extra_args}",
      model: "",
      extraArgs: "",
    });
    // Both model and extra_args are empty → collapse to just "claude"
    expect(result).toBe("claude\n");
  });

  it("renders correctly when only model is set", () => {
    const result = renderProviderCommand({
      template: "claude --model {model}",
      model: "claude-haiku-4-5",
    });
    expect(result).toBe("claude --model claude-haiku-4-5\n");
  });

  // -------------------------------------------------------------------------
  // Always terminates with \n
  // -------------------------------------------------------------------------

  it("always appends a trailing newline", () => {
    const result = renderProviderCommand({ template: "claude" });
    expect(result.endsWith("\n")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // {session_id} sequencing contract
  // -------------------------------------------------------------------------

  it("leaves {session_id} verbatim when sessionId is not provided (undefined)", () => {
    // The pane UUID hasn't been generated yet at modal-submit time; the
    // placeholder must survive so applyGridLayout can inject it per-pane.
    const result = renderProviderCommand({
      template: "claude --model {model} {session_id} {mcp_config} {extra_args}",
      model: "claude-sonnet-4-6",
    });
    expect(result).toContain("{session_id}");
  });

  it("substitutes {session_id} when sessionId is explicitly provided", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = renderProviderCommand({
      template: "claude --model {model} {session_id} {extra_args}",
      model: "claude-sonnet-4-6",
      sessionId: uuid,
    });
    expect(result).toContain(`--session-id ${uuid}`);
    expect(result).not.toContain("{session_id}");
  });

  it("collapses {session_id} when sessionId is an explicit empty string", () => {
    // Explicit empty string = caller signalling 'not a Claude provider'.
    const result = renderProviderCommand({
      template: "claude --model {model} {session_id} {extra_args}",
      model: "claude-sonnet-4-6",
      sessionId: "",
      extraArgs: "--verbose",
    });
    expect(result).not.toContain("{session_id}");
    expect(result).not.toContain("--session-id");
  });

  it("renders full Claude template with both session_id and mcp_config", () => {
    // The desired end state: one launch produces both flags in the command.
    const uuid = "aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb";
    const mcpPath = "/tmp/codenest-mcp/project-1-abc.json";
    const result = renderProviderCommand({
      template: "claude --model {model} {session_id} {mcp_config} {extra_args}",
      model: "claude-sonnet-4-6",
      sessionId: uuid,
      mcpConfigPath: mcpPath,
      extraArgs: "--dangerously-skip-permissions",
    });
    expect(result).toContain(`--session-id ${uuid}`);
    expect(result).toContain(`--mcp-config ${mcpPath}`);
    expect(result).toContain("--dangerously-skip-permissions");
    expect(result.endsWith("\n")).toBe(true);
  });

  it("collapses {mcp_config} when mcpConfigPath is absent and session_id is preserved", () => {
    // No project MCP — only session_id should end up in the command.
    const uuid = "11112222-3333-4444-5555-666677778888";
    const result = renderProviderCommand({
      template: "claude --model {model} {session_id} {mcp_config} {extra_args}",
      model: "claude-sonnet-4-6",
      sessionId: uuid,
      // mcpConfigPath not provided
      extraArgs: "",
    });
    expect(result).toContain(`--session-id ${uuid}`);
    expect(result).not.toContain("--mcp-config");
    expect(result).not.toContain("{mcp_config}");
  });

  it("non-Claude template (no {session_id} placeholder) is unaffected by sessionId", () => {
    // Non-Claude providers don't have the placeholder; providing a sessionId
    // should not inject anything and no warn should be emitted.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = renderProviderCommand({
      template: "openai {extra_args}",
      sessionId: "some-uuid",
      extraArgs: "--flag",
    });
    expect(result).toBe("openai --flag\n");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// =============================================================================
// safeInjectClaudeArgs
// =============================================================================

describe("safeInjectClaudeArgs", () => {
  it("appends --session-id when missing from a claude command", () => {
    const uuid = "test-uuid-1234";
    const result = safeInjectClaudeArgs(
      "claude --model claude-sonnet-4-6\n",
      uuid,
    );
    expect(result).toContain(`--session-id ${uuid}`);
    expect(result.endsWith("\n")).toBe(true);
  });

  it("appends --mcp-config when path is provided and missing from command", () => {
    const uuid = "test-uuid-1234";
    const mcp = "/tmp/mcp.json";
    const result = safeInjectClaudeArgs(
      "claude --model claude-sonnet-4-6\n",
      uuid,
      mcp,
    );
    expect(result).toContain(`--mcp-config ${mcp}`);
  });

  it("appends both --session-id and --mcp-config when both are absent", () => {
    const uuid = "aaaa-bbbb-cccc";
    const mcp = "/tmp/project-mcp.json";
    const result = safeInjectClaudeArgs(
      "claude --dangerously-skip-permissions\n",
      uuid,
      mcp,
    );
    expect(result).toContain(`--session-id ${uuid}`);
    expect(result).toContain(`--mcp-config ${mcp}`);
    expect(result.endsWith("\n")).toBe(true);
  });

  it("does NOT double-append --session-id when already present", () => {
    const uuid = "aaaa-bbbb";
    const cmd = `claude --session-id ${uuid} --model opus\n`;
    const result = safeInjectClaudeArgs(cmd, uuid);
    expect(result.split("--session-id").length - 1).toBe(1);
  });

  it("does NOT double-append --mcp-config when already present", () => {
    const uuid = "test-uuid";
    const mcp = "/tmp/mcp.json";
    const cmd = `claude --mcp-config ${mcp}\n`;
    const result = safeInjectClaudeArgs(cmd, uuid, mcp);
    expect(result.split("--mcp-config").length - 1).toBe(1);
  });

  it("does NOT touch non-claude commands", () => {
    const cmd = "openai --flag\n";
    const result = safeInjectClaudeArgs(cmd, "some-uuid", "/tmp/mcp.json");
    expect(result).toBe(cmd);
  });

  it("does NOT touch commands whose first token is 'claude-code' (unrelated program)", () => {
    const cmd = "claude-code --flag\n";
    const result = safeInjectClaudeArgs(cmd, "some-uuid");
    // claude-code is an unrelated program — must not inject
    expect(result).toBe(cmd);
  });

  it("injects --session-id for aliased 'claude-work' commands (Anthropic alias)", () => {
    const uuid = "alias-uuid-5678";
    const result = safeInjectClaudeArgs("claude-work --dangerously-skip-permissions\n", uuid);
    expect(result).toContain(`--session-id ${uuid}`);
    expect(result.endsWith("\n")).toBe(true);
  });

  it("injects --session-id for aliased 'claude_personal' commands (underscore alias)", () => {
    const uuid = "underscore-uuid-9999";
    const result = safeInjectClaudeArgs("claude_personal --dangerously-skip-permissions\n", uuid);
    expect(result).toContain(`--session-id ${uuid}`);
    expect(result.endsWith("\n")).toBe(true);
  });

  it("injects both --session-id and --mcp-config for aliased 'claude-work' command", () => {
    const uuid = "work-uuid-1234";
    const mcp = "/tmp/codenest-mcp/proj-abc.json";
    const result = safeInjectClaudeArgs("claude-work --dangerously-skip-permissions\n", uuid, mcp);
    expect(result).toContain(`--session-id ${uuid}`);
    expect(result).toContain(`--mcp-config ${mcp}`);
    expect(result.endsWith("\n")).toBe(true);
  });

  it("preserves the command unchanged when sessionId is empty", () => {
    const cmd = "claude --model opus\n";
    const result = safeInjectClaudeArgs(cmd, "");
    // empty sessionId must not inject --session-id
    expect(result).not.toContain("--session-id");
  });

  it("does not append --mcp-config when mcpConfigPath is empty", () => {
    const cmd = "claude --model opus\n";
    const result = safeInjectClaudeArgs(cmd, "some-uuid", "");
    expect(result).not.toContain("--mcp-config");
    expect(result).toContain("--session-id some-uuid");
  });
});

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
// buildGridLayout
// =============================================================================

describe("buildGridLayout", () => {
  // -------------------------------------------------------------------------
  // Leaf count assertions
  // -------------------------------------------------------------------------

  it("1×1 produces exactly 1 leaf", () => {
    const layout = buildGridLayout({ rows: 1, cols: 1 });
    expect(collectLeaves(layout)).toHaveLength(1);
    expect(layout.type).toBe("leaf");
  });

  it("1×3 produces exactly 3 leaves", () => {
    const layout = buildGridLayout({ rows: 1, cols: 3 });
    expect(collectLeaves(layout)).toHaveLength(3);
  });

  it("2×2 produces exactly 4 leaves", () => {
    const layout = buildGridLayout({ rows: 2, cols: 2 });
    expect(collectLeaves(layout)).toHaveLength(4);
  });

  it("3×2 produces exactly 6 leaves", () => {
    const layout = buildGridLayout({ rows: 3, cols: 2 });
    expect(collectLeaves(layout)).toHaveLength(6);
  });

  it("4×2 produces exactly 8 leaves", () => {
    const layout = buildGridLayout({ rows: 4, cols: 2 });
    expect(collectLeaves(layout)).toHaveLength(8);
  });

  // -------------------------------------------------------------------------
  // Structure assertions
  // -------------------------------------------------------------------------

  it("1×1 root is a PaneLeaf", () => {
    const layout = buildGridLayout({ rows: 1, cols: 1 });
    expect(layout.type).toBe("leaf");
  });

  it("1×2 root is a horizontal Split", () => {
    const layout = buildGridLayout({ rows: 1, cols: 2 });
    expect(layout.type).toBe("split");
    if (layout.type === "split") {
      expect(layout.direction).toBe("h");
    }
  });

  it("2×1 root is a vertical Split", () => {
    const layout = buildGridLayout({ rows: 2, cols: 1 });
    expect(layout.type).toBe("split");
    if (layout.type === "split") {
      expect(layout.direction).toBe("v");
    }
  });

  it("2×2 root is a vertical Split containing two horizontal Splits", () => {
    const layout = buildGridLayout({ rows: 2, cols: 2 });
    expect(layout.type).toBe("split");
    if (layout.type !== "split") return;
    expect(layout.direction).toBe("v");
    expect(layout.children[0].type).toBe("split");
    expect(layout.children[1].type).toBe("split");
    if (layout.children[0].type === "split") {
      expect(layout.children[0].direction).toBe("h");
    }
    if (layout.children[1].type === "split") {
      expect(layout.children[1].direction).toBe("h");
    }
  });

  // -------------------------------------------------------------------------
  // cwd and initCommand propagation
  // -------------------------------------------------------------------------

  it("propagates cwd to every leaf", () => {
    const layout = buildGridLayout({ rows: 2, cols: 2, cwd: "/tmp/proj" });
    const leaves = collectLeaves(layout);
    expect(leaves).toHaveLength(4);
    for (const leaf of leaves) {
      expect(leaf.cwd).toBe("/tmp/proj");
    }
  });

  it("propagates initCommand to every leaf", () => {
    const layout = buildGridLayout({
      rows: 1,
      cols: 3,
      initCommand: "claude\n",
    });
    const leaves = collectLeaves(layout);
    for (const leaf of leaves) {
      expect(leaf.initCommand).toBe("claude\n");
    }
  });

  it("leaves cwd and initCommand undefined when not provided", () => {
    const layout = buildGridLayout({ rows: 1, cols: 2 });
    const leaves = collectLeaves(layout);
    for (const leaf of leaves) {
      expect(leaf.cwd).toBeUndefined();
      expect(leaf.initCommand).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // Cap enforcement — over-budget shapes throw
  // -------------------------------------------------------------------------

  it(`throws RangeError when rows*cols > ${GRID_MAX_PANES}`, () => {
    expect(() => buildGridLayout({ rows: 3, cols: 3 })).toThrow(RangeError);
  });

  it("throws RangeError when rows=0", () => {
    expect(() => buildGridLayout({ rows: 0, cols: 1 })).toThrow(RangeError);
  });

  it("throws RangeError when cols=0", () => {
    expect(() => buildGridLayout({ rows: 1, cols: 0 })).toThrow(RangeError);
  });

  it("throws RangeError when rows=5", () => {
    expect(() => buildGridLayout({ rows: 5, cols: 1 })).toThrow(RangeError);
  });

  it("throws RangeError when cols=5", () => {
    expect(() => buildGridLayout({ rows: 1, cols: 5 })).toThrow(RangeError);
  });

  it("4×2 = 8 panes does NOT throw (boundary is inclusive)", () => {
    expect(() => buildGridLayout({ rows: 4, cols: 2 })).not.toThrow();
  });

  it("2×4 = 8 panes does NOT throw (boundary is inclusive)", () => {
    expect(() => buildGridLayout({ rows: 2, cols: 4 })).not.toThrow();
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
