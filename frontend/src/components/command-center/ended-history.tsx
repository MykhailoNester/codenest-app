import { memo, useState, type ReactElement } from "react";
import { useEndedSessions } from "../../lib/api";
import type { ProfileOut } from "../../lib/api";
import { SessionCard } from "./session-card";

interface EndedHistoryProps {
  profiles: ProfileOut[];
  onSelectSession: (sessionId: string) => void;
  onClose: () => void;
}

const PAGE_SIZE = 20;

function EndedHistoryInner({
  profiles,
  onSelectSession,
  onClose,
}: EndedHistoryProps): ReactElement {
  const [offset, setOffset] = useState(0);
  const { data, isFetching } = useEndedSessions(offset, PAGE_SIZE);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const currentPage = Math.floor(offset / PAGE_SIZE);
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  function handlePrev() {
    setOffset((o) => Math.max(0, o - PAGE_SIZE));
  }

  function handleNext() {
    setOffset((o) => o + PAGE_SIZE);
  }

  function handleSelect(sessionId: string) {
    onSelectSession(sessionId);
    onClose();
  }

  return (
    /* backdrop */
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Ended sessions"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
      }}
    >
      {/* drawer */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--line-2)",
          borderRadius: 12,
          width: "min(680px, 92vw)",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 20px",
            borderBottom: "1px solid var(--line-2)",
            flexShrink: 0,
          }}
        >
          <span className="d3-h">
            Ended Sessions
            <span
              style={{
                marginLeft: 8,
                fontSize: "11px",
                color: "var(--fg-4)",
                fontFamily: "var(--font-mono)",
                fontWeight: 400,
              }}
            >
              {total} total
            </span>
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--fg-3)",
              fontSize: "18px",
              lineHeight: 1,
              padding: "0 4px",
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* body */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "12px 16px",
          }}
        >
          {isFetching && items.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                color: "var(--fg-4)",
                fontSize: "12px",
                padding: "32px 0",
              }}
            >
              Loading…
            </div>
          ) : items.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                color: "var(--fg-4)",
                fontSize: "12px",
                padding: "32px 0",
              }}
            >
              No ended sessions found.
            </div>
          ) : (
            <div className="d3-list__grid">
              {items.map((s) => (
                <SessionCard
                  key={s.session_id}
                  session={s}
                  selected={false}
                  onSelect={handleSelect}
                  profiles={profiles}
                />
              ))}
            </div>
          )}
        </div>

        {/* footer pagination */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 20px",
            borderTop: "1px solid var(--line-2)",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: "11px",
              color: "var(--fg-4)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {total > 0
              ? `Showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`
              : "0 results"}
          </span>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="d3-btn"
              onClick={handlePrev}
              disabled={!hasPrev}
              aria-label="Previous page"
            >
              Prev
            </button>
            <span
              style={{
                fontSize: "11px",
                color: "var(--fg-3)",
                alignSelf: "center",
                fontFamily: "var(--font-mono)",
              }}
            >
              {currentPage + 1} / {totalPages || 1}
            </span>
            <button
              type="button"
              className="d3-btn"
              onClick={handleNext}
              disabled={!hasNext}
              aria-label="Next page"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export const EndedHistory = memo(EndedHistoryInner);
