import {
  useCallback,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
  Component,
  type ErrorInfo,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  useLookups,
  createProfile,
  updateProfile,
  deleteProfile,
  upsertSetting,
  fetchSidecar,
  useTerminalSettings,
  useFactoryReset,
  TERMINAL_SETTING_DEFAULTS,
  SCREENSHOT_HOTKEY_DEFAULT,
  type ProfileOut,
  type SidecarError,
  type TerminalSettings,
} from "../lib/api";
import {
  DEFAULT_PREFS,
  NOTIF_QUERY_KEY,
  parseNotifPrefs,
  type NotifPrefs,
} from "../lib/notif-prefs";
import { Shell } from "../components/layout/shell";
import {
  useTerminalStore,
  TERMINAL_STORAGE_KEY,
} from "../stores/terminal-store";
import { collectLeaves, paneKind } from "../lib/layout-tree";
import { agentStop, closeTerminal } from "../lib/ipc";
import {
  SettingsNav,
  type SettingsSectionId,
} from "../components/settings/settings-nav";
import { ProvidersTab } from "../components/settings/providers-tab";
import { WorkflowLabelsTab } from "../components/settings/workflow-labels-tab";
import { FeaturesTab } from "../components/settings/features-tab";

// Stable empty sentinels. `lookups?.foo ?? []` produces a fresh array
// reference on every render before lookups resolves, which would make
// the `set state on prop change` pattern in ListEditor below treat the
// "same" empty list as different on every pass and cycle indefinitely.
const NO_STRINGS: string[] = [];
const NO_COLORS: Record<string, string> = {};

// Validates a global-shortcut accelerator string.  Requires at least one
// recognised modifier (Ctrl, Cmd/Command, Alt/Option, Shift, Super, Meta)
// followed by a + and a non-whitespace key token.  Examples that pass:
//   "Ctrl+Shift+2", "Cmd+Shift+S", "Super+K", "Alt+F4"
// Examples that fail (and are rejected before persist):
//   "asdf", "Ctrl", "Shift+Shift", ""
const HOTKEY_RE =
  /^(Ctrl|Cmd|Command|Alt|Option|Shift|Super|Meta)(\+(Ctrl|Cmd|Command|Alt|Option|Shift|Super|Meta))*\+\S+$/i;

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

interface ProfileFormState {
  name: string;
  color: string;
  icon: string;
  cwd_hint: string;
  claude_config_dir: string;
  default_model: string;
  default_project_id: string;
}

function emptyForm(): ProfileFormState {
  return {
    name: "",
    color: "#6366f1",
    icon: "user",
    cwd_hint: "",
    claude_config_dir: "",
    default_model: "",
    default_project_id: "",
  };
}

function fromProfile(p: ProfileOut): ProfileFormState {
  return {
    name: p.name,
    color: p.color,
    icon: p.icon,
    cwd_hint: p.cwd_hint ?? "",
    claude_config_dir: p.claude_config_dir ?? "",
    default_model: p.default_model ?? "",
    default_project_id: p.default_project_id
      ? String(p.default_project_id)
      : "",
  };
}

function toPayload(form: ProfileFormState) {
  return {
    name: form.name,
    color: form.color,
    icon: form.icon,
    cwd_hint: form.cwd_hint || null,
    claude_config_dir: form.claude_config_dir || null,
    default_model: form.default_model || null,
    default_project_id: form.default_project_id
      ? parseInt(form.default_project_id)
      : null,
  };
}

// ─── ErrorBoundary ────────────────────────────────────────────────────────────

interface ErrorBoundaryState {
  error: Error | null;
}

class SectionErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[SectionErrorBoundary]", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: "20px 16px",
            background: "var(--bg-3)",
            border: "1px solid #ef444450",
            borderRadius: 8,
            color: "var(--fg-1)",
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "#ef4444",
              marginBottom: 6,
            }}
          >
            This section failed to render
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--fg-3)",
              fontFamily: "var(--font-mono)",
              wordBreak: "break-all",
            }}
          >
            {this.state.error.message}
          </div>
          <button
            type="button"
            className="d3-btn d3-btn--ghost"
            style={{ marginTop: 12, fontSize: 12 }}
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const VALID_SECTIONS = new Set<SettingsSectionId>([
  "providers",
  "profiles",
  "features",
  "categories",
  "workflow-labels",
  "terminal",
  "notifications",
  "general",
]);

