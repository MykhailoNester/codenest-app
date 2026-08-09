/**
 * Sidecar HTTP client.
 *
 * In dev: targets the local FastAPI uvicorn process on 127.0.0.1:8002.
 * In production: targets the embedded PyInstaller sidecar (Phase 1) on the
 * same loopback URL — the binary is bundled inside the .app and started by
 * the Tauri shell.
 *
 * All sidecar fetches go through `fetchSidecar` so that the base URL,
 * default headers, and error handling can be changed in one place.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
  type UseQueryResult,
  type UseMutationResult,
} from "@tanstack/react-query";
import { sseRegistry, SSE_EVENT_NAMES } from "./sse-registry";
import { SIDECAR_BASE_URL } from "./sidecar-url";
import {
  FEATURE_DEFAULTS,
  FEATURE_CACHE_KEY,
  FEATURE_CACHE_EVENT,
} from "./nav-items";
import {
  AGENT_CATALOG_RESET_EVENT,
  AGENT_CATALOG_STORAGE_KEY,
  AGENT_SELECTION_STORAGE_KEY,
} from "./agent-storage-keys";

// Re-exported so any existing `import { FEATURE_CACHE_KEY } from "./api"`
// caller still resolves — the constant itself now lives in `nav-items.ts`
// (a leaf module with no imports) so a non-react-query consumer can read it
// without pulling in react-query.
export { FEATURE_CACHE_KEY };

// Re-exported so existing `import { SIDECAR_BASE_URL } from "./api"` callers keep
// working. The constant itself lives in `sidecar-url.ts` to avoid an import cycle
// with `sse-registry.ts` (which also needs it) — see that file for the history.
export { SIDECAR_BASE_URL };

export class SidecarError extends Error {
  public readonly status: number;
  public readonly path: string;

  constructor(message: string, status: number, path: string) {
    super(message);
    this.name = "SidecarError";
    this.status = status;
    this.path = path;
  }
}

export async function fetchSidecar<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const url = `${SIDECAR_BASE_URL}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new SidecarError(
      `Sidecar request failed: ${response.status} ${response.statusText}`,
      response.status,
      path,
    );
  }

  // Allow callers to opt out of JSON parsing by passing a non-json Accept header.
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as T;
  }
  return (await response.text()) as unknown as T;
}

/**
 * Health-check payload returned by the sidecar's `/health` endpoint.
 *
 * The legacy FastAPI app does not yet expose `/health`; until that endpoint
 * is added (Phase 1), `useHealth` will surface a non-200 SidecarError and
 * the hello page will render the "connecting…" state. This is expected.
 */
export interface SidecarHealth {
  status: string;
  version?: string;
}

export function useHealth(): UseQueryResult<SidecarHealth, SidecarError> {
  return useQuery<SidecarHealth, SidecarError>({
    queryKey: ["sidecar", "health"],
    queryFn: () => fetchSidecar<SidecarHealth>("/health"),
    refetchInterval: 5_000,
    retry: false,
  });
}

// ─── Command Center ──────────────────────────────────────────────────────────

export interface CommandCenterCounts {
  active: number;
  idle: number;
  ended: number;
  total: number;
}

export interface CommandCenterProject {
  id: number;
  name: string;
  path: string | null;
}

export interface CommandCenterData {
  counts: CommandCenterCounts;
  projects: CommandCenterProject[];
  inbox_count: number;
}

export function useCommandCenter(): UseQueryResult<
  CommandCenterData,
  SidecarError
> {
  return useQuery<CommandCenterData, SidecarError>({
    queryKey: ["command-center"],
    queryFn: () => fetchSidecar<CommandCenterData>("/api/v1/command-center"),
    refetchInterval: 30_000,
  });
}

export interface ActiveSessionCounts {
  /** Number of currently-active (non-idle, non-ended) sessions. */
  activeCount: number;
  /** Number of distinct projects with at least one active session. */
  activeProjects: number;
}

/**
 * Shell-level hook for the topbar headline badge.
 *
 * Derives counts from the already-polling `command-center` query so we don't
 * add a separate fetch at shell level.  The query key is shared with
 * `useCommandCenter()` — both hooks hit the same cached entry.
 *
 * `activeProjects` is not available from `/command-center` directly (it only
 * returns counts), so we derive it as the number of projects that have a
 * non-zero active count — approximated conservatively as 0 when counts.active
 * is 0, and counts.active otherwise (each session is typically a separate
 * project in practice).  The detailed per-project count is only needed for the
 * Command Center page's hero row, which computes it from the full session list.
 */
export function useActiveSessionCounts(): ActiveSessionCounts {
  const { data } = useCommandCenter();
  const activeCount = data?.counts.active ?? 0;
  // `/command-center` doesn't expose a distinct-projects count, but the
  // command-center page itself derives it from the full session list.
  // For the topbar badge (shell level) we expose just the raw active count.
  // The command-center page overwrites the Topbar title with its own metric
  // tile, so the headline here is only shown on other pages.
  return { activeCount, activeProjects: activeCount };
}

// ─── Agent sessions ──────────────────────────────────────────────────────────

export interface AgentSession {
  id: number;
  session_id: string;
  profile: string;
  status: "active" | "idle" | "stopped" | "ended";
  cwd: string | null;
  project_id: number | null;
  provider_id: number | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  project_name: string | null;
  initial_prompt: string | null;
  current_tool: string | null;
  total_tool_calls: number;
  started_at: string;
  ended_at: string | null;
  last_event_at: string | null;
}

export function useAgentSessions(
  profile?: string,
  status?: string,
  includeEnded?: boolean,
  providerId?: number | null,
): UseQueryResult<AgentSession[], SidecarError> {
  const params = new URLSearchParams();
  if (profile) params.set("profile", profile);
  if (status) params.set("status", status);
  if (includeEnded) params.set("include_ended", "true");
  if (providerId != null) params.set("provider_id", String(providerId));
  const qs = params.toString();
  return useQuery<AgentSession[], SidecarError>({
    queryKey: ["sessions", profile, status, includeEnded, providerId ?? null],
    queryFn: () =>
      fetchSidecar<AgentSession[]>(
        `/api/v1/agents/sessions${qs ? `?${qs}` : ""}`,
      ),
    refetchInterval: 30_000,
  });
}

// ─── Session-state HUD (per-pane strip) ──────────────────────────────────────

/**
 * Per-pane session-state facts for the terminal HUD strip (C1 — mirrors
 * `app/models/session_hud.py`'s `PaneHud`).
 *
 * Honesty contract: every optional field is `null` only when the app
 * genuinely does not know the value — the HUD renders no cell for it rather
 * than a placeholder. Live updates ride the existing `/agents/stream` SSE
 * connection as an additive `hud` field (C2, see `stores/session-hud-store.ts`);
 * this shape is also the one-shot hydration fetch on store activation (D3).
 */
export interface PaneHud {
  pane_id: string;
  session_id: string;
  status: "active" | "idle" | "stopped" | "ended";
  model: string | null;
  context_tokens: number | null;
  context_window: number | null;
  cost_usd: number;
  started_at: string;
  ended_at: string | null;
  current_tool: string | null;
  current_tool_started_at: string | null;
  thinking: boolean;
  todo_done: number | null;
  todo_total: number | null;
}

/**
 * One-shot hydration fetch for the session-state HUD store — a bare array,
 * not a `useQuery` hook. `stores/session-hud-store.ts` owns the single call
 * and fans the result out to every pane; a second caller belongs there, not
 * here (D3 — no new polling loop).
 */
export function fetchPaneHuds(): Promise<PaneHud[]> {
  return fetchSidecar<PaneHud[]>("/api/v1/agents/hud");
}

// ─── Reconcile stale sessions ────────────────────────────────────────────────

export interface CleanupStaleResult {
  closed: number;
  session_ids: string[];
}

export function useCleanupStaleSessions(): UseMutationResult<
  CleanupStaleResult,
  SidecarError,
  void
> {
  const queryClient = useQueryClient();
  return useMutation<CleanupStaleResult, SidecarError, void>({
    mutationFn: () =>
      fetchSidecar<CleanupStaleResult>(
        "/api/v1/agents/sessions/cleanup-stale",
        {
          method: "POST",
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["command-center"] });
      void queryClient.invalidateQueries({ queryKey: ["recent-events"] });
    },
  });
}

// ─── Ended sessions (paginated history) ──────────────────────────────────────

export interface EndedSessionsPage {
  items: AgentSession[];
  total: number;
}

