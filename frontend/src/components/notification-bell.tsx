import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  useNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  type Notification,
} from "../lib/api";
import { Icon } from "./icon";
import styles from "./notification-bell.module.css";
import { relativeTime } from "../lib/format-helpers";
import { useEscapeKey } from "../hooks/use-escape-key";

function typeIcon(type: string): string {
  switch (type) {
    case "task_assigned":
    case "blocker_resolved":
      return "tasks";
    case "session_completed":
    case "session_info":
      return "check-circle";
    case "session_failed":
    case "cost_threshold":
    case "budget_threshold":
      return "zap";
    default:
      return "bell";
  }
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

  // Notifications are informational only — clicking a row marks it read but
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
        className={styles.bell}
        type="button"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        aria-expanded={open}
        onClick={handleToggle}
      >
        <Icon name="bell" size={16} />
        {badge !== null && <span className={styles.badge}>{badge}</span>}
      </button>

      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            className={styles.dropdown}
            style={{ top: dropdownPos.top, right: dropdownPos.right }}
            role="dialog"
            aria-label="Notifications"
          >
            <div className={styles.header}>
              <span className={styles.headerTitle}>Notifications</span>
              {unreadCount > 0 && (
                <span className={styles.headerBadge}>{unreadCount} unread</span>
              )}
            </div>
            {notifications.length === 0 ? (
              <div className={styles.empty}>No notifications</div>
            ) : (
              <>
                <div className={styles.list}>
                  {notifications.slice(0, 50).map((n) => (
                    <button
                      key={n.id}
                      className={`${styles.item}${n.read_at === null ? ` ${styles.unread}` : ""}`}
                      type="button"
                      onClick={() => void handleRowClick(n)}
                    >
                      <span className={styles.itemIcon}>
                        <Icon name={typeIcon(n.type)} size={13} />
                      </span>
                      <span className={styles.itemBody}>
                        <span className={styles.itemTitle}>{n.title}</span>
                        {n.body && (
                          <span
                            className={
                              expandedIds.has(n.id)
                                ? styles.itemDescExpanded
                                : styles.itemDesc
                            }
                            onClick={(e) => handleExpandToggle(e, n.id)}
                          >
                            {n.body}
                          </span>
                        )}
                        <span className={styles.itemTime}>
                          {relativeTime(n.created_at)}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
                {unreadCount > 0 && (
                  <div className={styles.footer}>
                    <button
                      className={styles.markAll}
                      type="button"
                      onClick={() => void handleMarkAll()}
                    >
                      Mark all read
                    </button>
                  </div>
                )}
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
