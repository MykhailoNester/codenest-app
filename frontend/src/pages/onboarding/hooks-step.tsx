import { useState, type ReactElement } from "react";
import { useHookSnippet, useHookStatus, useProviders, type Provider } from "../../lib/api";
import styles from "./onboarding-page.module.css";

// Fallback shown only while the sidecar snippet endpoint is loading or errors.
// Format matches the "command" hook type that the sidecar generates in
// hooks_service.build_hook_settings() — a curl POST ending in `|| true` so it
// silently no-ops when the desktop app is offline (the native "http" type
// raises ECONNREFUSED in every session instead). Once the sidecar responds, its
// live snippet (with the correct runtime base URL) replaces this.
const FALLBACK_SNIPPET = `{
  "hooks": {
    "SessionStart": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s --max-time 5 -X POST -H 'Content-Type: application/json' --data-binary @- http://localhost:8002/api/v1/hooks/session-start >/dev/null 2>&1 || true", "timeout": 6 }] }
    ],
    "UserPromptSubmit": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s --max-time 5 -X POST -H 'Content-Type: application/json' --data-binary @- http://localhost:8002/api/v1/hooks/user-prompt >/dev/null 2>&1 || true", "timeout": 6 }] }
    ],
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s --max-time 5 -X POST -H 'Content-Type: application/json' --data-binary @- http://localhost:8002/api/v1/hooks/pre-tool >/dev/null 2>&1 || true", "timeout": 6 }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s --max-time 5 -X POST -H 'Content-Type: application/json' --data-binary @- http://localhost:8002/api/v1/hooks/post-tool >/dev/null 2>&1 || true", "timeout": 6 }] }
    ],
    "Stop": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s --max-time 5 -X POST -H 'Content-Type: application/json' --data-binary @- http://localhost:8002/api/v1/hooks/stop >/dev/null 2>&1 || true", "timeout": 6 }] }
    ],
    "SessionEnd": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s --max-time 5 -X POST -H 'Content-Type: application/json' --data-binary @- http://localhost:8002/api/v1/hooks/session-end >/dev/null 2>&1 || true", "timeout": 6 }] }
    ]
  }
}`;

// ─── Per-provider hook card ───────────────────────────────────────────────────

interface ProviderCardProps {
  provider: Provider;
  index: number;
}