export function useEndedSessions(
  offset: number,
  limit = 20,
): UseQueryResult<EndedSessionsPage, SidecarError> {
  return useQuery<EndedSessionsPage, SidecarError>({
    queryKey: ["sessions", "ended", offset, limit],
    queryFn: () =>
      fetchSidecar<EndedSessionsPage>(
        `/api/v1/agents/sessions/ended?limit=${limit}&offset=${offset}`,
      ),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

// ─── Recent events (Live Activity ticker) ────────────────────────────────────

export interface RecentEvent {
  id: number;
  session_id: string;
  event_type: string;
  tool_name: string | null;
  summary: string | null;
  payload_json: string | null;
  created_at: string;
  profile: string;
  status: string;
  provider_id: number | null;
  project_name: string | null;
}

export function useRecentEvents(
  limit = 50,
  providerId?: number | null,
): UseQueryResult<RecentEvent[], SidecarError> {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (providerId != null) params.set("provider_id", String(providerId));
  return useQuery<RecentEvent[], SidecarError>({
    queryKey: ["recent-events", limit, providerId ?? null],
    queryFn: () =>
      fetchSidecar<RecentEvent[]>(
        `/api/v1/agents/recent-events?${params.toString()}`,
      ),
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
}

// ─── Session replay ───────────────────────────────────────────────────────────

export interface AgentEvent {
  id: number;
  session_id: string;
  event_type: string;
  tool_name: string | null;
  summary: string | null;
  payload_json: string | null;
  created_at: string;
}

export interface SessionDetail {
  session: AgentSession;
  events: AgentEvent[];
}

export function useSessionReplay(
  sessionId: string,
): UseQueryResult<SessionDetail, SidecarError> {
  return useQuery<SessionDetail, SidecarError>({
    queryKey: ["session-replay", sessionId],
    queryFn: () =>
      fetchSidecar<SessionDetail>(
        `/api/v1/agents/sessions/${encodeURIComponent(sessionId)}`,
      ),
    enabled: Boolean(sessionId),
    refetchInterval: 10_000,
  });
}

// ─── Agent runs (multi-provider tracking) ────────────────────────────

/** A row from the unified agent list (``agent_runs`` + observe-only sessions). */
export interface AgentRun {
  /**
   * ``'run'`` for dashboard-launched agents (have a pane_id, Focus/Stop
   * actions available); ``'observe'`` for external hook-driven sessions
   * that are not linked to any ``agent_runs`` row (no actions).
   */
  row_kind: "run" | "observe";
  id: number | null;
  session_id: string | null;
  provider_id: number | null;
  project_id: number | null;
  pane_id: string | null;
  model: string | null;
  prompt_preview: string | null;
  status: "running" | "ended";
  source_kind: string | null;
  source_id: number | null;
  started_at: string;
  ended_at: string | null;
  /** Profile name (e.g. "work", "personal") — null for pre-migration rows. */
  profile: string | null;
  /**
   * Where the pane lives: ``'embedded'`` = main-window terminal grid,
   * ``'popout'`` = detached terminals window. ``null`` is treated as
   * ``'embedded'`` (safe fallback for pre-migration rows and observe-only rows).
   */
  target: "embedded" | "popout" | null;
  // joined provider fields
  provider_name: string | null;
  provider_display_name: string | null;
  provider_color: string | null;
  // joined project fields
  project_name: string | null;
  // joined session enrichment (Claude only, null for other providers)
  session_status: string | null;
  session_current_tool: string | null;
  session_tokens_in: number | null;
  session_tokens_out: number | null;
  session_cost_usd: number | null;
  session_initial_prompt: string | null;
  session_total_tool_calls: number | null;
  // joined schedule fields — set when this session is a scheduled run.
  schedule_id: number | null;
  schedule_name: string | null;
}

export function useAgentRuns(
  providerId?: number | null,
  status?: string,
  profile?: string,
  limit = 100,
): UseQueryResult<AgentRun[], SidecarError> {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (providerId != null) params.set("provider_id", String(providerId));
  if (status) params.set("status", status);
  if (profile) params.set("profile", profile);
  return useQuery<AgentRun[], SidecarError>({
    queryKey: [
      "agent-runs",
      providerId ?? null,
      status ?? null,
      profile ?? null,
      limit,
    ],
    queryFn: () =>
      fetchSidecar<AgentRun[]>(`/api/v1/agents/runs?${params.toString()}`),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

// ─── SSE live stream ─────────────────────────────────────────────────────────

// ─── Dashboard ────────────────────────────────────────────────────────────────

export interface TaskCounts {
  backlog: number;
  todo: number;
  "in-progress": number;
  blocked: number;
  done: number;
}

export interface ActivityEntry {
  id: number;
  entity_type: string;
  entity_id: number;
  action: string;
  old_value: string | null;
  new_value: string | null;
  actor: string;
  created_at: string;
}

export interface Task {
  id: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  effort: string | null;
  assignee_id: number | null;
  assignee_name: string | null;
  project_id: number;
  project_name: string | null;
  started_date: string | null;
  completed_date: string | null;
  created_at: string;
  updated_at: string;
  blockers?: TaskBlocker[];
  labels?: TaskLabel[];
}

/**
 * One `task_label` tag on a task. `id` is the `taxonomies.id` the
 * `/api/v1/tasks/{id}/labels` endpoints key on; `label` is the taxonomy row's
 * `display_name`. A task can carry any number of these.
 */
export interface TaskLabel {
  id: number;
  slug: string;
  label: string;
  color: string | null;
  sort_order: number;
}

export interface TaskBlocker {
  id: number;
  blocking_task_id: number;
  blocking_title: string;
  blocking_status: string;
}

export interface Project {
  id: number;
  name: string;
  description: string | null;
  tech_stack: string | null;
  status: string;
  path: string | null;
  /** Absolute filesystem root used by the Command Center / PTY launcher. */
  root_path: string | null;
  /** 1 when this row represents the synthetic workspace aggregate project. */
  is_workspace: number;
  /** 1 when the project is active (not archived). */
  is_active: number;
  /** FK → providers.id; null means "no default set". */
  default_provider_id: number | null;
  /** FK → profiles.id; null means unassigned / uses the default profile. */
  profile_id: number | null;
  created_at: string;
  total_tasks?: number;
  inbox_count?: number;
  task_counts?: Record<string, number>;
}

export interface DashboardData {
  task_counts: TaskCounts;
  inbox_count: number;
  projects: Project[];
  in_progress_tasks: Task[];
  recent_activity: ActivityEntry[];
}

export function useDashboard(): UseQueryResult<DashboardData, SidecarError> {
  return useQuery<DashboardData, SidecarError>({
    queryKey: ["dashboard"],
    queryFn: () => fetchSidecar<DashboardData>("/api/v1/dashboard"),
    refetchInterval: 10_000,
  });
}

// ─── Dashboard trends ─────────────────────────────────────────────────────────

export interface DashboardTrends {
  /** ISO date strings in ascending order, length == days. */
  dates: string[];
  /** Tasks completed each day. */
  tasks_done: number[];
  /** Agent cost (USD) each day. */
  cost_usd: number[];
  /** Dashboard-launched agent runs each day. */
  agent_runs: number[];
}

export function useDashboardTrends(
  days = 7,
): UseQueryResult<DashboardTrends, SidecarError> {
  return useQuery<DashboardTrends, SidecarError>({
    queryKey: ["dashboard-trends", days],
    queryFn: () =>
      fetchSidecar<DashboardTrends>(`/api/v1/dashboard/trends?days=${days}`),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export interface TaskFilters {
  status?: string;
  project_id?: string | number;
  assignee_id?: string | number;
  priority?: string;
  sort?: string;
}

export function useTasks(
  filters: TaskFilters = {},
): UseQueryResult<Task[], SidecarError> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return useQuery<Task[], SidecarError>({
    queryKey: ["tasks", filters],
    queryFn: () => fetchSidecar<Task[]>(`/api/v1/tasks${qs ? `?${qs}` : ""}`),
    refetchInterval: 10_000,
  });
}

export function useTask(taskId: number): UseQueryResult<Task, SidecarError> {
  return useQuery<Task, SidecarError>({
    queryKey: ["task", taskId],
    queryFn: () => fetchSidecar<Task>(`/api/v1/tasks/${taskId}`),
    enabled: taskId > 0,
  });
}

// Standalone fetchers (no hook — callers invalidate ["tasks"] / ["dashboard"]
// themselves after a write) for the Work Board's write paths. `tasks.tsx`
// used to call `fetchSidecar` inline for these three; relocated here so
// every sidecar URL for tasks lives in `api.ts`, following the
// createProfile/updateProfile precedent above.

export interface TaskCreateInput {
  title: string;
  description: string | null;
  status: string;
  priority: string;
  effort: string | null;
  assignee_id: number | null;
  project_id: number;
}

export function createTask(input: TaskCreateInput): Promise<{ id: number }> {
  return fetchSidecar<{ id: number }>("/api/v1/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export type TaskPatch = Partial<TaskCreateInput>;

export function updateTask(
  id: number,
  patch: TaskPatch,
): Promise<{ ok: true }> {
  return fetchSidecar<{ ok: true }>(`/api/v1/tasks/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function changeTaskStatus(
  id: number,
  status: string,
): Promise<{ ok: true }> {
  return fetchSidecar<{ ok: true }>(`/api/v1/tasks/${id}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

/**
 * Builds the next `board_wip_limits` map from `current` (delete the key when
 * `limit` is null, else set it) and writes it through the existing settings
 * endpoint. Never mutates `current` in place — the caller (`useLookups()`'s
 * cached value) is a React Query result, and mutating it in place trips
 * `react-hooks/immutability`. Does not invalidate `["lookups"]` itself,
 * mirroring `features-tab.tsx`'s upsertSetting call — the caller does that.
 */
export function setBoardWipLimit(
  current: Readonly<Record<string, number>>,
  statusSlug: string,
  limit: number | null,
): Promise<SettingOut> {
  const next = { ...current };
  if (limit === null) delete next[statusSlug];
  else next[statusSlug] = limit;
  return upsertSetting("board_wip_limits", next);
}

// ─── Task labels ──────────────────────────────────────────────────────────────
//
// Available labels come from `useTaxonomy("task_label")`, not from a fetcher
// here — see the `TaxonomyKind` union below. These four cover reading and
// writing the per-task assignment; there is no dedicated React Query hook —
// callers invalidate `["tasks"]` / `["dashboard"]` themselves after a write,
// since a task's `labels` array is embedded in both.

export function fetchTaskLabels(taskId: number): Promise<TaskLabel[]> {
  return fetchSidecar<TaskLabel[]>(`/api/v1/tasks/${taskId}/labels`);
}

export function setTaskLabels(
  taskId: number,
  labelIds: number[],
): Promise<TaskLabel[]> {
  return fetchSidecar<TaskLabel[]>(`/api/v1/tasks/${taskId}/labels`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label_ids: labelIds }),
  });
}

export function addTaskLabel(
  taskId: number,
  labelId: number,
): Promise<{ ok: true }> {
  return fetchSidecar<{ ok: true }>(`/api/v1/tasks/${taskId}/labels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label_id: labelId }),
  });
}

export function removeTaskLabel(
  taskId: number,
  labelId: number,
): Promise<{ ok: true }> {
  return fetchSidecar<{ ok: true }>(
    `/api/v1/tasks/${taskId}/labels/${labelId}`,
    { method: "DELETE" },
  );
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export function useProjects(): UseQueryResult<Project[], SidecarError> {
  return useQuery<Project[], SidecarError>({
    queryKey: ["projects"],
    queryFn: () => fetchSidecar<Project[]>("/api/v1/projects"),
    refetchInterval: 30_000,
  });
}

export type ProjectPatch = Partial<
  Pick<
    Project,
    | "name"
    | "description"
    | "tech_stack"
    | "status"
    | "path"
    | "default_provider_id"
    | "profile_id"
  >
>;

export function useUpdateProject(): UseMutationResult<
  Project,
  SidecarError,
  { id: number; patch: ProjectPatch }
> {
  const queryClient = useQueryClient();
  return useMutation<
    Project,
    SidecarError,
    { id: number; patch: ProjectPatch }
  >({
    mutationFn: ({ id, patch }) =>
      fetchSidecar<Project>(`/api/v1/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["lookups"] });
    },
  });
}

/**
 * Delete a project by id via the legacy `/api/v1/projects/{id}` endpoint.
 * Named `useDeleteProjectLegacy` to avoid collision with the Command Center's
 * `useDeleteWorkspaceProject` which hits `/api/v1/command-center/projects/{id}`.
 */
export function useDeleteProjectLegacy(): UseMutationResult<
  unknown,
  SidecarError,
  number
> {
  const queryClient = useQueryClient();
  return useMutation<unknown, SidecarError, number>({
    mutationFn: (id) =>
      fetchSidecar(`/api/v1/projects/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["lookups"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export interface PathValidationResult {
  exists: boolean;
  is_dir: boolean;
  absolute: boolean;
}

export function useValidateProjectPath(): UseMutationResult<
  PathValidationResult,
  SidecarError,
  string
> {
  return useMutation<PathValidationResult, SidecarError, string>({
    mutationFn: (path) =>
      fetchSidecar<PathValidationResult>("/api/v1/projects/validate-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      }),
  });
}

// ─── Project discovery ─────────────────────────────────────────────

export interface DiscoveryCandidate {
  name: string;
  path: string;
  stack: string | null;
  git: boolean;
  /** Detected AI tooling, e.g. ["claude"]. */
  tools: string[];
  /** Origin/first git remote URL, when the candidate is a git repo. */
  git_remote: string | null;
  /** Counts present only for Claude repos. */
  agents?: number;
  skills?: number;
  already_imported: boolean;
}

export interface ScanResponse {
  candidates: DiscoveryCandidate[];
}

export interface ScanRequest {
  roots?: string[];
  max_depth?: number;
  max_results?: number;
  /** Onboarding mode: only git repos qualify; walk through manifest-only dirs. */
  git_only?: boolean;
}

export interface ImportItem {
  path: string;
  name?: string;
  stack?: string | null;
}

export interface ImportResponse {
  imported: number;
  skipped: number;
  new_project_ids: number[];
}

export function useScanProjects(): UseMutationResult<
  ScanResponse,
  SidecarError,
  ScanRequest | undefined
> {
  return useMutation<ScanResponse, SidecarError, ScanRequest | undefined>({
    mutationFn: (body) =>
      fetchSidecar<ScanResponse>("/api/v1/projects/discovery/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      }),
  });
}

export function useImportProjects(): UseMutationResult<
  ImportResponse,
  SidecarError,
  ImportItem[]
> {
  const queryClient = useQueryClient();
  return useMutation<ImportResponse, SidecarError, ImportItem[]>({
    mutationFn: (items) =>
      fetchSidecar<ImportResponse>("/api/v1/projects/discovery/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["lookups"] });
    },
  });
}

export interface RichImportItem {
  path: string;
  name?: string;
  stack?: string | null;
  /** Profile to attach the imported project to; null = use server default. */
  profile_id?: number | null;
}

export interface RichImportResponse {
  imported: number;
  skipped: number;
  errors: string[];
}

/**
 * Onboarding-step import that routes each candidate through the rich
 * `POST /api/v1/command-center/projects` endpoint so that agents, skills,
 * and `root_path` are populated rather than the metadata-only discovery import.
 *
 * Duplicate projects (HTTP 400 from the sidecar) are counted as skipped so
 * a re-import is idempotent. All items are imported sequentially to avoid
 * overwhelming the sidecar with parallel DB writes.
 */
export function useRichImportProjects(): UseMutationResult<
  RichImportResponse,
  SidecarError,
  RichImportItem[]
> {
  const qc = useQueryClient();
  return useMutation<RichImportResponse, SidecarError, RichImportItem[]>({
    mutationFn: async (items) => {
      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];
      for (const item of items) {
        try {
          await fetchSidecar<ImportCommitResult>(`${CC_BASE}/projects`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              root_path: item.path,
              name: item.name,
              tech_stack: item.stack ?? undefined,
              enable_agents: true,
              enable_skills: true,
              enable_commands: false,
              ...(item.profile_id != null
                ? { profile_id: item.profile_id }
                : {}),
            }),
          });
          imported += 1;
        } catch (err) {
          // HTTP 400 means "already imported at this root_path" — treat as skip.
          if (err instanceof SidecarError && err.status === 400) {
            skipped += 1;
          } else {
            skipped += 1;
            errors.push(
              `${item.name ?? item.path}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
      return { imported, skipped, errors };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["workspace", "projects"] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["lookups"] });
    },
  });
}

// ─── Taxonomies ────────────────────────────────────────────────────

export type TaxonomyKind =
  | "task_status"
  | "task_priority"
  | "workflow_status"
  | "workflow_priority"
  | "task_label";

export interface Taxonomy {
  id: number;
  kind: TaxonomyKind;
  slug: string;
  display_name: string;
  sort_order: number;
  color: string | null;
  is_default: boolean;
  is_active: boolean;
}

export function useTaxonomies(): UseQueryResult<Taxonomy[], SidecarError> {
  return useQuery<Taxonomy[], SidecarError>({
    queryKey: ["taxonomies"],
    queryFn: () => fetchSidecar<Taxonomy[]>("/api/v1/taxonomies"),
    staleTime: 60_000,
  });
}

export function useTaxonomy(
  kind: TaxonomyKind,
): UseQueryResult<Taxonomy[], SidecarError> {
  return useQuery<Taxonomy[], SidecarError>({
    queryKey: ["taxonomies", kind],
    queryFn: () => fetchSidecar<Taxonomy[]>(`/api/v1/taxonomies/${kind}`),
    staleTime: 60_000,
  });
}

interface CreateTaxonomyInput {
  kind: TaxonomyKind;
  slug: string;
  display_name: string;
  sort_order?: number;
  color?: string | null;
}

export function useCreateTaxonomy(): UseMutationResult<
  Taxonomy,
  SidecarError,
  CreateTaxonomyInput
> {
  const queryClient = useQueryClient();
  return useMutation<Taxonomy, SidecarError, CreateTaxonomyInput>({
    mutationFn: (input) =>
      fetchSidecar<Taxonomy>("/api/v1/taxonomies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["taxonomies"] });
      void queryClient.invalidateQueries({ queryKey: ["lookups"] });
    },
  });
}

interface UpdateTaxonomyInput {
  id: number;
  patch: {
    display_name?: string;
    sort_order?: number;
    color?: string | null;
    is_active?: boolean;
  };
}

export function useUpdateTaxonomy(): UseMutationResult<
  Taxonomy,
  SidecarError,
  UpdateTaxonomyInput
> {
  const queryClient = useQueryClient();
  return useMutation<Taxonomy, SidecarError, UpdateTaxonomyInput>({
    mutationFn: ({ id, patch }) =>
      fetchSidecar<Taxonomy>(`/api/v1/taxonomies/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["taxonomies"] });
      void queryClient.invalidateQueries({ queryKey: ["lookups"] });
    },
  });
}

/** Reorder one taxonomy kind by supplying the full ordered id list. */
export function useReorderTaxonomy(): UseMutationResult<
  Taxonomy[],
  SidecarError,
  { kind: TaxonomyKind; orderedIds: number[] }
> {
  const queryClient = useQueryClient();
  return useMutation<
    Taxonomy[],
    SidecarError,
    { kind: TaxonomyKind; orderedIds: number[] }
  >({
    mutationFn: ({ kind, orderedIds }) =>
      fetchSidecar<Taxonomy[]>(`/api/v1/taxonomies/${kind}/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ordered_ids: orderedIds }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["taxonomies"] });
      void queryClient.invalidateQueries({ queryKey: ["lookups"] });
    },
  });
}

export function useDeleteTaxonomy(): UseMutationResult<
  { ok: true },
  SidecarError,
  number
> {
  const queryClient = useQueryClient();
  return useMutation<{ ok: true }, SidecarError, number>({
    mutationFn: (id) =>
      fetchSidecar<{ ok: true }>(`/api/v1/taxonomies/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["taxonomies"] });
      void queryClient.invalidateQueries({ queryKey: ["lookups"] });
    },
  });
}

// ─── Markdown Editor ───────────────────────────────────────────────

export type MarkdownKind = "claude" | "agents";

export interface MarkdownFile {
  project_id: number;
  kind: MarkdownKind;
  path: string;
  exists: boolean;
  content: string;
  sha: string;
}

export interface MarkdownDiff {
  project_id: number;
  kind: MarkdownKind;
  path: string;
  unified_diff: string;
  current_sha: string;
  proposed_sha: string;
  no_op: boolean;
}

export function useMarkdownFile(
  projectId: number | undefined,
  kind: MarkdownKind,
): UseQueryResult<MarkdownFile, SidecarError> {
  return useQuery<MarkdownFile, SidecarError>({
    queryKey: ["markdown-files", projectId, kind],
    queryFn: () =>
      fetchSidecar<MarkdownFile>(
        `/api/v1/markdown-files/${projectId}?kind=${kind}`,
      ),
    enabled: typeof projectId === "number" && projectId > 0,
    staleTime: 30_000,
  });
}

export function useMarkdownDiff(): UseMutationResult<
  MarkdownDiff,
  SidecarError,
  { projectId: number; kind: MarkdownKind; content: string }
> {
  return useMutation<
    MarkdownDiff,
    SidecarError,
    { projectId: number; kind: MarkdownKind; content: string }
  >({
    mutationFn: ({ projectId, kind, content }) =>
      fetchSidecar<MarkdownDiff>(`/api/v1/markdown-files/${projectId}/diff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, content }),
      }),
  });
}

export function useSaveMarkdownFile(): UseMutationResult<
  MarkdownFile,
  SidecarError,
  {
    projectId: number;
    kind: MarkdownKind;
    content: string;
    expected_sha: string | null;
  }
