import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSidecar, useNotificationsStream } from "../lib/api";
import { emitNativeNotification } from "../lib/ipc";
import {
  NOTIF_QUERY_KEY,
  parseNotifPrefs,
  prefFor,
  type NotifPrefs,
} from "../lib/notif-prefs";

export function ToastHost(): null {
  const queryClient = useQueryClient();

  // Per-type delivery preferences (shared cache with the Settings editor, so a
  // toggle there takes effect immediately). Read through a ref inside onEvent
  // so changing prefs does NOT re-create the callback and re-subscribe the SSE
  // stream (which would re-toast the 60-min backlog).
  const { data: prefSetting } = useQuery<{ value_json: string } | null>({
    queryKey: NOTIF_QUERY_KEY,
    queryFn: () =>
      fetchSidecar<{ value_json: string } | null>(
        "/api/v1/settings/notification_prefs_json",
      ).catch(() => null),
  });
  const prefs: NotifPrefs = useMemo(
    () => parseNotifPrefs(prefSetting?.value_json),
    [prefSetting?.value_json],
  );
  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  const onEvent = useCallback(
    (eventName: string, data: unknown) => {
      if (eventName === "snapshot") {
        void queryClient.invalidateQueries({ queryKey: ["notifications"] });
        return;
      }

      if (eventName !== "notification") return;

      const n = data as {
        type?: string;
        title?: string;
        body?: string | null;
        priority?: string;
      };

      const title = n.title ?? "Notification";
      const description = n.body ?? undefined;
      const priority = n.priority ?? "normal";
      const pref = prefFor(prefsRef.current, n.type);

      void queryClient.invalidateQueries({ queryKey: ["notifications"] });

      // In-app toast: honour the per-type preference; priority only styles it.
      // Low priority stays non-intrusive (no toast).
      if (pref.toast && priority !== "low") {
        if (priority === "high") {
          toast.error(title, {
            description,
            duration: Infinity,
            closeButton: true,
          });
        } else {
          toast(title, { description, duration: 6000, closeButton: true });
        }
      }

      // Native macOS notification when the user opted in for this type.
      if (pref.native) {
        void emitNativeNotification({ title, body: description, priority }).catch(
          () => {
            // permission denied — in-app toast (if enabled) already shown
          },
        );
      }
    },
    [queryClient],
  );

  useNotificationsStream(onEvent);

  return null;
}
