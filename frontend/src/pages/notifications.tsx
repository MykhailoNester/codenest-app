import { useCallback, useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  dismissNotification,
  type Notification,
} from "../lib/api";
import { Shell } from "../components/layout/shell";
import { Icon } from "../components/icon";
import { relativeTime } from "../lib/format-helpers";

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

function typeLabel(type: string): string {
  switch (type) {
    case "task_assigned":
      return "Task";
    case "blocker_resolved":
      return "Unblocked";
    case "session_completed":
      return "Session";
    case "session_failed":
      return "Session";
    case "session_info":
      return "Session";
    case "cost_threshold":
    case "budget_threshold":
      return "Budget";
    default:
      return type.replace(/_/g, " ");
  }
}

interface NotificationRowProps {
  n: Notification;
  onRead: (n: Notification) => void;
  onDismiss: (id: number) => void;
}

function NotificationRow({
  n,
  onRead,
  onDismiss,
}: NotificationRowProps): ReactElement {
  const isUnread = n.read_at === null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 14,
        padding: "14px 18px",
        borderBottom: "1px solid var(--line-1)",
        background: isUnread
          ? "color-mix(in srgb, var(--accent) 4%, transparent)"
          : "transparent",
        transition: "background 0.15s",
      }}
    >
      <span
        style={{
          flexShrink: 0,
          width: 32,
          height: 32,
          borderRadius: "50%",
          background: "var(--bg-3)",
          border: "1px solid var(--line-2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: isUnread ? "var(--accent)" : "var(--fg-3)",
          marginTop: 2,
        }}
      >
        <Icon name={typeIcon(n.type)} size={13} />
      </span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 2,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontWeight: isUnread ? 600 : 400,
              fontSize: 14,
              color: "var(--fg-0)",
              cursor: "pointer",
            }}
            onClick={() => onRead(n)}
          >
            {n.title}
          </span>
          <span
            style={{
              fontSize: 10,
              padding: "1px 5px",
              borderRadius: 3,
              background: "var(--bg-3)",
              color: "var(--fg-4)",
              border: "1px solid var(--line-2)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            {typeLabel(n.type)}
          </span>
          {isUnread && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--accent)",
                flexShrink: 0,
              }}
              aria-label="Unread"
            />
          )}
        </div>
        {n.body && (
          <p
            style={{
              fontSize: 13,
              color: "var(--fg-2)",
              margin: "0 0 4px",
              lineHeight: 1.4,
            }}
          >
            {n.body}
          </p>
        )}
        <span style={{ fontSize: 11, color: "var(--fg-4)" }}>
          {relativeTime(n.created_at)}
        </span>
      </div>

      <div
        style={{ flexShrink: 0, display: "flex", gap: 6, alignItems: "center" }}
      >
        {isUnread && (
          <button
            type="button"
            title="Mark as read"
            style={{
              background: "none",
              border: "1px solid var(--line-2)",
              borderRadius: 4,
              cursor: "pointer",
              color: "var(--fg-3)",
              fontSize: 11,
              padding: "3px 8px",
            }}
            onClick={() => onRead(n)}
          >
            Read
          </button>
        )}
        <button
          type="button"
          title="Dismiss"
          style={{
            background: "none",
            border: "1px solid var(--line-2)",
            borderRadius: 4,
            cursor: "pointer",
            color: "var(--fg-4)",
            fontSize: 11,
            padding: "3px 8px",
          }}
          onClick={() => onDismiss(n.id)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function NotificationsPage(): ReactElement {
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);

  const { data: notifications = [], isLoading } = useNotifications(unreadOnly);
  const unreadCount = notifications.filter((n) => n.read_at === null).length;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["notifications"] });
  }, [queryClient]);

  // Notifications are informational only — clicking a row marks it read but
  // does not navigate anywhere.
  const handleRead = useCallback(
    async (n: Notification) => {
      if (n.read_at === null) {
        await markNotificationRead(n.id);
        invalidate();
      }
    },
    [invalidate],
  );

  const handleDismiss = useCallback(
    async (id: number) => {
      await dismissNotification(id);
      invalidate();
    },
    [invalidate],
  );

  const handleMarkAll = useCallback(async () => {
    await markAllNotificationsRead();
    invalidate();
  }, [invalidate]);

  return (
    <Shell
      actions={
        unreadCount > 0 ? (
          <button
            className="d3-btn d3-btn--ghost"
            type="button"
            style={{ fontSize: 12 }}
            onClick={() => void handleMarkAll()}
          >
            Mark all read
          </button>
        ) : undefined
      }
    >
      <div style={{ padding: "0 24px 24px" }}>
        {/* Filter tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
          <button
            type="button"
            className={`d3-tag${!unreadOnly ? " is-on" : ""}`}
            onClick={() => setUnreadOnly(false)}
          >
            All
          </button>
          <button
            type="button"
            className={`d3-tag${unreadOnly ? " is-on" : ""}`}
            onClick={() => setUnreadOnly(true)}
          >
            Unread {unreadCount > 0 ? `(${unreadCount})` : ""}
          </button>
        </div>

        <div className="d3-card" style={{ padding: 0, overflow: "hidden" }}>
          {isLoading ? (
            <div
              style={{
                padding: "32px 0",
                textAlign: "center",
                color: "var(--fg-3)",
                fontSize: 13,
              }}
            >
              Loading…
            </div>
          ) : notifications.length === 0 ? (
            <div
              style={{
                padding: "48px 0",
                textAlign: "center",
                color: "var(--fg-3)",
                fontSize: 13,
              }}
            >
              {unreadOnly
                ? "No unread notifications."
                : "No notifications yet."}
            </div>
          ) : (
            notifications.map((n) => (
              <NotificationRow
                key={n.id}
                n={n}
                onRead={(notif) => void handleRead(notif)}
                onDismiss={(id) => void handleDismiss(id)}
              />
            ))
          )}
        </div>
      </div>
    </Shell>
  );
}
