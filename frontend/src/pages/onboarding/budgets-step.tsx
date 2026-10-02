import { useState, useEffect, useRef, type ReactElement } from "react";
import { useCreateBudget, useWorkspaceProjects } from "../../lib/api";
import { StepHead, StepField, StepHint } from "./step-chrome";

interface ProjectLimit {
  uid: number;
  projectId: number | "";
  amount: string;
}

let _rowSeq = 0;

/**
 * Deck has no switch. The pre-Deck control was a `div[role="switch"]` with its
 * own key handling; this keeps the same ARIA contract on a real button, where
 * Enter and Space activate natively, and shows the state as text so it reads
 * with colour off.
 */
function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`dk-btn${checked ? " pri" : ""}`}
      onClick={() => onChange(!checked)}
    >
      {checked ? "on" : "off"}
    </button>
  );
}

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
      <StepHead
        kicker="step 06 · optional"
        title={
          <>
            Set budgets <span className="dim">— optional</span>
          </>
        }
      >
        Thanks to per-file-path attribution, cost can be tracked per project even
        from workspace sessions. Set limits now or continue and configure later
        in Settings.
      </StepHead>

      <div className="dk-group">
        <h2 className="dk-group__h">
          <span>Workspace limit</span>
          <span className="sp" />
          <span className="dk-actions">
            <Switch
              checked={wsEnabled}
              onChange={setWsEnabled}
              label="Workspace monthly limit"
            />
          </span>
        </h2>
        <div className="dk-form">
          <div className="dk-form__grid">
            <StepField label="Monthly limit (USD)" htmlFor="ob-ws-limit">
              <input
                id="ob-ws-limit"
                className="dk-ctl"
                inputMode="decimal"
                value={wsLimit}
                placeholder="0.00"
                disabled={!wsEnabled}
                onChange={(e) => setWsLimit(e.target.value)}
              />
            </StepField>
            <StepField label="Hard stop">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--u2)",
                }}
              >
                <Switch
                  checked={hardStop}
                  onChange={setHardStop}
                  label="Hard-stop sessions when the limit is reached"
                />
                <StepHint>
                  Hard-stop sessions when the limit is reached
                </StepHint>
              </div>
            </StepField>
          </div>
        </div>
      </div>

      <div className="dk-group">
        <h2 className="dk-group__h">
          <span>Per-project limits</span>
          <span className="n">{rows.length}</span>
          <span className="note">accurate via hooks</span>
          <span className="sp" />
          <span className="dk-actions">
            <button
              type="button"
              className="dk-btn"
              onClick={addRow}
              disabled={rows.length >= projects.length && projects.length > 0}
            >
              ＋ Add project limit
            </button>
          </span>
        </h2>

        {rows.length === 0 && (
          <StepHint>
            No per-project limits yet — add one above, or continue and set them
            later in Settings.
          </StepHint>
        )}

        {rows.map((r, i) => (
          <div
            key={r.uid}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--u2)",
              padding: "var(--u) var(--u3)",
            }}
          >
            <span className="dk-sel">
              <select
                aria-label={`Project for limit ${i + 1}`}
                value={r.projectId}
                onChange={(e) =>
                  setRows((prev) =>
                    prev.map((x, j) =>
                      j === i
                        ? {
                            ...x,
                            projectId: e.target.value
                              ? Number(e.target.value)
                              : "",
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
            </span>
            <input
              className="dk-ctl"
              style={{ width: 130, flex: "none" }}
              aria-label={`Monthly limit ${i + 1} (USD)`}
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
            <button
              type="button"
              aria-label="Remove limit"
              className="dk-btn bare danger icon"
              onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
