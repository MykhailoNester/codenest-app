/**
 * `telemetry-copy.ts` — the consent copy, asserted rather than admired (#179).
 *
 * Most of this file is unusual for a test suite: it greps prose. That is the
 * point. The strings in `telemetry-copy.ts` are what a user reads immediately
 * before agreeing to send telemetry about their work to a local endpoint that
 * has no authentication and whose figures outrank every other source this app
 * has. The failure mode this suite exists to catch is not a crash — it is a
 * later edit that keeps the paragraph and removes its teeth, leaving a screen
 * that reads reassuringly and is no longer true.
 *
 * So the assertions below are about *specific claims*, not about length or
 * presence. Each one names the fact in the sidecar it is derived from. A change
 * that makes one of these fail is a change that either altered the behaviour —
 * in which case fix the behaviour's description — or softened the disclosure,
 * in which case this failing is the whole return on writing it down.
 */

import { describe, it, expect } from "vitest";
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
  outcomeNote,
  preservationNote,
  stateHeadline,
  summarise,
  writeConfirmBody,
} from "../telemetry-copy";
import type { TelemetryKeyPlan, TelemetryResult } from "../../../lib/api";

const ALL = [
  HEADLINE,
  EXPOSURE_TITLE,
  ...WHAT_LEAVES,
  ...WHAT_DOES_NOT_LEAVE,
  ...NOT_INCLUDED,
  ...EXPOSURE,
  ...HOW_TO_TURN_OFF,
].join("\n");

function key(
  k: string,
  action: TelemetryKeyPlan["action"],
  value: string | null = null,
): TelemetryKeyPlan {
  return { key: k, action, value, detail: null };
}

function result(over: Partial<TelemetryResult> = {}): TelemetryResult {
  return {
    config_home: "",
    settings_path: "/home/u/.claude/settings.json",
    status: "planned",
    refusal: null,
    changed: true,
    created_file: false,
    backup_path: null,
    state: "off",
    enable: [],
    disable: [],
    left_foreign: 0,
    notes: [],
    ...over,
  };
}

// ─── the exposure, which is the reason this file is tested at all ────────────

describe("the unauthenticated-endpoint disclosure", () => {
  it("says the endpoint has no authentication and that any local process can post", () => {
    // `otlp_receiver_service`: "the sidecar binds 127.0.0.1 and is
    // unauthenticated by design … any program the user can run can post."
    const text = [EXPOSURE_TITLE, ...EXPOSURE].join("\n").toLowerCase();
    expect(text).toContain("no authentication");
    expect(text).toContain("any process running as you");
    expect(text).toContain("cannot tell which process");
  });

  it("says the fabricated figure wins and cannot be corrected afterwards", () => {
    // `otlp_reconcile_service`: Lane B outranks every other lane, and the
    // regression guard engages only once Lane B already owns the field, so the
    // first claim on a session is unguarded at any value.
    const text = EXPOSURE.join("\n").toLowerCase();
    expect(text).toContain("outranks");
    expect(text).toContain("no other source can write it back");
    expect(text).toContain("cannot afterwards be corrected");
  });

  it("names how a session id is obtained rather than implying it is secret", () => {
    expect(EXPOSURE.join("\n")).toContain("~/.claude/projects");
  });

  it("states the one value that is refused, and that it is the only one", () => {
    // `_observed_metric_keys` refuses a cost whose SUM is zero. Saying "any
    // value" would overclaim; omitting the caveat would let a reader think the
    // hole was closed.
    const text = EXPOSURE.join("\n");
    expect(text).toContain("exactly zero is refused");
    expect(text).toContain("Every other fabricated value is not");
  });

  it("does not soften the exposure with a reassurance that it is local", () => {
    // The specific failure this guards: "it's all local, so it's private".
    // Loopback is what *creates* the exposure here, not what bounds it.
    const text = EXPOSURE.join("\n").toLowerCase();
    expect(text).not.toMatch(/(stays|only) on your (own )?machine/);
    expect(text).not.toMatch(/\bsafe\b|\bsecure\b|\bprivate\b/);
  });
});

// ─── what is and is not exported ─────────────────────────────────────────────

