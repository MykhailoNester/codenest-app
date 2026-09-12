/**
 * The Hooks page's claims, as pure functions (#171).
 *
 * Split out of `hooks.tsx` the way `onboarding/hook-verify-copy.ts` is split
 * out of `hooks-step.tsx`: everything here is a statement the page makes about
 * the user's machine, and a statement is worth testing without a DOM.
 *
 * Three rules are encoded here rather than left to whoever writes the JSX,
 * because each is a way the page could quietly lie:
 *
 * 1. **Hooks merge, and every one of them runs.** A source that declares a
 *    hook never stands in for another source that also declares one — the
 *    harness collects them all and runs them all. So every number this module
 *    produces is a sum, nothing is ever deducted, and no function here ranks
 *    sources against each other. The settings resolution order that decides a
 *    single *scalar* value (a model name, a permission mode) says nothing about
 *    how many programs end up on an event.
 * 2. **The `--settings` source is unknown, never zero.** Its contribution comes
 *    from a path chosen in a command line the sidecar never sees. It arrives
 *    with `observable: false` and `count: 0`, and rendering that 0 would assert
 *    something the report explicitly says it cannot know. `sourceCountLabel`
 *    is the only thing allowed to turn a bucket into a number, and it refuses
 *    for that one. It also makes every event total a floor, which is what
 *    `eventTotal().atLeast` carries.
 * 3. **Nothing here is a duration.** `timeout_seconds` is a ceiling a config
 *    file declares. It is never how long anything took — no hook payload and no
 *    transcript can say that — so `timeoutLabel` spells out "configured" and
 *    there is no other time-shaped value in this module.
 */

import type {
  EffectiveHookEvent,
  EffectiveHookSourceBucket,
  EffectiveHookContribution,
  EffectiveHookScannedFile,
  HookInstallReport,
  HookInstallResult,
} from "../lib/api";

/** The contributor list is eight long, always — the sidecar asserts the same. */
export const CONTRIBUTOR_SOURCE_COUNT = 8;

/** Shown for a source whose contribution cannot be read off disk. */
export const UNKNOWN_COUNT_LABEL = "unknown";

/**
 * What to print in a source bucket's count slot.
 *
 * The unobservable source comes back with `count: 0` because the field is an
 * integer and has to hold something. Printing that 0 would tell the reader
 * "nothing is wired here", which is a claim the report itself refuses to make.
 */
export function sourceCountLabel(bucket: EffectiveHookSourceBucket): string {
  if (!bucket.observable) return UNKNOWN_COUNT_LABEL;
  return String(bucket.count);
}

export interface EventTotal {
  /** Hooks actually found on this event, across every readable source. */
  found: number;
  /**
   * True when at least one source on this event could not be read, which makes
   * `found` a floor rather than a complete count.
   */
  atLeast: boolean;
}

/**
 * How many separate programs sit on this event's critical path.
 *
 * A sum across all eight buckets — which is what the sidecar's `total` already
 * is — paired with whether any source was unreadable. Both halves matter: the
 * number is the question the page exists to answer, and `atLeast` is what stops
 * it being read as complete when one contributor is invisible by construction.
 */
export function eventTotal(event: EffectiveHookEvent): EventTotal {
  return {
    found: event.total,
    atLeast: event.by_source.some((b) => !b.observable),
  };
}

/** "PreToolUse — 5 hooks run" / "— nothing found" , with the floor marked. */
export function eventTotalLabel(event: EffectiveHookEvent): string {
  const { found, atLeast } = eventTotal(event);
  const base =
    found === 0 ? "none found" : `${found} ${found === 1 ? "hook" : "hooks"}`;
  return atLeast ? `${base} + unknown` : base;
}

/**
 * What this app is allowed to print about one hook's command.
 *
 * Anything this app did not itself author is reduced by the sidecar to an
 * executable name, and that reduction is deliberate — a hook command is an
 * arbitrary shell string that can carry a token in its argv. This function
 * never reconstructs anything, and the copy it returns states the rule rather
 * than apologising for missing data.
 */
export function commandLabel(c: EffectiveHookContribution): string {
  if (c.codenest_authored && c.command) return c.command;
  return c.executable;
}

/** Why a command is shown as a bare program name. */
export function redactionNote(c: EffectiveHookContribution): string | null {
  if (!c.redacted) return null;
  return "Program name only — this app does not print the arguments of a command it did not write.";
}

/**
 * The declared timeout, labelled as what it is.
 *
 * There is no measured duration anywhere on this page and there cannot be:
 * hook payloads carry no timing and a transcript can only time this app's own
 * hook. This is the ceiling the config file declares, and the word "configured"
 * is part of the value so it cannot be rendered as an observation by accident.
 */
export function timeoutLabel(c: EffectiveHookContribution): string | null {
  if (c.timeout_seconds == null) return null;
  return `configured timeout ${c.timeout_seconds}s`;
}

// ─── scanned files ───────────────────────────────────────────────────────────