// Legacy section ids that were merged into "workflow-labels" — keep old links
// (?section=taxonomies / ?section=statuses) landing on the new section.
const LEGACY_SECTION_ALIASES: Record<string, SettingsSectionId> = {
  taxonomies: "workflow-labels",
  statuses: "workflow-labels",
};

function isValidSection(s: string | null): s is SettingsSectionId {
  return s !== null && VALID_SECTIONS.has(s as SettingsSectionId);
}

function resolveSection(s: string | null): SettingsSectionId {
  if (isValidSection(s)) return s;
  if (s !== null && s in LEGACY_SECTION_ALIASES)
    return LEGACY_SECTION_ALIASES[s] as SettingsSectionId;
  return "profiles";
}

export function SettingsPage(): ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawSection = searchParams.get("section");
  const activeSection: SettingsSectionId = resolveSection(rawSection);

  function handleSectionChange(section: SettingsSectionId): void {
    setSearchParams({ section }, { replace: true });
  }

  return (
    <Shell>
      <div style={{ padding: "0 24px 24px" }}>
        <div
          style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 28 }}
        >
          <SettingsNav active={activeSection} onChange={handleSectionChange} />

          <div style={{ minWidth: 0 }}>
            <SectionErrorBoundary key={activeSection}>
              <>
                {activeSection === "providers" && <ProvidersTab />}
                {activeSection === "profiles" && <ProfilesTab />}
                {activeSection === "features" && <FeaturesTab />}
                {activeSection === "general" && <GeneralTab />}
                {activeSection === "categories" && <CategoriesTab />}
                {activeSection === "workflow-labels" && <WorkflowLabelsTab />}
                {activeSection === "notifications" && <NotificationsTab />}
                {activeSection === "terminal" && <TerminalTab />}
              </>
            </SectionErrorBoundary>
          </div>
        </div>
      </div>
    </Shell>
  );
}

// ─── Profiles tab ────────────────────────────────────────────────────────────

