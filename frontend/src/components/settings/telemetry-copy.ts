/**
 * The consent copy for the guided telemetry enable (#179).
 *
 * Split out of `telemetry-tab.tsx` the way `hooks-copy.ts` is split out of
 * `hooks.tsx`, and for a sharper reason than testability: every string in this
 * file is a claim made to a user immediately before they agree to send
 * telemetry about their work somewhere. A claim is worth asserting in a test,
 * and `__tests__/telemetry-copy.test.ts` asserts these — not that they exist,
 * but that they still say the specific uncomfortable things they were written
 * to say.
 *
 * The rule this file is under
 * ---------------------------
 * **A consent screen that undersells what is being consented to is worse than
 * no consent screen.** Nothing here may be softened into product copy. If a
 * sentence below reads as too alarming to ship, the response is to make the
 * underlying behaviour safer — not to reword the sentence. That is not a
 * stylistic preference; it is the only rule that keeps this file honest as the
 * app around it changes.
 *
 * Three specific temptations, named so they can be refused
 * -------------------------------------------------------
 * 1. **"Local, so it's private."** The receiving endpoint is unauthenticated on
 *    loopback *by design* (`AGENTS.md` forbids widening the bind or adding
 *    auth), which means any process running as this user can post to it. The
 *    exposure section says so in the words the sidecar's own header uses.
 * 2. **"It just makes costs accurate."** It does — and the same channel is the
 *    one that can make them wrong, permanently, because Lane B outranks every
 *    other source of a cost figure and no other source can write one back.
 *    Accuracy and that hazard are the same sentence and are printed together.
 * 3. **"Now you'll see hook latency."** No. Ten of the eighteen instrument
 *    names Claude Code ships are *spans*, not counters — `claude_code.hook`
 *    among them — and a metrics receiver cannot receive a span. This app has no
 *    trace receiver. Promising it would be the easiest lie on this screen to
 *    tell and the easiest to believe.
 *
 * What is *not* here: any statement about a specific env value or file path.
 * Those come from the plan response, which read this machine. A consent screen
 * that describes a generic machine is describing somebody else's.
 */

import type {
  TelemetryKeyPlan,
  TelemetryReport,
  TelemetryResult,
} from "../../lib/api";

/** What each variable is for, in one line, beside its value in the plan table. */
export const KEY_PURPOSE: Readonly<Record<string, string>> = {
  CLAUDE_CODE_ENABLE_TELEMETRY:
    "The master switch. Without it Claude Code creates no meter and exports nothing.",
  OTEL_METRICS_EXPORTER:
    "Turns on the metrics signal, and only the metrics signal.",
  OTEL_EXPORTER_OTLP_PROTOCOL:
    "Pinned to http/json. This app's receiver parses JSON with no OpenTelemetry or protobuf dependency at all; the OTLP default, http/protobuf, arrives as bytes it refuses with a 415.",
  OTEL_EXPORTER_OTLP_ENDPOINT:
    "This app's sidecar. The exporter appends /v1/metrics to it itself.",
  OTEL_METRIC_EXPORT_INTERVAL:
    "How often an export is sent, in milliseconds. Set explicitly, at Claude Code's own current default, so this figure is one this app chose rather than one it inherited.",
} as const;

/** The lead paragraph. States the transaction before any of its detail. */
export const HEADLINE =
  "Claude Code sends no telemetry until you turn it on. This writes five environment variables into your Claude Code settings.json and points its metrics exporter at this app, so the cost and token figures shown here stop being this app's estimates and start being the numbers the CLI itself reports.";

/**
 * What actually leaves Claude Code.
 *
 * The identity attributes are named individually on purpose. "Some metadata"
 * would be true and useless; `user.email` is the word that lets a reader
 * actually decide. That this app drops them rather than storing them is said
 * in the same breath — and so is the fact that dropping happens *after* they
 * have already left the CLI and crossed the socket.
 */