export type ScanTone = "ok" | "info" | "warn";

export interface ScanCopy {
  label: string;
  tone: ScanTone;
}

/**
 * Per-file status copy. Reported per file rather than collapsed, because "your
 * project settings file is not valid JSON" and "you have no project settings
 * file" produce the same empty event list and mean completely different things.
 */
export function scanCopy(file: EffectiveHookScannedFile): ScanCopy {
  switch (file.status) {
    case "ok":
      return { label: "read", tone: "ok" };
    case "missing_file":
      return { label: "no such file", tone: "info" };
    case "invalid_json":
      return {
        label: "not valid JSON — its hooks were not read",
        tone: "warn",
      };
    case "unreadable":
      return { label: "could not be read", tone: "warn" };
    case "out_of_scope":
      return {
        label: "outside the directories this app will read",
        tone: "warn",
      };
    case "truncated":
      return {
        label: "too many files here — only the first were read",
        tone: "warn",
      };
    default:
      return { label: file.status, tone: "info" };
  }
}

/** True when something in the scan makes the counts on this page incomplete. */
export function scanIsIncomplete(files: EffectiveHookScannedFile[]): boolean {
  return files.some(
    (f) =>
      f.status === "invalid_json" ||
      f.status === "unreadable" ||
      f.status === "out_of_scope" ||
      f.status === "truncated",
  );
}

// ─── the install plan (#170) ─────────────────────────────────────────────────

export interface StaleFinding {
  settingsPath: string;
  /** Events this app wrote in a shape it no longer emits. */
  events: string[];
  /**
   * True when `PreToolUse` is one of them. That is not one stale hook among
   * several: before #172 every command discarded its stdout, and `PreToolUse`'s
   * stdout is the channel a permission decision comes back on. An install from
   * before then still grades "ok" on verify while every standing rule the user
   * writes is computed, printed, and thrown away.
   */
  discardsPermissionDecisions: boolean;
}

/**
 * Installs this app made in a shape it no longer emits.
 *
 * The single most useful thing this page knows, and the only place it can be
 * learned: verify grades a pre-#172 `PreToolUse` command green, so a user with
 * one has no signal at any other layer that their permission rules do nothing.
 */
export function staleFindings(
  plan: HookInstallReport | undefined,
): StaleFinding[] {
  if (!plan) return [];
  const out: StaleFinding[] = [];
  for (const result of plan.results) {
    const events = result.events
      .filter((e) => e.action === "repair" && e.repaired > 0)
      .map((e) => e.event);
    if (events.length === 0) continue;
    out.push({
      settingsPath: result.settings_path,
      events,
      discardsPermissionDecisions: events.includes("PreToolUse"),
    });
  }
  return out;
}

export interface PlanSummary {
  /** Events with no hook of ours, where one would be appended. */
  add: number;
  /** Ours, in an older shape, rewritten in place. */
  repair: number;
  /** Events the installer will not touch and says why. */
  conflict: number;
  /** Already present and current. */
  ok: number;
  /** Hooks the installer looked at and deliberately left alone. */
  left: number;
  /** Whether applying this plan would change the file at all. */
  changes: boolean;
}

/**
 * One config home's plan, counted.
 *
 * `left` is the preservation receipt: hooks the installer read, recognised as
 * not its own (or its own under a matcher it never writes), and will not touch.
 * It is a count and not a list because a third-party hook command can carry a
 * credential — the same rule that keeps those commands out of the read.
 */
export function planSummary(result: HookInstallResult): PlanSummary {
  const summary: PlanSummary = {
    add: 0,
    repair: 0,
    conflict: 0,
    ok: 0,
    left: 0,
    changes: false,
  };
  for (const e of result.events) {
    if (e.action === "add") summary.add += 1;
    else if (e.action === "repair") summary.repair += 1;
    else if (e.action === "conflict") summary.conflict += 1;
    else summary.ok += 1;
    summary.left += e.left_narrow + e.left_foreign + e.left_malformed;
  }
  summary.changes = summary.add > 0 || summary.repair > 0;
  return summary;
}

/** One line saying what pressing Apply would do to this file, or that nothing would. */
export function planHeadline(result: HookInstallResult): string {
  if (result.status === "refused") {
    return result.refusal ?? "This file cannot be written.";
  }
  const s = planSummary(result);
  if (!s.changes) {
    return "Nothing to change — every event this app ingests is already wired here.";
  }
  const parts: string[] = [];
  if (s.add > 0) parts.push(`add ${s.add} ${s.add === 1 ? "event" : "events"}`);
  if (s.repair > 0)
    parts.push(
      `rewrite ${s.repair} ${s.repair === 1 ? "hook" : "hooks"} this app wrote in an older shape`,
    );
  const left =
    s.left > 0
      ? `, and leave ${s.left} ${s.left === 1 ? "hook" : "hooks"} it did not write exactly where they are`
      : "";
  return `Would ${parts.join(" and ")}${left}.`;
}
