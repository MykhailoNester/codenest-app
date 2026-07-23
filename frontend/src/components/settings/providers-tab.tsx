/**
 * ProvidersTab — Settings → Workspace → Providers
 *
 * Full CRUD table for provider rows.  Includes inline create/edit form with
 * fields for name, display_name, color, command_template, default_args,
 * default_env (KEY=VALUE textarea), alias/command, config_home (browse), and
 * is_enabled toggle.
 */

import { useRef, useState, type ReactElement } from "react";
import {
  useProviders,
  useCreateProvider,
  useUpdateProvider,
  useDeleteProvider,
  useConfigHomes,
  useValidateProjectPath,
  type Provider,
} from "../../lib/api";
import { pickDirectory } from "../../lib/ipc";

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  background: "var(--bg-3)",
  border: "1px solid var(--line-2)",
  color: "var(--fg-0)",
  borderRadius: 6,
  fontSize: 13,
  boxSizing: "border-box",
};

const fieldLabel: React.CSSProperties = {
  fontSize: 11,
  color: "var(--fg-3)",
  display: "block",
  marginBottom: 4,
};

interface ProviderFormState {
  name: string;
  display_name: string;
  color: string;
  /** Full command_template string — kept in sync with command_alias. */
  command_template: string;
  /** Leading binary token shown in the Alias / Command field. */
  command_alias: string;
  default_args: string;
  default_env: string; // KEY=VALUE lines
  /**
   * Resolved absolute path for CLAUDE_CONFIG_DIR.
   * Empty string means "not set yet".
   */
  config_home: string;
  is_enabled: boolean;
  api_key: string;
  has_existing_api_key: boolean;
  base_url: string;
}

function emptyForm(): ProviderFormState {
  return {
    name: "",
    display_name: "",
    color: "#6366f1",
    command_template: "claude {extra_args}",
    command_alias: "claude",
    default_args: "",
    default_env: "",
    config_home: "",
    is_enabled: true,
    api_key: "",
    has_existing_api_key: false,
    base_url: "",
  };
}

