/**
 * Settings → Telemetry — the guided enable (#179).
 *
 * Why this lives in Settings and not on the Hooks page or in onboarding
 * ---------------------------------------------------------------------
 * All three were candidates and two of them fail on the same point, which is
 * the one property a consent surface cannot trade away: **the place consent is
 * given has to be the place it can be withdrawn, and it has to still be there
 * tomorrow.**
 *
 * *Onboarding* runs once. A user who declines has no way back to it and a user
 * who accepts has nowhere to go to change their mind, so the disable path would
 * have no home. It can link here; it cannot be here.
 *
 * *The Hooks page* is the closer call, and the better argument is on its side
 * at first glance: it is already this app's settings.json surface, it already
 * owns the plan-then-confirm pattern, and it writes the very same file through
 * the very same writer. What sinks it is that it is feature-gated — `hooks` is
 * a toggle in Settings → Features — so a user who switches that off after
 * enabling telemetry is left with telemetry on and the only off switch gone.
 * "Consent you cannot withdraw" is not a rough edge; it is the failure.
 *
 * Settings has no feature gate and cannot be hidden, it is where a person looks
 * for what an app is allowed to do, and it needs no nav slug at all — so the
 * four-registry rule (`FEATURE_DEFAULTS` / `KNOWN_FEATURES_ORDERED` /
 * `_FEATURES_DEFAULT` / `KNOWN_FEATURES`) does not fire here, which is one
 * fewer set of mirrors to drift.
 *
 * What this page is not allowed to do
 * -----------------------------------
 * Everything it asserts about this machine comes from the plan response, which
 * read the file. It renders no value it did not get from there and invents no
 * reassurance. The words themselves are in `telemetry-copy.ts` under a rule
 * stated at length in that file's header; nothing in this component may
 * paraphrase them into something friendlier.
 *
 * Plan first, always: the plan comes from a route that structurally cannot
 * write, it is fetched on load, and both writers are reachable only after the
 * user has seen it and pressed a second, separately-labelled button that names
 * the file.
 */

import { useMemo, useState, type ReactElement } from "react";
import { toast } from "sonner";
import {
  useProviders,
  useSetTelemetry,
  useTelemetryPlan,
  type TelemetryKeyPlan,
  type TelemetryNote,
  type TelemetryResult,
} from "../../lib/api";
import {
  EXPOSURE,
  EXPOSURE_TITLE,
  HEADLINE,
  HOW_TO_TURN_OFF,
  KEY_PURPOSE,
  NOT_INCLUDED,
  WHAT_DOES_NOT_LEAVE,
  WHAT_LEAVES,
  disableConfirmBody,
  enableButtonLabel,
  firstResult,
  outcomeNote,
  preservationNote,
  stateHeadline,
  summarise,
  writeConfirmBody,
} from "./telemetry-copy";

/** The sidecar resolves an empty config home to `~/.claude`. */
const DEFAULT_CONFIG_HOME = "";
const DEFAULT_CONFIG_HOME_LABEL = "~/.claude (default)";

const card: React.CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line-2)",
  borderRadius: 8,
  padding: 16,
  marginBottom: 16,
};

const sectionTitle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg-0)",
  margin: "0 0 8px",
};

const body: React.CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.6,
  color: "var(--fg-2)",
  margin: "0 0 8px",
};

const meta: React.CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.55,
  color: "var(--fg-3)",
};

const mono: React.CSSProperties = {
  fontFamily:
    "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
  fontSize: 11.5,
};

const button: React.CSSProperties = {
  padding: "6px 12px",
  background: "var(--bg-3)",
  border: "1px solid var(--line-2)",
  borderRadius: 6,
  color: "var(--fg-0)",
  fontSize: 12.5,
  cursor: "pointer",
};

