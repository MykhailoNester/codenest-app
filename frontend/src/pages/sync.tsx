import { useMemo, useState, type ReactElement } from "react";
import { toast } from "sonner";
import {
  useCreateSnapshot,
  useCreateSyncTarget,
  useDeleteSyncTarget,
  useRestoreSnapshot,
  useSyncHistory,
  useSyncSnapshots,
  useSyncTargets,
  type SyncKind,
  type SyncSnapshotListed,
  type SyncTarget,
} from "../lib/api";
import { Shell } from "../components/layout/shell";
import { formatBytes } from "../lib/format-helpers";

const SYNC_KINDS: readonly SyncKind[] = [
  "local",
  "icloud",
  "dropbox",
  "syncthing",
  "s3",
];

const cardStyle: React.CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line-2)",
  borderRadius: 8,
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const inputStyle: React.CSSProperties = {
  padding: "6px 8px",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  color: "var(--fg-0)",
  borderRadius: 4,
  fontSize: 12,
};


function NewTargetForm({
  onCreate,
  submitting,
}: {
  onCreate: (input: {
    label: string;
    kind: SyncKind;
    dir_path: string;
  }) => void;
  submitting: boolean;
}): ReactElement {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<SyncKind>("local");
  const [dirPath, setDirPath] = useState("");
  const canSubmit = label.trim() && dirPath.trim() && kind !== "s3";
  return (
    <form
      style={cardStyle}
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        onCreate({ label: label.trim(), kind, dir_path: dirPath.trim() });
        setLabel("");
        setDirPath("");
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)" }}>
        Add sync target
      </div>
      <p style={{ fontSize: 11, color: "var(--fg-3)", margin: 0 }}>
        Snapshots are written as <code>.tar.gz</code> files to this directory.
        The user's iCloud / Dropbox / Syncthing app handles uploading. S3 is not
        yet supported in v1 — encryption is also a known follow-up.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11,
            color: "var(--fg-3)",
          }}
        >
          Label
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="My Dropbox backup"
            style={inputStyle}
          />
        </label>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11,
            color: "var(--fg-3)",
          }}
        >
          Kind
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as SyncKind)}
            style={inputStyle}
          >
            {SYNC_KINDS.map((k) => (
              <option key={k} value={k} disabled={k === "s3"}>
                {k}
                {k === "s3" ? " (coming soon)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11,
            color: "var(--fg-3)",
            gridColumn: "1 / -1",
          }}
        >
          Directory path
          <input
            value={dirPath}
            onChange={(e) => setDirPath(e.target.value)}
            placeholder="/Users/you/Library/Mobile Documents/com~apple~CloudDocs/codenest-backups"
            style={{ ...inputStyle, fontFamily: "monospace" }}
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={!canSubmit || submitting}
        style={{
          alignSelf: "flex-start",
          padding: "5px 12px",
          borderRadius: 4,
          border: "1px solid var(--line-2)",
          background: canSubmit ? "rgba(59, 130, 246, 0.15)" : "var(--bg-1)",
          color: canSubmit ? "var(--fg-0)" : "var(--fg-3)",
          cursor: canSubmit ? "pointer" : "not-allowed",
          fontSize: 12,
        }}
      >
        {submitting ? "Adding…" : "Add target"}
      </button>
    </form>
  );
}

function SnapshotList({
  target,
  snapshots,
  onRestore,
  restoring,
}: {
  target: SyncTarget;
  snapshots: SyncSnapshotListed[];
  onRestore: (file_name: string) => void;
  restoring: boolean;
}): ReactElement {
  if (snapshots.length === 0) {
    return (
      <div style={{ fontSize: 11, color: "var(--fg-4)" }}>
        No snapshots in <code>{target.dir_path}</code>. Click "Take snapshot" to
        create one.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {snapshots.map((s) => (
        <div
          key={s.file_name}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            padding: "4px 8px",
            background: "var(--bg-1)",
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ color: "var(--fg-1)", fontFamily: "monospace" }}>
              {s.file_name}
            </span>
            <span style={{ color: "var(--fg-4)", fontSize: 11 }}>
              {formatBytes(s.bytes)}
              {s.manifest
                ? ` · v${s.manifest.version} · ${s.manifest.sources.join(", ")}`
                : " · invalid manifest"}
            </span>
          </div>
          <button
            type="button"
            disabled={!s.valid || restoring}
            onClick={() => {
              if (
                window.confirm(
                  `Restore ${s.file_name}? Your current DB and plugins will be renamed to *.pre-restore-* first.`,
                )
              ) {
                onRestore(s.file_name);
              }
            }}
            style={{
              padding: "3px 10px",
              borderRadius: 4,
              border: "1px solid var(--line-2)",
              background: "transparent",
              color: s.valid ? "var(--fg-2)" : "var(--fg-4)",
              cursor: s.valid && !restoring ? "pointer" : "not-allowed",
              fontSize: 11,
            }}
          >
            {restoring ? "Restoring…" : "Restore"}
          </button>
        </div>
      ))}
    </div>
  );
}

