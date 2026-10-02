/**
 * The bell in the chrome, drawn on Deck (#283).
 *
 * It is the one piece of chrome on every screen, and since #270 folded the
 * Notifications page away it is the only place the full history — read and
 * unread — lives. It was still the old blue rounded theme (icon chips per row,
 * a pill "N unread" badge, cards with heavy padding) sitting inside a
 * monospace console.
 *
 * One vocabulary with Needs You
 * -----------------------------
 * `attention_service._produce_notifications` gives every unread notification
 * severity `queued`, which `pages/attention.tsx` renders as the `wait` glyph
 * (`?`). The same notification therefore carries the same `?` here, and a read
 * one — history, waiting on nobody — is `idle` (`·`). That is also the
 * unread/read distinction: glyph plus `.sub` on the title, so it survives with
 * colour off.
 *
 * The per-type blue icon chip is replaced by a `.dk-tag` carrying the type as
 * a word ("session failed", "budget"), which is Deck's own trade — icons out,
 * text plus the state glyph in. The type is *not* mapped onto the glyph
 * column: that would give the bell a second vocabulary for a row Needs You
 * already calls `?`.
 *
 * Still no navigation. A row marks itself read and stays where it is, exactly
 * as before. `lib/notification-route.ts`'s `notifRoute` is the routing
 * authority for the folded rows on Needs You (via `lib/attention-action.ts`)
 * and this component has never called it; wiring it in would be a product
 * decision, not a restyle.
 */
import React, { useState, useRef, useEffect, useCallback, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  useNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  type Notification,
} from "../lib/api";
import { Icon } from "./icon";
import { DeckGrid, DeckHead, DeckLine } from "./deck/deck-grid";
import { relativeTime } from "../lib/format-helpers";
import { useEscapeKey } from "../hooks/use-escape-key";

/**
 * This popover's column template.
 *
 * Not in `DECK_COLS`: that module is a deck primitive and is out of scope for
 * this ticket, so the shape lives with the only list that has it — the same
 * call `pages/attention.tsx` makes for `ATTENTION_COLS` and
 * `components/sessions/run-cols.ts` for the run lists. A 520px popover has
 * room for the subject and a timestamp and nothing else, which no named
 * template describes; `simple` is the closest and still spends 90px on a
 * column this list does not have.
 */
const BELL_COLS = "14px minmax(0, 1fr) 76px";

/**
 * `.dk-modal` is the Deck panel — border, ground, header/body/footer, capped
 * height. The bell is a popover anchored under its trigger rather than a
 * centred dialog, so it takes the panel without `.dk-scrim` and overrides the
 * two things the scrim would otherwise have decided: where it sits and how
 * wide it is. Same inline-override move `launch/launch-composer.tsx` makes for
 * its own modal.
 */
const POPOVER_STYLE: CSSProperties = {
  position: "fixed",
  width: "min(520px, calc(100vw - 24px))",
  maxHeight: "min(70vh, 560px)",
  zIndex: 9999,
};

/**
 * A body is prose, and `.dk-list.prose` is Deck's one opt-out from the
 * truncating line — but an unclamped 40-line body would push the next
 * notification off the popover. Collapsed is two lines; clicking the body
 * opens it, which is the behaviour the old card had.
 */
const BODY_COLLAPSED: CSSProperties = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
  overflow: "hidden",
};
const BODY_EXPANDED: CSSProperties = { whiteSpace: "pre-wrap" };

/** The type, as a word. Replaces the blue per-type icon chip. */
const TYPE_LABEL: Record<string, string> = {
  task_assigned: "task",
  blocker_resolved: "unblocked",
  session_completed: "session done",
  session_info: "session",
  session_failed: "session failed",
  cost_threshold: "cost",
  budget_threshold: "budget",
  inbox_new: "inbox",
};

function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type.replace(/_/g, " ");
}

