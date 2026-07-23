import { useMemo, useState, type ReactElement } from "react";
import { toast } from "sonner";
import {
  useCreateMcpServer,
  useDeleteMcpServer,
  useMcpServers,
  useMcpSuggested,
  useProjects,
  useTestMcpServer,
  useUpdateMcpServer,
  useInstallMarketplaceItem,
  type McpServer,
  type McpSuggested,
  type McpServerPatch,
} from "../lib/api";
import { Shell } from "../components/layout/shell";
import styles from "./mcp-servers.module.css";

interface ArgsEnv {
  args: string[];
  env: Record<string, string>;
}

function parseArgsEnv(argsText: string, envText: string): ArgsEnv {
  const a = argsText.trim() === "" ? [] : JSON.parse(argsText);
  const e = envText.trim() === "" ? {} : JSON.parse(envText);
  if (!Array.isArray(a) || !a.every((x) => typeof x === "string")) {
    throw new Error("args must be a JSON array of strings");
  }
  if (typeof e !== "object" || e === null || Array.isArray(e)) {
    throw new Error("env must be a JSON object");
  }
  return { args: a as string[], env: e as Record<string, string> };
}

export function McpServersPage(): ReactElement {
  const servers = useMcpServers();
  const suggested = useMcpSuggested();
  const createMutation = useCreateMcpServer();

  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");

  function handleCreate(): void {
    if (!slug || !name || !command) {
      toast.error("slug, name, command required");
      return;
    }
    let parsed: ArgsEnv;
    try {
      parsed = parseArgsEnv(argsText, envText);
    } catch (err) {
      toast.error(`Invalid JSON: ${(err as Error).message}`);
      return;
    }
    createMutation.mutate(
      { slug, name, command, args: parsed.args, env: parsed.env },
      {
        onSuccess: () => {
          setSlug("");
          setName("");
          setCommand("");
          setArgsText("");
          setEnvText("");
          toast.success(`Added ${name}`);
        },
        onError: (e) => toast.error(`Create failed: ${e.message}`),
      },
    );
  }

  return (
    <Shell>
      <div className={styles.page}>
        <header>
          <p className={styles.subtitle}>
            Toggle, configure, and test the MCP servers the dashboard offers to
            Claude Code.
          </p>
        </header>

        <section>
          <h2 className={styles.sectionTitle}>Configured</h2>
          {servers.isPending ? (
            <div className={styles.empty}>Loading…</div>
          ) : (servers.data?.servers ?? []).length === 0 ? (
            <div className={styles.empty}>
              No servers configured yet. Install from Suggested below or add one
              manually.
            </div>
          ) : (
            <div className={styles.list} role="list">
              {(servers.data?.servers ?? []).map((s) => (
                <ServerCard key={s.id} server={s} />
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className={styles.sectionTitle}>Add manually</h2>
          <div className={styles.createForm}>
            <div className={styles.row}>
              <label htmlFor="mcp-slug">slug</label>
              <input
                id="mcp-slug"
                className={styles.input}
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="e.g. filesystem"
              />
            </div>
            <div className={styles.row}>
              <label htmlFor="mcp-name">name</label>
              <input
                id="mcp-name"
                className={styles.input}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Display name"
              />
            </div>
            <div className={`${styles.row} ${styles.full}`}>
              <label htmlFor="mcp-cmd">command</label>
              <input
                id="mcp-cmd"
                className={styles.input}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="/path/to/binary or npx"
              />
            </div>
            <div className={`${styles.row} ${styles.full}`}>
              <label htmlFor="mcp-args">args (JSON array)</label>
              <textarea
                id="mcp-args"
                className={styles.textarea}
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder='[ "-y", "package-name" ]'
              />
            </div>
            <div className={`${styles.row} ${styles.full}`}>
              <label htmlFor="mcp-env">env (JSON object)</label>
              <textarea
                id="mcp-env"
                className={styles.textarea}
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                placeholder='{ "KEY": "value" }'
              />
            </div>
            <div className={`${styles.actions} ${styles.full}`}>
              <button
                type="button"
                className={styles.btn}
                onClick={handleCreate}
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? "Adding…" : "Add server"}
              </button>
            </div>
          </div>
        </section>

        <section>
          <h2 className={styles.sectionTitle}>Suggested</h2>
          {suggested.isPending ? (
            <div className={styles.empty}>Loading…</div>
          ) : (suggested.data?.items ?? []).length === 0 ? (
            <div className={styles.empty}>
              Nothing new from the marketplace right now.
            </div>
          ) : (
            <div className={styles.list} role="list">
              {(suggested.data?.items ?? []).map((it) => (
                <SuggestedCard key={it.slug} item={it} />
              ))}
            </div>
          )}
        </section>
      </div>
    </Shell>
  );
}

interface ServerCardProps {
  server: McpServer;
}

function ServerCard({ server }: ServerCardProps): ReactElement {
  const update = useUpdateMcpServer();
  const remove = useDeleteMcpServer();
  const test = useTestMcpServer();
  const [editing, setEditing] = useState(false);
  const [command, setCommand] = useState(server.command);
  const [argsText, setArgsText] = useState(JSON.stringify(server.args));
  const [envText, setEnvText] = useState(JSON.stringify(server.env, null, 2));

  function applyPatch(patch: McpServerPatch, label: string): void {
    update.mutate(
      { id: server.id, patch },
      {
        onSuccess: () => toast.success(`${label}: ${server.name}`),
        onError: (e) => toast.error(`${label} failed: ${e.message}`),
      },
    );
  }

  function handleToggle(): void {
    applyPatch(
      { enabled: !server.enabled },
      server.enabled ? "Disabled" : "Enabled",
    );
  }

  function handleSaveEdit(): void {
    let parsed: ArgsEnv;
    try {
      parsed = parseArgsEnv(argsText, envText);
    } catch (err) {
      toast.error(`Invalid JSON: ${(err as Error).message}`);
      return;
    }
    update.mutate(
      { id: server.id, patch: { command, args: parsed.args, env: parsed.env } },
      {
        onSuccess: () => {
          setEditing(false);
          toast.success(`Saved ${server.name}`);
        },
        onError: (e) => toast.error(`Save failed: ${e.message}`),
      },
    );
  }

  function handleDelete(): void {
    if (
      !confirm(
        `Delete ${server.name}? This only removes the dashboard registry row.`,
      )
    )
      return;
    remove.mutate(server.id, {
      onSuccess: () => toast.success(`Deleted ${server.name}`),
      onError: (e) => toast.error(`Delete failed: ${e.message}`),
    });
  }

  function handleTest(): void {
    test.mutate(server.id, {
      onSuccess: (r) => {
        if (r.ok) toast.success(`Test OK: ${r.detail}`);
        else toast.error(`Test failed: ${r.detail}`);
      },
      onError: (e) => toast.error(`Test failed: ${e.message}`),
    });
  }

  return (
    <article className={styles.card} role="listitem">
      <div className={styles.head}>
        <div>
          <div className={styles.name}>{server.name}</div>
          <div className={styles.meta}>
            <code>{server.slug}</code> ·{" "}
            {server.enabled ? "enabled" : "disabled"} · {server.source}
          </div>
          <div className={styles.mono}>
            {server.command} {server.args.join(" ")}
          </div>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={handleToggle}
            disabled={update.isPending}
          >
            {server.enabled ? "Disable" : "Enable"}
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Cancel" : "Edit"}
          </button>
          <button
            type="button"
            className={styles.btn}
            onClick={handleTest}
            disabled={test.isPending}
          >
            {test.isPending ? "Testing…" : "Test"}
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnDanger}`}
            onClick={handleDelete}
            disabled={remove.isPending}
          >
            Delete
          </button>
        </div>
      </div>

      {editing ? (
        <div className={styles.createForm}>
          <div className={`${styles.row} ${styles.full}`}>
            <label htmlFor={`cmd-${server.id}`}>command</label>
            <input
              id={`cmd-${server.id}`}
              className={styles.input}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
          </div>
          <div className={`${styles.row} ${styles.full}`}>
            <label htmlFor={`args-${server.id}`}>args</label>
            <textarea
              id={`args-${server.id}`}
              className={styles.textarea}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
            />
          </div>
          <div className={`${styles.row} ${styles.full}`}>
            <label htmlFor={`env-${server.id}`}>env</label>
            <textarea
              id={`env-${server.id}`}
              className={styles.textarea}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
            />
          </div>
          <div className={`${styles.actions} ${styles.full}`}>
            <button
              type="button"
              className={styles.btn}
              onClick={handleSaveEdit}
              disabled={update.isPending}
            >
              {update.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : null}

      {test.data ? (
        <>
          <div className={test.data.ok ? styles.testOk : styles.testFail}>
            {test.data.ok ? "OK" : "FAIL"} — {test.data.detail}
            {test.data.rc !== null ? ` (rc=${test.data.rc})` : ""}
          </div>
          {test.data.stderr_tail ? (
            <pre className={styles.testTail}>{test.data.stderr_tail}</pre>
          ) : null}
        </>
      ) : null}
    </article>
  );
}

interface SuggestedCardProps {
  item: McpSuggested;
}

function SuggestedCard({ item }: SuggestedCardProps): ReactElement {
  const projects = useProjects();
  const install = useInstallMarketplaceItem();
  const eligible = useMemo(
    () => (projects.data ?? []).filter((p) => !!p.path),
    [projects.data],
  );
  const [projectId, setProjectId] = useState<number | null>(
    eligible[0]?.id ?? null,
  );

  function handleInstall(): void {
    if (projectId === null) {
      toast.error("Pick a project to install into");
      return;
    }
    install.mutate(
      { slug: item.slug, projectId },
      {
        onSuccess: () => toast.success(`Installed ${item.name}`),
        onError: (e) => toast.error(`Install failed: ${e.message}`),
      },
    );
  }

  return (
    <article className={styles.card} role="listitem">
      <div className={styles.head}>
        <div>
          <div className={styles.name}>{item.name}</div>
          <div className={styles.meta}>
            <code>{item.slug}</code> · {item.source}
          </div>
          {item.summary ? (
            <div className={styles.meta}>{item.summary}</div>
          ) : null}
        </div>
        <div className={styles.actions}>
          <select
            className={styles.input}
            value={projectId ?? ""}
            onChange={(e) =>
              setProjectId(e.target.value ? Number(e.target.value) : null)
            }
            aria-label="Install target project"
          >
            <option value="">Select project…</option>
            {eligible.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={styles.btn}
            onClick={handleInstall}
            disabled={install.isPending || projectId === null}
          >
            {install.isPending ? "Installing…" : "Install"}
          </button>
        </div>
      </div>
    </article>
  );
}