function ProviderHookCard({ provider, index }: ProviderCardProps): ReactElement {
  const [copied, setCopied] = useState(false);

  const configHome = provider.default_env["CLAUDE_CONFIG_DIR"] ?? null;
  const snippetQ = useHookSnippet(configHome);

  const displaySnippet = snippetQ.data?.snippet ?? FALLBACK_SNIPPET;
  const settingsPath =
    snippetQ.data?.settings_path ??
    (configHome ? `${configHome}/settings.json` : "<config home>/settings.json");

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(displaySnippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  };

  const codeStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    fontSize: 11.5,
    lineHeight: 1.65,
    color: "var(--fg-1)",
    background: "var(--bg-0)",
    border: "1px solid var(--line-2)",
    borderRadius: "var(--r-3, 8px)",
    padding: "15px 16px",
    overflowX: "auto",
    whiteSpace: "pre",
    maxHeight: 220,
    display: "block",
  };

  return (
    <div className={styles.card} style={{ marginTop: index > 0 ? 14 : 0 }}>
      {/* Card header — provider alias label */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 14,
          paddingBottom: 12,
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--fg-3)",
          }}
        >
          Provider
        </span>
        <code
          style={{
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            fontSize: 12,
            background: "rgba(168, 85, 247, 0.12)",
            border: "1px solid rgba(168, 85, 247, 0.3)",
            borderRadius: 4,
            padding: "2px 8px",
            color: "#c89bff",
            fontWeight: 600,
          }}
        >
          {provider.name}
        </code>
        {provider.display_name !== provider.name && (
          <span
            style={{
              fontSize: 12,
              color: "var(--fg-2)",
            }}
          >
            {provider.display_name}
          </span>
        )}
      </div>

      {/* CONFIG HOME + TARGET FILE — read-only display fields */}
      <div className={styles.grid2} style={{ marginBottom: 14 }}>
        <div>
          <label className={styles.fieldLabel}>Config home</label>
          {configHome ? (
            <input
              className={`${styles.fld} ${styles.fldMono}`}
              readOnly
              value={configHome}
              aria-label="Config home (read-only)"
            />
          ) : (
            <div
              style={{
                padding: "9px 11px",
                border: "1px solid var(--line-1)",
                borderRadius: "var(--r-2, 6px)",
                background: "rgba(245, 158, 11, 0.08)",
                borderColor: "rgba(245, 158, 11, 0.35)",
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
                fontSize: 12,
                color: "var(--warn, #f59e0b)",
              }}
            >
              No config home set — edit this provider to add one
            </div>
          )}
          <p className={styles.hint}>
            The Claude config directory this alias uses.
          </p>
        </div>
        <div>
          <label className={styles.fieldLabel}>Target file</label>
          <input
            className={`${styles.fld} ${styles.fldMono}`}
            readOnly
            value={settingsPath}
            aria-label="Target settings file (read-only)"
          />
          <p className={styles.hint}>
            Merge the hook block below into this file.
          </p>
        </div>
      </div>

      {/* Hook block — same content for all providers (URL points at sidecar) */}
      <label className={styles.fieldLabel}>Hook block</label>
      <div className={styles.codeWrap}>
        <div className={styles.codeActions}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSm}`}
            onClick={() => void copy()}
            disabled={!configHome}
          >
            {copied ? "✓ Copied" : "⧉ Copy"}
          </button>
        </div>
        <code style={codeStyle}>{displaySnippet}</code>
      </div>
    </div>
  );
}

// ─── Step shell ───────────────────────────────────────────────────────────────

/** Step 5 — guided copy-paste of the settings.json hooks block + real verification. */
export function HooksStep({
  registerCommit,
}: {
  registerCommit: (fn: () => Promise<void>) => void;
}): ReactElement {
  // Display-only step — user pastes the snippet themselves. Continue just advances.
  useState(() => {
    registerCommit(() => Promise.resolve());
  });

  // Record the mount time so we can detect fresh pings (not pre-existing history).
  // useState with lazy init runs exactly once, giving a stable ISO timestamp.
  const [mountedAt] = useState<string>(() => new Date().toISOString());

  // Aggregate hook status — polling every 3 s while displayed.
  const statusQ = useHookStatus(mountedAt, true);
  const connected = statusQ.data?.connected ?? false;

  // Read configured providers (enabled only — these are what the user set up in step 03).
  const providersQ = useProviders(false);
  const providers = providersQ.data ?? [];

  // Providers that have a CLAUDE_CONFIG_DIR — these get cards.
  const wiredProviders = providers.filter(
    (p) => typeof p.default_env["CLAUDE_CONFIG_DIR"] === "string" &&
      p.default_env["CLAUDE_CONFIG_DIR"].trim() !== "",
  );
  // Providers that are enabled but have no config home set.
  const unwiredProviders = providers.filter(
    (p) => !p.default_env["CLAUDE_CONFIG_DIR"]?.trim(),
  );

  return (
    <>
      <div className={styles.kicker}>Step 05 &middot; Wire telemetry</div>
      <h1 className={styles.title}>Connect Claude Code hooks</h1>
      <p className={styles.lead}>
        For the command center to see sessions, prompts, tool calls and cost,
        Claude Code reports to the sidecar via hooks. For each provider below,
        paste the hook block into the listed{" "}
        <code
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            background: "rgba(255,255,255,.06)",
            border: "1px solid var(--line-2)",
            borderRadius: 4,
            padding: "1px 5px",
          }}
        >
          settings.json
        </code>{" "}
        — we never edit it for you.
      </p>

      {/* Scrollable card list — handles N providers without breaking layout */}
      <div
        style={{
          overflowY: wiredProviders.length > 1 ? "auto" : undefined,
          maxHeight: wiredProviders.length > 1 ? 520 : undefined,
          paddingRight: wiredProviders.length > 1 ? 4 : undefined,
        }}
      >
        {wiredProviders.length === 0 && providers.length === 0 && (
          <div className={styles.card}>
            <p style={{ color: "var(--fg-3)", fontSize: 13, margin: 0 }}>
              No providers configured yet — go back to Step 03 to set up an
              Anthropic alias.
            </p>
          </div>
        )}

        {wiredProviders.map((provider, i) => (
          <ProviderHookCard key={provider.id} provider={provider} index={i} />
        ))}

        {/* Warn about providers that have no config home */}
        {unwiredProviders.length > 0 && (
          <div
            style={{
              marginTop: 12,
              padding: "11px 14px",
              border: "1px solid rgba(245, 158, 11, 0.3)",
              borderRadius: "var(--r-3, 8px)",
              background: "rgba(245, 158, 11, 0.08)",
              fontSize: 12.5,
              color: "var(--fg-2)",
              lineHeight: 1.55,
            }}
          >
            <strong style={{ color: "var(--warn, #f59e0b)" }}>
              Missing config home
            </strong>{" "}
            — the following provider
            {unwiredProviders.length === 1 ? "" : "s"} have no{" "}
            <code
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                background: "rgba(255,255,255,.06)",
                borderRadius: 3,
                padding: "1px 4px",
              }}
            >
              CLAUDE_CONFIG_DIR
            </code>{" "}
            set and will not be shown here:{" "}
            {unwiredProviders.map((p) => p.name).join(", ")}. Edit them on the
            Providers page to complete hook wiring.
          </div>
        )}
      </div>

      <p className={styles.hint} style={{ marginTop: 8 }}>
        The <strong>SessionStart</strong> hook injects your project name→path
        registry into workspace sessions, and <strong>PostToolUse</strong>{" "}
        powers per-file cost attribution.
      </p>

      {/* Aggregate verification bar */}
      <div
        className={connected ? `${styles.verify} ${styles.verifyOn}` : styles.verify}
      >
        <span className={styles.verifyDot} />
        <span className={styles.verifyText}>
          {connected
            ? "Hook received — Claude Code is connected to the sidecar."
            : "Waiting for first hook ping… start a Claude Code session after pasting the block."}
        </span>
      </div>
    </>
  );
}
