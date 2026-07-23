import { useState, type ReactElement } from "react";
import { toast } from "sonner";
import {
  useCreateParallelRun,
  useDeleteParallelRun,
  useMergeParallelAttempt,
  useParallelRun,
  useParallelAttemptDiff,
  useParallelRuns,
  useProjects,
  type ParallelAttempt,
  type ParallelRunSummary,
} from "../lib/api";
import { Shell } from "../components/layout/shell";
import styles from "./parallel-runs.module.css";

const MIN_ATTEMPTS = 2;
const MAX_ATTEMPTS = 8;

function badgeClassFor(status: "open" | "merged" | "discarded"): string {
  if (status === "open") return styles.badgeOpen ?? "";
  if (status === "merged") return styles.badgeMerged ?? "";
  return styles.badgeDiscarded ?? "";
}

export function ParallelRunsPage(): ReactElement {
  const projects = useProjects();
  const runs = useParallelRuns();
  const createMutation = useCreateParallelRun();
  const deleteMutation = useDeleteParallelRun();

  const eligibleProjects = (projects.data ?? []).filter((p) => !!p.path);

  const [projectId, setProjectId] = useState<number | "">("");
  const [prompt, setPrompt] = useState("");
  const [attempts, setAttempts] = useState(3);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);

  function handleCreate(): void {
    if (typeof projectId !== "number") return;
    if (!prompt.trim()) {
      toast.error("Prompt is required");
      return;
    }
    createMutation.mutate(
      { projectId, prompt: prompt.trim(), attempts },
      {
        onSuccess: (detail) => {
          toast.success(`Spawned ${detail.attempts.length} worktrees`);
          setActiveRunId(detail.run.id);
          setPrompt("");
        },
        onError: (e) => toast.error(`Create failed: ${e.message}`),
      },
    );
  }

  function handleDelete(runId: number): void {
    if (!confirm("Discard this run and remove all its worktrees?")) return;
    deleteMutation.mutate(runId, {
      onSuccess: () => {
        toast.success("Run discarded");
        if (activeRunId === runId) setActiveRunId(null);
      },
      onError: (e) => toast.error(`Delete failed: ${e.message}`),
    });
  }

  return (
    <Shell>
      <div className={styles.page}>
        <header className={styles.header}>
          <div>
            <p className={styles.subtitle}>
              Fan one prompt out into N isolated git worktrees on the target
              project, compare each attempt's diff side-by-side, and merge the
              winner.
            </p>
          </div>
        </header>

        <section className={styles.createForm} aria-label="New parallel run">
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="pr-project">
              Project
            </label>
            <select
              id="pr-project"
              className={styles.select}
              value={projectId}
              onChange={(e) =>
                setProjectId(e.target.value ? Number(e.target.value) : "")
              }
            >
              <option value="">Select a project…</option>
              {eligibleProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.path}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="pr-attempts">
              Attempts
            </label>
            <select
              id="pr-attempts"
              className={styles.select}
              value={attempts}
              onChange={(e) => setAttempts(Number(e.target.value))}
            >
              {Array.from(
                { length: MAX_ATTEMPTS - MIN_ATTEMPTS + 1 },
                (_, i) => MIN_ATTEMPTS + i,
              ).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className={styles.btn}
            onClick={handleCreate}
            disabled={createMutation.isPending || typeof projectId !== "number"}
          >
            {createMutation.isPending ? "Spawning…" : "Create run"}
          </button>
          <div className={`${styles.field} ${styles.fieldFull}`}>
            <label className={styles.fieldLabel} htmlFor="pr-prompt">
              Prompt (describe the task)
            </label>
            <textarea
              id="pr-prompt"
              className={styles.input}
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. add a /health endpoint and a smoke test"
            />
          </div>
        </section>

        <RunList
          runs={runs.data?.runs ?? []}
          isPending={runs.isPending}
          activeRunId={activeRunId}
          onSelect={(id) => setActiveRunId(id === activeRunId ? null : id)}
          onDelete={handleDelete}
          deleting={deleteMutation.isPending}
        />

        {activeRunId !== null ? <RunDetail runId={activeRunId} /> : null}
      </div>
    </Shell>
  );
}

interface RunListProps {
  runs: ParallelRunSummary[];
  isPending: boolean;
  activeRunId: number | null;
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
  deleting: boolean;
}

function RunList({
  runs,
  isPending,
  activeRunId,
  onSelect,
  onDelete,
  deleting,
}: RunListProps): ReactElement {
  if (isPending) return <div className={styles.empty}>Loading runs…</div>;
  if (runs.length === 0) {
    return (
      <div className={styles.empty}>
        No parallel runs yet — create one above.
      </div>
    );
  }
  return (
    <section>
      <div className={styles.runList} role="list">
        {runs.map((r) => (
          <RunRow
            key={r.id}
            run={r}
            isActive={activeRunId === r.id}
            onSelect={() => onSelect(r.id)}
            onDelete={() => onDelete(r.id)}
            deleting={deleting}
          />
        ))}
      </div>
    </section>
  );
}