describe("what leaves Claude Code", () => {
  it("names the identity attributes individually", () => {
    // `_IDENTITY_ATTRS` in `otlp_receiver_service`. "Some metadata" would be
    // true and useless; `user.email` is the word that lets someone decide.
    for (const attr of [
      "user.id",
      "user.email",
      "organization.id",
      "terminal.type",
    ]) {
      expect(WHAT_LEAVES.join("\n")).toContain(attr);
    }
  });

  it("says the identity attributes are dropped at this end, after they left", () => {
    const text = WHAT_LEAVES.join("\n");
    expect(text).toContain("drops those rather than storing them");
    expect(text).toContain("after they have left Claude Code");
  });

  it("says something else listening on the port receives the export", () => {
    expect(WHAT_LEAVES.join("\n")).toContain("receives the export instead");
  });

  it("says prompts and responses are not exported, and why", () => {
    // `/v1/logs` answers 501 without reading the body.
    const text = WHAT_DOES_NOT_LEAVE.join("\n");
    expect(text).toContain("logs signal");
    expect(text).toContain("501");
    expect(text).toContain("without reading the request body");
  });
});

describe("what this does not give you", () => {
  it("refuses the hook-latency promise by name", () => {
    // Ten of the eighteen instrument names are spans; a metrics receiver
    // cannot receive one, and #178 (the trace receiver) is not built.
    const text = NOT_INCLUDED.join("\n");
    expect(text).toContain("Not hook latency");
    expect(text).toContain("tool reliability");
    expect(text).toContain("claude_code.hook");
    expect(text).toContain("spans, not counters");
    expect(text).toContain("no trace receiver");
  });

  it("never claims a span-borne instrument is available anywhere in the copy", () => {
    for (const span of [
      "claude_code.tool.execution",
      "claude_code.subagent.spawn",
      "claude_code.mcp.rpc",
      "claude_code.compaction",
    ]) {
      // They may be named as *unavailable*; what is banned is any sentence
      // offering one. The NOT_INCLUDED block is the only place spans appear.
      const outside = ALL.replace(NOT_INCLUDED.join("\n"), "");
      expect(outside).not.toContain(span);
    }
  });
});

// ─── the protocol pin, which is load-bearing ─────────────────────────────────

describe("the per-variable explanations", () => {
  it("covers all five variables and nothing else", () => {
    expect(Object.keys(KEY_PURPOSE).sort()).toEqual([
      "CLAUDE_CODE_ENABLE_TELEMETRY",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_PROTOCOL",
      "OTEL_METRICS_EXPORTER",
      "OTEL_METRIC_EXPORT_INTERVAL",
    ]);
  });

  it("explains the http/json pin as a receiver constraint, not a preference", () => {
    const text = KEY_PURPOSE["OTEL_EXPORTER_OTLP_PROTOCOL"] ?? "";
    expect(text).toContain("http/json");
    expect(text).toContain("http/protobuf");
    expect(text).toContain("415");
  });

  it("says the endpoint variable is a base the exporter appends a path to", () => {
    expect(KEY_PURPOSE["OTEL_EXPORTER_OTLP_ENDPOINT"]).toContain("/v1/metrics");
  });

  it("says the interval is set deliberately rather than inherited", () => {
    expect(KEY_PURPOSE["OTEL_METRIC_EXPORT_INTERVAL"]).toContain(
      "this app chose",
    );
  });
});

// ─── withdrawal ──────────────────────────────────────────────────────────────

describe("how to turn it off", () => {
  it("is a button, not an instruction to hand-edit JSON", () => {
    const text = HOW_TO_TURN_OFF.join("\n");
    expect(text).toContain("Turn telemetry off below");
    expect(text).toContain("no hand-editing of JSON");
  });

  it("says a variable this app did not write is not removed", () => {
    expect(HOW_TO_TURN_OFF.join("\n")).toContain(
      "A variable this app did not write is not removed",
    );
  });

  it("says disabling does not retract figures already recorded", () => {
    const text = HOW_TO_TURN_OFF.join("\n");
    expect(text).toContain("does not retract figures already recorded");
    expect(text).toContain("stay outranking");
  });
});

describe("the confirm bodies", () => {
  it("name the file and the backup before the write", () => {
    const text = writeConfirmBody(result());
    expect(text).toContain("/home/u/.claude/settings.json");
    expect(text).toContain("timestamped copy");
    expect(text).toContain("left exactly as it is");
  });

  it("say the disable takes the same backup", () => {
    expect(disableConfirmBody(result())).toContain("same backup");
  });
});

