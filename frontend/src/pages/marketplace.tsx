import { useMemo, useState, type ReactElement } from "react";
import { toast } from "sonner";
import {
  useMarketplaceCatalog,
  useMarketplaceInstalls,
  useInstallMarketplaceItem,
  useProjects,
  type MarketplaceItem,
  type Project,
} from "../lib/api";
import { Shell } from "../components/layout/shell";
import styles from "./marketplace.module.css";

const ALL = "__all__";

function formatRelative(iso: string | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const sec = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function MarketplacePage(): ReactElement {
  const catalogQuery = useMarketplaceCatalog();
  const installsQuery = useMarketplaceInstalls();
  const projectsQuery = useProjects();
  const installMutation = useInstallMarketplaceItem();

  const [typeFilter, setTypeFilter] = useState<string>(ALL);
  const [sourceFilter, setSourceFilter] = useState<string>(ALL);
  const [query, setQuery] = useState("");
  const [pendingItem, setPendingItem] = useState<MarketplaceItem | null>(null);
  const [targetProjectId, setTargetProjectId] = useState<number | null>(null);

  const catalogData = catalogQuery.data;
  const types = catalogData?.types ?? [];
  const sources = catalogData?.sources ?? [];

  const filtered = useMemo(() => {
    const items = catalogData?.items ?? [];
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (typeFilter !== ALL && it.type !== typeFilter) return false;
      if (sourceFilter !== ALL && it.source !== sourceFilter) return false;
      if (!q) return true;
      const hay =
        `${it.name} ${it.slug} ${it.summary ?? ""} ${(it.tags ?? []).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }, [catalogData, typeFilter, sourceFilter, query]);

  const projects: Project[] = projectsQuery.data ?? [];
  const installableProjects = projects.filter((p) => !!p.path);

  function startInstall(item: MarketplaceItem): void {
    setPendingItem(item);
    setTargetProjectId(
      installableProjects.length > 0
        ? (installableProjects[0]?.id ?? null)
        : null,
    );
  }

  function confirmInstall(): void {
    if (!pendingItem || targetProjectId == null) return;
    installMutation.mutate(
      { slug: pendingItem.slug, projectId: targetProjectId },
      {
        onSuccess: (res) => {
          toast.success(
            `Installed ${pendingItem.name} → ${res.installed_path}`,
          );
          setPendingItem(null);
        },
        onError: (e) => toast.error(`Install failed: ${e.message}`),
      },
    );
  }

  return (
    <Shell>
      <div className={styles.page}>
        <header className={styles.header}>
          <div>
            <p className={styles.subtitle}>
              Browse and one-click install agents, skills, commands, hooks, and
              MCP servers into a project's <code>.claude/</code> tree.
            </p>
          </div>
          <input
            className={styles.search}
            placeholder="Search items, tags, slugs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </header>

        <section className={styles.filters} aria-label="Filters">
          <FilterChips
            label="Type"
            active={typeFilter}
            options={types}
            onChange={setTypeFilter}
          />
          <FilterChips
            label="Source"
            active={sourceFilter}
            options={sources}
            onChange={setSourceFilter}
          />
        </section>

        {catalogQuery.isPending ? (
          <div className={styles.empty}>Loading catalog…</div>
        ) : catalogQuery.isError ? (
          <div className={styles.empty}>
            Failed to load catalog: {catalogQuery.error.message}
          </div>
        ) : filtered.length === 0 ? (
          <div className={styles.empty}>
            No items match the current filters.
          </div>
        ) : (
          <div className={styles.grid} role="list">
            {filtered.map((it) => (
              <article key={it.slug} className={styles.card} role="listitem">
                <div className={styles.cardHead}>
                  <div>
                    <div className={styles.cardName}>{it.name}</div>
                    <div className={styles.cardMeta}>{it.type}</div>
                  </div>
                  <span className={`${styles.badge} ${styles.badgeSource}`}>
                    {it.source}
                  </span>
                </div>
                {it.summary ? (
                  <div className={styles.cardSummary}>{it.summary}</div>
                ) : null}
                <div className={styles.cardActions}>
                  <button
                    type="button"
                    className={styles.installBtn}
                    onClick={() => startInstall(it)}
                    disabled={installableProjects.length === 0}
                  >
                    Install
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}

        <section>
          <h2 className={styles.sectionTitle}>Recent installs</h2>
          {installsQuery.data && installsQuery.data.installs.length > 0 ? (
            <table className={styles.installsTable}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Type</th>
                  <th>Source</th>
                  <th>Project</th>
                  <th>Path</th>
                  <th>Installed</th>
                </tr>
              </thead>
              <tbody>
                {installsQuery.data.installs.map((row) => (
                  <tr key={row.id}>
                    <td>{row.item_slug}</td>
                    <td>{row.item_type}</td>
                    <td>{row.source}</td>
                    <td>{row.project_name ?? row.project_id}</td>
                    <td title={row.installed_path}>
                      {row.installed_path.split("/").slice(-3).join("/")}
                      {row.exists === false ? " (missing on disk)" : ""}
                    </td>
                    <td>{formatRelative(row.installed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className={styles.empty}>No items installed yet.</div>
          )}
        </section>
      </div>

      {pendingItem ? (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true">
          <div className={styles.modal}>
            <h2 className={styles.modalTitle}>Install {pendingItem.name}</h2>
            <div className={styles.modalRow}>
              <span className={styles.modalLabel}>
                Drops <code>{pendingItem.filename}</code> ({pendingItem.type})
                into the chosen project's <code>.claude/</code> tree.
              </span>
            </div>
            <div className={styles.modalRow}>
              <label className={styles.modalLabel} htmlFor="install-project">
                Target project
              </label>
              <select
                id="install-project"
                className={styles.modalSelect}
                value={targetProjectId ?? ""}
                onChange={(e) => setTargetProjectId(Number(e.target.value))}
              >
                {installableProjects.length === 0 ? (
                  <option value="">No projects with a path configured</option>
                ) : (
                  installableProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.path}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div className={styles.modalButtons}>
              <button
                type="button"
                className={styles.filterChip}
                onClick={() => setPendingItem(null)}
                disabled={installMutation.isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.installBtn}
                onClick={confirmInstall}
                disabled={installMutation.isPending || targetProjectId == null}
              >
                {installMutation.isPending ? "Installing…" : "Install"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Shell>
  );
}

interface FilterChipsProps {
  label: string;
  active: string;
  options: readonly string[];
  onChange: (next: string) => void;
}

function FilterChips({
  label,
  active,
  options,
  onChange,
}: FilterChipsProps): ReactElement {
  return (
    <div className={styles.filters} aria-label={label}>
      <span className={styles.cardMeta}>{label}:</span>
      <button
        type="button"
        className={`${styles.filterChip} ${active === ALL ? styles.filterChipActive : ""}`}
        onClick={() => onChange(ALL)}
      >
        All
      </button>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          className={`${styles.filterChip} ${active === opt ? styles.filterChipActive : ""}`}
          onClick={() => onChange(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