export const WHAT_LEAVES = [
  "Every 60 seconds, while a session is running, Claude Code POSTs a metrics export to this app's sidecar. Two of the eight counters it carries are the ones this app keeps: what the session has cost, and its input, output, cache-read and cache-creation token counts, plus the model name.",
  "The other six leave Claude Code too, and this app throws them away on arrival: how many lines of code you changed, how many commits you made, how many pull requests you opened, how many times you accepted or rejected an edit, how many sessions you started, and how long you were actively working. They are dropped before anything is written to this app's database — but, exactly as with the identity attributes below, dropping happens at this end, after they have left Claude Code. An earlier draft of this paragraph said \"eight counters\" and then described only the two, which understated what crosses the socket; if you are deciding whether to turn this on, the six are part of what you are deciding about.",
  "Alongside them the export carries attributes identifying you and your machine: user.id, user.email, organization.id, terminal.type, your Claude Code version and your OS. This app drops those rather than storing them — they are stripped before anything is written to its database — but they are in the export. Dropping happens at this end, after they have left Claude Code.",
  "If this app is not running, the export fails and nothing is sent. If something else is listening on that port, it receives the export instead.",
] as const;

/**
 * What does not leave. Worth its own block: the thing a reader most fears is
 * the thing this enable specifically does not do, and burying that inside a
 * reassuring paragraph would waste the one place it can be believed.
 */
export const WHAT_DOES_NOT_LEAVE = [
  "Your prompts and Claude's responses are not exported. That content travels on OpenTelemetry's logs signal, which this does not turn on and which this app's receiver refuses outright: /v1/logs answers 501 without reading the request body, so the text never enters this process even briefly.",
  "This app never sets a logs exporter and never will. If one is already set in your settings.json it is yours, it is pointed wherever you pointed it, and this app neither changes it nor reads what it sends.",
] as const;

/**
 * What this does NOT give you.
 *
 * Present because the absence is not obvious and the plausible guess is wrong:
 * a user who turns on "telemetry" reasonably expects timing. Ground truth is
 * that hook and tool timing live on the traces signal, and there is no trace
 * receiver in this app.
 */
export const NOT_INCLUDED = [
  "Not hook latency, and not tool reliability. Those live on OpenTelemetry's traces signal — claude_code.hook, claude_code.tool, claude_code.llm_request and seven others are spans, not counters, and a metrics receiver cannot receive a span.",
  "This app has no trace receiver: /v1/traces answers 501. Turning telemetry on will not make a hook-timing number appear anywhere in this app.",
] as const;

/**
 * The exposure. The hardest block on the screen and the one most likely to be
 * softened by a later edit, which is why the test greps for its specifics —
 * "no authentication", "any process", "outranks", "cannot be corrected".
 *
 * Every claim here is taken from a verified fact in the sidecar:
 * `otlp_receiver_service`'s "What this endpoint trusts, and what it does not",
 * and `otlp_reconcile_service`'s note that the regression guard engages only
 * once Lane B already owns a field, leaving its *first* claim unguarded at any
 * value. The one thing deliberately narrowed from the original demonstration:
 * a cost point of literal zero is now refused at the presence check, so the
 * $4.50 → $0.00 case specifically no longer reproduces. Every non-zero value
 * still does, and saying "any value" without that caveat would be overclaiming
 * in the same way understating it would be underclaiming.
 */
export const EXPOSURE_TITLE =
  "The endpoint this points at has no authentication, and that is deliberate";

export const EXPOSURE = [
  "This app's sidecar binds loopback only and is unauthenticated by design. It accepts an OTLP export from any process running as you on this machine and cannot tell which process sent one.",
  "That matters because these numbers win. A cost reported over this endpoint outranks this app's own estimate and every other source it has, and once it has been recorded no other source can write it back. A single POST naming a session id — and session ids are readable from ~/.claude/projects by anything that can read your home directory — sets that session's displayed cost to whatever it says, and it cannot afterwards be corrected by this app's own accounting.",
  "A fabricated cost of exactly zero is refused. Every other fabricated value is not.",
  "Nothing here closes that. Authentication on the loopback sidecar is ruled out by the app's own trust model, and a receiver has no way to tell a truthful export from an invented one. Three things bound it: only cost, tokens and model can be moved this way; every figure is recorded as having come from this endpoint, so a number you dispute can be traced to it; and the whole channel stays shut until you open it here.",
] as const;

/** How to withdraw. A real button, named as such, not an instruction to edit JSON. */
export const HOW_TO_TURN_OFF = [
  "Turn telemetry off below. It removes exactly the variables this app wrote, from the same file, through the same backup and the same atomic replace — no hand-editing of JSON.",
  "A variable this app did not write is not removed. It is listed and left, including one of these five whose value you have since changed by hand.",
  "Turning it off stops new figures arriving. It does not retract figures already recorded: those stay, and stay outranking this app's own estimates.",
] as const;