function ProfilesTab(): ReactElement {
  const qc = useQueryClient();
  const { data: lookups } = useLookups();
  const profiles = lookups?.profiles ?? [];
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<ProfileFormState>(emptyForm());
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<{
    id: number;
    message: string;
  } | null>(null);

  function startNew(): void {
    setEditingId("new");
    setForm(emptyForm());
    setError(null);
  }

  function startEdit(p: ProfileOut): void {
    setEditingId(p.id);
    setForm(fromProfile(p));
    setError(null);
  }

  async function save(): Promise<void> {
    setError(null);
    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }
    try {
      if (editingId === "new") {
        await createProfile(toPayload(form));
      } else if (typeof editingId === "number") {
        await updateProfile(editingId, toPayload(form));
      }
      void qc.invalidateQueries({ queryKey: ["lookups"] });
      setEditingId(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save profile");
    }
  }

  async function remove(p: ProfileOut): Promise<void> {
    if (confirmDeleteId !== p.id) {
      setConfirmDeleteId(p.id);
      setRowError(null);
      return;
    }
    try {
      await deleteProfile(p.id);
      void qc.invalidateQueries({ queryKey: ["lookups"] });
      setConfirmDeleteId(null);
    } catch (e: unknown) {
      setRowError({
        id: p.id,
        message: e instanceof Error ? e.message : "Failed to delete profile",
      });
    }
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <span className="d3-h">Profiles</span>
        <button
          type="button"
          className="d3-btn d3-btn--primary"
          onClick={startNew}
        >
          + New Profile
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        {profiles.map((p) => (
          <div
            key={p.id}
            className="d3-card"
            style={{ padding: 16, borderLeft: `3px solid ${p.color}` }}
          >
            {/* Profile identity row */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 8,
              }}
            >
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 4,
                  background: p.color,
                }}
              />
              <span
                style={{ fontSize: 14, color: "var(--fg-0)", fontWeight: 600, flex: 1 }}
              >
                {p.name}
              </span>
              {/* Project count badge */}
              <span
                style={{
                  fontSize: 11,
                  padding: "1px 7px",
                  borderRadius: 10,
                  background: "var(--bg-3)",
                  border: "1px solid var(--line-2)",
                  color: "var(--fg-3)",
                }}
                title={`${p.project_count} project${p.project_count === 1 ? "" : "s"} in this group`}
              >
                {p.project_count} {p.project_count === 1 ? "project" : "projects"}
              </span>
            </div>
            {/* Provider binding metadata (secondary, shown only when present) */}
            {p.claude_config_dir && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--fg-4)",
                  fontFamily: "var(--font-mono)",
                  marginBottom: 6,
                }}
                title="Claude config directory bound to this profile for session attribution"
              >
                {p.claude_config_dir}
              </div>
            )}
            {rowError?.id === p.id && (
              <div style={{ fontSize: 11, color: "#ef4444", marginBottom: 6 }}>
                {rowError.message}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <button
                type="button"
                className="d3-btn d3-btn--ghost"
                onClick={() => startEdit(p)}
              >
                Edit
              </button>
              {confirmDeleteId === p.id && (
                <button
                  type="button"
                  className="d3-btn d3-btn--ghost"
                  style={{ color: "var(--fg-3)" }}
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
                    ? { background: "rgba(239,68,68,0.12)", fontWeight: 600 }
                    : {}),
                }}
                onClick={() => void remove(p)}
              >
                {confirmDeleteId === p.id ? "Confirm delete" : "Delete"}
              </button>
            </div>
          </div>
        ))}
      </div>

      {editingId !== null && (
        <div className="d3-card" style={{ padding: 20 }}>
          <span className="d3-h" style={{ display: "block", marginBottom: 12 }}>
            {editingId === "new" ? "New Profile" : `Edit "${form.name}"`}
          </span>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 120px",
              gap: 10,
              marginBottom: 10,
            }}
          >
            <div>
              <label style={fieldLabel}>Name *</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                style={inputStyle}
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
          <div style={{ marginBottom: 10 }}>
            <label style={fieldLabel}>
              Claude config dir{" "}
              <span style={{ color: "var(--fg-4)", fontStyle: "italic" }}>
                (provider binding — for session attribution)
              </span>
            </label>
            <input
              placeholder="/.claude-clientx/"
              value={form.claude_config_dir}
              onChange={(e) =>
                setForm({ ...form, claude_config_dir: e.target.value })
              }
              style={inputStyle}
            />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={fieldLabel}>
              Working directory hint{" "}
              <span style={{ color: "var(--fg-4)", fontStyle: "italic" }}>
                (optional)
              </span>
            </label>
            <input
              placeholder="/Users/me/Work/ClientX"
              value={form.cwd_hint}
              onChange={(e) => setForm({ ...form, cwd_hint: e.target.value })}
              style={inputStyle}
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={fieldLabel}>Icon</label>
            <input
              value={form.icon}
              onChange={(e) => setForm({ ...form, icon: e.target.value })}
              style={inputStyle}
            />
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
              onClick={() => setEditingId(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── General tab ─────────────────────────────────────────────────────────────

function GeneralTab(): ReactElement {
  const qc = useQueryClient();
  const { data: lookups } = useLookups();

  const [displayName, setDisplayName] = useState<string>("");
  const [role, setRole] = useState<string>("");
  const [identitySaved, setIdentitySaved] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [lastLookups, setLastLookups] = useState(lookups);

  // Sync local state when the remote data first resolves — uses the same
  // "track last seen" pattern as TerminalSettingsTab to avoid a setState-in-effect lint error.
  if (lookups !== lastLookups) {
    setLastLookups(lookups);
    if (lookups) {
      setDisplayName(lookups.user_display_name);
      setRole(lookups.user_role);
    }
  }

  const saveIdentity = useMutation<void, Error>({
    mutationFn: async () => {
      const name = displayName.trim() || "Operator";
      const roleVal = role.trim() || "Owner";
      await upsertSetting("user_display_name", name);
      await upsertSetting("user_role", roleVal);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["lookups"] });
      setIdentitySaved(true);
      setIdentityError(null);
      setTimeout(() => setIdentitySaved(false), 2000);
    },
    onError: (e) => {
      setIdentityError(e.message);
    },
  });

  return (
    <div>
      <span className="d3-h" style={{ display: "block", marginBottom: 12 }}>
        General
      </span>

      <div
        style={{
          border: "1px solid var(--line-2)",
          borderRadius: 8,
          padding: 20,
          marginBottom: 24,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--fg-3)",
            textTransform: "uppercase",
            letterSpacing: "0.07em",
            marginBottom: 16,
          }}
        >
          User Identity
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
          <div>
            <label style={fieldLabel} htmlFor="identity-display-name">
              Display Name
            </label>
            <input
              id="identity-display-name"
              style={inputStyle}
              type="text"
              value={displayName}
              placeholder="Operator"
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div>
            <label style={fieldLabel} htmlFor="identity-role">
              Role
            </label>
            <input
              id="identity-role"
              style={inputStyle}
              type="text"
              value={role}
              placeholder="Owner"
              onChange={(e) => setRole(e.target.value)}
            />
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            className="d3-btn d3-btn--primary"
            style={{ fontSize: 12 }}
            disabled={saveIdentity.isPending}
            onClick={() => saveIdentity.mutate()}
          >
            {saveIdentity.isPending ? "Saving…" : "Save"}
          </button>
          {identitySaved && (
            <span style={{ fontSize: 12, color: "var(--fg-3)" }}>Saved</span>
          )}
          {identityError && (
            <span style={{ fontSize: 12, color: "#ef4444" }}>{identityError}</span>
          )}
        </div>
      </div>

      <DangerZone />
    </div>
  );
}

