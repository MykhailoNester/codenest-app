/**
 * Settings — kept by the supervision pivot because providers and models are
 * what make model selection possible. Everything else here is the small set of
 * things that have nowhere else to live: profiles, workflow labels and
 * categories, terminal, notifications, telemetry, identity and the reset.
 *
 * The Features tab stays. It is the only writer of `enabled_features`, and
 * seven slugs still ship off (`_FEATURES_DEFAULT` in `settings_service.py`);
 * removing the tab before #274 deletes those pages would make them permanently
 * unreachable, which is the exact failure the "frontend chrome renders only
 * from known-good state" rule exists to prevent. See the ticket #343 report.
 *
 * Four sections — providers, workflow labels, features and telemetry — are
 * still their pre-Deck components under `components/settings/`. They are
 * outside this ticket's file scope and render on Deck's bridge tokens.
 */

import {
  useCallback,
  useEffect,
  useMemo,
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
import { DeckShell } from "../components/deck/deck-shell";
import {
  DeckGrid,
  DeckHead,
  DeckLine,
  type DeckState,
} from "../components/deck/deck-grid";
import { DeckMenu } from "../components/deck/deck-menu";
import {
  useTerminalStore,
  TERMINAL_STORAGE_KEY,
} from "../stores/terminal-store";
import { collectLeaves, paneKind } from "../lib/layout-tree";
import { agentStop, closeTerminal } from "../lib/ipc";
import { type SettingsSectionId } from "../components/settings/settings-nav";
import { ProvidersTab } from "../components/settings/providers-tab";
import { WorkflowLabelsTab } from "../components/settings/workflow-labels-tab";
import { FeaturesTab } from "../components/settings/features-tab";
import { TelemetryTab } from "../components/settings/telemetry-tab";

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

/* ── Shared Deck pieces ──────────────────────────────────────────────── */

/**
 * A section's heading and its actions in one container. Deck's rule is that
 * every action lives in a container and clusters use `.dk-actions`; `.dk-bar`
 * is the container the detail pages already use for exactly this.
 */
function SectionHead({
  label,
  note,
  actions,
}: {
  label: string;
  note?: ReactNode;
  actions?: ReactNode;
}): ReactElement {
  return (
    <div className="dk-bar">
      <h2
        style={{
          margin: 0,
          font: "inherit",
          fontSize: 12,
          fontWeight: 400,
          letterSpacing: "1.3px",
          textTransform: "uppercase",
          color: "var(--fg-2)",
        }}
      >
        {label}
      </h2>
      {note != null && <span className="dk-bar__ref">{note}</span>}
      {actions != null && (
        <>
          <span className="sp" />
          <span className="dk-actions">{actions}</span>
        </>
      )}
    </div>
  );
}

/** A labelled control. Deck has no form primitive of its own. */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <label
      htmlFor={htmlFor}
      style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}
    >
      <span className="dim" style={{ fontSize: "var(--fs-xs)" }}>
        {label}
        {hint && <span style={{ color: "var(--fg-4)" }}> — {hint}</span>}
      </span>
      {children}
    </label>
  );
}

/** The panel an inline editor sits in: one hairline, no card, no shadow. */
function Panel({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--u3)",
        padding: "var(--u3)",
        marginTop: "var(--u4)",
        border: "1px solid var(--line)",
        borderRadius: 3,
      }}
    >
      {children}
    </div>
  );
}

function FieldGrid({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
        gap: "var(--u3)",
      }}
    >
      {children}
    </div>
  );
}

function ErrorNote({ message }: { message: string }): ReactElement {
  return (
    <div className="dk-note" style={{ color: "var(--err)", padding: 0 }}>
      {message}
    </div>
  );
}

/* ── Profile form state ──────────────────────────────────────────────── */

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
            padding: "var(--u3)",
            border: "1px solid var(--err)",
            borderRadius: 3,
          }}
        >
          <div style={{ color: "var(--err)", marginBottom: "var(--u2)" }}>
            this section failed to render
          </div>
          <div className="dk-note" style={{ padding: 0 }}>
            {this.state.error.message}
          </div>
          <span className="dk-actions" style={{ marginTop: "var(--u3)" }}>
            <button
              type="button"
              className="dk-btn"
              onClick={() => this.setState({ error: null })}
            >
              retry
            </button>
          </span>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ── Section rail ────────────────────────────────────────────────────── */