function TargetCard({
  target,
  onDelete,
  onSnapshot,
  snapshotting,
  onRestore,
  restoring,
}: {
  target: SyncTarget;
  onDelete: () => void;
  onSnapshot: () => void;
  snapshotting: boolean;
  onRestore: (file_name: string) => void;
  restoring: boolean;
}): ReactElement {
  const { data: snapshots = [] } = useSyncSnapshots(target.id);
  return (
    <div style={cardStyle}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-0)" }}>
            {target.label}
          </span>
          <span
            style={{
              fontSize: 11,
              color: "var(--fg-3)",
              fontFamily: "monospace",
            }}
          >
            {target.kind} · {target.dir_path}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            onClick={onSnapshot}
            disabled={snapshotting || !target.enabled}
            style={{
              padding: "5px 10px",
              borderRadius: 4,
              border: "1px solid var(--line-2)",
              background: "rgba(34, 197, 94, 0.15)",
              color: "var(--fg-0)",
              cursor:
                snapshotting || !target.enabled ? "not-allowed" : "pointer",
              fontSize: 12,
            }}
          >
            {snapshotting ? "Snapshotting…" : "Take snapshot"}
          </button>
          <button
            type="button"
            onClick={onDelete}
            style={{
              padding: "5px 10px",
              borderRadius: 4,
              border: "1px solid var(--line-2)",
              background: "transparent",
              color: "#ef4444",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Remove
          </button>
        </div>
      </div>
      <SnapshotList
        target={target}
        snapshots={snapshots}
        onRestore={onRestore}
        restoring={restoring}
      />
    </div>
  );
}

export function SyncPage(): ReactElement {
  const { data: targets = [], isPending } = useSyncTargets();
  const { data: history = [] } = useSyncHistory();
  const create = useCreateSyncTarget();
  const remove = useDeleteSyncTarget();
  const snapshot = useCreateSnapshot();
  const restore = useRestoreSnapshot();

  const lastFiveHistory = useMemo(() => history.slice(0, 5), [history]);

  return (
    <Shell>
      <div
        style={{
          padding: "16px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          color: "var(--fg-1)",
        }}
      >
        <NewTargetForm
          submitting={create.isPending}
          onCreate={(input) =>
            create.mutate(input, {
              onSuccess: () => toast.success(`Target '${input.label}' added`),
              onError: (e) => toast.error(`Add failed: ${e.message}`),
            })
          }
        />

        {isPending ? (
          <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
            Loading targets…
          </div>
        ) : targets.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
            No sync targets configured yet.
          </div>
        ) : (
          targets.map((t) => (
            <TargetCard
              key={t.id}
              target={t}
              onDelete={() => {
                if (
                  window.confirm(
                    `Remove target '${t.label}'? Existing snapshot files on disk are not deleted.`,
                  )
                ) {
                  remove.mutate(t.id, {
                    onSuccess: () => toast.success(`Removed ${t.label}`),
                  });
                }
              }}
              snapshotting={snapshot.isPending}
              onSnapshot={() =>
                snapshot.mutate(t.id, {
                  onSuccess: (r) =>
                    toast.success(
                      `Snapshot ${r.file_name} (${formatBytes(r.bytes)})`,
                    ),
                  onError: (e) => toast.error(`Snapshot failed: ${e.message}`),
                })
              }
              restoring={restore.isPending}
              onRestore={(file_name) =>
                restore.mutate(
                  { targetId: t.id, file_name },
                  {
                    onSuccess: (r) =>
                      toast.success(
                        `Restored from ${r.restored_from} (backup stamp ${r.backup_stamp})`,
                      ),
                    onError: (e) => toast.error(`Restore failed: ${e.message}`),
                  },
                )
              }
            />
          ))
        )}

        {lastFiveHistory.length > 0 && (
          <div style={cardStyle}>
            <div
              style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)" }}
            >
              Recent activity
            </div>
            {lastFiveHistory.map((h) => (
              <div
                key={h.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12,
                  color: "var(--fg-2)",
                }}
              >
                <span style={{ fontFamily: "monospace" }}>
                  {h.action} · {h.file_name}
                </span>
                <span style={{ color: "var(--fg-4)" }}>
                  {h.created_at.slice(0, 19)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}