// ─── Danger Zone ─────────────────────────────────────────────────────────────

/**
 * Stop every terminal child and forget the persisted tab layout, so a factory
 * reset leaves nothing running against the database and workspace it wipes.
 *
 * Both calls are idempotent for an unknown id, and every failure is swallowed:
 * a pane that cannot be torn down must not block the reset the user asked for.
 */
async function teardownSessionsForReset(): Promise<void> {
  try {
    const leaves = useTerminalStore
      .getState()
      .tabs.flatMap((tab) => collectLeaves(tab.layout));
    await Promise.allSettled(
      leaves.map((leaf) =>
        paneKind(leaf) === "agent"
          ? agentStop(leaf.terminalId)
          : closeTerminal(leaf.terminalId),
      ),
    );
    useTerminalStore.setState({
      tabs: [],
      activeTabId: "",
      focusedLeafId: null,
      maximizedLeafId: null,
    });
    // After the store write above, so the persistence subscriber cannot
    // re-write the key we just cleared.
    localStorage.removeItem(TERMINAL_STORAGE_KEY);
  } catch {
    /* non-fatal — the reset itself is what matters */
  }
}

function DangerZone(): ReactElement {
  const navigate = useNavigate();
  const reset = useFactoryReset();
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReset(): Promise<void> {
    if (!confirmed) {
      setConfirmed(true);
      return;
    }
    setError(null);
    try {
      // Tear down live sessions and persisted tabs *before* wiping the
      // database. Both outlive a reset otherwise: an agent session is only
      // stopped when its leaf leaves the store (that is what keeps it alive
      // across a sibling-close remount, see `agent-pane.tsx`), and no pane is
      // even mounted here — we are on the Settings page — so nothing would run
      // that cleanup. The result would be `claude` children and a restored tab
      // strip still pointing at the workspace the reset just recreated.
      await teardownSessionsForReset();

      await reset.mutateAsync();
      // Navigate to onboarding — the gate will redirect here anyway once the
      // query cache is cleared, but doing it explicitly avoids a flash.
      navigate("/onboarding", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed");
      setConfirmed(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid rgba(239,68,68,0.3)",
        borderRadius: 8,
        padding: 20,
        background: "rgba(239,68,68,0.04)",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "#ef4444",
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          marginBottom: 12,
        }}
      >
        Danger Zone
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div>
          <div
            style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-1)", marginBottom: 4 }}
          >
            Reset Command Center
          </div>
          <div style={{ fontSize: 12, color: "var(--fg-3)", maxWidth: 420 }}>
            Wipes all projects, tasks, sessions, settings, and agents, then
            restarts the first-run setup flow. This cannot be undone.
          </div>
          {error && (
            <div style={{ fontSize: 12, color: "#ef4444", marginTop: 6 }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          {confirmed && (
            <button
              type="button"
              className="d3-btn d3-btn--ghost"
              onClick={() => setConfirmed(false)}
              disabled={reset.isPending}
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleReset()}
            disabled={reset.isPending}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: confirmed
                ? "1px solid #ef4444"
                : "1px solid rgba(239,68,68,0.5)",
              background: confirmed ? "#ef4444" : "transparent",
              color: confirmed ? "#fff" : "#ef4444",
              fontSize: 13,
              fontWeight: confirmed ? 700 : 500,
              cursor: reset.isPending ? "not-allowed" : "pointer",
              opacity: reset.isPending ? 0.6 : 1,
              transition: "background 0.15s, color 0.15s, border-color 0.15s",
            }}
          >
            {reset.isPending
              ? "Resetting…"
              : confirmed
                ? "Yes, wipe everything"
                : "Reset Command Center"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── List editor (categories + statuses) ────────────────────────────────────

interface ListEditorProps {
  title: string;
  settingKey: string;
  values: string[];
  colors?: Record<string, string>;
  colorsKey?: string;
}

function ListEditor({
  title,
  settingKey,
  values,
  colors,
  colorsKey,
}: ListEditorProps): ReactElement {
  const qc = useQueryClient();
  const incomingColors = colors ?? NO_COLORS;
  const [items, setItems] = useState<string[]>(values);
  const [colorMap, setColorMap] =
    useState<Record<string, string>>(incomingColors);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastValues, setLastValues] = useState(values);
  if (values !== lastValues) {
    setLastValues(values);
    setItems(values);
  }
  const [lastColors, setLastColors] = useState(incomingColors);
  if (incomingColors !== lastColors) {
    setLastColors(incomingColors);
    setColorMap(incomingColors);
  }

  function add(): void {
    const v = draft.trim();
    if (!v) return;
    if (items.includes(v)) {
      setError(`"${v}" already exists`);
      return;
    }
    setError(null);
    setItems([...items, v]);
    setDraft("");
  }

  function remove(value: string): void {
    setItems(items.filter((i) => i !== value));
    if (colorsKey) {
      const next = { ...colorMap };
      delete next[value];
      setColorMap(next);
    }
  }

  async function save(): Promise<void> {
    await upsertSetting(settingKey, items);
    if (colorsKey) {
      await upsertSetting(colorsKey, colorMap);
    }
    void qc.invalidateQueries({ queryKey: ["lookups"] });
  }

  return (
    <div className="d3-card" style={{ padding: 20, marginBottom: 12 }}>
      <span className="d3-h" style={{ display: "block", marginBottom: 12 }}>
        {title}
      </span>
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}
      >
        {items.map((v) => {
          const color = colorMap[v];
          return (
            <span
              key={v}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 10px",
                background: "var(--bg-3)",
                border: `1px solid ${color ?? "var(--line-2)"}50`,
                color: color ?? "var(--fg-1)",
                borderRadius: 999,
                fontSize: 12,
              }}
            >
              {colorsKey && (
                <input
                  type="color"
                  value={color ?? "#94a3b8"}
                  onChange={(e) =>
                    setColorMap({ ...colorMap, [v]: e.target.value })
                  }
                  style={{
                    width: 18,
                    height: 18,
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                  }}
                  aria-label={`Color for ${v}`}
                />
              )}
              <span>{v}</span>
              <button
                type="button"
                onClick={() => remove(v)}
                aria-label={`Remove ${v}`}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--fg-3)",
                  cursor: "pointer",
                  padding: 0,
                  fontSize: 14,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </span>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add new…"
          style={{ ...inputStyle, maxWidth: 200 }}
        />
        <button type="button" className="d3-btn" onClick={add}>
          Add
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="d3-btn d3-btn--primary"
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
      {error && (
        <div style={{ fontSize: 12, color: "#ef4444", marginTop: 8 }}>
          {error}
        </div>
      )}
    </div>
  );
}

function CategoriesTab(): ReactElement {
  const { data: lookups } = useLookups();
  return (
    <div>
      <ListEditor
        title="Document categories"
        settingKey="document_categories"
        values={lookups?.document_categories ?? NO_STRINGS}
        colors={lookups?.document_category_colors ?? NO_COLORS}
        colorsKey="document_category_colors"
      />
    </div>
  );
}

// ─── Notifications tab ───────────────────────────────────────────────────────

const NOTIF_TYPES = [
  { key: "task_assigned", label: "Task Assigned" },
  { key: "blocker_resolved", label: "Blocker Resolved" },
  { key: "session_completed", label: "Session Completed" },
  { key: "session_failed", label: "Session Failed" },
  { key: "session_info", label: "Session Info" },
  { key: "cost_threshold", label: "Cost Threshold" },
  { key: "budget_threshold", label: "Budget Threshold" },
] as const;

type NotifType = (typeof NOTIF_TYPES)[number]["key"];

// ─── Terminal tab ─────────────────────────────────────────────────────────────

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): ReactElement {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        cursor: "pointer",
        padding: "10px 0",
        borderTop: "1px solid var(--line-2)",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2 }}
      />
      <div>
        <div style={{ fontSize: 13, color: "var(--fg-1)" }}>{label}</div>
        {description && (
          <div style={{ fontSize: 11, color: "var(--fg-4)", marginTop: 2 }}>
            {description}
          </div>
        )}
      </div>
    </label>
  );
}

