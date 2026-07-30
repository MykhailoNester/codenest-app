import { useState, type ReactElement } from "react";
import {
  SIDECAR_BASE_URL,
  useHookSnippet,
  useHookStatus,
  useMintHookSelfTest,
  useProviders,
  useVerifyHooks,
  fetchHookSelfTestReceipt,
  type HookEventVerdict,
  type HookSelfTestMint,
  type HookSelfTestReceipt,
  type HookSettingsVerify,
  type HookVerifyReport,
  type Provider,
} from "../../lib/api";
import {
  isTauriAvailable,
  runHookProbe,
  type HookProbeResult,
} from "../../lib/ipc";
import {
  classifyLiveProbe,
  describeRequestFailure,
  eventChipTone,
  verifyBarCopy,
  type LiveProbeOutcome,
  type RequestFailure,
} from "./hook-verify-copy";
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

function eventChipClassName(status: HookEventVerdict["status"]): string {
  const tone = eventChipTone(status);
  if (tone === "ok") return `${styles.eventChip} ${styles.eventChipOk}`;
  if (tone === "warn") return `${styles.eventChip} ${styles.eventChipWarn}`;
  return `${styles.eventChip} ${styles.eventChipErr}`;
}

// ─── Per-provider hook card ───────────────────────────────────────────────────

interface ProviderCardProps {
  provider: Provider;
  index: number;
  verify?: HookSettingsVerify;
}