function envToText(env: Record<string, string> | null | undefined): string {
  if (!env) return "";
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function textToEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function fromProvider(p: Provider): ProviderFormState {
  const safeEnv = p.default_env ?? {};
  const storedConfigHome = safeEnv["CLAUDE_CONFIG_DIR"] ?? "";
  // Build env text without the CLAUDE_CONFIG_DIR line — it's managed via the
  // dedicated Browse field so the textarea doesn't show a duplicate entry.
  const envWithoutConfigHome = Object.fromEntries(
    Object.entries(safeEnv).filter(([k]) => k !== "CLAUDE_CONFIG_DIR"),
  );
  return {
    name: p.name,
    display_name: p.display_name,
    color: p.color ?? "#6366f1",
    command_template: p.command_template,
    command_alias: commandAlias(p.command_template),
    default_args: p.default_args,
    default_env: envToText(envWithoutConfigHome),
    config_home: storedConfigHome,
    is_enabled: p.is_enabled,
    // The API never returns the cleartext key — leave the input empty so the
    // user types a new value only when they actually want to rotate or clear it.
    api_key: "",
    has_existing_api_key: p.has_api_key,
    base_url: p.base_url ?? "",
  };
}

// ── Alias helpers ────────────────────────────────────────────────────────────

/** Extract the leading binary token from a command_template string. */
function commandAlias(template: string): string {
  return template.trim().split(/\s+/)[0] ?? "claude";
}

/**
 * Rewrite the leading token in a command_template while preserving the rest
 * (placeholders included).
 */
function replaceCommandAlias(template: string, alias: string): string {
  const trimmed = template.trim();
  const spaceIdx = trimmed.search(/\s/);
  if (spaceIdx === -1) return alias;
  return alias + trimmed.slice(spaceIdx);
}

const TEMPLATE_CHIPS = [
  { label: "{cwd}", value: "{cwd}" },
  { label: "{extra_args}", value: "{extra_args}" },
  { label: "{project_name}", value: "{project_name}" },
  { label: "{project_id}", value: "{project_id}" },
  { label: "{profile_name}", value: "{profile_name}" },
];

export function ProvidersTab(): ReactElement {
  const { data: providers = [] } = useProviders(true);
  const { data: configHomesData } = useConfigHomes();
  const createProvider = useCreateProvider();
  const updateProvider = useUpdateProvider();
  const deleteProvider = useDeleteProvider();
  const validatePath = useValidateProjectPath();

  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<ProviderFormState>(emptyForm());
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<{
    id: number;
    message: string;
  } | null>(null);
  const [configHomeValid, setConfigHomeValid] = useState<
    boolean | null
  >(null);
  const [pickingDir, setPickingDir] = useState(false);

  // Root element ref — used to find the scroll container ancestor on cancel/save
  // and to scroll the form card into view when it opens.
  const rootRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  function scrollPageToTop(): void {
    requestAnimationFrame(() => {
      rootRef.current
        ?.closest(".d3-page-scroll")
        ?.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  function scrollFormIntoView(): void {
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  function startNew(): void {
    setEditingId("new");
    setForm(emptyForm());
    setError(null);
    setConfigHomeValid(null);
    scrollFormIntoView();
  }

  function startEdit(p: Provider): void {
    setEditingId(p.id);
    setForm(fromProvider(p));
    setError(null);
    // If the provider already has a config home, treat it as valid (it was
    // previously accepted and stored).
    const safeEnv = p.default_env ?? {};
    const existingHome = safeEnv["CLAUDE_CONFIG_DIR"] ?? "";
    setConfigHomeValid(existingHome !== "" ? true : null);
    scrollFormIntoView();
  }

  function cancel(): void {
    setEditingId(null);
    setError(null);
    setConfigHomeValid(null);
    scrollPageToTop();
  }

  function insertChip(chip: string): void {
    setForm((prev) => ({
      ...prev,
      command_template: prev.command_template + chip,
    }));
  }

  async function handleBrowse(): Promise<void> {
    setPickingDir(true);
    try {
      const picked = await pickDirectory();
      if (picked === null) return; // user cancelled
      setForm((prev) => ({ ...prev, config_home: picked }));
      setConfigHomeValid(null); // will validate below
      try {
        const result = await validatePath.mutateAsync(picked);
        setConfigHomeValid(result.exists && result.is_dir);
      } catch {
        setConfigHomeValid(false);
      }
    } finally {
      setPickingDir(false);
    }
  }

  async function handleChipPick(home: string): Promise<void> {
    setForm((prev) => ({ ...prev, config_home: home }));
    setConfigHomeValid(null);
    try {
      const result = await validatePath.mutateAsync(home);
      setConfigHomeValid(result.exists && result.is_dir);
    } catch {
      setConfigHomeValid(false);
    }
  }

  async function save(): Promise<void> {
    setError(null);
    if (!form.name.trim()) {
      setError("Name (slug) is required");
      return;
    }
    if (!form.display_name.trim()) {
      setError("Display name is required");
      return;
    }

    // Reconstruct command_template by replacing the leading token (alias).
    const effectiveTemplate = replaceCommandAlias(
      form.command_template,
      form.command_alias.trim() || "claude",
    );

    // Merge: textarea env vars + CLAUDE_CONFIG_DIR from the browse field.
    const textareaEnv = textToEnv(form.default_env);
    const mergedEnv: Record<string, string> = { ...textareaEnv };
    if (form.config_home.trim()) {
      mergedEnv["CLAUDE_CONFIG_DIR"] = form.config_home.trim();
    }

    const payload = {
      name: form.name.trim(),
      display_name: form.display_name.trim(),
      color: form.color,
      command_template: effectiveTemplate,
      default_args: form.default_args,
      default_env: mergedEnv,
      is_enabled: form.is_enabled,
      // Empty input = "leave existing value alone" because the cleartext
      // key isn't returned by the API and we never want to clobber it
      // accidentally on a generic Save.
      api_key: form.api_key.trim() || null,
      base_url: form.base_url.trim() || null,
    };

    try {
      if (editingId === "new") {
        await createProvider.mutateAsync(payload);
      } else if (typeof editingId === "number") {
        await updateProvider.mutateAsync({ id: editingId, patch: payload });
      }
      setEditingId(null);
      setConfigHomeValid(null);
      scrollPageToTop();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to save provider";
      // Surface 409 duplicate-name as a friendly message.
      if (msg.includes("409") || msg.toLowerCase().includes("conflict")) {
        setError(
          `A provider named "${form.name.trim()}" already exists. Choose a different name.`,
        );
      } else {
        setError(msg);
      }
    }
  }

  async function remove(p: Provider): Promise<void> {
    if (confirmDeleteId !== p.id) {
      setConfirmDeleteId(p.id);
      setRowError(null);
      return;
    }
    try {
      await deleteProvider.mutateAsync(p.id);
      setConfirmDeleteId(null);
    } catch (e: unknown) {
      setRowError({
        id: p.id,
        message: e instanceof Error ? e.message : "Failed to delete provider",
      });
    }
  }

  async function toggleEnabled(p: Provider): Promise<void> {
    try {
      await updateProvider.mutateAsync({
        id: p.id,
        patch: { is_enabled: !p.is_enabled },
      });
    } catch (e: unknown) {
      setRowError({
        id: p.id,
        message: e instanceof Error ? e.message : "Failed to update provider",
      });
    }
  }

  const suggestedHomes = configHomesData?.config_homes ?? [];

  return (
    <div ref={rootRef}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <span className="d3-h">Providers</span>
        <button
          type="button"
          className="d3-btn d3-btn--primary"
          onClick={startNew}
        >
          + New Provider
        </button>
      </div>

      {/* ── Empty state ────────────────────────────────────────────────── */}
      {providers.length === 0 && editingId === null && (
        <div
          style={{
            padding: "40px 24px",
            textAlign: "center",
            border: "1px dashed var(--line-2)",
            borderRadius: 8,
            marginBottom: 16,
          }}
        >
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: "var(--fg-1)",
              marginBottom: 8,
            }}
          >
            No providers configured
          </div>
          <div
            style={{ fontSize: 13, color: "var(--fg-3)", marginBottom: 16 }}
          >
            Add your first Anthropic alias to start launching Claude sessions.
          </div>
          <button
            type="button"
            className="d3-btn d3-btn--primary"
            onClick={startNew}
          >
            Add provider
          </button>
        </div>
      )}

      {/* ── Providers table ───────────────────────────────────────────── */}
      {providers.length > 0 && (
        <div style={{ overflowX: "auto", marginBottom: 16 }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid var(--line-2)",
                  color: "var(--fg-3)",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                <th
                  style={{
                    textAlign: "left",
                    padding: "6px 10px 6px 0",
                    fontWeight: 500,
                  }}
                >
                  Provider
                </th>
                <th
                  style={{
                    textAlign: "left",
                    padding: "6px 10px",
                    fontWeight: 500,
                  }}
                >
                  Command
                </th>
                <th
                  style={{
                    textAlign: "left",
                    padding: "6px 10px",
                    fontWeight: 500,
                  }}
                >
                  Config home
                </th>
                <th
                  style={{
                    textAlign: "center",
                    padding: "6px 10px",
                    fontWeight: 500,
                  }}
                >
                  Enabled
                </th>
                <th
                  style={{
                    textAlign: "right",
                    padding: "6px 0 6px 10px",
                    fontWeight: 500,
                  }}
                >
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => {
                const configDir = (p.default_env ?? {})["CLAUDE_CONFIG_DIR"];
                return (
                  <tr
                    key={p.id}
                    style={{
                      borderBottom: "1px solid var(--line-2)",
                      color: "var(--fg-1)",
                    }}
                  >
                    <td style={{ padding: "10px 10px 10px 0" }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: "50%",
                            background: p.color ?? "#6366f1",
                            flexShrink: 0,
                          }}
                        />
                        <div>
                          <div style={{ fontWeight: 500 }}>
                            {p.display_name}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--fg-4)" }}>
                            {p.name}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td
                      style={{
                        padding: "10px",
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color: "var(--fg-3)",
                        maxWidth: 160,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {p.command_template}
                    </td>
                    <td
                      style={{
                        padding: "10px",
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color: configDir ? "var(--fg-2)" : "var(--fg-4)",
                        maxWidth: 200,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {configDir ?? "—"}
                    </td>
                    <td style={{ padding: "10px", textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={p.is_enabled}
                        onChange={() => void toggleEnabled(p)}
                        aria-label={`${p.display_name} enabled`}
                      />
                    </td>
                    <td
                      style={{
                        padding: "10px 0 10px 10px",
                        textAlign: "right",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {rowError?.id === p.id && (
                        <div
                          style={{
                            fontSize: 11,
                            color: "#ef4444",
                            marginBottom: 4,
                          }}
                        >
                          {rowError.message}
                        </div>
                      )}
                      <button
                        type="button"
                        className="d3-btn d3-btn--ghost"
                        style={{ marginRight: 8 }}
                        onClick={() => startEdit(p)}
                      >
                        Edit
                      </button>
                      {confirmDeleteId === p.id && (
                        <button
                          type="button"
                          className="d3-btn d3-btn--ghost"
                          style={{ marginRight: 8, color: "var(--fg-3)" }}
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Cancel
                        </button>
                      )}
                      <button
                        type="button"
                        className="d3-btn d3-btn--ghost"
                        style={{
                          color: "#ef4444",
                          ...(confirmDeleteId === p.id
                            ? {
                                background: "rgba(239,68,68,0.12)",
                                fontWeight: 600,
                              }
                            : {}),
                        }}
                        onClick={() => void remove(p)}
                      >
                        {confirmDeleteId === p.id ? "Confirm delete" : "Delete"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Create / Edit form ────────────────────────────────────────── */}
      {editingId !== null && (
        <div ref={formRef} className="d3-card" style={{ padding: 20 }}>
          <span className="d3-h" style={{ display: "block", marginBottom: 12 }}>
            {editingId === "new"
              ? "New Provider"
              : `Edit "${form.display_name}"`}
          </span>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 80px",
              gap: 10,
              marginBottom: 10,
            }}
          >
            <div>
              <label style={fieldLabel}>Display name *</label>
              <input
                value={form.display_name}
                onChange={(e) =>
                  setForm({ ...form, display_name: e.target.value })
                }
                style={inputStyle}
              />
            </div>
            <div>
              <label style={fieldLabel}>Name (slug) *</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="claude-work"
                style={inputStyle}
                spellCheck={false}
                disabled={typeof editingId === "number"}
              />
            </div>
            <div>
              <label style={fieldLabel}>Color</label>
              <input
                type="color"
                value={form.color}
                onChange={(e) => setForm({ ...form, color: e.target.value })}
                style={{ ...inputStyle, padding: 4, height: 32 }}
              />
            </div>
          </div>

          {/* ── Alias / Command + Config Home ── */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
              marginBottom: 10,
            }}
          >
            <div>
              <label style={fieldLabel}>Alias / command</label>
              <input
                value={form.command_alias}
                onChange={(e) =>
                  setForm({ ...form, command_alias: e.target.value })
                }
                placeholder="claude"
                style={{
                  ...inputStyle,
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                }}
                spellCheck={false}
              />
              <div
                style={{
                  fontSize: 11,
                  color: "var(--fg-4)",
                  marginTop: 4,
                }}
              >
                The CLI the session invokes.
              </div>
            </div>

            {/* ── Config home: Browse + path display ── */}
            <div>
              <label style={fieldLabel}>Config home (CLAUDE_CONFIG_DIR)</label>

              {/* Path display + Browse button */}
              <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                <div
                  style={{
                    flex: 1,
                    padding: "6px 10px",
                    background: "var(--bg-3)",
                    border: `1px solid ${
                      configHomeValid === true
                        ? "#22c55e"
                        : configHomeValid === false
                          ? "#ef4444"
                          : "var(--line-2)"
                    }`,
                    borderRadius: 6,
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                    color: form.config_home
                      ? "var(--fg-1)"
                      : "var(--fg-4)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {form.config_home || "No directory selected"}
                </div>
                <button
                  type="button"
                  className="d3-btn d3-btn--ghost"
                  onClick={() => void handleBrowse()}
                  disabled={pickingDir}
                  style={{ flexShrink: 0, whiteSpace: "nowrap" }}
                >
                  {pickingDir ? "…" : "Browse…"}
                </button>
              </div>

              {/* Validation feedback */}
              {configHomeValid === false && (
                <div
                  style={{ fontSize: 11, color: "#ef4444", marginTop: 4 }}
                >
                  Path does not exist or is not a directory.
                </div>
              )}
              {configHomeValid === true && (
                <div
                  style={{ fontSize: 11, color: "#22c55e", marginTop: 4 }}
                >
                  Valid directory.
                </div>
              )}

              {/* Quick-pick chips from scanned ~/.claude* dirs */}
              {suggestedHomes.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 4,
                    marginTop: 6,
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      color: "var(--fg-4)",
                      alignSelf: "center",
                      marginRight: 2,
                    }}
                  >
                    Detected:
                  </span>
                  {suggestedHomes.map((h) => (
                    <button
                      key={h}
                      type="button"
                      onClick={() => void handleChipPick(h)}
                      style={{
                        fontSize: 10,
                        padding: "2px 8px",
                        background:
                          form.config_home === h
                            ? "var(--accent-soft, var(--bg-3))"
                            : "var(--bg-3)",
                        border: `1px solid ${form.config_home === h ? "var(--accent)" : "var(--line-2)"}`,
                        borderRadius: 4,
                        color:
                          form.config_home === h
                            ? "var(--accent)"
                            : "var(--fg-3)",
                        cursor: "pointer",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {h}
                    </button>
                  ))}
                </div>
              )}

              <div
                style={{
                  fontSize: 11,
                  color: "var(--fg-4)",
                  marginTop: 4,
                }}
              >
                Selects which Claude config &amp; auth the session uses.
              </div>
            </div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={fieldLabel}>Command template</label>
            <input
              value={form.command_template}
              onChange={(e) =>
                setForm({ ...form, command_template: e.target.value })
              }
              style={inputStyle}
              spellCheck={false}
            />
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 4,
                marginTop: 6,
              }}
            >
              {TEMPLATE_CHIPS.map((chip) => (
                <button
                  key={chip.value}
                  type="button"
                  onClick={() => insertChip(chip.value)}
                  style={{
                    fontSize: 10,
                    padding: "2px 8px",
                    background: "var(--bg-3)",
                    border: "1px solid var(--line-2)",
                    borderRadius: 4,
                    color: "var(--fg-3)",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={fieldLabel}>Default args</label>
            <input
              value={form.default_args}
              onChange={(e) =>
                setForm({ ...form, default_args: e.target.value })
              }
              placeholder="--dangerously-skip-permissions"
              style={inputStyle}
              spellCheck={false}
            />
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={fieldLabel}>
              Default env (KEY=VALUE, one per line; ~ is expanded at PTY spawn)
            </label>
            <textarea
              value={form.default_env}
              onChange={(e) =>
                setForm({ ...form, default_env: e.target.value })
              }
              rows={3}
              placeholder={"ANOTHER_VAR=value"}
              style={{
                ...inputStyle,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                resize: "vertical",
              }}
              spellCheck={false}
            />
            <div style={{ fontSize: 11, color: "var(--fg-4)", marginTop: 4 }}>
              CLAUDE_CONFIG_DIR is managed by the Config home field above.
            </div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={fieldLabel}>
              Base URL (optional — for OpenAI-compatible / Ollama)
            </label>
            <input
              type="text"
              value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              placeholder="https://api.openai.com/v1"
              style={inputStyle}
              spellCheck={false}
            />
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={fieldLabel}>
              API key (stored as plain text — Keychain integration is a
              follow-up)
            </label>
            <input
              type="password"
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              placeholder={
                form.has_existing_api_key ? "(set — type to rotate)" : "sk-…"
              }
              style={inputStyle}
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                cursor: "pointer",
                fontSize: 13,
                color: "var(--fg-1)",
              }}
            >
              <input
                type="checkbox"
                checked={form.is_enabled}
                onChange={(e) =>
                  setForm({ ...form, is_enabled: e.target.checked })
                }
              />
              Enabled
            </label>
          </div>

          {error && (
            <div style={{ fontSize: 12, color: "#ef4444", marginBottom: 10 }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="d3-btn d3-btn--primary"
              onClick={() => void save()}
            >
              Save
            </button>
            <button
              type="button"
              className="d3-btn d3-btn--ghost"
              onClick={cancel}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