function TerminalTab(): ReactElement {
  const qc = useQueryClient();
  const { data: saved } = useTerminalSettings();

  // TERMINAL_SETTING_DEFAULTS already contains screenshot_hotkey so no override needed.
  const [form, setForm] = useState<TerminalSettings>(TERMINAL_SETTING_DEFAULTS);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<TerminalSettings | undefined>(
    undefined,
  );

  // Sync local state when the remote data first resolves — uses the same
  // "track last seen" pattern as ListEditor above to avoid an effect.
  if (saved !== lastSaved) {
    setLastSaved(saved);
    if (saved) setForm(saved);
  }

  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved_, setSaved_] = useState(false);

  // When App.tsx's registration catch fires (shortcut taken or malformed), it
  // dispatches "screenshot:hotkey-error" so the error reaches the settings UI.
  useEffect(() => {
    function onHotkeyError(e: Event): void {
      const msg = (e as CustomEvent<string>).detail;
      setHotkeyError(
        msg ||
          "That shortcut is unavailable — it may be in use by another app.",
      );
    }
    document.addEventListener("screenshot:hotkey-error", onHotkeyError);
    return () =>
      document.removeEventListener("screenshot:hotkey-error", onHotkeyError);
  }, []);

  async function saveAll(): Promise<void> {
    setSaveError(null);
    setHotkeyError(null);

    const hotkey = form.screenshot_hotkey.trim();

    // Format validation: must be at least one modifier (Ctrl|Cmd|Command|Alt|
    // Option|Shift|Super|Meta) followed by + and a non-whitespace key token.
    // Catches "asdf", "Ctrl", "Shift+Shift", etc. before they are persisted.
    if (!HOTKEY_RE.test(hotkey)) {
      setHotkeyError(
        'Invalid format. Use modifier+key, e.g. "Ctrl+Shift+2" or "Cmd+Shift+S".',
      );
      return;
    }

    try {
      await Promise.all([
        upsertSetting("terminal.font_family", form.font_family),
        upsertSetting("terminal.font_size", form.font_size),
        upsertSetting("terminal.scrollback", form.scrollback),
        upsertSetting("terminal.copy_on_select", form.copy_on_select ? 1 : 0),
        upsertSetting("screenshot.hotkey", hotkey),
      ]);
      void qc.invalidateQueries({ queryKey: ["settings", "terminal"] });
      setSaved_(true);
      setTimeout(() => setSaved_(false), 2000);
      // Notify terminal panes so they can live-apply font changes.
      document.dispatchEvent(
        new CustomEvent("terminal:settings-changed", { detail: form }),
      );
      // App.tsx re-registers the hotkey automatically when screenshotHotkey
      // changes (driven by the query invalidation above).  On registration
      // failure it dispatches "screenshot:hotkey-error" which the useEffect
      // above receives and routes to setHotkeyError.
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : "Failed to save");
    }
  }

  return (
    <div>
      <span className="d3-h" style={{ display: "block", marginBottom: 12 }}>
        Terminal
      </span>

      <div className="d3-card" style={{ padding: 20, marginBottom: 12 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--fg-3)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            display: "block",
            marginBottom: 14,
          }}
        >
          Font
        </span>

        <div style={{ marginBottom: 12 }}>
          <label style={fieldLabel}>Font family</label>
          <input
            value={form.font_family}
            onChange={(e) => setForm({ ...form, font_family: e.target.value })}
            style={inputStyle}
            spellCheck={false}
          />
        </div>

        <div style={{ marginBottom: 4 }}>
          <label style={fieldLabel}>Font size (9–24)</label>
          <input
            type="number"
            min={9}
            max={24}
            value={form.font_size}
            onChange={(e) =>
              setForm({
                ...form,
                font_size: Math.max(
                  9,
                  Math.min(24, parseInt(e.target.value, 10) || 13),
                ),
              })
            }
            style={{ ...inputStyle, width: 80 }}
          />
        </div>
      </div>

      <div className="d3-card" style={{ padding: 20, marginBottom: 12 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--fg-3)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            display: "block",
            marginBottom: 14,
          }}
        >
          Session
        </span>

        <div style={{ marginBottom: 4 }}>
          <label style={fieldLabel}>Scrollback lines</label>
          <input
            type="number"
            min={1000}
            max={100000}
            step={1000}
            value={form.scrollback}
            onChange={(e) =>
              setForm({
                ...form,
                scrollback: Math.max(
                  1000,
                  Math.min(100_000, parseInt(e.target.value, 10) || 5000),
                ),
              })
            }
            style={{ ...inputStyle, width: 120 }}
          />
        </div>

      </div>

      <div className="d3-card" style={{ padding: 20, marginBottom: 12 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--fg-3)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            display: "block",
            marginBottom: 14,
          }}
        >
          Screenshot
        </span>

        <div style={{ marginBottom: 4 }}>
          <label style={fieldLabel}>Ring hotkey</label>
          <input
            value={form.screenshot_hotkey}
            onChange={(e) =>
              setForm({ ...form, screenshot_hotkey: e.target.value })
            }
            placeholder={SCREENSHOT_HOTKEY_DEFAULT}
            style={{ ...inputStyle, width: 220, fontFamily: "monospace" }}
            spellCheck={false}
          />
          <div style={{ fontSize: 11, color: "var(--fg-4)", marginTop: 4 }}>
            Global shortcut that opens the screenshot ring (e.g. Ctrl+Shift+2).
            Takes effect after saving — requires the app to be running in the
            foreground when the new binding is first used. If the combo is taken
            by another app the previous binding is kept.
          </div>
          {hotkeyError && (
            <div style={{ fontSize: 11, color: "#ef4444", marginTop: 4 }}>
              {hotkeyError}
            </div>
          )}
        </div>
      </div>

      <div
        className="d3-card"
        style={{ padding: "4px 20px 16px", marginBottom: 16 }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--fg-3)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            display: "block",
            paddingTop: 16,
            marginBottom: 4,
          }}
        >
          Behaviour
        </span>
        <ToggleRow
          label="Copy on select"
          description="Automatically copy selected text to the clipboard."
          checked={form.copy_on_select}
          onChange={(v) => setForm({ ...form, copy_on_select: v })}
        />
      </div>

      {saveError && (
        <div style={{ fontSize: 12, color: "#ef4444", marginBottom: 10 }}>
          {saveError}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          type="button"
          className="d3-btn d3-btn--primary"
          onClick={() => void saveAll()}
        >
          Save
        </button>
        {saved_ && (
          <span style={{ fontSize: 12, color: "var(--fg-3)" }}>Saved.</span>
        )}
      </div>
    </div>
  );
}