interface RunRowProps {
  run: ParallelRunSummary;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  deleting: boolean;
}

function RunRow({
  run,
  isActive,
  onSelect,
  onDelete,
  deleting,
}: RunRowProps): ReactElement {
  return (
    <div
      className={`${styles.runCard} ${isActive ? styles.runCardActive : ""}`}
      onClick={onSelect}
      role="listitem"
    >
      <span className={`${styles.badge} ${badgeClassFor(run.status)}`}>
        {run.status}
      </span>
      <div>
        <div className={styles.attemptTitle}>{run.prompt.slice(0, 120)}</div>
        <div className={styles.runMeta}>
          #{run.id} · {run.project_name} · {run.attempt_count} attempts · base{" "}
          {run.default_branch}
        </div>
      </div>
      <button
        type="button"
        className={`${styles.btn} ${styles.btnGhost}`}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        disabled={deleting || run.status !== "open"}
        title={run.status !== "open" ? "Already closed" : "Discard this run"}
      >
        Discard
      </button>
    </div>
  );
}

interface RunDetailProps {
  runId: number;
}

function RunDetail({ runId }: RunDetailProps): ReactElement {
  const detail = useParallelRun(runId);

  if (detail.isPending)
    return <div className={styles.empty}>Loading run #{runId}…</div>;
  if (detail.isError)
    return (
      <div className={styles.empty}>
        Failed to load run: {detail.error.message}
      </div>
    );
  if (!detail.data)
    return <div className={styles.empty}>Run #{runId} not found.</div>;

  const { run, attempts } = detail.data;
  return (
    <div className={styles.detail}>
      <div>
        <div className={styles.attemptTitle}>
          Run #{run.id} — {run.project_name}
        </div>
        <div className={styles.runMeta}>
          base branch <span className={styles.mono}>{run.default_branch}</span>{" "}
          · status {run.status}
        </div>
      </div>
      <div className={styles.attempts} role="list">
        {attempts.map((a) => (
          <AttemptCard
            key={a.id}
            runId={run.id}
            attempt={a}
            runStatus={run.status}
          />
        ))}
      </div>
    </div>
  );
}

interface AttemptCardProps {
  runId: number;
  attempt: ParallelAttempt;
  runStatus: ParallelRunSummary["status"];
}

function AttemptCard({
  runId,
  attempt,
  runStatus,
}: AttemptCardProps): ReactElement {
  const diff = useParallelAttemptDiff(runId, attempt.id);
  const merge = useMergeParallelAttempt();
  const [showDiff, setShowDiff] = useState(false);

  function handleMerge(): void {
    merge.mutate(
      { runId, attemptId: attempt.id },
      {
        onSuccess: () =>
          toast.success(`Merged attempt ${attempt.attempt_index}`),
        onError: (e) => toast.error(`Merge failed: ${e.message}`),
      },
    );
  }

  const noChanges = !!diff.data && diff.data.files.length === 0;

  return (
    <article className={styles.attempt} role="listitem">
      <div className={styles.attemptHead}>
        <div>
          <div className={styles.attemptTitle}>
            Attempt {attempt.attempt_index}
          </div>
          <div className={styles.mono}>{attempt.branch}</div>
        </div>
        <span className={`${styles.badge} ${badgeClassFor(attempt.status)}`}>
          {attempt.status}
        </span>
      </div>
      <div className={styles.mono} title={attempt.worktree_path}>
        {attempt.worktree_path.split("/").slice(-3).join("/")}
      </div>
      {diff.isPending ? (
        <div className={styles.diffEmpty}>Loading diff…</div>
      ) : diff.isError ? (
        <div className={styles.diffEmpty}>Diff error: {diff.error.message}</div>
      ) : noChanges ? (
        <div className={styles.diffEmpty}>
          No changes yet — run an agent in this worktree.
        </div>
      ) : (
        <>
          <div className={styles.diffFiles}>
            {(diff.data?.files ?? []).map((f) => (
              <div key={f.path} className={styles.diffFile}>
                <span className={styles.statusTag}>{f.status}</span>
                <span className={styles.mono}>{f.path}</span>
              </div>
            ))}
          </div>
          <button
            type="button"
            className={styles.diffToggle}
            onClick={() => setShowDiff((v) => !v)}
            aria-expanded={showDiff}
          >
            {showDiff ? "Hide diff" : "Show diff"}
          </button>
          {showDiff && diff.data ? (
            <pre className={styles.diffBody}>{diff.data.unified_diff}</pre>
          ) : null}
        </>
      )}
      <div className={styles.attemptActions}>
        <span className={styles.runMeta}>
          {diff.data ? `${diff.data.files.length} files` : ""}
        </span>
        <button
          type="button"
          className={styles.btn}
          onClick={handleMerge}
          disabled={runStatus !== "open" || noChanges || merge.isPending}
          title={
            noChanges
              ? "Nothing to merge"
              : "Merge this attempt into the project's default branch"
          }
        >
          {merge.isPending ? "Merging…" : "Merge this attempt"}
        </button>
      </div>
    </article>
  );
}