> {
  const queryClient = useQueryClient();
  return useMutation<
    MarkdownFile,
    SidecarError,
    {
      projectId: number;
      kind: MarkdownKind;
      content: string;
      expected_sha: string | null;
    }
  >({
    mutationFn: ({ projectId, kind, content, expected_sha }) =>
      fetchSidecar<MarkdownFile>(`/api/v1/markdown-files/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, content, expected_sha }),
      }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({
        queryKey: ["markdown-files", data.project_id, data.kind],
      });
    },
  });
}

// ─── Marketplace / Agent Gallery ─────────────────────────────────────────────

export type MarketplaceItemType =
  "agent" | "skill" | "subagent" | "hook" | "mcp" | "command";

export interface MarketplaceItem {
  slug: string;
  name: string;
  type: MarketplaceItemType;
  source: string;
  filename: string;
  summary?: string;
  tags?: string[];
}

export interface MarketplaceCatalog {
  items: MarketplaceItem[];
  sources: string[];
  types: string[];
}

export interface MarketplaceInstall {
  id: number;
  item_slug: string;
  item_type: MarketplaceItemType;
  source: string;
  project_id: number;
  installed_path: string;
  content_sha256: string;
  installed_at: string;
  project_name?: string;
  project_path?: string;
  exists?: boolean;
}

export interface MarketplaceInstallResult {
  id: number;
  item_slug: string;
  item_type: MarketplaceItemType;
  source: string;
  project_id: number;
  installed_path: string;
  content_sha256: string;
}

export function useMarketplaceCatalog(): UseQueryResult<
  MarketplaceCatalog,
  SidecarError
> {
  return useQuery<MarketplaceCatalog, SidecarError>({
    queryKey: ["marketplace", "items"],
    queryFn: () =>
      fetchSidecar<MarketplaceCatalog>("/api/v1/marketplace/items"),
    staleTime: 60_000,
  });
}

export function useMarketplaceInstalls(
  projectId?: number,
): UseQueryResult<{ installs: MarketplaceInstall[] }, SidecarError> {
  const path =
    typeof projectId === "number"
      ? `/api/v1/marketplace/installs?project_id=${projectId}`
      : "/api/v1/marketplace/installs";
  return useQuery<{ installs: MarketplaceInstall[] }, SidecarError>({
    queryKey: ["marketplace", "installs", projectId ?? "all"],
    queryFn: () => fetchSidecar<{ installs: MarketplaceInstall[] }>(path),
    staleTime: 15_000,
  });
}

export function useInstallMarketplaceItem(): UseMutationResult<
  MarketplaceInstallResult,
  SidecarError,
  { slug: string; projectId: number }
> {
  const queryClient = useQueryClient();
  return useMutation<
    MarketplaceInstallResult,
    SidecarError,
    { slug: string; projectId: number }
  >({
    mutationFn: ({ slug, projectId }) =>
      fetchSidecar<MarketplaceInstallResult>("/api/v1/marketplace/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, project_id: projectId }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["marketplace", "installs"],
      });
      // MCP installs also create an mcp_servers row server-side.
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
  });
}

// ─── Parallel Agent Runner ───────────────────────────────────────────────────

export type ParallelRunStatus = "open" | "merged" | "discarded";
export type ParallelAttemptStatus = "open" | "merged" | "discarded";

export interface ParallelRunSummary {
  id: number;
  project_id: number;
  prompt: string;
  attempts: number;
  status: ParallelRunStatus;
  default_branch: string;
  created_at: string;
  closed_at: string | null;
  project_name: string;
  project_path: string | null;
  attempt_count: number;
}

export interface ParallelAttempt {
  id: number;
  run_id: number;
  attempt_index: number;
  branch: string;
  worktree_path: string;
  status: ParallelAttemptStatus;
  merged_at: string | null;
  created_at: string;
}

export interface ParallelRunDetail {
  run: ParallelRunSummary;
  attempts: ParallelAttempt[];
}

export interface ParallelAttemptDiff {
  run_id: number;
  attempt_id: number;
  branch: string;
  base_branch: string;
  files: { status: string; path: string }[];
  unified_diff: string;
}

export function useParallelRuns(
  projectId?: number,
): UseQueryResult<{ runs: ParallelRunSummary[] }, SidecarError> {
  const path =
    typeof projectId === "number"
      ? `/api/v1/parallel-runs?project_id=${projectId}`
      : "/api/v1/parallel-runs";
  return useQuery<{ runs: ParallelRunSummary[] }, SidecarError>({
    queryKey: ["parallel-runs", projectId ?? "all"],
    queryFn: () => fetchSidecar<{ runs: ParallelRunSummary[] }>(path),
    staleTime: 15_000,
  });
}

export function useParallelRun(
  runId: number | undefined,
): UseQueryResult<ParallelRunDetail, SidecarError> {
  return useQuery<ParallelRunDetail, SidecarError>({
    queryKey: ["parallel-run", runId ?? 0],
    queryFn: () =>
      fetchSidecar<ParallelRunDetail>(`/api/v1/parallel-runs/${runId}`),
    enabled: typeof runId === "number" && runId > 0,
    staleTime: 10_000,
  });
}

export function useParallelAttemptDiff(
  runId: number | undefined,
  attemptId: number | undefined,
): UseQueryResult<ParallelAttemptDiff, SidecarError> {
  return useQuery<ParallelAttemptDiff, SidecarError>({
    queryKey: ["parallel-run-diff", runId ?? 0, attemptId ?? 0],
    queryFn: () =>
      fetchSidecar<ParallelAttemptDiff>(
        `/api/v1/parallel-runs/${runId}/attempts/${attemptId}/diff`,
      ),
    enabled:
      typeof runId === "number" &&
      runId > 0 &&
      typeof attemptId === "number" &&
      attemptId > 0,
    staleTime: 5_000,
  });
}

export function useCreateParallelRun(): UseMutationResult<
  ParallelRunDetail,
  SidecarError,
  { projectId: number; prompt: string; attempts: number }
> {
  const queryClient = useQueryClient();
  return useMutation<
    ParallelRunDetail,
    SidecarError,
    { projectId: number; prompt: string; attempts: number }
  >({
    mutationFn: ({ projectId, prompt, attempts }) =>
      fetchSidecar<ParallelRunDetail>("/api/v1/parallel-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId, prompt, attempts }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["parallel-runs"] });
    },
  });
}

export function useMergeParallelAttempt(): UseMutationResult<
  ParallelRunDetail,
  SidecarError,
  { runId: number; attemptId: number }
> {
  const queryClient = useQueryClient();
  return useMutation<
    ParallelRunDetail,
    SidecarError,
    { runId: number; attemptId: number }
  >({
    mutationFn: ({ runId, attemptId }) =>
      fetchSidecar<ParallelRunDetail>(
        `/api/v1/parallel-runs/${runId}/attempts/${attemptId}/merge`,
        { method: "POST" },
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["parallel-runs"] });
      void queryClient.invalidateQueries({
        queryKey: ["parallel-run", data.run.id],
      });
    },
  });
}

export function useDeleteParallelRun(): UseMutationResult<
  { run_id: number; status: string; removed: number },
  SidecarError,
  number
> {
  const queryClient = useQueryClient();
  return useMutation<
    { run_id: number; status: string; removed: number },
    SidecarError,
    number
  >({
    mutationFn: (runId) =>
      fetchSidecar<{ run_id: number; status: string; removed: number }>(
        `/api/v1/parallel-runs/${runId}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, runId) => {
      void queryClient.invalidateQueries({ queryKey: ["parallel-runs"] });
      void queryClient.invalidateQueries({ queryKey: ["parallel-run", runId] });
    },
  });
}

// ─── MCP Server Management ───────────────────────────────────────────────────

export interface McpServer {
  id: number;
  slug: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  source: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  /** Project-scoping mode. Defaults to 'all'. */
  scope_mode?: "all" | "allowlist" | "off";
}

export interface McpSuggested {
  slug: string;
  name: string;
  type: string;
  source: string;
  filename: string;
  summary?: string;
  tags?: string[];
}

export interface McpTestResult {
  ok: boolean;
  rc: number | null;
  timed_out: boolean;
  stderr_tail: string;
  detail: string;
}

export interface McpServerInput {
  slug: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled?: boolean;
  notes?: string | null;
}

export type McpServerPatch = Partial<
  Pick<McpServer, "name" | "command" | "args" | "env" | "enabled" | "notes">
>;

export function useMcpServers(): UseQueryResult<
  { servers: McpServer[] },
  SidecarError
> {
  return useQuery<{ servers: McpServer[] }, SidecarError>({
    queryKey: ["mcp-servers"],
    queryFn: () =>
      fetchSidecar<{ servers: McpServer[] }>("/api/v1/mcp-servers"),
    staleTime: 15_000,
  });
}

export function useMcpSuggested(): UseQueryResult<
  { items: McpSuggested[] },
  SidecarError
> {
  return useQuery<{ items: McpSuggested[] }, SidecarError>({
    queryKey: ["mcp-servers", "suggested"],
    queryFn: () =>
      fetchSidecar<{ items: McpSuggested[] }>("/api/v1/mcp-servers/suggested"),
    staleTime: 30_000,
  });
}

export function useCreateMcpServer(): UseMutationResult<
  McpServer,
  SidecarError,
  McpServerInput