function NotificationsTab(): ReactElement {
  const qc = useQueryClient();

  const { data: prefSetting } = useQuery<
    { value_json: string } | null,
    SidecarError
  >({
    queryKey: NOTIF_QUERY_KEY,
    queryFn: () =>
      fetchSidecar<{ value_json: string } | null>(
        "/api/v1/settings/notification_prefs_json",
      ).catch(() => null),
  });

  const prefs: NotifPrefs = parseNotifPrefs(prefSetting?.value_json);

  // Mutation with optimistic update so the checkbox responds immediately and
  // rolls back if the server request fails.
  const toggleMutation = useMutation<
    unknown,
    SidecarError,
    { next: NotifPrefs },
    { previous: { value_json: string } | null | undefined }
  >({
    mutationFn: ({ next }) =>
      // Pass the plain object — upsertSetting will JSON.stringify it once.
      upsertSetting("notification_prefs_json", next),
    onMutate: async ({ next }) => {
      // Cancel any in-flight refetch so it doesn't overwrite the optimistic value.
      await qc.cancelQueries({ queryKey: NOTIF_QUERY_KEY });
      const previous = qc.getQueryData<{ value_json: string } | null>(
        NOTIF_QUERY_KEY,
      );
      // Optimistically write the new value into the cache.
      qc.setQueryData<{ value_json: string }>(NOTIF_QUERY_KEY, {
        value_json: JSON.stringify(next),
      });
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      // Rollback to the snapshot we captured in onMutate.
      qc.setQueryData(NOTIF_QUERY_KEY, ctx?.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: NOTIF_QUERY_KEY });
    },
  });

  const toggle = useCallback(
    (type: NotifType, channel: "toast" | "native") => {
      const next: NotifPrefs = { ...DEFAULT_PREFS, ...prefs };
      const existing = next[type] as
        | { toast: boolean; native: boolean }
        | undefined;
      const current = existing ?? { toast: false, native: false };
      next[type] = {
        toast: current.toast,
        native: current.native,
        [channel]: !current[channel],
      };
      toggleMutation.mutate({ next });
    },
    [prefs, toggleMutation],
  );

  return (
    <div style={{ padding: "20px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--fg-1)",
            marginBottom: 4,
          }}
        >
          Notification Preferences
        </div>
        <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
          Configure which events show toasts or native macOS notifications.
        </div>
      </div>
      <table
        style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}
      >
        <thead>
          <tr
            style={{
              color: "var(--fg-3)",
              fontSize: 11,
              textTransform: "uppercase",
            }}
          >
            <th
              style={{ textAlign: "left", padding: "6px 0", fontWeight: 500 }}
            >
              Event
            </th>
            <th
              style={{
                textAlign: "center",
                padding: "6px 12px",
                fontWeight: 500,
              }}
            >
              Toast
            </th>
            <th
              style={{
                textAlign: "center",
                padding: "6px 12px",
                fontWeight: 500,
              }}
            >
              Native
            </th>
          </tr>
        </thead>
        <tbody>
          {NOTIF_TYPES.map(({ key, label }) => {
            const p = (prefs[key] ?? DEFAULT_PREFS[key]) as {
              toast: boolean;
              native: boolean;
            };
            return (
              <tr
                key={key}
                style={{
                  borderTop: "1px solid var(--border-1)",
                  color: "var(--fg-1)",
                }}
              >
                <td style={{ padding: "10px 0" }}>{label}</td>
                <td style={{ textAlign: "center", padding: "10px 12px" }}>
                  <input
                    type="checkbox"
                    checked={p.toast}
                    onChange={() => toggle(key, "toast")}
                    aria-label={`${label} toast`}
                  />
                </td>
                <td style={{ textAlign: "center", padding: "10px 12px" }}>
                  <input
                    type="checkbox"
                    checked={p.native}
                    onChange={() => toggle(key, "native")}
                    aria-label={`${label} native`}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