export function TelemetryTab(): ReactElement {
  const providers = useProviders(true);

  // The same derivation the Hooks page uses: the default config home plus
  // whatever the configured providers actually pin via CLAUDE_CONFIG_DIR.
  // Deliberately not the sidecar's `config-homes` discovery list, which globs
  // every `~/.claude*` directory on the machine including ones nothing runs
  // under — and writing into one of those would be a write nobody asked for.
  const configHomes = useMemo(() => {
    const seen = new Set<string>([DEFAULT_CONFIG_HOME]);
    for (const p of providers.data ?? []) {
      const home = (p.default_env["CLAUDE_CONFIG_DIR"] ?? "").trim();
      if (home) seen.add(home.replace(/\/+$/, ""));
    }
    return [...seen];
  }, [providers.data]);

  const [override, setOverride] = useState<string | null>(null);
  const configHome =
    override !== null && configHomes.includes(override)
      ? override
      : (configHomes[0] ?? DEFAULT_CONFIG_HOME);

  const plan = useTelemetryPlan([configHome]);
  const result = firstResult(plan.data);

  return (
    <div style={{ maxWidth: 760 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>
        Telemetry
      </h2>
      <p style={body}>{HEADLINE}</p>

      <div style={{ marginBottom: 16 }}>
        <label
          htmlFor="telemetry-config-home"
          style={{
            fontSize: 11,
            color: "var(--fg-3)",
            display: "block",
            marginBottom: 4,
          }}
        >
          Claude Code config home
        </label>
        <select
          id="telemetry-config-home"
          value={configHome}
          onChange={(e) => setOverride(e.target.value)}
          style={{
            padding: "6px 10px",
            background: "var(--bg-3)",
            border: "1px solid var(--line-2)",
            color: "var(--fg-0)",
            borderRadius: 6,
            fontSize: 12.5,
          }}
        >
          {configHomes.map((home) => (
            <option key={home || "__default__"} value={home}>
              {home === DEFAULT_CONFIG_HOME ? DEFAULT_CONFIG_HOME_LABEL : home}
            </option>
          ))}
        </select>
      </div>

      <Block title="What leaves Claude Code" lines={WHAT_LEAVES} />
      <Block title="What does not" lines={WHAT_DOES_NOT_LEAVE} />
      <Block title="What this does not give you" lines={NOT_INCLUDED} />
      <Block title={EXPOSURE_TITLE} lines={EXPOSURE} tone="alarm" />

      {plan.isError ? (
        <div style={{ ...card, borderColor: "var(--warn, #b7791f)" }}>
          <div style={sectionTitle}>Could not read the settings file</div>
          <div style={meta}>{plan.error.message}</div>
        </div>
      ) : plan.isPending ? (
        <div style={card}>
          <div style={meta}>Reading the settings file…</div>
        </div>
      ) : result ? (
        <PlanCard configHome={configHome} result={result} />
      ) : null}

      <Block title="Turning it back off" lines={HOW_TO_TURN_OFF} />
    </div>
  );
}

function Block({
  title,
  lines,
  tone,
}: {
  title: string;
  lines: readonly string[];
  tone?: "alarm";
}): ReactElement {
  return (
    <section
      style={
        tone === "alarm"
          ? { ...card, borderColor: "var(--danger, #c0392b)" }
          : card
      }
    >
      <h3 style={sectionTitle}>{title}</h3>
      {lines.map((line) => (
        <p key={line.slice(0, 40)} style={body}>
          {line}
        </p>
      ))}
    </section>
  );
}

// ─── the plan, then the two writes ───────────────────────────────────────────

function PlanCard({
  configHome,
  result,
}: {
  configHome: string;
  result: TelemetryResult;
}): ReactElement {
  const setTelemetry = useSetTelemetry();
  const [confirming, setConfirming] = useState<"enable" | "disable" | null>(
    null,
  );
  const summary = summarise(result);
  const applied = firstResult(setTelemetry.data);

  function run(mode: "enable" | "disable"): void {
    setTelemetry.mutate(
      { mode, config_homes: [configHome] },
      {
        onSuccess: (r) => {
          setConfirming(null);
          toast.success(
            r.overall === "applied"
              ? mode === "enable"
                ? "Telemetry enabled — settings.json updated"
                : "Telemetry disabled — settings.json updated"
              : `Nothing to do (${r.overall})`,
          );
        },
        onError: (e) => toast.error(`Failed: ${e.message}`),
      },
    );
  }

  return (
    <section style={card}>
      <h3 style={sectionTitle}>This file, right now</h3>
      <p style={{ ...meta, marginBottom: 8 }}>
        <span style={mono}>{result.settings_path}</span>
      </p>
      <p style={body}>{stateHeadline(result)}</p>

      {result.notes.map((note) => (
        <NoteRow key={note.key} note={note} />
      ))}

      <div style={{ margin: "12px 0" }}>
        {result.enable.map((entry) => (
          <KeyRow key={entry.key} entry={entry} />
        ))}
      </div>

      <p style={meta}>{preservationNote(result)}</p>
      <p style={meta}>
        Turning it off would remove {summary.removable} of the five.
      </p>

      {result.status === "refused" ? (
        <p style={{ ...meta, marginTop: 12 }}>
          This file cannot be written, so there is nothing to confirm.
        </p>
      ) : confirming === null ? (
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button
            type="button"
            style={button}
            disabled={!summary.changes}
            onClick={() => setConfirming("enable")}
          >
            {summary.changes
              ? enableButtonLabel(result)
              : "Already on — nothing to write"}
          </button>
          <button
            type="button"
            style={button}
            disabled={summary.removable === 0}
            onClick={() => setConfirming("disable")}
          >
            {summary.removable > 0
              ? "Turn telemetry off…"
              : "Nothing of this app's to remove"}
          </button>
        </div>
      ) : (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            background: "var(--bg-3)",
            border: "1px solid var(--line-2)",
            borderRadius: 6,
          }}
        >
          <div style={{ ...sectionTitle, marginBottom: 6 }}>
            {confirming === "enable"
              ? `Write to ${result.settings_path}?`
              : `Remove these variables from ${result.settings_path}?`}
          </div>
          <p style={body}>
            {confirming === "enable"
              ? writeConfirmBody(result)
              : disableConfirmBody(result)}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              style={button}
              disabled={setTelemetry.isPending}
              onClick={() => run(confirming)}
            >
              {setTelemetry.isPending
                ? "Writing…"
                : confirming === "enable"
                  ? "Yes, write the file"
                  : "Yes, remove them"}
            </button>
            <button
              type="button"
              style={button}
              disabled={setTelemetry.isPending}
              onClick={() => setConfirming(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {applied ? (
        <p style={{ ...meta, marginTop: 12 }}>{outcomeNote(applied)}</p>
      ) : null}
    </section>
  );
}

function KeyRow({ entry }: { entry: TelemetryKeyPlan }): ReactElement {
  return (
    <div
      style={{
        padding: "8px 0",
        borderTop: "1px solid var(--line-2)",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <span style={{ ...mono, color: "var(--fg-0)" }}>{entry.key}</span>
        <span
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color:
              entry.action === "conflict"
                ? "var(--danger, #c0392b)"
                : "var(--fg-3)",
          }}
        >
          {entry.action === "ok"
            ? "already set by this app"
            : entry.action === "add"
              ? "would be added"
              : entry.action === "update"
                ? "would be rewritten"
                : "left alone"}
        </span>
      </div>
      {entry.value !== null ? (
        <div style={{ ...mono, color: "var(--fg-2)" }}>
          {entry.action === "conflict" ? "this app would write: " : "= "}
          {entry.value}
        </div>
      ) : null}
      <div style={meta}>{entry.detail ?? KEY_PURPOSE[entry.key] ?? ""}</div>
    </div>
  );
}

function NoteRow({ note }: { note: TelemetryNote }): ReactElement {
  return (
    <div
      style={{
        marginTop: 8,
        padding: 10,
        borderRadius: 6,
        border: `1px solid ${
          note.severity === "blocking"
            ? "var(--danger, #c0392b)"
            : "var(--warn, #b7791f)"
        }`,
      }}
    >
      <div style={{ ...mono, color: "var(--fg-0)" }}>{note.key}</div>
      <div style={meta}>{note.detail}</div>
    </div>
  );
}

export default TelemetryTab;