export function NotificationBell(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{
    top: number;
    right: number;
  }>({ top: 0, right: 0 });
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<number>>(
    new Set(),
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const { data: notifications = [] } = useNotifications(false);

  const unread = notifications.filter((n) => n.read_at === null);
  const unreadCount = unread.length;
  const badge =
    unreadCount > 9 ? "9+" : unreadCount > 0 ? String(unreadCount) : null;

  const handleToggle = useCallback(() => {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom + 6,
        right: window.innerWidth - rect.right,
      });
    } else {
      setExpandedIds(new Set());
    }
    setOpen((v) => !v);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        buttonRef.current &&
        !buttonRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setOpen(false);
        setExpandedIds(new Set());
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleClose = useCallback(() => setOpen(false), []);
  useEscapeKey(handleClose, open);

  const handleExpandToggle = useCallback((e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Notifications are informational only — activating a row marks it read but
  // does not navigate anywhere.
  const handleRowClick = useCallback(
    async (n: Notification) => {
      if (!n.read_at) {
        await markNotificationRead(n.id);
        void queryClient.invalidateQueries({ queryKey: ["notifications"] });
      }
    },
    [queryClient],
  );

  const handleMarkAll = useCallback(async () => {
    await markAllNotificationsRead();
    void queryClient.invalidateQueries({ queryKey: ["notifications"] });
  }, [queryClient]);

  return (
    <>
      <button
        ref={buttonRef}
        className="dk-btn bare"
        type="button"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        aria-expanded={open}
        onClick={handleToggle}
      >
        <Icon name="bell" size={13} />
        {badge !== null && (
          <span className="dk-tag" data-s="wait">
            {badge}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          // `deck` because this portals to `document.body`, outside the `.deck`
          // the page draws inside — without it every Deck token resolves to
          // nothing and the panel renders as an unstyled white box.
          // `display: contents` keeps the wrapper out of layout
          // (`launch/launch-composer.tsx` sets the same precedent).
          <div className="deck" style={{ display: "contents" }}>
            <div
              ref={dropdownRef}
              className="dk-modal"
              style={{
                ...POPOVER_STYLE,
                top: dropdownPos.top,
                right: dropdownPos.right,
              }}
              role="dialog"
              aria-label="Notifications"
            >
              <div className="dk-modal__h">
                <span>notifications</span>
                {unreadCount > 0 && (
                  <span className="dim">{unreadCount} unread</span>
                )}
                <span className="sp" />
                {unreadCount > 0 && (
                  <button
                    type="button"
                    className="dk-btn"
                    onClick={() => void handleMarkAll()}
                  >
                    mark all read
                  </button>
                )}
              </div>
              <div className="dk-modal__b">
                {notifications.length === 0 ? (
                  <div className="dk-note">No notifications</div>
                ) : (
                  <DeckGrid cols={BELL_COLS} className="prose" label="Notifications">
                    <DeckHead cells={["notification", "r when"]} />
                    {notifications.slice(0, 50).map((n) => {
                      const isUnread = n.read_at === null;
                      return (
                        <DeckLine
                          key={n.id}
                          state={isUnread ? "wait" : "idle"}
                          // Activation is the row's one action, and it is the
                          // row's own write rather than a bulk one — a read row
                          // has nothing to activate, so it carries no handler.
                          onOpen={isUnread ? () => void handleRowClick(n) : undefined}
                          cells={[
                            {
                              v: (
                                <>
                                  <div className="dk-actions">
                                    {/* Unread is bold and on `.sub`'s brighter
                                        ink, read is neither — the distinction
                                        survives with colour off, which is the
                                        same test the glyph column passes. */}
                                    {isUnread ? (
                                      <b className="sub">{n.title}</b>
                                    ) : (
                                      <span>{n.title}</span>
                                    )}
                                    <span className="dk-tag">{typeLabel(n.type)}</span>
                                  </div>
                                  {n.body && (
                                    <div
                                      className="dim"
                                      style={
                                        expandedIds.has(n.id)
                                          ? BODY_EXPANDED
                                          : BODY_COLLAPSED
                                      }
                                      onClick={(e) => handleExpandToggle(e, n.id)}
                                    >
                                      {n.body}
                                    </div>
                                  )}
                                  {isUnread && (
                                    <div className="dk-actions">
                                      <button
                                        type="button"
                                        className="dk-btn bare"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void handleRowClick(n);
                                        }}
                                      >
                                        mark read
                                      </button>
                                    </div>
                                  )}
                                </>
                              ),
                              title: n.title,
                            },
                            { v: relativeTime(n.created_at), cls: "r" },
                          ]}
                        />
                      );
                    })}
                  </DeckGrid>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