> {
  const queryClient = useQueryClient();
  return useMutation<McpServer, SidecarError, McpServerInput>({
    mutationFn: (input) =>
      fetchSidecar<McpServer>("/api/v1/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
  });
}

export function useUpdateMcpServer(): UseMutationResult<
  McpServer,
  SidecarError,
  { id: number; patch: McpServerPatch }
> {
  const queryClient = useQueryClient();
  return useMutation<
    McpServer,
    SidecarError,
    { id: number; patch: McpServerPatch }
  >({
    mutationFn: ({ id, patch }) =>
      fetchSidecar<McpServer>(`/api/v1/mcp-servers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
  });
}

export function useDeleteMcpServer(): UseMutationResult<
  { id: number; deleted: boolean },
  SidecarError,
  number
> {
  const queryClient = useQueryClient();
  return useMutation<{ id: number; deleted: boolean }, SidecarError, number>({
    mutationFn: (id) =>
      fetchSidecar<{ id: number; deleted: boolean }>(
        `/api/v1/mcp-servers/${id}`,
        {
          method: "DELETE",
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
  });
}

export function useTestMcpServer(): UseMutationResult<
  McpTestResult,
  SidecarError,
  number
> {
  return useMutation<McpTestResult, SidecarError, number>({
    mutationFn: (id) =>
      fetchSidecar<McpTestResult>(`/api/v1/mcp-servers/${id}/test`, {
        method: "POST",
      }),
  });
}

// ─── MCP scoping + launch materialization ─────────────────────

/** An MCP server as returned by GET /effective — includes scope_mode. */
export interface EffectiveMcpServer extends McpServer {
  scope_mode: "all" | "allowlist" | "off";
}

export interface EffectiveMcpServersResult {
  servers: EffectiveMcpServer[];
  project_id: number;
}

/** GET /api/v1/mcp-servers/effective?project_id= */
export function useEffectiveMcpServers(
  projectId: number | "" | undefined,
): UseQueryResult<EffectiveMcpServersResult, SidecarError> {
  return useQuery<EffectiveMcpServersResult, SidecarError>({
    queryKey: ["mcp-servers", "effective", projectId],
    queryFn: () =>
      fetchSidecar<EffectiveMcpServersResult>(
        `/api/v1/mcp-servers/effective?project_id=${String(projectId)}`,
      ),
    enabled: typeof projectId === "number",
    staleTime: 10_000,
  });
}

export interface McpScopeInput {
  scope_mode: "all" | "allowlist" | "off";
  project_ids: number[];
}

/** POST /api/v1/mcp-servers/{id}/scope */
export function useSetMcpScope(): UseMutationResult<
  McpServer,
  SidecarError,
  { id: number; scope: McpScopeInput }
> {
  const queryClient = useQueryClient();
  return useMutation<
    McpServer,
    SidecarError,
    { id: number; scope: McpScopeInput }
  >({
    mutationFn: ({ id, scope }) =>
      fetchSidecar<McpServer>(`/api/v1/mcp-servers/${id}/scope`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scope),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
  });
}

export interface McpConfigResult {
  path: string;
  project_id: number;
}

/**
 * Imperatively call POST /api/v1/launches/mcp-config?project_id=.
 * Used at launch submit time — not a hook, since it's called inside an
 * async submit handler rather than at render time.
 *
 * ``excludeSlugs`` are applied server-side so the written config is the
 * authoritative record of what the launched agent can reach.  Pass the
 * per-launch exclusion set from the capability disclosure
 * panel so the file matches exactly what the panel showed.
 */
export async function materializeMcpConfig(
  projectId: number,
  excludeSlugs?: ReadonlySet<string> | string[],
): Promise<McpConfigResult> {
  const exclude =
    excludeSlugs instanceof Set ? [...excludeSlugs] : (excludeSlugs ?? []);
  return fetchSidecar<McpConfigResult>(
    `/api/v1/launches/mcp-config?project_id=${projectId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exclude_slugs: exclude }),
    },
  );
}

// ─── Agent Routing & Scheduling ──────────────────────────────────────────────

export type ScheduleKind = "cron" | "event" | "interval";

export type ScheduleRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "missed"
  | "timed_out"
  | "cancelled";

export type ScheduleRunTrigger = "scheduled" | "manual" | "catchup" | "event";

export type RunMode = "background" | "windowed";
export type ResultKind = "transcript" | "artifact" | "summary" | "notification";
export type NotifyPolicy = "on_failure" | "every_run" | "never";

export interface Schedule {
  id: number;
  name: string;
  kind: ScheduleKind;
  cron_expr: string | null;
  event_name: string | null;
  // Interval schedules ("every N from now").
  interval_seconds: number | null;
  anchor_at: string | null;
  agent_name: string;
  prompt: string;
  enabled: boolean;
  // Execution-bridge fields (Phase 1)
  project_id: number | null;
  provider_id: number | null;
  model: string | null;
  run_mode: RunMode;
  result_kind: ResultKind;
  permission_mode: string;
  allowed_tools: string | null;
  max_budget_usd: number | null;
  max_runtime_sec: number | null;
  notify_policy: NotifyPolicy;
  artifact_dir: string | null;
  next_fire_at: string | null;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleRun {
  id: number;
  schedule_id: number;
  trigger_kind: "cron" | "event" | "manual";
  trigger: ScheduleRunTrigger;
  status: ScheduleRunStatus;
  session_id: string | null;
  detail: string | null;
  fired_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  transcript_path: string | null;
  artifact_path: string | null;
  summary_text: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
}

/** Cron preview response from POST /schedules/cron-preview */
export interface CronPreview {
  cron_expr: string;
  description: string;
  next_fires: string[];
  /** Present when the preset resolves to an interval ("every N from now"). */
  interval_seconds?: number | null;
}

export interface ScheduleCreateInput {
  name: string;
  kind: ScheduleKind;
  cron_expr?: string | null;
  event_name?: string | null;
  interval_seconds?: number | null;
  agent_name: string;
  prompt?: string;
  enabled?: boolean;
  // Execution-bridge fields
  project_id?: number | null;
  provider_id?: number | null;
  model?: string | null;
  run_mode?: RunMode;
  result_kind?: ResultKind;
  permission_mode?: string;
  allowed_tools?: string | null;
  max_budget_usd?: number | null;
  max_runtime_sec?: number | null;
  notify_policy?: NotifyPolicy;
  artifact_dir?: string | null;
}

export type SchedulePatch = Partial<
  Pick<
    Schedule,
    | "name"
    | "cron_expr"
    | "event_name"
    | "interval_seconds"
    | "agent_name"
    | "prompt"
    | "enabled"
    | "project_id"
    | "provider_id"
    | "model"
    | "run_mode"
    | "result_kind"
    | "permission_mode"
    | "allowed_tools"
    | "max_budget_usd"
    | "max_runtime_sec"
    | "notify_policy"
    | "artifact_dir"
  >
>;

export function useSchedules(): UseQueryResult<
  { schedules: Schedule[] },
  SidecarError
> {
  return useQuery<{ schedules: Schedule[] }, SidecarError>({
    queryKey: ["schedules"],
    queryFn: () => fetchSidecar<{ schedules: Schedule[] }>("/api/v1/schedules"),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export function useScheduleRuns(
  scheduleId: number | undefined,
): UseQueryResult<{ runs: ScheduleRun[] }, SidecarError> {
  return useQuery<{ runs: ScheduleRun[] }, SidecarError>({
    queryKey: ["schedule-runs", scheduleId ?? 0],
    queryFn: () =>
      fetchSidecar<{ runs: ScheduleRun[] }>(
        `/api/v1/schedules/${scheduleId}/runs`,
      ),
    enabled: typeof scheduleId === "number" && scheduleId > 0,
    staleTime: 10_000,
  });
}

export function useCreateSchedule(): UseMutationResult<
  Schedule,
  SidecarError,
  ScheduleCreateInput
> {
  const queryClient = useQueryClient();
  return useMutation<Schedule, SidecarError, ScheduleCreateInput>({
    mutationFn: (input) =>
      fetchSidecar<Schedule>("/api/v1/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
}

export function useUpdateSchedule(): UseMutationResult<
  Schedule,
  SidecarError,
  { id: number; patch: SchedulePatch }
> {
  const queryClient = useQueryClient();
  return useMutation<
    Schedule,
    SidecarError,
    { id: number; patch: SchedulePatch }
  >({
    mutationFn: ({ id, patch }) =>
      fetchSidecar<Schedule>(`/api/v1/schedules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
}

export function useDeleteSchedule(): UseMutationResult<
  { id: number; deleted: boolean },
  SidecarError,
  number
> {
  const queryClient = useQueryClient();
  return useMutation<{ id: number; deleted: boolean }, SidecarError, number>({
    mutationFn: (id) =>
      fetchSidecar<{ id: number; deleted: boolean }>(
        `/api/v1/schedules/${id}`,
        {
          method: "DELETE",
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
}

export function useFireScheduleManual(): UseMutationResult<
  Schedule,
  SidecarError,
  number
> {
  const queryClient = useQueryClient();
  return useMutation<Schedule, SidecarError, number>({
    mutationFn: (id) =>
      fetchSidecar<Schedule>(`/api/v1/schedules/${id}/fire`, {
        method: "POST",
      }),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ["schedule-runs", id] });
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
}

export function useDispatchScheduleEvent(): UseMutationResult<
  { event_name: string; matched: number },
  SidecarError,
  { event_name: string; detail?: string }
> {
  const queryClient = useQueryClient();
  return useMutation<
    { event_name: string; matched: number },
    SidecarError,
    { event_name: string; detail?: string }
  >({
    mutationFn: (input) =>
      fetchSidecar<{ event_name: string; matched: number }>(
        "/api/v1/schedules/events",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
}

export function useScheduleRun(
  runId: number | undefined,
): UseQueryResult<ScheduleRun, SidecarError> {
  return useQuery<ScheduleRun, SidecarError>({
    queryKey: ["schedule-run", runId ?? 0],
    queryFn: () => fetchSidecar<ScheduleRun>(`/api/v1/schedules/runs/${runId}`),
    enabled: typeof runId === "number" && runId > 0,
    staleTime: 10_000,
  });
}

export interface RunTranscript {
  run_id: number;
  content: string | null;
}

export function useScheduleRunTranscript(
  runId: number | undefined,
): UseQueryResult<RunTranscript, SidecarError> {
  return useQuery<RunTranscript, SidecarError>({
    queryKey: ["schedule-run-transcript", runId ?? 0],
    queryFn: () =>
      fetchSidecar<RunTranscript>(`/api/v1/schedules/runs/${runId}/transcript`),
    enabled: typeof runId === "number" && runId > 0,
    staleTime: 30_000,
  });
}

// ─── Cron preview helper (powers the builder UI) ────────────────

export interface CronPreviewInput {
  cron_expr?: string;
  preset_kind?: string;
  hour?: number;
  minute?: number;
  weekdays?: number[];
  day_of_month?: number;
  every_n_hours?: number;
  count?: number;
}

/**
 * Preview a cron expression or preset: returns the canonical cron expression,
 * a plain-English description, and the next N fire times.
 *
 * Used by the builder UI to show a live preview before saving.
 */
export function useCronPreview(): UseMutationResult<
  CronPreview,
  SidecarError,
  CronPreviewInput
> {
  return useMutation<CronPreview, SidecarError, CronPreviewInput>({
    mutationFn: (input) =>
      fetchSidecar<CronPreview>("/api/v1/schedules/cron-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
  });
}

// ─── Schedule transcript retention settings ───────────────────────────────────

export interface ScheduleRetention {
  retention_days: number;
}

export function useScheduleRetention(): UseQueryResult<
  ScheduleRetention,
  SidecarError
> {
  return useQuery<ScheduleRetention, SidecarError>({
    queryKey: ["schedule-retention"],
    queryFn: () =>
      fetchSidecar<ScheduleRetention>("/api/v1/schedules/retention"),
  });
}

export function useSetScheduleRetention(): UseMutationResult<
  ScheduleRetention,
  SidecarError,
  number
> {
  const queryClient = useQueryClient();
  return useMutation<ScheduleRetention, SidecarError, number>({
    mutationFn: (days) =>
      fetchSidecar<ScheduleRetention>("/api/v1/schedules/retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retention_days: days }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["schedule-retention"] });
    },
  });
}

export function useCreateInboxItem(): UseMutationResult<
  { id: number },
  SidecarError,
  { title: string; description?: string; source?: string; type?: string }
> {
  const queryClient = useQueryClient();
  return useMutation<
    { id: number },
    SidecarError,
    { title: string; description?: string; source?: string; type?: string }
  >({
    mutationFn: (data) =>
      fetchSidecar<{ id: number }>("/api/v1/inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: data.title,
          description: data.description ?? null,
          source: data.source ?? "omni-bar",
          type: data.type ?? "prompt",
          priority: "normal",
          status: "inbox",
          action_text: null,
          project_id: null,
          submitted_date: null,
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
      void queryClient.invalidateQueries({ queryKey: ["inbox-counts"] });
    },
  });
}

// ─── Browser & Preview Pane ──────────────────────────────────────────────────

export interface PreviewDetect {
  port: number | null;
  url: string | null;
}

export interface PreviewVisit {
  id: number;
  url: string;
  title: string | null;
  visited_at: string;
}

export function useDetectDevServer(): UseQueryResult<
  PreviewDetect,
  SidecarError
> {
  return useQuery<PreviewDetect, SidecarError>({
    queryKey: ["preview-detect"],
    queryFn: () => fetchSidecar<PreviewDetect>("/api/v1/preview/detect"),
    // Probe every 15 s until *something* answers, then stop — the user can
    // click "Use dev server" to repick if their port changes.
    refetchInterval: (query) => (query.state.data?.url ? false : 15_000),
    staleTime: 10_000,
  });
}

export function usePreviewVisits(): UseQueryResult<
  { visits: PreviewVisit[] },
  SidecarError
> {
  return useQuery<{ visits: PreviewVisit[] }, SidecarError>({
    queryKey: ["preview-visits"],
    queryFn: () =>
      fetchSidecar<{ visits: PreviewVisit[] }>("/api/v1/preview/visits"),
    staleTime: 30_000,
  });
}

export function useRecordPreviewVisit(): UseMutationResult<
  PreviewVisit,
  SidecarError,
  { url: string; title?: string | null }
> {
  const queryClient = useQueryClient();
  return useMutation<
    PreviewVisit,
    SidecarError,
    { url: string; title?: string | null }
  >({
    mutationFn: ({ url, title }) =>
      fetchSidecar<PreviewVisit>("/api/v1/preview/visits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, title: title ?? null }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["preview-visits"] });
    },
  });
}

// ─── Multimodal Attachments ────────────────────────────────────────

export interface AttachmentMeta {
  id: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  extracted_text: string | null;
  inbox_item_id: number | null;
  created_at: string;
}

export interface AttachmentCreateInput {
  filename: string;
  mime_type: string;
  content_b64: string;
  inbox_item_id?: number | null;
}

export function useCreateAttachment(): UseMutationResult<
  AttachmentMeta,
  SidecarError,
  AttachmentCreateInput
> {
  const queryClient = useQueryClient();
  return useMutation<AttachmentMeta, SidecarError, AttachmentCreateInput>({
    mutationFn: (input) =>
      fetchSidecar<AttachmentMeta>("/api/v1/attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["attachments"] });
    },
  });
}

// ─── Knowledge Base / Context Library ──────────────────────────────

export interface LibraryItem {
  id: number;
  slug: string;
  title: string;
  body: string;
  tags: string[];
  source: string;
  created_at: string;
  updated_at: string;
}

export interface LibraryItemInput {
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  source?: string;
}

export type LibraryItemPatch = Partial<
  Pick<LibraryItem, "title" | "body" | "tags" | "source">
>;

export function useLibraryItems(
  q?: string,
  tag?: string,
  enabled = true,
): UseQueryResult<{ items: LibraryItem[] }, SidecarError> {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (tag) params.set("tag", tag);
  const qs = params.toString();
  return useQuery<{ items: LibraryItem[] }, SidecarError>({
    queryKey: ["library", q ?? "", tag ?? ""],
    queryFn: () =>
      fetchSidecar<{ items: LibraryItem[] }>(
        qs ? `/api/v1/library?${qs}` : "/api/v1/library",
      ),
    enabled,
    staleTime: 30_000,
  });
}

/**
 * One library item by slug, or `null` when there is none. The shared resolver
 * for `@library:<slug>`, needed because the list endpoint returns only the
 * newest 50.
 *
 * A 404 resolves to `null` rather than throwing — the omni-bar's `@`
 * resolution, the agent composer's mention menu and `useLibraryItemBySlug`
 * below all need "not found" to be a value, not an exception. Any *other*
 * failure still rejects and is not swallowed.
 */
export async function fetchLibraryItemBySlug(
  slug: string,
): Promise<LibraryItem | null> {
  try {
    return await fetchSidecar<LibraryItem>(
      `/api/v1/library/by-slug/${encodeURIComponent(slug)}`,
    );
  } catch (err) {
    if (err instanceof SidecarError && err.status === 404) return null;
    throw err;
  }
}

export function useLibraryItemBySlug(
  slug: string | undefined,
): UseQueryResult<LibraryItem | null, SidecarError> {
  return useQuery<LibraryItem | null, SidecarError>({
    queryKey: ["library-by-slug", slug ?? ""],
    queryFn: () => fetchLibraryItemBySlug(slug ?? ""),
    enabled: typeof slug === "string" && slug.length > 0,
    staleTime: 30_000,
  });
}

export function useCreateLibraryItem(): UseMutationResult<
  LibraryItem,
  SidecarError,
  LibraryItemInput
> {
  const queryClient = useQueryClient();
  return useMutation<LibraryItem, SidecarError, LibraryItemInput>({
    mutationFn: (input) =>
      fetchSidecar<LibraryItem>("/api/v1/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

export function useUpdateLibraryItem(): UseMutationResult<
  LibraryItem,
  SidecarError,
  { id: number; patch: LibraryItemPatch }
> {
  const queryClient = useQueryClient();
  return useMutation<
    LibraryItem,
    SidecarError,
    { id: number; patch: LibraryItemPatch }
  >({
    mutationFn: ({ id, patch }) =>
      fetchSidecar<LibraryItem>(`/api/v1/library/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

export function useDeleteLibraryItem(): UseMutationResult<
  { id: number; deleted: boolean },
  SidecarError,
  number
> {
  const queryClient = useQueryClient();
  return useMutation<{ id: number; deleted: boolean }, SidecarError, number>({
    mutationFn: (id) =>
      fetchSidecar<{ id: number; deleted: boolean }>(`/api/v1/library/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

// ─── Inbox ────────────────────────────────────────────────────────────────────

export interface InboxItem {
  id: number;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  status: string;
  source: string | null;
  project_id: number | null;
  project_name: string | null;
  task_id: number | null;
  submitted_date: string | null;
  created_at: string;
}

export interface InboxCounts {
  inbox: number;
  review: number;
  ready: number;
  done: number;
  rejected: number;
}

export function useInboxItems(
  status = "inbox",
  projectId?: number,
): UseQueryResult<InboxItem[], SidecarError> {
  const params = new URLSearchParams({ status });
  if (projectId) params.set("project_id", String(projectId));
  return useQuery<InboxItem[], SidecarError>({
    queryKey: ["inbox", status, projectId],
    queryFn: () =>
      fetchSidecar<InboxItem[]>(`/api/v1/inbox?${params.toString()}`),
    refetchInterval: 5_000,
  });
}

export function useInboxCounts(): UseQueryResult<InboxCounts, SidecarError> {
  return useQuery<InboxCounts, SidecarError>({
    queryKey: ["inbox-counts"],
    queryFn: () => fetchSidecar<InboxCounts>("/api/v1/inbox/counts"),
    refetchInterval: 5_000,
  });
}

export interface PromoteOptions {
  project_id: number;
  priority?: string;
  assignee_id?: number;
  notes?: string;
}

export function promoteInboxItem(
  id: number,
  opts: PromoteOptions,
): Promise<{ task_id: number }> {
  return fetchSidecar<{ task_id: number }>(`/api/v1/inbox/${id}/promote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
}

export function updateInboxItem(
  id: number,
  data: Partial<
    Pick<
      InboxItem,
      "title" | "description" | "status" | "priority" | "source" | "project_id"
    >
  >,
): Promise<{ ok: boolean }> {
  return fetchSidecar<{ ok: boolean }>(`/api/v1/inbox/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// ─── Team ─────────────────────────────────────────────────────────────────────

export interface TeamMember {
  id: number;
  name: string;
  role: string;
  type: string;
  subtype: string | null;
  department: string | null;
  status: string;
  agent_file: string | null;
  joined_date: string | null;
  notes: string | null;
}

export function useTeamMembers(): UseQueryResult<TeamMember[], SidecarError> {
  return useQuery<TeamMember[], SidecarError>({
    queryKey: ["team"],
    queryFn: () => fetchSidecar<TeamMember[]>("/api/v1/team"),
    refetchInterval: 60_000,
  });
}

// ─── Documents ────────────────────────────────────────────────────────────────

export interface Document {
  id: number;
  title: string;
  category: string;
  file_path: string;
  exists: boolean;
  summary: string | null;
  author_name: string | null;
  created_at: string;
}

export function useDocuments(
  category = "",
): UseQueryResult<Document[], SidecarError> {
  const qs = category ? `?category=${encodeURIComponent(category)}` : "";
  return useQuery<Document[], SidecarError>({
    queryKey: ["documents", category],
    queryFn: () => fetchSidecar<Document[]>(`/api/v1/documents${qs}`),
    refetchInterval: 30_000,
  });
}

export function useSidecarSSE(
  _eventKey: string,
  onEvent: (data: unknown, eventName: string) => void,
): void {
  // Latest-callback ref. The original implementation listed `onEvent` in
  // the effect deps, which forced a resubscribe on every render whenever
  // callers passed an inline arrow. On the Command Center page that
  // closure depends on `selectedId` (a useState), so every state change
  // tore down + reopened the EventSource — which then replayed the
  // server snapshot and invalidated queries, kicking off another render.
  // The result was an SSE-driven render storm that pegged the UI thread.
  const handlerRef = useRef(onEvent);
  useLayoutEffect(() => {
    handlerRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    return sseRegistry.subscribe("agents", SSE_EVENT_NAMES, (name, data) => {
      handlerRef.current(data, name);
    });
  }, []);
}

// ─── Profiles + app settings ──────────────────────────────────────

export interface ProfileOut {
  id: number;
  name: string;
  color: string;
  icon: string;
  cwd_hint: string | null;
  env_json: string;
  claude_config_dir: string | null;
  default_model: string | null;
  default_project_id: number | null;
  created_at: string;
  /** FK to the provider this profile belongs to (populated by onboarding). */
  provider_id: number | null;
  /**
   * Number of non-workspace projects attached to this profile.
   * Returned by list_profiles() since migration 005.
   */
  project_count: number;
}

export interface ProfileInput {
  name?: string;
  color?: string;
  icon?: string;
  cwd_hint?: string | null;
  env_json?: string;
  claude_config_dir?: string | null;
  default_model?: string | null;
  default_project_id?: number | null;
  /** Link this profile to a provider so hook sessions resolve provider_id at start. */
  provider_id?: number | null;
}

export interface SettingOut {
  key: string;
  value_json: string;
  updated_at: string;
}

/**
 * One workflow-vocabulary entry (task status / priority / inbox status) as
 * surfaced to the UI. `slug` is the stable key stored on tasks; `label`,
 * `color`, and `sort_order` are user-editable under Settings → Workflow Labels
 * and drive the board columns, dropdowns, and badges.
 */
export interface WorkflowVocabEntry {
  slug: string;
  label: string;
  color: string | null;
  sort_order: number;
}

export interface LookupsOut {
  statuses: string[];
  status_colors: Record<string, string>;
  /** Task statuses (active, ordered) from the Workflow Labels taxonomy. */
  workflow_task_statuses: WorkflowVocabEntry[];
  /** Task priorities (active, ordered) from the Workflow Labels taxonomy. */
  workflow_task_priorities: WorkflowVocabEntry[];
  /** Inbox/triage statuses (active, ordered) from the Workflow Labels taxonomy. */
  workflow_inbox_statuses: WorkflowVocabEntry[];
  document_categories: string[];
  document_category_colors: Record<string, string>;
  /**
   * Work-in-progress cap per board column, keyed by task-status slug. A
   * missing key means "no limit". Values are always positive integers —
   * the sidecar coerces out anything else. Write with
   * `upsertSetting("board_wip_limits", nextMap)` then invalidate `["lookups"]`.
   */
  board_wip_limits: Record<string, number>;
  profiles: ProfileOut[];
  /**
   * `true` once the legacy first-run persona wizard was completed.
   * The new onboarding gate uses ``workspace_state.onboarding_completed``
   * via ``useOnboardingState``; this field is kept for DB backward compat.
   */
  wizard_completed: boolean;
  /**
   * Global hard gate for feature modules (Phase 1 feature toggles).
   * Maps feature slug → enabled boolean.  Missing key means enabled
   * (all-on default reproduces pre-toggle behaviour on old installs).
   */
  enabled_features: Record<string, boolean>;
  /** Display name shown in the sidebar footer. Defaults to "Operator". */
  user_display_name: string;
  /** Role label shown below the display name in the sidebar footer. Defaults to "Owner". */
  user_role: string;
}

export function fetchProfiles(): Promise<ProfileOut[]> {
  return fetchSidecar<ProfileOut[]>("/api/v1/profiles");
}

export function useProfiles(): UseQueryResult<ProfileOut[], SidecarError> {
  return useQuery<ProfileOut[], SidecarError>({
    queryKey: ["profiles"],
    queryFn: fetchProfiles,
    staleTime: 30_000,
  });
}

export function createProfile(data: ProfileInput): Promise<ProfileOut> {
  return fetchSidecar<ProfileOut>("/api/v1/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function updateProfile(
  id: number,
  data: ProfileInput,
): Promise<ProfileOut> {
  return fetchSidecar<ProfileOut>(`/api/v1/profiles/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function deleteProfile(id: number): Promise<{ ok: true }> {
  return fetchSidecar<{ ok: true }>(`/api/v1/profiles/${id}`, {
    method: "DELETE",
  });
}

export function fetchLookups(): Promise<LookupsOut> {
  return fetchSidecar<LookupsOut>("/api/v1/settings/lookups");
}

export function upsertSetting(
  key: string,
  value: unknown,
): Promise<SettingOut> {
  return fetchSidecar<SettingOut>(
    `/api/v1/settings/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value_json: JSON.stringify(value) }),
    },
  );
}

export function useLookups(): UseQueryResult<LookupsOut, SidecarError> {
  return useQuery<LookupsOut, SidecarError>({
    queryKey: ["lookups"],
    queryFn: fetchLookups,
    staleTime: 5 * 60_000,
    retry: 5,
    retryDelay: 1_000,
  });
}

/**
 * Resolves the enabled-features map with three-tier precedence:
 *   live sidecar data > localStorage cache > FEATURE_DEFAULTS
 *
 * The returned map is always complete (every known feature key is present)
 * so the sidebar and FeatureRoute can make a deterministic decision on the
 * very first render, before the sidecar has responded.
 *
 * The cache is written each time fresh live data arrives and cleared by
 * `useFactoryReset` so a reset returns the user to default behaviour.
 */
export function useEnabledFeatures(): Record<string, boolean> {
  const { data } = useLookups();

  // Read the persisted cache once on mount (synchronous, before first paint).
  const cached = useMemo<Record<string, boolean> | null>(() => {
    try {
      const raw = localStorage.getItem(FEATURE_CACHE_KEY);
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : null;
    } catch {
      return null;
    }
  }, []);

  // Persist fresh live data to localStorage whenever it arrives, announcing
  // the write (only when it actually changed, to avoid a pointless notify on
  // every refetch) so a non-react-query consumer can re-read it without a
  // QueryClient.
  useEffect(() => {
    if (!data?.enabled_features) return;
    try {
      const next = JSON.stringify(data.enabled_features);
      if (localStorage.getItem(FEATURE_CACHE_KEY) !== next) {
        localStorage.setItem(FEATURE_CACHE_KEY, next);
        window.dispatchEvent(new Event(FEATURE_CACHE_EVENT));
      }
    } catch {
      /* non-fatal */
    }
  }, [data?.enabled_features]);

  // Merge with explicit precedence: live > cache > defaults.
  return useMemo(
    () => ({
      ...FEATURE_DEFAULTS,
      ...(cached ?? {}),
      ...(data?.enabled_features ?? {}),
    }),
    [cached, data?.enabled_features],
  );
}

// ─── Providers ───────────────────────────────────────────────────────────────

export interface Provider {
  id: number;
  name: string;
  display_name: string;
  command_template: string;
  default_args: string;
  is_enabled: boolean;
  color: string | null;
  default_env: Record<string, string>;
  /** Selectable model strings — ["default"] means no dropdown shown. */
  models: string[];
  default_model: string | null;
  /** True iff the sidecar has a cleartext api_key stored for this provider.
   *  The cleartext value itself is never returned by the API. */
  has_api_key: boolean;
  base_url: string | null;
}

export interface ProviderCreateInput {
  name: string;
  display_name: string;
  command_template?: string;
  default_args?: string;
  default_env?: Record<string, string>;
  color?: string | null;
  is_enabled?: boolean;
  api_key?: string | null;
  base_url?: string | null;
}

export interface ProviderUpdateInput {
  display_name?: string;
  command_template?: string;
  default_args?: string;
  default_env?: Record<string, string>;
  color?: string | null;
  is_enabled?: boolean;
  api_key?: string | null;
  base_url?: string | null;
}

export interface ProviderModel {
  id: number;
  provider_id: number;
  model_name: string;
  display_name: string;
  is_default: boolean;
  is_enabled: boolean;
}

export interface ProviderStats {
  provider_id: number | null;
  name: string;
  display_name: string;
  color: string | null;
  default_model: string | null;
  sessions: number;
  sessions_today: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  linked_projects: number;
  linked_tasks: number;
}

export type ProviderStatsWindow = "today" | "7d" | "30d" | "all";

export interface ConfigHomesResult {
  config_homes: string[];
}

export function useConfigHomes(): UseQueryResult<
  ConfigHomesResult,
  SidecarError
> {
  return useQuery<ConfigHomesResult, SidecarError>({
    queryKey: ["providers", "config-homes"],
    queryFn: () =>
      fetchSidecar<ConfigHomesResult>("/api/v1/providers/config-homes"),
    staleTime: 60_000,
    retry: false,
  });
}

export function useProviders(
  includeDisabled = false,
): UseQueryResult<Provider[], SidecarError> {
  return useQuery<Provider[], SidecarError>({
    queryKey: ["providers", includeDisabled],
    queryFn: () =>
      fetchSidecar<Provider[]>(
        `/api/v1/providers${includeDisabled ? "?include_disabled=true" : ""}`,
      ),
    staleTime: 5 * 60_000,
  });
}

export function useProviderStats(
  since: ProviderStatsWindow = "today",
): UseQueryResult<ProviderStats[], SidecarError> {
  return useQuery<ProviderStats[], SidecarError>({
    queryKey: ["provider-stats", since],
    queryFn: () =>
      fetchSidecar<ProviderStats[]>(`/api/v1/providers/stats?since=${since}`),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 5,
    retryDelay: 1_000,
  });
}

export function useProviderModels(
  providerId: number | null | undefined,
): UseQueryResult<ProviderModel[], SidecarError> {
  return useQuery<ProviderModel[], SidecarError>({
    queryKey: ["provider-models", providerId ?? null],
    queryFn: () =>
      fetchSidecar<ProviderModel[]>(`/api/v1/providers/${providerId}/models`),
    enabled: providerId != null,
    staleTime: 5 * 60_000,
  });
}

// Invalidate every cache that depends on the providers table.  This keeps
// the sidebar (`provider-stats`), launch modal (`providers`), settings tab
// (`providers`+`includeDisabled`), and downstream profile lookups (`lookups`)
// in sync after any create/update/delete.
function invalidateProviderCaches(
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  void queryClient.invalidateQueries({ queryKey: ["providers"] });
  void queryClient.invalidateQueries({ queryKey: ["provider-stats"] });
  void queryClient.invalidateQueries({ queryKey: ["provider-models"] });
  void queryClient.invalidateQueries({ queryKey: ["lookups"] });
}

export function useCreateProvider(): UseMutationResult<
  Provider,
  SidecarError,
  ProviderCreateInput
> {
  const queryClient = useQueryClient();
  return useMutation<Provider, SidecarError, ProviderCreateInput>({
    mutationFn: (data) =>
      fetchSidecar<Provider>("/api/v1/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => invalidateProviderCaches(queryClient),
  });
}

export function useUpdateProvider(): UseMutationResult<
  Provider,
  SidecarError,
  { id: number; patch: ProviderUpdateInput }
> {
  const queryClient = useQueryClient();
  return useMutation<
    Provider,
    SidecarError,
    { id: number; patch: ProviderUpdateInput }
  >({
    mutationFn: ({ id, patch }) =>
      fetchSidecar<Provider>(`/api/v1/providers/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    onSuccess: () => invalidateProviderCaches(queryClient),
  });
}

export function useDeleteProvider(): UseMutationResult<
  { ok: true },
  SidecarError,
  number
> {
  const queryClient = useQueryClient();
  return useMutation<{ ok: true }, SidecarError, number>({
    mutationFn: (id) =>
      fetchSidecar<{ ok: true }>(`/api/v1/providers/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => invalidateProviderCaches(queryClient),
  });
}

// ─── Launch overrides (task-launch feature) ──────────────────────────────────

// PromptFanout and LaunchTarget are the canonical source in launch-seed.ts.
import type { PromptFanout, LaunchTarget } from "./launch-seed";
export type { PromptFanout, LaunchTarget };

/**
 * Payload accepted by PUT /api/v1/launch/overrides/{kind}/{id}.
 * All fields optional — missing fields are stored as NULL.
 */
export interface LaunchOverridePayload {
  project_id?: number | null;
  provider_id?: number | null;
  model?: string | null;
  rows?: number | null;
  cols?: number | null;
  target?: LaunchTarget | null;
  profile_id?: number | null;
  extra_args?: string | null;
  prompt_fanout?: PromptFanout | null;
  prompt_override?: string | null;
}

export interface LaunchOverride {
  source_kind: "task" | "inbox";
  source_id: number;
  project_id: number | null;
  provider_id: number | null;
  model: string | null;
  rows: number | null;
  cols: number | null;
  target: LaunchTarget | null;
  profile_id: number | null;
  extra_args: string | null;
  prompt_fanout: PromptFanout | null;
  prompt_override: string | null;
  updated_at: string | null;
}

export function useUpsertLaunchOverride(): UseMutationResult<
  LaunchOverride,
  SidecarError,
  { kind: "task" | "inbox"; id: number; payload: LaunchOverridePayload }
> {
  const queryClient = useQueryClient();
  return useMutation<
    LaunchOverride,
    SidecarError,
    { kind: "task" | "inbox"; id: number; payload: LaunchOverridePayload }
  >({
    mutationFn: ({ kind, id, payload }) =>
      fetchSidecar<LaunchOverride>(`/api/v1/launch/overrides/${kind}/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: ["launch-seed", vars.kind, vars.id],
      });
    },
  });
}

export function useDeleteLaunchOverride(): UseMutationResult<
  { ok: true },
  SidecarError,
  { kind: "task" | "inbox"; id: number }
> {
  const queryClient = useQueryClient();
  return useMutation<
    { ok: true },
    SidecarError,
    { kind: "task" | "inbox"; id: number }
  >({
    mutationFn: ({ kind, id }) =>
      fetchSidecar<{ ok: true }>(`/api/v1/launch/overrides/${kind}/${id}`, {
        method: "DELETE",
      }),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: ["launch-seed", vars.kind, vars.id],
      });
    },
  });
}

// ─── System info ──────────────────────────────────────────────────────────────

export interface SystemInfo {
  home: string;
  platform: string;
}

export function useSystemInfo(): UseQueryResult<SystemInfo, SidecarError> {
  return useQuery<SystemInfo, SidecarError>({
    queryKey: ["system-info"],
    queryFn: () => fetchSidecar<SystemInfo>("/api/v1/system/info"),
    staleTime: Infinity,
  });
}

// ─── Search ──────────────────────────────────────────────────────────────────

export type SearchResultType = "task" | "project" | "doc" | "inbox" | "event";

export interface SearchResult {
  type: SearchResultType;
  id: number;
  title: string;
  snippet: string;
  score: number;
  url?: string;
  session_id?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
  total: number;
}

const DEFAULT_SEARCH_TYPES: SearchResultType[] = [
  "task",
  "project",
  "doc",
  "inbox",
  "event",
];

export async function searchAll(
  q: string,
  types: SearchResultType[] = DEFAULT_SEARCH_TYPES,
  limit = 20,
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    q,
    types: types.join(","),
    limit: String(limit),
  });
  return fetchSidecar<SearchResponse>(`/api/v1/search?${params}`);
}

export function useSearch(
  query: string,
  types: SearchResultType[] = DEFAULT_SEARCH_TYPES,
  limit = 20,
): UseQueryResult<SearchResponse, SidecarError> {
  return useQuery<SearchResponse, SidecarError>({
    queryKey: ["search", query, types, limit],
    queryFn: () => searchAll(query, types, limit),
    enabled: query.trim().length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}

// ─── Session telemetry (Phase 7) ─────────────────────────────────────────────

export interface DailySpend {
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

export function useDailySpend(): UseQueryResult<DailySpend, SidecarError> {
  return useQuery<DailySpend, SidecarError>({
    queryKey: ["sessions", "daily-spend"],
    queryFn: () => fetchSidecar<DailySpend>("/api/v1/sessions/stats/daily"),
    refetchInterval: 15_000,
  });
}

// ─── Agent stats ───────────────────────────────────────────────────

export interface AgentSummary {
  profile: string;
  run_count: number;
  success_rate: number;
  last_seen: string | null;
  total_cost_usd: number;
  top_tool: string | null;
  projects_touched_count: number;
}

export interface AgentToolCount {
  name: string;
  count: number;
}

export interface AgentProjectStat {
  id: number;
  name: string;
  count: number;
  cost: number;
}

export interface AgentDailyPoint {
  date: string;
  runs: number;
  cost: number;
}

export interface AgentStats {
  profile: string;
  range: string;
  counts: {
    total: number;
    success: number;
    failed: number;
    ongoing: number;
  };
  costs: {
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
  };
  tools: AgentToolCount[];
  avg_duration_seconds: number;
  projects: AgentProjectStat[];
  daily: AgentDailyPoint[];
}

export interface AgentSessionRow {
  session_id: string;
  profile: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  total_tool_calls: number;
  cost_usd: number;
  project_name: string | null;
  initial_prompt: string | null;
}

export interface AgentSessionPage {
  total: number;
  sessions: AgentSessionRow[];
}

export function useAgentList(): UseQueryResult<AgentSummary[], SidecarError> {
  return useQuery<AgentSummary[], SidecarError>({
    queryKey: ["agents", "list"],
    queryFn: () => fetchSidecar<AgentSummary[]>("/api/v1/agents"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useAgentStats(
  name: string,
  range: "7d" | "30d" | "all",
): UseQueryResult<AgentStats, SidecarError> {
  return useQuery<AgentStats, SidecarError>({
    queryKey: ["agents", name, "stats", range],
    queryFn: () =>
      fetchSidecar<AgentStats>(
        `/api/v1/agents/${encodeURIComponent(name)}/stats?range=${range}`,
      ),
    staleTime: 30_000,
    enabled: Boolean(name),
  });
}

export function useAgentProfileSessions(
  name: string,
  page: number,
  limit = 50,
): UseQueryResult<AgentSessionPage, SidecarError> {
  const offset = page * limit;
  return useQuery<AgentSessionPage, SidecarError>({
    queryKey: ["agents", name, "sessions", page],
    queryFn: () =>
      fetchSidecar<AgentSessionPage>(
        `/api/v1/agents/${encodeURIComponent(name)}/sessions?limit=${limit}&offset=${offset}`,
      ),
    placeholderData: keepPreviousData,
    enabled: Boolean(name),
  });
}

export function useAgentEvents(
  name: string,
  sessionId: string | null,
): UseQueryResult<AgentEvent[], SidecarError> {
  return useQuery<AgentEvent[], SidecarError>({
    queryKey: ["agents", name, "events", sessionId],
    queryFn: () =>
      fetchSidecar<AgentEvent[]>(
        `/api/v1/agents/${encodeURIComponent(name)}/events?session_id=${encodeURIComponent(sessionId!)}`,
      ),
    enabled: sessionId !== null,
    staleTime: 0,
  });
}

// ─── Agent invocation history (attribution by subagent_type) ─────────────────

export interface AgentInvocationStats {
  total_invocations: number;
  last_invoked_at: string | null;
  /** Rounded to nearest second; null when no completed invocation exists. */
  avg_duration_seconds: number | null;
  /** Count of invocations with a matching PostToolUse (i.e. completed). */
  completed: number;
}

export interface AgentInvocationRow {
  id: number;
  created_at: string;
  session_id: string;
  /** Free-form label from $.tool_input.name — may be null. */
  label: string | null;
  /** Task description from $.tool_input.description, truncated to 140 chars. */
  description: string | null;
  profile: string;
  project_name: string | null;
  /** Duration in whole seconds; null when the PostToolUse hasn't arrived yet. */
  duration_seconds: number | null;
}

export interface AgentInvocationsResponse {
  stats: AgentInvocationStats;
  invocations: AgentInvocationRow[];
  total: number;
}

export function useAgentInvocations(
  name: string,
  range: "7d" | "30d" | "all",
  page = 0,
  limit = 50,
): UseQueryResult<AgentInvocationsResponse, SidecarError> {
  const offset = page * limit;
  return useQuery<AgentInvocationsResponse, SidecarError>({
    queryKey: ["agents", name, "invocations", range, page],
    queryFn: () =>
      fetchSidecar<AgentInvocationsResponse>(
        `/api/v1/agents/${encodeURIComponent(name)}/invocations?range=${range}&limit=${limit}&offset=${offset}`,
      ),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    enabled: Boolean(name),
  });
}

// ─── Cost & Activity metrics ──────────────────────────────────────

export interface CostBucket {
  key: string;
  label: string;
  total_cost_usd: number;
  total_tokens_in: number;
  total_tokens_out: number;
  run_count: number;
  daily?: Array<{ date: string; cost_usd: number; runs: number }>;
}

export interface CostMetricsResponse {
  groups: CostBucket[];
  grand_total: {
    total_cost_usd: number;
    total_tokens_in: number;
    total_tokens_out: number;
    run_count: number;
  };
}

export interface ActivityBucket {
  key: string;
  label: string;
  count: number;
  daily?: Array<{ date: string; count: number }>;
}

export interface ActivityMetricsResponse {
  groups: ActivityBucket[];
  grand_total: { count: number };
}

export interface CostMetricsParams {
  group_by: "project" | "agent" | "profile" | "day";
  range: "7d" | "30d" | "90d";
  project_id?: number;
  agent?: string;
  profile_id?: number; // TODO: wire profile_id from the sidebar context
  include_daily?: boolean;
}

export interface ActivityMetricsParams {
  group_by: "project" | "agent" | "profile" | "day";
  range: "7d" | "30d" | "90d";
  project_id?: number;
  agent?: string;
  profile_id?: number; // TODO: wire profile_id from the sidebar context
}

export function useCostMetrics(
  params: CostMetricsParams,
): UseQueryResult<CostMetricsResponse, SidecarError> {
  const qs = new URLSearchParams();
  qs.set("group_by", params.group_by);
  qs.set("range", params.range);
  if (params.project_id !== undefined)
    qs.set("project_id", String(params.project_id));
  if (params.agent !== undefined) qs.set("agent", params.agent);
  if (params.profile_id !== undefined)
    qs.set("profile_id", String(params.profile_id));
  if (params.include_daily !== undefined)
    qs.set("include_daily", String(params.include_daily));
  return useQuery<CostMetricsResponse, SidecarError>({
    queryKey: ["metrics", "cost", params],
    queryFn: () =>
      fetchSidecar<CostMetricsResponse>(
        `/api/v1/metrics/cost?${qs.toString()}`,
      ),
    staleTime: 60_000,
  });
}

export function useActivityMetrics(
  params: ActivityMetricsParams,
): UseQueryResult<ActivityMetricsResponse, SidecarError> {
  const qs = new URLSearchParams();
  qs.set("group_by", params.group_by);
  qs.set("range", params.range);
  if (params.project_id !== undefined)
    qs.set("project_id", String(params.project_id));
  if (params.agent !== undefined) qs.set("agent", params.agent);
  if (params.profile_id !== undefined)
    qs.set("profile_id", String(params.profile_id));
  return useQuery<ActivityMetricsResponse, SidecarError>({
    queryKey: ["metrics", "activity", params],
    queryFn: () =>
      fetchSidecar<ActivityMetricsResponse>(
        `/api/v1/metrics/activity?${qs.toString()}`,
      ),
    staleTime: 60_000,
  });
}

// ─── Notifications ─────────────────────────────────────────────────

export interface Notification {
  id: number;
  type: string;
  title: string;
  body: string | null;
  payload_json: string | null;
  target: string | null;
  priority: string;
  read_at: string | null;
  created_at: string;
}

export function useNotifications(
  unreadOnly = false,
): UseQueryResult<Notification[], SidecarError> {
  return useQuery<Notification[], SidecarError>({
    queryKey: ["notifications", { unreadOnly }],
    queryFn: () =>
      fetchSidecar<Notification[]>(
        `/api/v1/notifications${unreadOnly ? "?unread=true" : ""}`,
      ),
    staleTime: 10_000,
  });
}

export function markNotificationRead(id: number): Promise<Notification> {
  return fetchSidecar<Notification>(`/api/v1/notifications/${id}/read`, {
    method: "POST",
  });
}

export function markAllNotificationsRead(): Promise<{ updated: number }> {
  return fetchSidecar<{ updated: number }>(`/api/v1/notifications/read-all`, {
    method: "POST",
  });
}

export function dismissNotification(id: number): Promise<{ deleted: number }> {
  return fetchSidecar<{ deleted: number }>(`/api/v1/notifications/${id}`, {
    method: "DELETE",
  });
}

export function useNotificationsStream(
  onEvent: (eventName: string, data: unknown) => void,
): void {
  const handlerRef = useRef(onEvent);
  useLayoutEffect(() => {
    handlerRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    const es = new EventSource(
      `${SIDECAR_BASE_URL}/api/v1/notifications/stream`,
    );
    // Track seen notification ids to deduplicate backlog replay and reconnects.
    const seenIds = new Set<number>();

    const handleEvent = (name: string, data: unknown) => {
      handlerRef.current(name, data);
    };

    es.addEventListener("notification", (e) => {
      try {
        const n = JSON.parse(e.data) as { id?: number };
        if (typeof n.id === "number") {
          if (seenIds.has(n.id)) return;
          seenIds.add(n.id);
        }
        handleEvent("notification", n);
      } catch {
        // ignore malformed event
      }
    });
    es.addEventListener("snapshot", (e) => {
      try {
        handleEvent("snapshot", JSON.parse(e.data));
      } catch {
        // ignore malformed event
      }
    });

    return () => {
      es.close();
    };
  }, []);
}

// ─── Terminal settings (section 18) ─────────────────────────────────────────

export interface TerminalSettings {
  font_family: string;
  font_size: number;
  scrollback: number;
  copy_on_select: boolean;
  /** Global screenshot-ring hotkey accelerator (e.g. "Ctrl+Shift+2"). */
  screenshot_hotkey: string;
}

/** Default accelerator for the screenshot-ring hotkey.
 *
 * Ctrl+Shift+2 has no documented macOS system binding; all Cmd+Shift+3/4/5/6
 * combinations are reserved by macOS screenshot tools.
 */
export const SCREENSHOT_HOTKEY_DEFAULT = "Ctrl+Shift+2";

const TERMINAL_SETTING_DEFAULTS: TerminalSettings = {
  font_family: "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
  font_size: 13,
  scrollback: 5000,
  copy_on_select: true,
  screenshot_hotkey: SCREENSHOT_HOTKEY_DEFAULT,
};

/** Parse a raw `app_settings` row list into a typed `TerminalSettings` object. */
function parseTerminalSettings(rows: SettingOut[]): TerminalSettings {
  const map = new Map(rows.map((r) => [r.key, r.value_json]));
  function getBool(key: string, def: boolean): boolean {
    const raw = map.get(key);
    if (raw === undefined) return def;
    try {
      const v = JSON.parse(raw);
      if (v === 0 || v === false) return false;
      if (v === 1 || v === true) return true;
    } catch {
      // ignore
    }
    return def;
  }
  function getStr(key: string, def: string): string {
    const raw = map.get(key);
    if (raw === undefined) return def;
    try {
      const v = JSON.parse(raw) as unknown;
      return typeof v === "string" ? v : def;
    } catch {
      return def;
    }
  }
  function getInt(key: string, def: number): number {
    const raw = map.get(key);
    if (raw === undefined) return def;
    try {
      const v = parseInt(String(JSON.parse(raw)), 10);
      return isNaN(v) ? def : v;
    } catch {
      return def;
    }
  }
  return {
    font_family: getStr(
      "terminal.font_family",
      TERMINAL_SETTING_DEFAULTS.font_family,
    ),
    font_size: getInt(
      "terminal.font_size",
      TERMINAL_SETTING_DEFAULTS.font_size,
    ),
    scrollback: getInt(
      "terminal.scrollback",
      TERMINAL_SETTING_DEFAULTS.scrollback,
    ),
    copy_on_select: getBool(
      "terminal.copy_on_select",
      TERMINAL_SETTING_DEFAULTS.copy_on_select,
    ),
    screenshot_hotkey: getStr(
      "screenshot.hotkey",
      TERMINAL_SETTING_DEFAULTS.screenshot_hotkey,
    ),
  };
}

export { TERMINAL_SETTING_DEFAULTS, parseTerminalSettings };

export function useTerminalSettings(): UseQueryResult<
  TerminalSettings,
  SidecarError
> {
  return useQuery<TerminalSettings, SidecarError>({
    queryKey: ["settings", "terminal"],
    queryFn: async () => {
      const rows = await fetchSidecar<SettingOut[]>("/api/v1/settings");
      // Include both terminal.* and screenshot.* settings so screenshot_hotkey
      // is returned by the same query without an extra HTTP round-trip.
      const termRows = rows.filter(
        (r) => r.key.startsWith("terminal.") || r.key.startsWith("screenshot."),
      );
      return parseTerminalSettings(termRows);
    },
    staleTime: 60_000,
  });
}

// ─── Launch Presets (launch-agents-grid) ─────────────────────────────────────

/** Mirrors `app/models/launch.py:LaunchCell`. */
export interface LaunchCellCreate {
  row: number;
  col: number;
  project_id: number;
  provider_id: number;
  extra_args: string;
  profile_id: number | null;
  env_overlay: Record<string, string>;
}

/** Mirrors `app/models/launch.py:LaunchPreset`. */
export interface LaunchPreset {
  id: number;
  name: string;
  project_id: number;
  provider_id: number;
  rows: number;
  cols: number;
  extra_args: string;
  target: "embedded" | "popout";
  profile_id: number | null;
  created_at: string;
  cells: LaunchCellCreate[] | null;
}

/** Mirrors `app/models/launch.py:LaunchPresetCreate`. */
export interface LaunchPresetCreate {
  name: string;
  project_id: number;
  provider_id: number;
  rows: number;
  cols: number;
  extra_args: string;
  target: "embedded" | "popout";
  profile_id: number | null;
  cells?: LaunchCellCreate[] | null;
}

export function useLaunchPresets(): UseQueryResult<
  LaunchPreset[],
  SidecarError
> {
  return useQuery<LaunchPreset[], SidecarError>({
    queryKey: ["launch-presets"],
    queryFn: () => fetchSidecar<LaunchPreset[]>("/api/v1/launch-presets"),
    staleTime: 30_000,
  });
}

export function useCreateLaunchPreset(): UseMutationResult<
  LaunchPreset,
  SidecarError,
  LaunchPresetCreate
> {
  const queryClient = useQueryClient();
  return useMutation<LaunchPreset, SidecarError, LaunchPresetCreate>({
    mutationFn: (data) =>
      fetchSidecar<LaunchPreset>("/api/v1/launch-presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["launch-presets"] });
    },
  });
}

export function useDeleteLaunchPreset(): UseMutationResult<
  { ok: true },
  SidecarError,
  number
> {
  const queryClient = useQueryClient();
  return useMutation<{ ok: true }, SidecarError, number>({
    mutationFn: (id) =>
      fetchSidecar<{ ok: true }>(`/api/v1/launch-presets/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["launch-presets"] });
    },
  });
}

// ─── Cost Budgets ─────────────────────────────────────────────────

export type BudgetScope = "workspace" | "project" | "agent";
export type BudgetPeriod = "daily" | "weekly" | "monthly";

export interface Budget {
  id: number;
  name: string;
  scope_type: BudgetScope;
  scope_id: number | null;
  scope_key: string | null;
  period: BudgetPeriod;
  limit_usd: number;
  hard_stop: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface BudgetBurn extends Budget {
  budget_id: number;
  period_start: string;
  period_end: string;
  spent_usd: number;
  percent: number;
}

export interface BudgetCreateInput {
  name: string;
  scope_type: BudgetScope;
  scope_id?: number | null;
  scope_key?: string | null;
  period: BudgetPeriod;
  limit_usd: number;
  hard_stop?: boolean;
  enabled?: boolean;
}

export interface BudgetPatchInput {
  name?: string;
  period?: BudgetPeriod;
  limit_usd?: number;
  hard_stop?: boolean;
  enabled?: boolean;
}

export function useBudgets(): UseQueryResult<Budget[], SidecarError> {
  return useQuery<Budget[], SidecarError>({
    queryKey: ["budgets"],
    queryFn: async () => {
      const r = await fetchSidecar<{ budgets: Budget[] }>("/api/v1/budgets");
      return r.budgets;
    },
    staleTime: 15_000,
  });
}

export function useBudgetBurn(): UseQueryResult<BudgetBurn[], SidecarError> {
  return useQuery<BudgetBurn[], SidecarError>({
    queryKey: ["budgets", "burn"],
    queryFn: async () => {
      const r = await fetchSidecar<{ items: BudgetBurn[] }>(
        "/api/v1/budgets/burn-rate",
      );
      return r.items;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export function useCreateBudget(): UseMutationResult<
  Budget,
  SidecarError,
  BudgetCreateInput
> {
  const queryClient = useQueryClient();
  return useMutation<Budget, SidecarError, BudgetCreateInput>({
    mutationFn: (payload) =>
      fetchSidecar<Budget>("/api/v1/budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["budgets"] });
    },
  });
}

export function useUpdateBudget(): UseMutationResult<
  Budget,
  SidecarError,
  { id: number; patch: BudgetPatchInput }
> {
  const queryClient = useQueryClient();
  return useMutation<
    Budget,
    SidecarError,
    { id: number; patch: BudgetPatchInput }
  >({
    mutationFn: ({ id, patch }) =>
      fetchSidecar<Budget>(`/api/v1/budgets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["budgets"] });
    },
  });
}

export function useDeleteBudget(): UseMutationResult<
  { ok: true },
  SidecarError,
  number
> {
  const queryClient = useQueryClient();
  return useMutation<{ ok: true }, SidecarError, number>({
    mutationFn: (id) =>
      fetchSidecar<{ ok: true }>(`/api/v1/budgets/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["budgets"] });
    },
  });
}

// ─── Activity Feed & Audit Log ────────────────────────────────────

export type FeedSource = "activity" | "agent_session";

export interface FeedRow {
  id: string;
  source: FeedSource;
  entity_type: string;
  entity_id: string;
  action: string;
  actor: string | null;
  project_id: number | null;
  summary: string;
  created_at: string;
}

export interface FeedCursor {
  before_created_at: string;
  before_id: string;
}

export interface FeedPage {
  items: FeedRow[];
  next_cursor: FeedCursor | null;
}

export interface FeedFilters {
  source?: FeedSource;
  actor?: string;
  project_id?: number;
  from_iso?: string;
  to_iso?: string;
  q?: string;
}

function feedQuery(
  filters: FeedFilters,
  extras: Record<string, string> = {},
): string {
  const params = new URLSearchParams();
  if (filters.source) params.set("source", filters.source);
  if (filters.actor) params.set("actor", filters.actor);
  if (filters.project_id != null)
    params.set("project_id", String(filters.project_id));
  if (filters.from_iso) params.set("from_iso", filters.from_iso);
  if (filters.to_iso) params.set("to_iso", filters.to_iso);
  if (filters.q) params.set("q", filters.q);
  for (const [k, v] of Object.entries(extras)) params.set(k, v);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function useFeed(
  filters: FeedFilters,
  cursor: FeedCursor | null = null,
): UseQueryResult<FeedPage, SidecarError> {
  const extras: Record<string, string> = {};
  if (cursor) {
    extras.before_created_at = cursor.before_created_at;
    extras.before_id = cursor.before_id;
  }
  return useQuery<FeedPage, SidecarError>({
    queryKey: ["feed", filters, cursor],
    queryFn: () =>
      fetchSidecar<FeedPage>(`/api/v1/feed${feedQuery(filters, extras)}`),
    staleTime: 15_000,
  });
}

export function feedCsvUrl(filters: FeedFilters): string {
  return `${SIDECAR_BASE_URL}/api/v1/feed.csv${feedQuery(filters)}`;
}

// ─── Plugins ──────────────────────────────────────────────────────

export type PluginTrustMode = "strict" | "permissive";
export type PluginSignatureStatus = "trusted" | "untrusted";
export type PluginLoadStatus = "loaded" | "skipped" | "error";

export interface PluginContribution {
  type: "sidebar_item" | "widget" | "mcp_server";
  [key: string]: unknown;
}

export interface PluginManifest {
  slug: string;
  name: string;
  version: string;
  contributions?: PluginContribution[];
  [key: string]: unknown;
}

export interface Plugin {
  id: number;
  slug: string;
  name: string;
  version: string;
  dir_path: string;
  manifest_sha256: string;
  manifest: PluginManifest;
  signature_status: PluginSignatureStatus;
  enabled: boolean;
  load_status: PluginLoadStatus;
  load_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface PluginsListResponse {
  plugins: Plugin[];
  trust_mode: PluginTrustMode;
  plugins_root: string;
}

export function usePlugins(): UseQueryResult<
  PluginsListResponse,
  SidecarError
> {
  return useQuery<PluginsListResponse, SidecarError>({
    queryKey: ["plugins"],
    queryFn: () => fetchSidecar<PluginsListResponse>("/api/v1/plugins"),
    staleTime: 15_000,
  });
}

interface RefreshResult {
  discovered: number;
  loaded: number;
  skipped: number;
  error: number;
}

export function useRefreshPlugins(): UseMutationResult<
  RefreshResult,
  SidecarError,
  void
> {
  const queryClient = useQueryClient();
  return useMutation<RefreshResult, SidecarError, void>({
    mutationFn: () =>
      fetchSidecar<RefreshResult>("/api/v1/plugins/refresh", {
        method: "POST",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
  });
}

export function useTrustPlugin(): UseMutationResult<
  { hash: string; total_trusted: number },
  SidecarError,
  { sha256: string; trust: boolean }
> {
  const queryClient = useQueryClient();
  return useMutation<
    { hash: string; total_trusted: number },
    SidecarError,
    { sha256: string; trust: boolean }
  >({
    mutationFn: ({ sha256, trust }) =>
      fetchSidecar<{ hash: string; total_trusted: number }>(
        `/api/v1/plugins/${trust ? "trust" : "untrust"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sha256 }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
  });
}

export function useSetPluginTrustMode(): UseMutationResult<
  { trust_mode: PluginTrustMode },
  SidecarError,
  PluginTrustMode
> {
  const queryClient = useQueryClient();
  return useMutation<
    { trust_mode: PluginTrustMode },
    SidecarError,
    PluginTrustMode
  >({
    mutationFn: (mode) =>
      fetchSidecar<{ trust_mode: PluginTrustMode }>(
        "/api/v1/plugins/trust-mode",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
  });
}

export function useSetPluginEnabled(): UseMutationResult<
  Plugin,
  SidecarError,
  { id: number; enabled: boolean }
> {
  const queryClient = useQueryClient();
  return useMutation<Plugin, SidecarError, { id: number; enabled: boolean }>({
    mutationFn: ({ id, enabled }) =>
      fetchSidecar<Plugin>(`/api/v1/plugins/${id}/enabled`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
  });
}

// ─── Cross-App Integrations ───────────────────────────────────────

export interface IntegrationMcpSpec {
  command: string;
  args: string[];
  env_template: string[];
}

export interface IntegrationEntry {
  slug: string;
  name: string;
  description: string;
  icon: string;
  pane_url: string;
  mcp: IntegrationMcpSpec;
  installed: boolean;
  mcp_server_slug: string | null;
}

export function useIntegrations(): UseQueryResult<
  IntegrationEntry[],
  SidecarError
> {
  return useQuery<IntegrationEntry[], SidecarError>({
    queryKey: ["integrations"],
    queryFn: async () => {
      const r = await fetchSidecar<{ integrations: IntegrationEntry[] }>(
        "/api/v1/integrations",
      );
      return r.integrations;
    },
    staleTime: 15_000,
  });
}

export function useInstallIntegration(): UseMutationResult<
  { integration: IntegrationEntry; mcp_server: unknown },
  SidecarError,
  { slug: string; env: Record<string, string> }
> {
  const queryClient = useQueryClient();
  return useMutation<
    { integration: IntegrationEntry; mcp_server: unknown },
    SidecarError,
    { slug: string; env: Record<string, string> }
  >({
    mutationFn: ({ slug, env }) =>
      fetchSidecar<{ integration: IntegrationEntry; mcp_server: unknown }>(
        `/api/v1/integrations/${slug}/install`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ env }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["integrations"] });
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
  });
}

export function useUninstallIntegration(): UseMutationResult<
  { slug: string; removed: boolean; mcp_server_id?: number },
  SidecarError,
  string
> {
  const queryClient = useQueryClient();
  return useMutation<
    { slug: string; removed: boolean; mcp_server_id?: number },
    SidecarError,
    string
  >({
    mutationFn: (slug) =>
      fetchSidecar<{ slug: string; removed: boolean; mcp_server_id?: number }>(
        `/api/v1/integrations/${slug}/uninstall`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["integrations"] });
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
  });
}

// ─── Local-First Sync & Backup ────────────────────────────────────

export type SyncKind = "local" | "icloud" | "dropbox" | "syncthing" | "s3";

export interface SyncTarget {
  id: number;
  label: string;
  kind: SyncKind;
  dir_path: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface SyncSnapshotManifest {
  version: number;
  created_at_utc: string;
  sources: string[];
  db_sha256: string;
  plugins_sha256: string;
}

export interface SyncSnapshotListed {
  file_name: string;
  file_path: string;
  bytes: number;
  manifest: SyncSnapshotManifest | null;
  valid: boolean;
}

export interface SyncSnapshotCreated {
  snapshot_id: number;
  file_name: string;
  file_path: string;
  bytes: number;
  archive_sha256: string;
  sources: string[];
  manifest: SyncSnapshotManifest;
}

export interface SyncRestoreResult {
  restored_from: string;
  db_path: string;
  plugins_path: string;
  backup_stamp: string;
  manifest: SyncSnapshotManifest;
}

export interface SyncHistoryRow {
  id: number;
  target_id: number;
  file_name: string;
  file_path: string;
  bytes: number;
  archive_sha256: string;
  sources_json: string;
  action: "create" | "restore";
  created_at: string;
}

export function useSyncTargets(): UseQueryResult<SyncTarget[], SidecarError> {
  return useQuery<SyncTarget[], SidecarError>({
    queryKey: ["sync-targets"],
    queryFn: async () => {
      const r = await fetchSidecar<{ targets: SyncTarget[] }>(
        "/api/v1/sync/targets",
      );
      return r.targets;
    },
    staleTime: 15_000,
  });
}

export function useCreateSyncTarget(): UseMutationResult<
  SyncTarget,
  SidecarError,
  { label: string; kind: SyncKind; dir_path: string }
> {
  const queryClient = useQueryClient();
  return useMutation<
    SyncTarget,
    SidecarError,
    { label: string; kind: SyncKind; dir_path: string }
  >({
    mutationFn: (payload) =>
      fetchSidecar<SyncTarget>("/api/v1/sync/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sync-targets"] });
    },
  });
}

export function useDeleteSyncTarget(): UseMutationResult<
  { ok: true },
  SidecarError,
  number
> {
  const queryClient = useQueryClient();
  return useMutation<{ ok: true }, SidecarError, number>({
    mutationFn: (id) =>
      fetchSidecar<{ ok: true }>(`/api/v1/sync/targets/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sync-targets"] });
      void queryClient.invalidateQueries({ queryKey: ["sync-snapshots"] });
    },
  });
}

export function useSyncSnapshots(
  targetId: number | null,
): UseQueryResult<SyncSnapshotListed[], SidecarError> {
  return useQuery<SyncSnapshotListed[], SidecarError>({
    queryKey: ["sync-snapshots", targetId],
    queryFn: async () => {
      const r = await fetchSidecar<{ snapshots: SyncSnapshotListed[] }>(
        `/api/v1/sync/targets/${targetId}/snapshots`,
      );
      return r.snapshots;
    },
    enabled: targetId != null,
    staleTime: 10_000,
  });
}

export function useCreateSnapshot(): UseMutationResult<
  SyncSnapshotCreated,
  SidecarError,
  number
> {
  const queryClient = useQueryClient();
  return useMutation<SyncSnapshotCreated, SidecarError, number>({
    mutationFn: (targetId) =>
      fetchSidecar<SyncSnapshotCreated>(
        `/api/v1/sync/targets/${targetId}/snapshot`,
        {
          method: "POST",
        },
      ),
    onSuccess: (_, targetId) => {
      void queryClient.invalidateQueries({
        queryKey: ["sync-snapshots", targetId],
      });
      void queryClient.invalidateQueries({ queryKey: ["sync-history"] });
    },
  });
}

export function useRestoreSnapshot(): UseMutationResult<
  SyncRestoreResult,
  SidecarError,
  { targetId: number; file_name: string }
> {
  const queryClient = useQueryClient();
  return useMutation<
    SyncRestoreResult,
    SidecarError,
    { targetId: number; file_name: string }
  >({
    mutationFn: ({ targetId, file_name }) =>
      fetchSidecar<SyncRestoreResult>(
        `/api/v1/sync/targets/${targetId}/restore`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_name }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sync-history"] });
    },
  });
}

export function useSyncHistory(): UseQueryResult<
  SyncHistoryRow[],
  SidecarError
> {
  return useQuery<SyncHistoryRow[], SidecarError>({
    queryKey: ["sync-history"],
    queryFn: async () => {
      const r = await fetchSidecar<{ history: SyncHistoryRow[] }>(
        "/api/v1/sync/history",
      );
      return r.history;
    },
    staleTime: 10_000,
  });
}

// ─── Phase 3: Command-Center workspace import + health ───────────────────────

/**
 * A project imported into the workspace (Phase 3 command-center feature).
 * Named `WorkspaceProject` to avoid collision with the pre-existing
 * `CommandCenterProject` interface (legacy live-agent board data shape).
 */
export interface WorkspaceProject {
  id: number;
  name: string;
  root_path: string;
  git_remote: string | null;
  tech_stack: string | null;
  is_active: number;
  imported_at: string | null;
  last_scanned_at: string | null;
  agent_count: number;
  enabled_count: number;
  /** FK → profiles.id; null means unassigned / default profile. */
  profile_id: number | null;
}

export interface WorkspaceAgent {
  id: number;
  name: string;
  description: string | null;
  model: string | null;
  canonical_path: string;
  link_path: string;
  link_type: string;
  enabled: number;
  has_name_mismatch: number;
  verify_status: "ok" | "dangling" | "mismatch" | "missing_target";
}

export interface ImportPreviewResult {
  project_name: string;
  root_path: string;
  git_remote: string | null;
  has_claude_dir: boolean;
  agents: Array<{
    name: string;
    frontmatter_name_raw: string | null;
    description: string | null;
    model: string | null;
    canonical_path: string;
    has_name_mismatch: boolean;
  }>;
  skills: Array<{ name: string; canonical_path: string }>;
  commands: Array<{ name: string; canonical_path: string }>;
  warnings: string[];
}

export interface ImportCommitResult {
  project_id: number;
  agents_created: number;
  skills_created: number;
  commands_created: number;
  links_created: number;
  links_failed: Array<{ link: string; reason: string }>;
  warnings: string[];
}

export interface WorkspaceHealthData {
  issues: Array<{
    kind: string;
    name: string;
    link_path: string;
    canonical_path: string | null;
    verify_status: string;
    detail: string | null;
  }>;
  issue_count: number;
}

const CC_BASE = "/api/v1/command-center";

export function useWorkspaceProjects(): UseQueryResult<
  WorkspaceProject[],
  SidecarError
> {
  return useQuery<WorkspaceProject[], SidecarError>({
    queryKey: ["workspace", "projects"],
    queryFn: () => fetchSidecar<WorkspaceProject[]>(`${CC_BASE}/projects`),
    staleTime: 15_000,
  });
}

export function useWorkspaceProjectAgents(
  projectId: number | null,
): UseQueryResult<WorkspaceAgent[], SidecarError> {
  return useQuery<WorkspaceAgent[], SidecarError>({
    queryKey: ["workspace", "project", projectId, "agents"],
    queryFn: () =>
      fetchSidecar<WorkspaceAgent[]>(`${CC_BASE}/projects/${projectId}/agents`),
    enabled: projectId != null,
    staleTime: 15_000,
  });
}

export interface WorkspaceSkill {
  id: number;
  name: string;
  canonical_path: string;
  link_path: string;
  link_type: string | null;
  enabled: number;
  verify_status: "ok" | "dangling" | "mismatch" | "missing_target" | null;
}

export function useWorkspaceProjectSkills(
  projectId: number | null,
): UseQueryResult<WorkspaceSkill[], SidecarError> {
  return useQuery<WorkspaceSkill[], SidecarError>({
    queryKey: ["workspace", "project", projectId, "skills"],
    queryFn: () =>
      fetchSidecar<WorkspaceSkill[]>(`${CC_BASE}/projects/${projectId}/skills`),
    enabled: projectId != null,
    staleTime: 15_000,
  });
}

export function useToggleWorkspaceProjectSkill(): UseMutationResult<
  { ok: boolean; links_regenerated: number },
  SidecarError,
  { projectId: number; skillId: number; enabled: boolean }
> {
  const qc = useQueryClient();
  return useMutation<
    { ok: boolean; links_regenerated: number },
    SidecarError,
    { projectId: number; skillId: number; enabled: boolean }
  >({
    mutationFn: ({ projectId, skillId, enabled }) =>
      fetchSidecar(`${CC_BASE}/projects/${projectId}/skills/${skillId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: (_data, { projectId }) => {
      void qc.invalidateQueries({
        queryKey: ["workspace", "project", projectId, "skills"],
      });
      void qc.invalidateQueries({ queryKey: ["workspace", "projects"] });
    },
  });
}

export function useWorkspaceHealth(): UseQueryResult<
  WorkspaceHealthData,
  SidecarError
> {
  return useQuery<WorkspaceHealthData, SidecarError>({
    queryKey: ["workspace", "health"],
    queryFn: () =>
      fetchSidecar<WorkspaceHealthData>(`${CC_BASE}/workspace/health`),
    staleTime: 30_000,
  });
}

// ─── Command Center workspace entity + setup (onboarding) ────────────────────

export interface Workspace {
  id: number;
  slug: string;
  label: string;
  root_path: string;
  created_at: string | null;
  updated_at: string | null;
}

export function useWorkspace(): UseQueryResult<Workspace, SidecarError> {
  return useQuery<Workspace, SidecarError>({
    queryKey: ["workspace", "active"],
    queryFn: () => fetchSidecar<Workspace>("/api/v1/workspace"),
    staleTime: 60_000,
  });
}

export interface ProviderModelInput {
  model_name: string;
  display_name?: string;
  is_default?: boolean;
}

export function useSetProviderModels(): UseMutationResult<
  ProviderModel[],
  SidecarError,
  { providerId: number; models: ProviderModelInput[] }
> {
  const queryClient = useQueryClient();
  return useMutation<
    ProviderModel[],
    SidecarError,
    { providerId: number; models: ProviderModelInput[] }
  >({
    mutationFn: ({ providerId, models }) =>
      fetchSidecar<ProviderModel[]>(`/api/v1/providers/${providerId}/models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models }),
      }),
    onSuccess: (_data, { providerId }) => {
      void queryClient.invalidateQueries({
        queryKey: ["provider-models", providerId],
      });
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}

export interface HookSnippet {
  settings_path: string;
  base_url: string;
  hooks: Record<string, unknown>;
  snippet: string;
}

export function useHookSnippet(
  configHome?: string | null,
): UseQueryResult<HookSnippet, SidecarError> {
  const qs = configHome ? `?config_home=${encodeURIComponent(configHome)}` : "";
  return useQuery<HookSnippet, SidecarError>({
    queryKey: ["workspace", "hooks", "snippet", configHome ?? null],
    queryFn: () =>
      fetchSidecar<HookSnippet>(`/api/v1/workspace/hooks/snippet${qs}`),
    staleTime: 60_000,
  });
}

export interface HookStatus {
  connected: boolean;
  sessions: number;
  last_ping_at: string | null;
}

export function useHookStatus(
  since: string | null,
  enabled: boolean,
): UseQueryResult<HookStatus, SidecarError> {
  const qs = since ? `?since=${encodeURIComponent(since)}` : "";
  return useQuery<HookStatus, SidecarError>({
    queryKey: ["workspace", "hooks", "status", since ?? null],
    queryFn: () =>
      fetchSidecar<HookStatus>(`/api/v1/workspace/hooks/status${qs}`),
    enabled,
    refetchInterval: enabled ? 3000 : false,
  });
}

// ─── Hook self-test verification (Test hooks / Run live test) ───────────────
//
// Onboarding step 05's verify bar only ever went green on an inbound ping
// from a real Claude Code session, which the wizard has no way to produce.
// These back a self-test instead: `useVerifyHooks` diffs each configured
// settings.json against what the sidecar would emit; `useMintHookSelfTest` +
// `fetchHookSelfTestReceipt` back a true end-to-end probe (paired with
// `runHookProbe` in `lib/ipc.ts`, which runs the actual curl).

export interface HookEventVerdict {
  event: string;
  status: "ok" | "missing" | "mismatch" | "malformed";
  detail: string | null;
}

export interface HookSettingsVerify {
  config_home: string;
  settings_path: string;
  file_status:
    | "ok"
    | "partial"
    | "absent"
    | "missing_file"
    | "invalid_json"
    | "unreadable";
  detail: string | null;
  events: HookEventVerdict[];
  found_elsewhere: string[];
}

export interface HookVerifyReport {
  base_url: string;
  expected_events: string[];
  overall: "ok" | "partial" | "absent" | "error";
  results: HookSettingsVerify[];
}

export function useVerifyHooks(): UseMutationResult<
  HookVerifyReport,
  SidecarError,
  { config_homes: string[] }
> {
  return useMutation<
    HookVerifyReport,
    SidecarError,
    { config_homes: string[] }
  >({
    mutationFn: (body) =>
      fetchSidecar<HookVerifyReport>("/api/v1/workspace/hooks/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  });
}

export interface HookSelfTestMint {
  token: string;
  url: string;
  max_time_seconds: number;
  expires_in_seconds: number;
  command: string;
}

export function useMintHookSelfTest(): UseMutationResult<
  HookSelfTestMint,
  SidecarError,
  void
> {
  return useMutation<HookSelfTestMint, SidecarError, void>({
    mutationFn: () =>
      fetchSidecar<HookSelfTestMint>("/api/v1/workspace/hooks/self-test", {
        method: "POST",
      }),
  });
}

export interface HookSelfTestReceipt {
  known: boolean;
  received: boolean;
  elapsed_ms: number | null;
}

export function fetchHookSelfTestReceipt(
  token: string,
): Promise<HookSelfTestReceipt> {
  return fetchSidecar<HookSelfTestReceipt>(
    `/api/v1/workspace/hooks/self-test/${encodeURIComponent(token)}`,
  );
}

export function useImportPreview(): UseMutationResult<
  ImportPreviewResult,
  SidecarError,
  { root_path: string }
> {
  return useMutation<ImportPreviewResult, SidecarError, { root_path: string }>({
    mutationFn: (body) =>
      fetchSidecar<ImportPreviewResult>(`${CC_BASE}/projects/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  });
}

export function useImportCommit(): UseMutationResult<
  ImportCommitResult,
  SidecarError,
  {
    root_path: string;
    name?: string;
    tech_stack?: string;
    enable_agents?: boolean;
    enable_skills?: boolean;
    enable_commands?: boolean;
  }
> {
  const qc = useQueryClient();
  return useMutation<
    ImportCommitResult,
    SidecarError,
    {
      root_path: string;
      name?: string;
      tech_stack?: string;
      enable_agents?: boolean;
      enable_skills?: boolean;
      enable_commands?: boolean;
    }
  >({
    mutationFn: (body) =>
      fetchSidecar<ImportCommitResult>(`${CC_BASE}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["workspace"] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export interface RescanResult {
  agents_added: number;
  agents_updated: number;
  agents_disabled: number;
  skills_added: number;
  skills_updated: number;
  skills_disabled: number;
  commands_added: number;
  commands_updated: number;
  commands_disabled: number;
}

export function useRescanWorkspaceProject(): UseMutationResult<
  RescanResult,
  SidecarError,
  number
> {
  const qc = useQueryClient();
  return useMutation<RescanResult, SidecarError, number>({
    mutationFn: (projectId) =>
      fetchSidecar<RescanResult>(`${CC_BASE}/projects/${projectId}/rescan`, {
        method: "POST",
      }),
    onSuccess: (_data, projectId) => {
      void qc.invalidateQueries({ queryKey: ["workspace"] });
      void qc.invalidateQueries({
        queryKey: ["workspace", "project", projectId, "agents"],
      });
      void qc.invalidateQueries({
        queryKey: ["workspace", "project", projectId, "skills"],
      });
      void qc.invalidateQueries({ queryKey: ["command-center", "agents"] });
    },
  });
}

export function useDeleteWorkspaceProject(): UseMutationResult<
  unknown,
  SidecarError,
  number
> {
  const qc = useQueryClient();
  return useMutation<unknown, SidecarError, number>({
    mutationFn: (projectId) =>
      fetchSidecar(`${CC_BASE}/projects/${projectId}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["workspace"] });
    },
  });
}

export function useRegenerateWorkspace(): UseMutationResult<
  unknown,
  SidecarError,
  void
> {
  const qc = useQueryClient();
  return useMutation<unknown, SidecarError, void>({
    mutationFn: () =>
      fetchSidecar(`${CC_BASE}/workspace/regenerate`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["workspace"] });
    },
  });
}

// ─── Command Center Onboarding ───────────────────────────────────────────────

export interface OnboardingState {
  completed: boolean;
}

/**
 * Fetch the onboarding completion state from the sidecar.
 *
 * `enabled` controls whether the query fires.  Pass `false` (or omit while
 * the sidecar is still starting) so the OnboardingGate does not prematurely
 * redirect a returning user whose DB is not yet reachable.  Once the sidecar
 * is ready, pass `true` to trigger the first fetch.
 *
 * Three retries with a 1 s delay handle the startup-race window on packaged
 * builds where the PyInstaller binary takes a moment to become healthy.
 */
export function useOnboardingState(
  enabled = true,
): UseQueryResult<OnboardingState, SidecarError> {
  return useQuery<OnboardingState, SidecarError>({
    queryKey: ["onboarding", "state"],
    queryFn: () => fetchSidecar<OnboardingState>(`${CC_BASE}/onboarding`),
    staleTime: 60_000,
    enabled,
    retry: 3,
    retryDelay: 1_000,
  });
}

export function useCompleteOnboarding(): UseMutationResult<
  OnboardingState,
  SidecarError,
  void
> {
  const qc = useQueryClient();
  return useMutation<OnboardingState, SidecarError, void>({
    mutationFn: () =>
      fetchSidecar<OnboardingState>(`${CC_BASE}/onboarding/complete`, {
        method: "POST",
      }),
    onSuccess: (data) => {
      // Write the completed state directly into the cache so the OnboardingGate
      // reads `completed: true` synchronously on the next render — before the
      // background refetch that invalidateQueries would trigger. Without this
      // the gate sees stale `completed: false` and immediately redirects back
      // to /onboarding.
      qc.setQueryData<OnboardingState>(["onboarding", "state"], data);
      void qc.invalidateQueries({ queryKey: ["onboarding"] });
    },
  });
}

export interface FactoryResetResult {
  ok: boolean;
}

export function useFactoryReset(): UseMutationResult<
  FactoryResetResult,
  SidecarError,
  void
> {
  const qc = useQueryClient();
  return useMutation<FactoryResetResult, SidecarError, void>({
    mutationFn: () =>
      fetchSidecar<FactoryResetResult>(`${CC_BASE}/factory-reset`, {
        method: "POST",
      }),
    onSuccess: () => {
      // Wipe the entire react-query cache so every page refetches from scratch.
      qc.clear();
      // Clear the feature-defaults cache so the sidebar reverts to FEATURE_DEFAULTS
      // on next cold launch rather than showing the pre-reset feature state.
      //
      // The agent catalog needs the same treatment for a sharper reason: a reset
      // deletes the `providers` / `provider_models` rows it caches, but the reset
      // navigates to onboarding *without* reloading the webview — so both the
      // localStorage copy and the store's in-memory copy (`loaded: true`, which
      // makes a refresh a no-op) would survive the rows they describe, and the
      // first pane opened after re-onboarding would spawn against the deleted
      // provider's binary and `CLAUDE_CONFIG_DIR`. The event drops the in-memory
      // half; `agent-catalog-store.ts` listens for it. Keys live in
      // `lib/agent-storage-keys.ts` so this file never imports the store.
      try {
        localStorage.removeItem(FEATURE_CACHE_KEY);
        localStorage.removeItem(AGENT_CATALOG_STORAGE_KEY);
        localStorage.removeItem(AGENT_SELECTION_STORAGE_KEY);
      } catch {
        /* non-fatal */
      }
      window.dispatchEvent(new Event(AGENT_CATALOG_RESET_EVENT));
    },
  });
}

// ─── Command Center Org-Agents ───────────────────────────────────────────────

export interface OrgAgent {
  id: number;
  name: string;
  display_name: string;
  description: string | null;
  model: string | null;
  enabled: number;
}

export function useOrgAgents(): UseQueryResult<OrgAgent[], SidecarError> {
  return useQuery<OrgAgent[], SidecarError>({
    queryKey: ["command-center", "org-agents"],
    queryFn: () => fetchSidecar<OrgAgent[]>(`${CC_BASE}/org-agents`),
    staleTime: 60_000,
  });
}

// ─── Configured agents (E3.2) ────────────────────────────────────────────────

export interface ConfiguredAgentInfo {
  id: number;
  name: string;
  display_name: string | null;
  description: string | null;
  model: string | null;
  verify_status: string | null;
  /** "org" for bundled org-agents; "project" for project_agents. */
  kind: "org" | "project";
  /** True when this agent's enabled=1 — i.e. it is shared into the workspace. */
  is_shared?: boolean;
}

export interface ConfiguredSkillInfo {
  id: number;
  name: string;
  canonical_path: string;
  verify_status: string | null;
  /** True when this skill's enabled=1 — i.e. it is shared into the workspace. */
  is_shared?: boolean;
}

export interface ConfiguredAgentsByProject {
  project_id: number;
  project_name: string;
  agents: ConfiguredAgentInfo[];
  skills: ConfiguredSkillInfo[];
}

export interface ConfiguredAgentsResult {
  /** Org-agents + project agents with enabled=1 (shared into workspace). */
  shared: ConfiguredAgentInfo[];
  /** Project skills with enabled=1 (shared into workspace). */
  shared_skills: ConfiguredSkillInfo[];
  /** ALL project agents/skills, grouped by project. Items with is_shared=true
   *  also appear in the shared section above. */
  by_project: ConfiguredAgentsByProject[];
}

export function useConfiguredAgents(): UseQueryResult<
  ConfiguredAgentsResult,
  SidecarError
> {
  return useQuery<ConfiguredAgentsResult, SidecarError>({
    queryKey: ["command-center", "agents"],
    queryFn: () => fetchSidecar<ConfiguredAgentsResult>(`${CC_BASE}/agents`),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

// ─── Promote agent to org/shared ─────────────────────────────────────────────

export interface PromoteAgentOrgRow {
  id: number;
  name: string;
  display_name: string | null;
  description: string | null;
  model: string | null;
  install_path: string;
  link_path: string;
  source: "promoted";
  enabled: number;
  verify_status: string;
}

export interface PromoteAgentResult {
  org_agent: PromoteAgentOrgRow;
  already_existed: boolean;
  regen: {
    total: number;
    counts: Record<string, number>;
    failed: Array<{ link: string; reason: string }>;
  };
}

export function usePromoteAgentToOrg(): UseMutationResult<
  PromoteAgentResult,
  SidecarError,
  { projectId: number; agentId: number }
> {
  const qc = useQueryClient();
  return useMutation<
    PromoteAgentResult,
    SidecarError,
    { projectId: number; agentId: number }
  >({
    mutationFn: ({ projectId, agentId }) =>
      fetchSidecar<PromoteAgentResult>(
        `${CC_BASE}/projects/${projectId}/agents/${agentId}/promote`,
        { method: "POST" },
      ),
    onSuccess: (_data, { projectId }) => {
      void qc.invalidateQueries({ queryKey: ["command-center", "org-agents"] });
      void qc.invalidateQueries({ queryKey: ["command-center", "agents"] });
      void qc.invalidateQueries({ queryKey: ["workspace"] });
      void qc.invalidateQueries({
        queryKey: ["workspace", "project", projectId, "agents"],
      });
    },
  });
}