function ProviderHookCard({
  provider,
  index,
  verify,
}: ProviderCardProps): ReactElement {
  const [copied, setCopied] = useState(false);

  const configHome = provider.default_env["CLAUDE_CONFIG_DIR"] ?? null;
  const snippetQ = useHookSnippet(configHome);

  const displaySnippet = snippetQ.data?.snippet ?? FALLBACK_SNIPPET;
  const settingsPath =
    snippetQ.data?.settings_path ??
    (configHome
      ? `${configHome}/settings.json`
      : "<config home>/settings.json");

  const otherPath = verify?.found_elsewhere[0];

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

      {/* Test hooks result — event chips + file/wrong-file detail. Absent
          until the user has run Test hooks at least once. */}
      {verify && (
        <div style={{ marginTop: 14 }}>
          <div className={styles.eventChips}>
            {verify.events.map((ev) => (
              <span
                key={ev.event}
                className={eventChipClassName(ev.status)}
                title={ev.detail ?? undefined}
              >
                {ev.event}
              </span>
            ))}
          </div>
          {verify.detail && (
            <p className={styles.hint} style={{ marginTop: 6 }}>
              {verify.detail}
            </p>
          )}
          {otherPath !== undefined && (
            <p
              className={styles.hint}
              style={{ marginTop: 6, color: "var(--warn, #f59e0b)" }}
            >
              Found in <code>{otherPath}</code> — move it to the file above.
            </p>
          )}
        </div>
      )}
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

  // Aggregate hook status — polling every 3 s while displayed. Kept (see
  // hook-verify-copy.ts) but no longer the only path to a green bar: it is a
  // real positive signal if it ever fires, but the self-test below is what
  // makes the bar reachable without a live Claude Code session.
  const statusQ = useHookStatus(mountedAt, true);
  const connected = statusQ.data?.connected ?? false;

  // Read configured providers (enabled only — these are what the user set up in step 03).
  const providersQ = useProviders(false);
  const providers = providersQ.data ?? [];

  // Providers that have a CLAUDE_CONFIG_DIR — these get cards.
  const wiredProviders = providers.filter(
    (p) =>
      typeof p.default_env["CLAUDE_CONFIG_DIR"] === "string" &&
      p.default_env["CLAUDE_CONFIG_DIR"].trim() !== "",
  );
  // Providers that are enabled but have no config home set.
  const unwiredProviders = providers.filter(
    (p) => !p.default_env["CLAUDE_CONFIG_DIR"]?.trim(),
  );

  const [report, setReport] = useState<HookVerifyReport | undefined>(undefined);
  const [live, setLive] = useState<LiveProbeOutcome | undefined>(undefined);
  const [failure, setFailure] = useState<RequestFailure | undefined>(undefined);
  const [probing, setProbing] = useState(false);

  const verifyM = useVerifyHooks();
  const mintM = useMintHookSelfTest();

  const onTestHooks = async (): Promise<void> => {
    setFailure(undefined);
    // A prior live test's outcome (even an error) must not keep outranking a
    // fresh, successful report — verifyBarCopy's priority puts `live` above
    // `report`, so a stale outcome here would pin the bar red after a
    // correct paste. Mirrors the reset onLiveTest already does for its own
    // stale `failure`/`live` state.
    setLive(undefined);
    try {
      const r = await verifyM.mutateAsync({
        config_homes: wiredProviders.map(
          (p) => p.default_env["CLAUDE_CONFIG_DIR"] ?? "",
        ),
      });
      setReport(r);
    } catch (e) {
      setReport(undefined);
      setFailure(describeRequestFailure("verify", e, SIDECAR_BASE_URL));
    }
  };

  const onLiveTest = async (): Promise<void> => {
    setFailure(undefined);
    setLive(undefined);
    if (!isTauriAvailable()) {
      setFailure(
        describeRequestFailure(
          "probe",
          new Error("the desktop shell is not available"),
          SIDECAR_BASE_URL,
        ),
      );
      return;
    }
    setProbing(true);
    let mint: HookSelfTestMint;
    try {
      mint = await mintM.mutateAsync();
    } catch (e) {
      setFailure(describeRequestFailure("mint", e, SIDECAR_BASE_URL));
      setProbing(false);
      return;
    }
    try {
      let probe: HookProbeResult;
      try {
        probe = await runHookProbe(mint.url, mint.max_time_seconds);
      } catch (e) {
        setFailure(describeRequestFailure("probe", e, SIDECAR_BASE_URL));
        return;
      }
      let receipt: HookSelfTestReceipt;
      try {
        receipt = await fetchHookSelfTestReceipt(mint.token);
        if (!receipt.received) {
          // C (the curl POST) and D (this read) can race by a few ms — one
          // retry after a short delay before concluding it never arrived.
          await new Promise((resolve) => setTimeout(resolve, 300));
          receipt = await fetchHookSelfTestReceipt(mint.token);
        }
      } catch (e) {
        setFailure(describeRequestFailure("receipt", e, SIDECAR_BASE_URL));
        return;
      }
      setLive(classifyLiveProbe(probe, receipt, mint.url));
    } finally {
      setProbing(false);
    }
  };

  const tauriAvailable = isTauriAvailable();
  const barCopy = verifyBarCopy(report, live, connected, failure);
  const verifyToneClass =
    barCopy.tone === "ok"
      ? styles.verifyOn
      : barCopy.tone === "warn"
        ? styles.verifyWarn
        : barCopy.tone === "error"
          ? styles.verifyErr
          : styles.verifyIdle;

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

        {wiredProviders.map((provider, i) => {
          const configHome = provider.default_env["CLAUDE_CONFIG_DIR"] ?? "";
          const verify =
            report?.results.find((r) => r.config_home === configHome) ??
            report?.results[i];
          return (
            <ProviderHookCard
              key={provider.id}
              provider={provider}
              index={i}
              verify={verify}
            />
          );
        })}

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

      {/* Actions — self-test the wiring without a Claude Code session. */}
      <div
        style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}
      >
        <div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={() => void onTestHooks()}
            disabled={wiredProviders.length === 0 || verifyM.isPending}
          >
            {verifyM.isPending ? "Testing…" : "Test hooks"}
          </button>
          {wiredProviders.length === 0 && (
            <p className={styles.hint} style={{ marginTop: 4 }}>
              No provider has a config home yet — set CLAUDE_CONFIG_DIR on the
              Providers page.
            </p>
          )}
        </div>
        <div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={() => void onLiveTest()}
            disabled={!tauriAvailable || probing}
          >
            {probing ? "Running…" : "Run live test"}
          </button>
          {!tauriAvailable && (
            <p className={styles.hint} style={{ marginTop: 4 }}>
              The live test needs the desktop app.
            </p>
          )}
        </div>
      </div>

      {/* Aggregate verification bar */}
      <div className={`${styles.verify} ${verifyToneClass}`}>
        <span className={styles.verifyDot} />
        <span className={styles.verifyText}>{barCopy.message}</span>
      </div>
    </>
  );
}
