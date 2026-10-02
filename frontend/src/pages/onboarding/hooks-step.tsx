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
import { StepHead, StepField, StepHint, StepNote, Lit } from "./step-chrome";

// Fallback shown only while the sidecar snippet endpoint is loading or errors.
// Format matches the "command" hook type that the sidecar generates in
// hooks_service.build_hook_settings() — a curl POST ending in `|| true` so it
// silently no-ops when the desktop app is offline (the native "http" type
// raises ECONNREFUSED in every session instead). Once the sidecar responds, its
// live snippet (with the correct runtime base URL) replaces this.
//
// PreToolUse is the one entry that does NOT redirect stdout: its response body
// is the pre-authorisation decision channel, so it carries `--fail` (nothing is
// printed on an HTTP error) and silences stderr only. It has to match the
// sidecar here rather than merely look plausible — a user who pastes this while
// the sidecar is still starting would otherwise get an install in which their
// standing permission rules silently never apply.
//
// The `X-Codenest-Hook` header is inert on the wire and is how the installer
// (`hooks_service.hook_authorship`) recognises a command as its own before
// rewriting it. A paste that omits it is adopted only by exact string match
// against a frozen list of past command shapes — which this text is not one
// of, so a drifted copy here becomes a hook the app can neither repair nor
// safely replace. That is why it is copied rather than approximated.
const FALLBACK_SNIPPET = `{
  "hooks": {
    "SessionStart": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s --max-time 5 -X POST -H 'Content-Type: application/json' -H 'X-Codenest-Hook: 1' --data-binary @- http://localhost:8002/api/v1/hooks/session-start >/dev/null 2>&1 || true", "timeout": 6 }] }
    ],
    "UserPromptSubmit": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s --max-time 5 -X POST -H 'Content-Type: application/json' -H 'X-Codenest-Hook: 1' --data-binary @- http://localhost:8002/api/v1/hooks/user-prompt >/dev/null 2>&1 || true", "timeout": 6 }] }
    ],
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s --fail --max-time 5 -X POST -H 'Content-Type: application/json' -H 'X-Codenest-Hook: 1' --data-binary @- http://localhost:8002/api/v1/hooks/pre-tool 2>/dev/null || true", "timeout": 6 }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s --max-time 5 -X POST -H 'Content-Type: application/json' -H 'X-Codenest-Hook: 1' --data-binary @- http://localhost:8002/api/v1/hooks/post-tool >/dev/null 2>&1 || true", "timeout": 6 }] }
    ],
    "Stop": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s --max-time 5 -X POST -H 'Content-Type: application/json' -H 'X-Codenest-Hook: 1' --data-binary @- http://localhost:8002/api/v1/hooks/stop >/dev/null 2>&1 || true", "timeout": 6 }] }
    ],
    "SessionEnd": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s --max-time 5 -X POST -H 'Content-Type: application/json' -H 'X-Codenest-Hook: 1' --data-binary @- http://localhost:8002/api/v1/hooks/session-end >/dev/null 2>&1 || true", "timeout": 6 }] }
    ]
  }
}`;

/**
 * Deck pages scroll as one, so N provider blocks would push Continue — the
 * only way forward — off the end. Same cap the pre-Deck step applied, and it
 * only engages past one provider, exactly as before.
 */
const PROVIDER_LIST_STYLE: React.CSSProperties = {
  overflowY: "auto",
  maxHeight: 520,
  paddingRight: 4,
};

/** The verification bar is a footer, so its hairline sits above it. */
const VERIFY_BAR_STYLE: React.CSSProperties = {
  marginTop: "var(--u4)",
  marginBottom: 0,
  paddingTop: "var(--u3)",
  paddingBottom: "var(--u3)",
  borderTop: "1px solid var(--line)",
  borderBottom: 0,
};

/** Deck's `.dk-tag` carries the same three tones through `data-s`. */
function eventChipState(status: HookEventVerdict["status"]): string {
  const tone = eventChipTone(status);
  if (tone === "ok") return "done";
  if (tone === "warn") return "wait";
  return "fail";
}

// ─── Per-provider hook card ───────────────────────────────────────────────────

interface ProviderCardProps {
  provider: Provider;
  verify?: HookSettingsVerify;
}