/** Shown inside the confirm, immediately above the button that writes. */
export function writeConfirmBody(result: TelemetryResult): string {
  return `This writes to ${result.settings_path}. A timestamped copy of the current file is written beside it first, and its path is reported back here. Every other entry in the file — your own environment variables included — is left exactly as it is.`;
}

export function disableConfirmBody(result: TelemetryResult): string {
  return `This removes the variables this app wrote from ${result.settings_path}. The same backup is taken first. Variables this app did not write are left untouched.`;
}

// ─── plan rendering ──────────────────────────────────────────────────────────

export interface TelemetrySummary {
  /** Already present with exactly the value this app writes. */
  ok: number;
  /** Absent; would be added. */
  add: number;
  /** Written by an older version of this app; would be rewritten. */
  update: number;
  /** Present with a value this app did not write; left exactly as it is. */
  conflict: number;
  /** Whether pressing "turn on" would rewrite the file at all. */
  changes: boolean;
  /** How many of the five turning it off would remove. */
  removable: number;
}

export function summarise(result: TelemetryResult): TelemetrySummary {
  const count = (list: TelemetryKeyPlan[], action: string): number =>
    list.filter((e) => e.action === action).length;
  const add = count(result.enable, "add");
  const update = count(result.enable, "update");
  return {
    ok: count(result.enable, "ok"),
    add,
    update,
    conflict: count(result.enable, "conflict"),
    changes: add + update > 0,
    removable: count(result.disable, "remove"),
  };
}

/**
 * The one-line verdict at the top of the card.
 *
 * `state` is the state of the file *as the plan found it*, so this sentence is
 * always in the past tense about a read and never a prediction. A file with a
 * blocking note is called out separately rather than being folded into "on" —
 * an enable that is fully written and silently exporting elsewhere is the worst
 * thing this screen could report as success.
 */
export function stateHeadline(result: TelemetryResult): string {
  if (result.status === "refused") {
    return `This settings.json cannot be read or written, so nothing can be changed: ${result.refusal ?? "no reason given"}`;
  }
  const blocking = result.notes.filter((n) => n.severity === "blocking");
  if (blocking.length > 0 && result.state !== "off") {
    return "Telemetry is configured in this file, but something else in it means the exports will not reach this app. See the warnings below.";
  }
  switch (result.state) {
    case "on":
      return "Telemetry is on and pointed at this app. All five variables are present with the values this app writes.";
    case "partial":
      return "Telemetry is partly configured in this file. Some of the five variables are set and some are not — see exactly which below.";
    default:
      return "Telemetry is off. None of the five variables is set in this file, and Claude Code is exporting nothing.";
  }
}

/** Label for the enable button, which changes meaning when it is a repair. */
export function enableButtonLabel(result: TelemetryResult): string {
  const { update, add } = summarise(result);
  if (update > 0 && add === 0) return "Repair these variables…";
  return "Turn telemetry on…";
}

/**
 * The preservation receipt, in the same shape #170's install card uses.
 *
 * A count rather than a list: an `env` block holds API keys, and this app does
 * not print the name or the value of an entry it did not write.
 */
export function preservationNote(result: TelemetryResult): string {
  const n = result.left_foreign;
  if (n === 0) return "There are no other environment variables in this file.";
  return `${n} other environment variable${n === 1 ? "" : "s"} in this file ${n === 1 ? "is" : "are"} left exactly as ${n === 1 ? "it is" : "they are"} — not read, not rewritten, not reordered.`;
}

/** What a write actually did, read back off the response. */
export function outcomeNote(result: TelemetryResult): string {
  if (result.status === "applied") {
    return result.backup_path
      ? `Written. The previous contents were saved to ${result.backup_path}.`
      : "Written. There was no previous file to copy.";
  }
  if (result.status === "refused") {
    return `Nothing was written: ${result.refusal ?? "no reason given"}`;
  }
  return "Nothing needed to change.";
}

/** The first result, which is the only one this screen ever asks for. */
export function firstResult(
  report: TelemetryReport | undefined,
): TelemetryResult | undefined {
  return report?.results[0];
}