// ─── plan rendering ──────────────────────────────────────────────────────────

describe("summarise", () => {
  it("counts each action and reports whether the file would change", () => {
    const r = result({
      enable: [
        key("CLAUDE_CODE_ENABLE_TELEMETRY", "ok", "1"),
        key("OTEL_METRICS_EXPORTER", "add", "otlp"),
        key("OTEL_EXPORTER_OTLP_PROTOCOL", "update", "http/json"),
        key("OTEL_EXPORTER_OTLP_ENDPOINT", "conflict", "http://localhost:8002"),
        key("OTEL_METRIC_EXPORT_INTERVAL", "add", "60000"),
      ],
      disable: [
        key("CLAUDE_CODE_ENABLE_TELEMETRY", "remove"),
        key("OTEL_METRICS_EXPORTER", "absent"),
        key("OTEL_EXPORTER_OTLP_PROTOCOL", "remove"),
        key("OTEL_EXPORTER_OTLP_ENDPOINT", "absent"),
        key("OTEL_METRIC_EXPORT_INTERVAL", "absent"),
      ],
    });
    expect(summarise(r)).toEqual({
      ok: 1,
      add: 2,
      update: 1,
      conflict: 1,
      changes: true,
      removable: 2,
    });
  });

  it("reports no change when every variable is already ours", () => {
    const r = result({
      enable: [key("CLAUDE_CODE_ENABLE_TELEMETRY", "ok", "1")],
    });
    expect(summarise(r).changes).toBe(false);
  });
});

describe("stateHeadline", () => {
  it("says telemetry is off when nothing is set", () => {
    expect(stateHeadline(result({ state: "off" }))).toContain(
      "Telemetry is off",
    );
  });

  it("refuses to call a file 'on' when a blocking note says the exports miss us", () => {
    // A fully-written enable that silently exports elsewhere is the worst
    // thing this screen could report as success.
    const r = result({
      state: "on",
      notes: [
        {
          key: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
          severity: "blocking",
          detail: "…",
        },
      ],
    });
    expect(stateHeadline(r)).toContain("will not reach this app");
  });

  it("surfaces the refusal reason verbatim when the file cannot be written", () => {
    const r = result({ status: "refused", refusal: "not writable" });
    expect(stateHeadline(r)).toContain("not writable");
  });
});

describe("enableButtonLabel", () => {
  it("calls it a repair when everything present is ours but stale", () => {
    const r = result({
      enable: [key("OTEL_EXPORTER_OTLP_PROTOCOL", "update", "http/json")],
    });
    expect(enableButtonLabel(r)).toContain("Repair");
  });

  it("calls it turning telemetry on when anything would be added", () => {
    const r = result({ enable: [key("OTEL_METRICS_EXPORTER", "add", "otlp")] });
    expect(enableButtonLabel(r)).toContain("Turn telemetry on");
  });
});

describe("preservationNote", () => {
  it("is a count and never names a foreign variable", () => {
    // An `env` block is where an ANTHROPIC_API_KEY lives.
    expect(preservationNote(result({ left_foreign: 3 }))).toBe(
      "3 other environment variables in this file are left exactly as they are — not read, not rewritten, not reordered.",
    );
    expect(preservationNote(result({ left_foreign: 1 }))).toContain(
      "1 other environment variable",
    );
    expect(preservationNote(result({ left_foreign: 0 }))).toContain(
      "no other environment variables",
    );
  });
});

describe("outcomeNote", () => {
  it("names where the backup went", () => {
    const r = result({
      status: "applied",
      backup_path:
        "/home/u/.claude/settings.json.codenest-backup-20260912T101500Z",
    });
    expect(outcomeNote(r)).toContain("codenest-backup-20260912T101500Z");
  });

  it("says plainly when there was no previous file to copy", () => {
    const r = result({ status: "applied", backup_path: null });
    expect(outcomeNote(r)).toContain("no previous file");
  });

  it("reports a refusal rather than implying success", () => {
    const r = result({
      status: "refused",
      refusal: "settings.json is a directory",
    });
    expect(outcomeNote(r)).toContain("Nothing was written");
    expect(outcomeNote(r)).toContain("is a directory");
  });
});
