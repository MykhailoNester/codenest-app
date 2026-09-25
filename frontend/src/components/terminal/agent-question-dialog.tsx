import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  askUserQuestionInput,
  type AgentQuestion,
  type PermissionRequest,
} from "../../lib/agent-conversation";
import styles from "./agent-question-dialog.module.css";

interface AgentQuestionDialogProps {
  request: PermissionRequest;
  questions: AgentQuestion[];
  isFocusedPane: boolean;
  pendingBehind: number;
  onAnswer: (updatedInput: Record<string, unknown>) => void;
  onDeny: () => void;
}

interface Draft {
  labels: string[];
  otherOpen: boolean;
  otherText: string;
}

function emptyDraft(): Draft {
  return { labels: [], otherOpen: false, otherText: "" };
}

function draftValues(draft: Draft): string[] {
  const other = draft.otherOpen ? draft.otherText.trim() : "";
  return other.length > 0 ? [...draft.labels, other] : draft.labels;
}

export function AgentQuestionDialog({
  request,
  questions,
  isFocusedPane,
  pendingBehind,
  onAnswer,
  onDeny,
}: AgentQuestionDialogProps): ReactElement {
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(emptyDraft));
  const submitRef = useRef<HTMLButtonElement>(null);

  // Mount-only: the mount site keys this on `requestId`, so the next queued ask
  // arrives as a fresh component rather than inheriting selections.
  useEffect(() => {
    submitRef.current?.focus();
  }, []);

  const answers = useMemo(() => {
    const out: Record<string, string | string[]> = {};
    questions.forEach((q, i) => {
      const values = draftValues(drafts[i] ?? emptyDraft());
      if (values.length === 0) return;
      out[q.question] = q.multiSelect ? values : (values[0] as string);
    });
    return out;
  }, [questions, drafts]);

  const complete = Object.keys(answers).length === questions.length;

  function update(index: number, next: (draft: Draft) => Draft): void {
    setDrafts((prev) => prev.map((d, i) => (i === index ? next(d) : d)));
  }

  function toggleOption(index: number, label: string): void {
    const multi = questions[index]?.multiSelect === true;
    update(index, (d) => {
      if (!multi) return { ...d, labels: [label], otherOpen: false };
      return d.labels.includes(label)
        ? { ...d, labels: d.labels.filter((l) => l !== label) }
        : { ...d, labels: [...d.labels, label] };
    });
  }

  function toggleOther(index: number): void {
    const multi = questions[index]?.multiSelect === true;
    update(index, (d) =>
      d.otherOpen
        ? { ...d, otherOpen: false }
        : { ...d, otherOpen: true, labels: multi ? d.labels : [] },
    );
  }

  function submit(): void {
    if (!complete) return;
    onAnswer(askUserQuestionInput(request.input, answers));
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!isFocusedPane) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-agent-composer]")) return;
      if (target?.closest?.("[data-question-other]")) {
        // Typing free text is not a keyboard shortcut — except esc, which still
        // means "I'm not answering this".
        if (e.key !== "Escape") return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        submit();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDeny();
        return;
      }
      if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const index = drafts.findIndex((d) => draftValues(d).length === 0);
        if (index < 0) return;
        const option = questions[index]?.options[Number(e.key) - 1];
        if (!option) return;
        e.preventDefault();
        e.stopPropagation();
        toggleOption(index, option.label);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  const name = request.displayName ?? request.toolName;

  return (
    <div className={styles.ask} data-question-dialog>
      <h5 className={styles.askTitle}>
        {name === request.toolName ? "Question" : name}
        {pendingBehind > 0 ? (
          <span className={styles.askCount}> (1 of {pendingBehind + 1})</span>
        ) : null}
      </h5>

      {questions.map((q, index) => {
        const draft = drafts[index] ?? emptyDraft();
        return (
          <div key={`${q.question}-${index}`} className={styles.block}>
            {q.header !== null ? <span className={styles.chip}>{q.header}</span> : null}
            <p className={styles.prompt}>{q.question}</p>
            <div
              className={styles.options}
              role={q.multiSelect ? "group" : "radiogroup"}
              aria-label={q.question}
            >
              {q.options.map((option, oi) => {
                const checked = draft.labels.includes(option.label);
                return (
                  <label key={option.label} className={styles.option}>
                    <input
                      type={q.multiSelect ? "checkbox" : "radio"}
                      name={`q-${request.requestId}-${index}`}
                      checked={checked}
                      onChange={() => toggleOption(index, option.label)}
                    />
                    <span className={styles.optionBody}>
                      <span className={styles.optionLabel}>
                        {option.label}
                        {oi < 9 ? <span className={styles.kbd}>{oi + 1}</span> : null}
                      </span>
                      {option.description !== null ? (
                        <span className={styles.optionMeta}>{option.description}</span>
                      ) : null}
                    </span>
                  </label>
                );
              })}

              <label className={styles.option}>
                <input
                  type={q.multiSelect ? "checkbox" : "radio"}
                  name={`q-${request.requestId}-${index}`}
                  checked={draft.otherOpen}
                  onChange={() => toggleOther(index)}
                />
                <span className={styles.optionBody}>
                  <span className={styles.optionLabel}>Other…</span>
                </span>
              </label>
            </div>
            {draft.otherOpen ? (
              <input
                type="text"
                data-question-other
                className={styles.otherInput}
                aria-label={`Other answer for: ${q.question}`}
                placeholder="Type your answer"
                value={draft.otherText}
                onChange={(e) => update(index, (d) => ({ ...d, otherText: e.target.value }))}
              />
            ) : null}
          </div>
        );
      })}

      <div className={styles.btns}>
        <button
          ref={submitRef}
          type="button"
          className={`${styles.btn} ${styles.btnPri}`}
          disabled={!complete}
          onClick={submit}
        >
          Answer <span className={styles.kbd}>⏎</span>
        </button>
        <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={onDeny}>
          Deny <span className={styles.kbd}>esc</span>
        </button>
      </div>
    </div>
  );
}