function ProviderHookCard({
  provider,
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

  /**
   * The snippet block. Deck's `.dk-out` is the console-output surface and this
   * is the same thing — a fixed-height, scrolling, monospace block — but
   * `.dk-out` is a flex column sized by its parent, and a `<code>` inside a
   * form needs its own height cap and horizontal scroll.
   */
  const codeStyle: React.CSSProperties = {
    display: "block",
    padding: "var(--u3)",
    border: "1px solid var(--line-2)",
    borderRadius: 3,
    background: "var(--bg)",
    color: "var(--fg-2)",
    fontSize: "var(--fs-s)",
    lineHeight: 1.65,
    whiteSpace: "pre",
    overflow: "auto",
    maxHeight: 220,
  };

  return (
    <div className="dk-group">
      <h2 className="dk-group__h">
        <span>Provider</span>
        <span className="n">{provider.name}</span>
        {provider.display_name !== provider.name && (
          <span className="note">{provider.display_name}</span>
        )}
        <span className="sp" />
        <span className="dk-actions">
          <button
            type="button"
            className="dk-btn"
            onClick={() => void copy()}
            disabled={configHome === null}
          >
            {copied ? "✓ Copied" : "⧉ Copy"}
          </button>
        </span>
      </h2>

      <div className="dk-form">
        <div className="dk-form__grid">
          <StepField
            label="Config home"
            htmlFor={`ob-hook-home-${provider.id}`}
            hint="The Claude config directory this alias uses."
          >
            {configHome !== null ? (
              <input
                id={`ob-hook-home-${provider.id}`}
                className="dk-ctl"
                readOnly
                value={configHome}
                aria-label="Config home (read-only)"
              />
            ) : (
              <StepHint tone="warn">
                No config home set — edit this provider to add one
              </StepHint>
            )}
          </StepField>

          <StepField
            label="Target file"
            htmlFor={`ob-hook-target-${provider.id}`}
            hint="Merge the hook block below into this file."
          >
            <input
              id={`ob-hook-target-${provider.id}`}
              className="dk-ctl"
              readOnly
              value={settingsPath}
              aria-label="Target settings file (read-only)"
            />
          </StepField>
        </div>

        <div className="dk-form__row full">
          <span className="dk-label">Hook block</span>
          <code style={codeStyle}>{displaySnippet}</code>
        </div>

        {/* Test hooks result — event chips + file/wrong-file detail. Absent
            until the user has run Test hooks at least once. */}
        {verify && (
          <div className="dk-form__row full">
            <span className="dk-actions">
              {verify.events.map((ev) => (
                <span
                  key={ev.event}
                  className="dk-tag"
                  data-s={eventChipState(ev.status)}
                  title={ev.detail ?? undefined}
                >
                  {ev.event}
                </span>
              ))}
            </span>
            {verify.detail != null && <StepHint>{verify.detail}</StepHint>}
            {otherPath !== undefined && (
              <StepHint tone="warn">
                Found in <Lit>{otherPath}</Lit> — move it to the file above.
              </StepHint>
            )}
          </div>
        )}
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
  const verifyState =
    barCopy.tone === "ok"
      ? "done"
      : barCopy.tone === "warn"
        ? "wait"
        : barCopy.tone === "error"
          ? "fail"
          : "idle";

  return (
    <>
      <StepHead kicker="step 05 · wire telemetry" title="Connect Claude Code hooks">
        For the command center to see sessions, prompts, tool calls and cost,
        Claude Code reports to the sidecar via hooks. For each provider below,
        paste the hook block into the listed <Lit>settings.json</Lit> — we never
        edit it for you.
      </StepHead>

      {/* Scrollable list — handles N providers without pushing the footer off. */}
      <div style={wiredProviders.length > 1 ? PROVIDER_LIST_STYLE : undefined}>
        {wiredProviders.length === 0 && providers.length === 0 && (
          <StepHint>
            No providers configured yet — go back to Step 03 to set up an
            Anthropic alias.
          </StepHint>
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
              verify={verify}
            />
          );
        })}

        {/* Warn about providers that have no config home */}
        {unwiredProviders.length > 0 && (
          <StepNote glyph="=" tone="warn">
            <strong>Missing config home</strong> — the following provider
            {unwiredProviders.length === 1 ? "" : "s"} have no{" "}
            <Lit>CLAUDE_CONFIG_DIR</Lit> set and will not be shown here:{" "}
            {unwiredProviders.map((p) => p.name).join(", ")}. Edit them on the
            Providers page to complete hook wiring.
          </StepNote>
        )}
      </div>

      <StepHint>
        The <strong>SessionStart</strong> hook injects your project name→path
        registry into workspace sessions, and <strong>PostToolUse</strong> powers
        per-file cost attribution.
      </StepHint>

      {/* Actions — self-test the wiring without a Claude Code session. */}
      <div className="dk-bar" style={{ marginTop: "var(--u4)" }}>
        <span className="dk-actions">
          <button
            type="button"
            className="dk-btn"
            onClick={() => void onTestHooks()}
            disabled={wiredProviders.length === 0 || verifyM.isPending}
          >
            {verifyM.isPending ? "Testing…" : "Test hooks"}
          </button>
          <button
            type="button"
            className="dk-btn"
            onClick={() => void onLiveTest()}
            disabled={!tauriAvailable || probing}
          >
            {probing ? "Running…" : "Run live test"}
          </button>
        </span>
      </div>

      {wiredProviders.length === 0 && (
        <StepHint>
          No provider has a config home yet — set CLAUDE_CONFIG_DIR on the
          Providers page.
        </StepHint>
      )}
      {!tauriAvailable && (
        <StepHint>The live test needs the desktop app.</StepHint>
      )}

      {/* Aggregate verification bar */}
      <div className="dk-bar" style={VERIFY_BAR_STYLE}>
        <span
          className="dk-s"
          data-s={verifyState}
          role="img"
          aria-label={barCopy.tone}
        />
        <span className="sans">{barCopy.message}</span>
      </div>
    </>
  );
}
