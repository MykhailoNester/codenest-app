import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import {
  askUserQuestionInput,
  type AgentQuestion,
  type PermissionRequest,
} from "../../lib/agent-conversation";

/* ── Local constants ─────────────────────────────────────────────────────
   Question, not warning: an ask from Claude is not a safety escalation, so it
   borrows the permission dialog's shape (Deck's `.dk-modal*`) but the live tone
   rather than the amber one. Inline, never inside `.dk-scrim`, for the reason
   `agent-permission-dialog.tsx` states.

   The buttons are Deck's own and are untouched by this file: Answer is the one
   `.dk-btn.pri`, Deny is the one `.dk-btn.danger`, and `.dk-actions .sep`
   separates them. Nothing below changes which button is which.

   Declared here rather than in `components/deck/*` or `design/deck/*`, which
   #283 does not touch — the precedent is the composer's `EDITOR_*` constants.
   Inline, so an override of a `.dk-*` rule does not depend on stylesheet
   injection order. */

const ASK_STYLE: CSSProperties = {
  width: "100%",
  maxHeight: "none",
  margin: "var(--u2) 0",
  borderColor: "var(--run)",
};

/** `.dk-modal__h` is written for a `div`; this is an `h5`, so the heading's own
 *  UA margin and weight have to go. */
const TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontWeight: 400,
  color: "var(--run)",
  borderBottomColor: "var(--run)",
};

const COUNT_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  textTransform: "none",
  letterSpacing: 0,
  color: "var(--fg-2)",
};

/** `.block + .block` as data: an adjacent-sibling rule is one of the two things
 *  an inline style cannot express, so the divider between two questions in the
 *  same ask is drawn from the index. */
const BLOCK_STYLE: CSSProperties = {};

const BLOCK_DIVIDED_STYLE: CSSProperties = {
  marginTop: "var(--u4)",
  paddingTop: "var(--u3)",
  borderTop: "1px solid var(--line)",
};

const PROMPT_STYLE: CSSProperties = {
  margin: "var(--u) 0 var(--u2)",
  fontSize: "var(--fs)",
  color: "var(--fg)",
  wordBreak: "break-word",
};

const OPTIONS_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--u)",
};

/** One answer. Not a `.dk-btn`: these are a radio/checkbox set, and giving an
 *  option a button's affordance would make picking one look like submitting
 *  it. The hover tone is the only feedback that it is pickable at all, so it
 *  is carried in state rather than dropped — an inline style has no `:hover`. */
const OPTION_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--u2)",
  padding: "5px var(--u2)",
  border: "1px solid var(--line)",
  borderRadius: 3,
  background: "var(--bg-1)",
  cursor: "pointer",
};

const OPTION_HOVER_STYLE: CSSProperties = {
  ...OPTION_STYLE,
  borderColor: "var(--run)",
};

const OPTION_BODY_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
};

const OPTION_LABEL_STYLE: CSSProperties = {
  fontSize: "var(--fs-s)",
  color: "var(--fg)",
  wordBreak: "break-word",
};

const OPTION_META_STYLE: CSSProperties = {
  fontSize: "var(--fs-s)",
  color: "var(--fg-3)",
  wordBreak: "break-word",
};

const OTHER_INPUT_STYLE: CSSProperties = { marginTop: 5 };

/** Inherits its container's colour rather than naming one — inside a
 *  `.dk-btn.pri` that means the inverted ground, inside an option label the
 *  ordinary foreground. */
const KBD_STYLE: CSSProperties = {
  marginLeft: "var(--u2)",
  fontSize: "var(--fs-xs)",
  opacity: 0.65,
};

function OptionLabel({ children }: { children: ReactNode }): ReactElement {
  const [hover, setHover] = useState(false);
  return (
    <label
      style={hover ? OPTION_HOVER_STYLE : OPTION_STYLE}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {children}
    </label>
  );
}

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
    <div className="dk-modal" style={ASK_STYLE} data-question-dialog>
      <h5 className="dk-modal__h" style={TITLE_STYLE}>
        question
        <span style={COUNT_STYLE}>
          {name === request.toolName ? "" : name}
          {pendingBehind > 0 ? ` (1 of ${pendingBehind + 1})` : ""}
        </span>
      </h5>

      <div className="dk-modal__b">
        {questions.map((q, index) => {
          const draft = drafts[index] ?? emptyDraft();
          return (
            <div
              key={`${q.question}-${index}`}
              style={index === 0 ? BLOCK_STYLE : BLOCK_DIVIDED_STYLE}
            >
              {q.header !== null ? <span className="dk-tag">{q.header}</span> : null}
              <p style={PROMPT_STYLE}>{q.question}</p>
              <div
                style={OPTIONS_STYLE}
                role={q.multiSelect ? "group" : "radiogroup"}
                aria-label={q.question}
              >
                {q.options.map((option, oi) => {
                  const checked = draft.labels.includes(option.label);
                  return (
                    <OptionLabel key={option.label}>
                      <input
                        type={q.multiSelect ? "checkbox" : "radio"}
                        name={`q-${request.requestId}-${index}`}
                        checked={checked}
                        onChange={() => toggleOption(index, option.label)}
                      />
                      <span style={OPTION_BODY_STYLE}>
                        <span style={OPTION_LABEL_STYLE}>
                          {option.label}
                          {oi < 9 ? <span style={KBD_STYLE}>{oi + 1}</span> : null}
                        </span>
                        {option.description !== null ? (
                          <span style={OPTION_META_STYLE}>{option.description}</span>
                        ) : null}
                      </span>
                    </OptionLabel>
                  );
                })}

                <OptionLabel>
                  <input
                    type={q.multiSelect ? "checkbox" : "radio"}
                    name={`q-${request.requestId}-${index}`}
                    checked={draft.otherOpen}
                    onChange={() => toggleOther(index)}
                  />
                  <span style={OPTION_BODY_STYLE}>
                    <span style={OPTION_LABEL_STYLE}>Other…</span>
                  </span>
                </OptionLabel>
              </div>
              {draft.otherOpen ? (
                <input
                  type="text"
                  data-question-other
                  className="dk-ctl"
                  style={OTHER_INPUT_STYLE}
                  aria-label={`Other answer for: ${q.question}`}
                  placeholder="Type your answer"
                  value={draft.otherText}
                  onChange={(e) => update(index, (d) => ({ ...d, otherText: e.target.value }))}
                />
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="dk-modal__f">
        <span className="dk-actions">
          <button
            ref={submitRef}
            type="button"
            className="dk-btn pri"
            disabled={!complete}
            onClick={submit}
          >
            Answer <span style={KBD_STYLE}>⏎</span>
          </button>
          <span className="sep" />
          <button type="button" className="dk-btn danger" onClick={onDeny}>
            Deny <span style={KBD_STYLE}>esc</span>
          </button>
        </span>
      </div>
    </div>
  );
}