interface SectionGroup {
  heading: string;
  items: { id: SettingsSectionId; label: string }[];
}

/** Lowercase, because Deck labels are. Mirrors `SettingsSectionId`. */
const SECTION_GROUPS: readonly SectionGroup[] = [
  {
    heading: "workspace",
    items: [
      { id: "providers", label: "providers" },
      { id: "profiles", label: "profiles" },
      { id: "features", label: "features" },
    ],
  },
  {
    heading: "workflow",
    items: [
      { id: "workflow-labels", label: "workflow labels" },
      { id: "categories", label: "categories" },
    ],
  },
  {
    heading: "interface",
    items: [{ id: "terminal", label: "terminal" }],
  },
  {
    heading: "system",
    items: [
      { id: "notifications", label: "notifications" },
      // #179. In Settings rather than behind a nav slug on purpose: this is
      // where telemetry is consented to *and* withdrawn, and Settings is the
      // one surface in the app that cannot be switched off in Features.
      { id: "telemetry", label: "telemetry" },
      { id: "general", label: "general" },
    ],
  },
];

const SECTION_LABEL: Record<string, string> = Object.fromEntries(
  SECTION_GROUPS.flatMap((g) => g.items.map((i) => [i.id, i.label])),
);

const VALID_SECTIONS = new Set<SettingsSectionId>([
  "providers",
  "profiles",
  "features",
  "categories",
  "workflow-labels",
  "terminal",
  "notifications",
  "telemetry",
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

function SectionRail({
  active,
  onChange,
}: {
  active: SettingsSectionId;
  onChange: (section: SettingsSectionId) => void;
}): ReactElement {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTION_GROUPS;
    return SECTION_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((i) => i.label.includes(q)),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  return (
    <nav aria-label="Settings sections" style={{ minWidth: 0 }}>
      <span className="dk-field" style={{ marginBottom: "var(--u3)" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter sections…"
          aria-label="Search settings"
        />
      </span>

      {groups.length === 0 && (
        <div className="dk-note" style={{ padding: "var(--u2)" }}>
          no matching settings.
        </div>
      )}

      {groups.map((group) => (
        <div className="dk-grp" key={group.heading}>
          <div className="dk-grp__h">{group.heading}</div>
          {group.items.map((item) => {
            const on = active === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`dk-nav${on ? " on" : ""}`}
                aria-current={on ? "page" : undefined}
                onClick={() => onChange(item.id)}
              >
                <span
                  className="dk-s dk-nav__g"
                  role="img"
                  aria-label={on ? "running" : "inert"}
                  data-s={on ? "run" : "idle"}
                />
                <span className="trunc">{item.label}</span>
                <span className="dk-nav__n" />
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/* ── Page ────────────────────────────────────────────────────────────── */

export function SettingsPage(): ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawSection = searchParams.get("section");
  const activeSection: SettingsSectionId = resolveSection(rawSection);

  function handleSectionChange(section: SettingsSectionId): void {
    setSearchParams({ section }, { replace: true });
  }

  return (
    <DeckShell
      title="settings"
      crumb={`${SECTION_LABEL[activeSection] ?? activeSection} · providers, models, and the little that is left`}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "176px minmax(0, 1fr)",
          gap: "var(--u8)",
          alignItems: "start",
        }}
      >
        <SectionRail active={activeSection} onChange={handleSectionChange} />

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
              {activeSection === "telemetry" && <TelemetryTab />}
            </>
          </SectionErrorBoundary>
        </div>
      </div>
    </DeckShell>
  );
}

// ─── Profiles tab ────────────────────────────────────────────────────────────

const COLS_PROFILE = "14px minmax(0, 1fr) 96px minmax(0, 1fr) auto";

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
      <SectionHead
        label="profiles"
        note="a claude config dir bound to a set of projects"
        actions={
          <button type="button" className="dk-btn" onClick={startNew}>
            + profile
          </button>
        }
      />

      {profiles.length === 0 ? (
        <div className="dk-note sans">
          No profiles yet. One profile is enough until two clients need separate
          Claude config directories.
        </div>
      ) : (
        <DeckGrid cols={COLS_PROFILE} label="Profiles">
          <DeckHead cells={["profile", "r projects", "config dir", "r "]} />
          {profiles.map((p) => (
            <DeckLine
              key={p.id}
              // A profile with no config dir cannot attribute a session, so it
              // is inert rather than bound.
              state={p.claude_config_dir ? "done" : "idle"}
              onOpen={() => startEdit(p)}
              cells={[
                {
                  v: (
                    <>
                      <span
                        aria-hidden="true"
                        style={{
                          display: "inline-block",
                          width: 8,
                          height: 8,
                          marginRight: 6,
                          borderRadius: 2,
                          background: p.color,
                          verticalAlign: "middle",
                        }}
                      />
                      {p.name}
                    </>
                  ),
                  cls: "sub",
                  title: p.name,
                },
                { v: String(p.project_count), cls: "r" },
                {
                  v: rowError?.id === p.id ? (
                    <span style={{ color: "var(--err)" }}>
                      {rowError.message}
                    </span>
                  ) : (
                    (p.claude_config_dir ?? "—")
                  ),
                  title: p.claude_config_dir ?? undefined,
                },
                {
                  v: (
                    <span
                      className="dk-actions end"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <DeckMenu
                        label={`Actions for ${p.name}`}
                        items={[
                          {
                            label: "Edit profile",
                            onSelect: () => {
                              setConfirmDeleteId(null);
                              startEdit(p);
                            },
                          },
                          {
                            label:
                              confirmDeleteId === p.id
                                ? "Confirm delete"
                                : "Delete profile",
                            danger: true,
                            separated: true,
                            onSelect: () => void remove(p),
                          },
                        ]}
                      />
                    </span>
                  ),
                  cls: "r",
                },
              ]}
            />
          ))}
        </DeckGrid>
      )}

      {editingId !== null && (
        <Panel>
          <div className="dim" style={{ fontSize: "var(--fs-s)" }}>
            {editingId === "new" ? "new profile" : `edit “${form.name}”`}
          </div>
          <FieldGrid>
            <Field label="name">
              <span className="dk-field">
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  aria-label="Profile name"
                />
              </span>
            </Field>
            <Field label="colour">
              <input
                type="color"
                value={form.color}
                onChange={(e) => setForm({ ...form, color: e.target.value })}
                aria-label="Profile colour"
                style={{
                  width: 48,
                  height: 24,
                  padding: 0,
                  border: "1px solid var(--line-2)",
                  borderRadius: 3,
                  background: "none",
                }}
              />
            </Field>
            <Field label="claude config dir" hint="for session attribution">
              <span className="dk-field">
                <input
                  placeholder="/.claude-clientx/"
                  value={form.claude_config_dir}
                  onChange={(e) =>
                    setForm({ ...form, claude_config_dir: e.target.value })
                  }
                  spellCheck={false}
                  aria-label="Claude config dir"
                />
              </span>
            </Field>
            <Field label="working directory hint" hint="optional">
              <span className="dk-field">
                <input
                  placeholder="~/Work/ClientX"
                  value={form.cwd_hint}
                  onChange={(e) =>
                    setForm({ ...form, cwd_hint: e.target.value })
                  }
                  spellCheck={false}
                  aria-label="Working directory hint"
                />
              </span>
            </Field>
            <Field label="icon">
              <span className="dk-field">
                <input
                  value={form.icon}
                  onChange={(e) => setForm({ ...form, icon: e.target.value })}
                  aria-label="Profile icon"
                />
              </span>
            </Field>
          </FieldGrid>
          {error && <ErrorNote message={error} />}
          <span className="dk-actions">
            <button
              type="button"
              className="dk-btn pri"
              onClick={() => void save()}
            >
              save
            </button>
            <button
              type="button"
              className="dk-btn"
              onClick={() => setEditingId(null)}
            >
              cancel
            </button>
          </span>
        </Panel>
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
  // "track last seen" pattern as TerminalTab to avoid a setState-in-effect lint error.
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
      <SectionHead
        label="general"
        note="who the rail says you are"
        actions={
          <>
            {identitySaved && <span className="dim">saved</span>}
            <button
              type="button"
              className="dk-btn pri"
              disabled={saveIdentity.isPending}
              onClick={() => saveIdentity.mutate()}
            >
              {saveIdentity.isPending ? "saving…" : "save"}
            </button>
          </>
        }
      />

      <FieldGrid>
        <Field label="display name" htmlFor="identity-display-name">
          <span className="dk-field">
            <input
              id="identity-display-name"
              type="text"
              value={displayName}
              placeholder="Operator"
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </span>
        </Field>
        <Field label="role" htmlFor="identity-role">
          <span className="dk-field">
            <input
              id="identity-role"
              type="text"
              value={role}
              placeholder="Owner"
              onChange={(e) => setRole(e.target.value)}
            />
          </span>
        </Field>
      </FieldGrid>
      {identityError && <ErrorNote message={identityError} />}

      <hr className="dk-rule" />
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
        padding: "var(--u3)",
        border: "1px solid var(--err)",
        borderRadius: 3,
      }}
    >
      <h2
        style={{
          margin: 0,
          font: "inherit",
          fontSize: 12,
          fontWeight: 400,
          letterSpacing: "1.3px",
          textTransform: "uppercase",
          color: "var(--err)",
        }}
      >
        danger zone
      </h2>
      <div className="dk-note sans" style={{ paddingLeft: 0 }}>
        <div style={{ color: "var(--fg-2)" }}>Reset Command Center</div>
        Wipes all projects, tasks, sessions, settings and agents, then restarts
        the first-run setup flow. This cannot be undone.
      </div>
      {error && <ErrorNote message={error} />}
      <span className="dk-actions">
        {confirmed && (
          <>
            <button
              type="button"
              className="dk-btn"
              onClick={() => setConfirmed(false)}
              disabled={reset.isPending}
            >
              cancel
            </button>
            <span className="sep" />
          </>
        )}
        <button
          type="button"
          className={confirmed ? "dk-btn danger pri" : "dk-btn danger"}
          onClick={() => void handleReset()}
          disabled={reset.isPending}
        >
          {reset.isPending
            ? "resetting…"
            : confirmed
              ? "yes, wipe everything"
              : "reset command center"}
        </button>
      </span>
    </div>
  );
}

// ─── List editor (categories) ────────────────────────────────────────────────

interface ListEditorProps {
  title: string;
  note: string;
  settingKey: string;
  values: string[];
  colors?: Record<string, string>;
  colorsKey?: string;
}

function ListEditor({
  title,
  note,
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
    <div>
      <SectionHead
        label={title}
        note={note}
        actions={
          <button
            type="button"
            className="dk-btn pri"
            onClick={() => void save()}
          >
            save
          </button>
        }
      />

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--u2)",
          marginBottom: "var(--u4)",
        }}
      >
        {items.length === 0 && (
          <span className="dim" style={{ fontSize: "var(--fs-s)" }}>
            none yet
          </span>
        )}
        {items.map((v) => {
          const color = colorMap[v];
          return (
            <span
              key={v}
              className="dk-tag"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: 24,
                color: color ?? undefined,
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
                    width: 14,
                    height: 14,
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
                className="dk-btn bare"
                style={{ height: 16, padding: "0 2px", color: "var(--fg-3)" }}
              >
                ×
              </button>
            </span>
          );
        })}
      </div>

      <span className="dk-actions">
        <span className="dk-field" style={{ width: 200 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="add new…"
            aria-label={`Add to ${title}`}
          />
        </span>
        <button type="button" className="dk-btn" onClick={add}>
          add
        </button>
      </span>
      {error && <ErrorNote message={error} />}
    </div>
  );
}

function CategoriesTab(): ReactElement {
  const { data: lookups } = useLookups();
  return (
    <ListEditor
      title="document categories"
      note="what a document can be filed under"
      settingKey="document_categories"
      values={lookups?.document_categories ?? NO_STRINGS}
      colors={lookups?.document_category_colors ?? NO_COLORS}
      colorsKey="document_category_colors"
    />
  );
}

// ─── Notifications tab ───────────────────────────────────────────────────────

const NOTIF_TYPES = [
  { key: "task_assigned", label: "task assigned" },
  { key: "blocker_resolved", label: "blocker resolved" },
  { key: "session_completed", label: "session completed" },
  { key: "session_failed", label: "session failed" },
  { key: "session_info", label: "session info" },
  { key: "cost_threshold", label: "cost threshold" },
  { key: "budget_threshold", label: "budget threshold" },
] as const;

type NotifType = (typeof NOTIF_TYPES)[number]["key"];

const NOTIF_STATE: Record<string, DeckState> = {
  session_failed: "fail",
  cost_threshold: "wait",
  budget_threshold: "wait",
};

const COLS_NOTIF = "14px minmax(0, 1fr) 80px 80px";

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
    <div>
      <SectionHead
        label="notifications"
        note="which events reach you, and how"
      />

      <DeckGrid cols={COLS_NOTIF} label="Notification preferences">
        <DeckHead cells={["event", "r toast", "r native"]} />
        {NOTIF_TYPES.map(({ key, label }) => {
          const p = (prefs[key] ?? DEFAULT_PREFS[key]) as {
            toast: boolean;
            native: boolean;
          };
          return (
            <DeckLine
              key={key}
              state={NOTIF_STATE[key] ?? "idle"}
              cells={[
                { v: label, cls: "sub" },
                {
                  v: (
                    <input
                      type="checkbox"
                      checked={p.toast}
                      onChange={() => toggle(key, "toast")}
                      aria-label={`${label} toast`}
                    />
                  ),
                  cls: "r",
                },
                {
                  v: (
                    <input
                      type="checkbox"
                      checked={p.native}
                      onChange={() => toggle(key, "native")}
                      aria-label={`${label} native`}
                    />
                  ),
                  cls: "r",
                },
              ]}
            />
          );
        })}
      </DeckGrid>
    </div>
  );
}

// ─── Terminal tab ─────────────────────────────────────────────────────────────

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
      <SectionHead
        label="terminal"
        note="shell, font, scrollback"
        actions={
          <>
            {saved_ && <span className="dim">saved</span>}
            <button
              type="button"
              className="dk-btn pri"
              onClick={() => void saveAll()}
            >
              save
            </button>
          </>
        }
      />

      <FieldGrid>
        <Field label="font family">
          <span className="dk-field">
            <input
              value={form.font_family}
              onChange={(e) =>
                setForm({ ...form, font_family: e.target.value })
              }
              spellCheck={false}
              aria-label="Terminal font family"
            />
          </span>
        </Field>
        <Field label="font size" hint="9–24">
          <span className="dk-field">
            <input
              type="number"
              min={9}
              max={24}
              value={form.font_size}
              aria-label="Terminal font size"
              onChange={(e) =>
                setForm({
                  ...form,
                  font_size: Math.max(
                    9,
                    Math.min(24, parseInt(e.target.value, 10) || 13),
                  ),
                })
              }
            />
          </span>
        </Field>
        <Field label="scrollback lines">
          <span className="dk-field">
            <input
              type="number"
              min={1000}
              max={100000}
              step={1000}
              value={form.scrollback}
              aria-label="Terminal scrollback lines"
              onChange={(e) =>
                setForm({
                  ...form,
                  scrollback: Math.max(
                    1000,
                    Math.min(100_000, parseInt(e.target.value, 10) || 5000),
                  ),
                })
              }
            />
          </span>
        </Field>
        <Field label="screenshot ring hotkey">
          <span className="dk-field">
            <input
              value={form.screenshot_hotkey}
              onChange={(e) =>
                setForm({ ...form, screenshot_hotkey: e.target.value })
              }
              placeholder={SCREENSHOT_HOTKEY_DEFAULT}
              spellCheck={false}
              aria-label="Screenshot ring hotkey"
            />
          </span>
        </Field>
      </FieldGrid>

      <div className="dk-note sans">
        The global shortcut that opens the screenshot ring (e.g. Ctrl+Shift+2).
        It takes effect after saving; if the combo is already taken by another
        app the previous binding is kept.
      </div>
      {hotkeyError && <ErrorNote message={hotkeyError} />}

      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "var(--u2)",
          padding: "var(--u3) 0",
          borderTop: "1px solid var(--line)",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={form.copy_on_select}
          onChange={(e) => setForm({ ...form, copy_on_select: e.target.checked })}
        />
        <span>
          copy on select
          <span
            className="dim"
            style={{ display: "block", fontSize: "var(--fs-xs)" }}
          >
            Automatically copy selected text to the clipboard.
          </span>
        </span>
      </label>

      {saveError && <ErrorNote message={saveError} />}
    </div>
  );
}
