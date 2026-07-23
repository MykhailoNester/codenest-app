import { useState, useEffect, useRef, type ReactElement } from "react";
import { useCreateBudget, useWorkspaceProjects } from "../../lib/api";
import styles from "./onboarding-page.module.css";

interface ProjectLimit {
  uid: number;
  projectId: number | "";
  amount: string;
}

let _rowSeq = 0;

/** Step 6 (optional) — workspace + per-project monthly budgets. */
export function BudgetsStep({
  registerCommit,
}: {
  registerCommit: (fn: () => Promise<void>) => void;
}): ReactElement {
  const projectsQ = useWorkspaceProjects();
  const projects = projectsQ.data ?? [];
  const createBudget = useCreateBudget();
  const [wsLimit, setWsLimit] = useState("250.00");
  const [wsEnabled, setWsEnabled] = useState(true);
  const [hardStop, setHardStop] = useState(false);
  const [rows, setRows] = useState<ProjectLimit[]>([]);

  // Keep a ref to the latest save logic so the stable wrapper always
  // captures current wsEnabled/wsLimit/hardStop/rows without re-registering.
  const saveRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    registerCommit(() => saveRef.current());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const projectData = projectsQ.data ?? [];
    saveRef.current = async (): Promise<void> => {
      const ws = parseFloat(wsLimit);
      if (wsEnabled && ws > 0) {
        await createBudget.mutateAsync({
          name: "Workspace monthly",
          scope_type: "workspace",
          period: "monthly",
          limit_usd: ws,
          hard_stop: hardStop,
        });
      }
      for (const r of rows) {
        const amt = parseFloat(r.amount);
        if (typeof r.projectId === "number" && amt > 0) {
          const proj = projectData.find((p) => p.id === r.projectId);
          await createBudget.mutateAsync({
            name: `${proj?.name ?? "Project"} monthly`,
            scope_type: "project",
            scope_id: r.projectId,
            period: "monthly",
            limit_usd: amt,
          });
        }
      }
    };
  }, [wsEnabled, wsLimit, hardStop, rows, projectsQ.data, createBudget]);

  const usedIds = new Set(
    rows
      .map((r) => r.projectId)
      .filter((x): x is number => typeof x === "number"),
  );

  const addRow = (): void => {
    const next = projects.find((p) => !usedIds.has(p.id));
    setRows((prev) => [
      ...prev,
      { uid: _rowSeq++, projectId: next?.id ?? "", amount: "" },
    ]);
  };

  return (
    <>
      <div className={styles.kicker}>Step 06 &middot; Optional</div>
      <h1 className={styles.title}>
        Set budgets{" "}
        <span className={styles.muted} style={{ fontSize: 16, fontWeight: 400 }}>
          — optional
        </span>
      </h1>
      <p className={styles.lead}>
        Thanks to per-file-path attribution, cost can be tracked per project
        even from workspace sessions. Set limits now or continue and configure
        later in Settings.
      </p>

      <div className={styles.card}>
        <div className={styles.budHead}>
          <label className={styles.fieldLabel} style={{ margin: 0 }}>
            Workspace monthly limit
          </label>
          <div
            className={`${styles.switch} ${wsEnabled ? styles.switchOn : ""}`}
            onClick={() => setWsEnabled((v) => !v)}
            role="switch"
            aria-checked={wsEnabled}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") setWsEnabled((v) => !v);
            }}
          />
        </div>
        <div className={styles.money}>
          <input
            className={`${styles.fld} ${styles.fldMono}`}
            inputMode="decimal"
            value={wsLimit}
            placeholder="0.00"
            disabled={!wsEnabled}
            onChange={(e) => setWsLimit(e.target.value)}
          />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            marginTop: 12,
          }}
        >
          <div
            className={`${styles.switch} ${hardStop ? styles.switchOn : ""}`}
            onClick={() => setHardStop((v) => !v)}
            role="switch"
            aria-checked={hardStop}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") setHardStop((v) => !v);
            }}
          />
          <span className={styles.hint} style={{ margin: 0 }}>
            Hard-stop sessions when the limit is reached
          </span>
        </div>
      </div>

      <div className={styles.sectionH}>
        Per-project limits
        <span className={styles.sectionHLine} />
        <span
          className={styles.muted}
          style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}
        >
          accurate via hooks
        </span>
      </div>

      {rows.length === 0 && (
        <p className={styles.hint}>
          No per-project limits yet — add one below, or continue and set them
          later in Settings.
        </p>
      )}

      {rows.map((r, i) => (
        <div key={r.uid} className={styles.budgetRow}>
          <select
            className={styles.fld}
            value={r.projectId}
            onChange={(e) =>
              setRows((prev) =>
                prev.map((x, j) =>
                  j === i
                    ? {
                        ...x,
                        projectId: e.target.value ? Number(e.target.value) : "",
                      }
                    : x,
                ),
              )
            }
          >
            <option value="">Select project…</option>
            {projects.map((p) => (
              <option
                key={p.id}
                value={p.id}
                disabled={usedIds.has(p.id) && p.id !== r.projectId}
              >
                {p.name}
              </option>
            ))}
          </select>
          <div className={styles.money} style={{ width: 130, flexShrink: 0 }}>
            <input
              className={`${styles.fld} ${styles.fldMono}`}
              inputMode="decimal"
              value={r.amount}
              placeholder="0.00"
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((x, j) =>
                    j === i ? { ...x, amount: e.target.value } : x,
                  ),
                )
              }
            />
          </div>
          <button
            type="button"
            aria-label="Remove limit"
            className={`${styles.btn} ${styles.btnSm} ${styles.delBtn}`}
            onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}

      <button
        type="button"
        className={`${styles.btn} ${styles.btnSm}`}
        onClick={addRow}
        disabled={rows.length >= projects.length && projects.length > 0}
        style={{ marginTop: 11, alignSelf: "flex-start" }}
      >
        ＋ Add project limit
      </button>
    </>
  );
}
