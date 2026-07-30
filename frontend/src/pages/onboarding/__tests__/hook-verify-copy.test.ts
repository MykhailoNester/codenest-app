import { describe, expect, it } from "vitest";
import { SidecarError } from "../../../lib/api";
import type {
  HookSelfTestReceipt,
  HookSettingsVerify,
  HookVerifyReport,
} from "../../../lib/api";
import type { HookProbeResult } from "../../../lib/ipc";
import {
  classifyLiveProbe,
  describeRequestFailure,
  verifyBarCopy,
  type LiveProbeOutcome,
  type RequestFailure,
  type RequestFailureKind,
} from "../hook-verify-copy";

const BASE_URL = "http://127.0.0.1:8002";
const PROBE_URL = `${BASE_URL}/api/v1/workspace/hooks/self-test/abc123`;

function probe(overrides: Partial<HookProbeResult> = {}): HookProbeResult {
  return {
    httpStatus: 200,
    exitCode: 0,
    curlMissing: false,
    durationMs: 12,
    stderr: "",
    ...overrides,
  };
}

function receipt(
  overrides: Partial<HookSelfTestReceipt> = {},
): HookSelfTestReceipt {
  return { known: true, received: true, elapsed_ms: 5, ...overrides };
}

function report(overrides: Partial<HookVerifyReport> = {}): HookVerifyReport {
  return {
    base_url: BASE_URL,
    expected_events: ["SessionStart"],
    overall: "ok",
    results: [],
    ...overrides,
  };
}

function verifyResult(
  overrides: Partial<HookSettingsVerify> = {},
): HookSettingsVerify {
  return {
    config_home: "~/.claude",
    settings_path: "/Users/x/.claude/settings.json",
    file_status: "ok",
    detail: null,
    events: [],
    found_elsewhere: [],
    ...overrides,
  };
}

describe("classifyLiveProbe", () => {
  it("reports curl-missing", () => {
    const outcome = classifyLiveProbe(
      probe({ curlMissing: true, httpStatus: null }),
      null,
      PROBE_URL,
    );
    expect(outcome.kind).toBe("curl-missing");
  });

  it("reports unreachable when curl returned no status", () => {
    const outcome = classifyLiveProbe(
      probe({ httpStatus: null, exitCode: 7 }),
      null,
      PROBE_URL,
    );
    expect(outcome.kind).toBe("unreachable");
    expect(outcome.message).toContain(PROBE_URL);
  });

  it("reports wrong-server on 200 with no receipt", () => {
    const outcome = classifyLiveProbe(
      probe({ httpStatus: 200 }),
      receipt({ received: false }),
      PROBE_URL,
    );
    expect(outcome.kind).toBe("wrong-server");
  });

  it("reports ok only when the receipt was observed", () => {
    const ok = classifyLiveProbe(
      probe({ httpStatus: 200 }),
      receipt({ received: true }),
      PROBE_URL,
    );
    expect(ok.kind).toBe("ok");

    const notReceived = classifyLiveProbe(
      probe({ httpStatus: 200 }),
      receipt({ received: false }),
      PROBE_URL,
    );
    expect(notReceived.kind).not.toBe("ok");
  });

  it("reports expired when the token is unknown", () => {
    const outcome = classifyLiveProbe(
      probe({ httpStatus: 200 }),
      receipt({ known: false }),
      PROBE_URL,
    );
    expect(outcome.kind).toBe("expired");

    const nullReceipt = classifyLiveProbe(
      probe({ httpStatus: 200 }),
      null,
      PROBE_URL,
    );
    expect(nullReceipt.kind).toBe("expired");
  });

  it("reports bad-status for a non-200, non-null status", () => {
    const outcome = classifyLiveProbe(
      probe({ httpStatus: 503 }),
      null,
      PROBE_URL,
    );
    expect(outcome.kind).toBe("bad-status");
  });
});

describe("describeRequestFailure", () => {
  it("reports sidecar-down when the mint request fails", () => {
    const failure = describeRequestFailure(
      "mint",
      new TypeError("Failed to fetch"),
      BASE_URL,
    );
    expect(failure.kind).toBe("sidecar-unreachable");
    expect(failure.message).toContain(BASE_URL);
    expect(failure.message).not.toContain("settings.json");
  });

  it("separates an API error from an unreachable API", () => {
    const failure = describeRequestFailure(
      "verify",
      new SidecarError("boom", 500, "/api/v1/workspace/hooks/verify"),
      BASE_URL,
    );
    expect(failure.kind).toBe("sidecar-error");
    expect(failure.message).toContain("500");
    expect(failure.message).toContain("/api/v1/workspace/hooks/verify");
    expect(failure.message).not.toMatch(/your settings\.json is/i);
  });

  it("a rejected probe URL is surfaced, not swallowed", () => {
    const failure = describeRequestFailure(
      "probe",
      new Error("refusing non-loopback probe url: http://example.com/x"),
      BASE_URL,
    );
    expect(failure.kind).toBe("probe-rejected");
    expect(failure.message).toContain(
      "refusing non-loopback probe url: http://example.com/x",
    );

    const barred = verifyBarCopy(undefined, undefined, false, failure);
    expect(barred.tone).toBe("error");
  });
});

describe("verifyBarCopy", () => {
  it("renders a request failure instead of the idle prompt", () => {
    const failure: RequestFailure = {
      kind: "sidecar-unreachable",
      message: "the app's API is not answering",
    };
    const copy = verifyBarCopy(undefined, undefined, false, failure);
    expect(copy.tone).toBe("error");
    expect(copy.message).not.toContain(
      "Not verified yet — paste the block above",
    );
  });

  it("prefers a request failure over a stale success", () => {
    const failure: RequestFailure = {
      kind: "sidecar-error",
      message: "the app's API answered 500",
    };
    const okReport = report({
      overall: "ok",
      results: [verifyResult()],
    });
    const copy = verifyBarCopy(okReport, undefined, true, failure);
    expect(copy.tone).toBe("error");
    expect(copy.message).toBe(failure.message);
  });

  it("prefers a live session ping over live-probe and report state", () => {
    const errorLive: LiveProbeOutcome = {
      kind: "unreachable",
      message: "nothing answered",
    };
    const copy = verifyBarCopy(undefined, errorLive, true, undefined);
    expect(copy.tone).toBe("ok");
  });

  it("distinguishes absent from wrong-file", () => {
    const plainAbsent = verifyBarCopy(
      report({
        overall: "absent",
        results: [verifyResult({ file_status: "missing_file" })],
      }),
      undefined,
      false,
      undefined,
    );
    expect(plainAbsent.message).not.toContain("settings.local.json");

    const wrongFile = verifyBarCopy(
      report({
        overall: "absent",
        results: [
          verifyResult({
            file_status: "missing_file",
            found_elsewhere: ["/Users/x/.claude/settings.local.json"],
          }),
        ],
      }),
      undefined,
      false,
      undefined,
    );
    expect(wrongFile.message).toContain("/Users/x/.claude/settings.local.json");
  });

  it("is idle before anything runs", () => {
    const copy = verifyBarCopy(undefined, undefined, false, undefined);
    expect(copy.tone).toBe("idle");
  });

  it("never asks the user to start a session", () => {
    const liveKinds: LiveProbeOutcome[] = [
      { kind: "ok", message: "passed" },
      { kind: "curl-missing", message: "missing" },
      { kind: "unreachable", message: "unreachable" },
      { kind: "bad-status", message: "bad status" },
      { kind: "wrong-server", message: "wrong server" },
      { kind: "expired", message: "expired" },
    ];
    const failureKinds: RequestFailureKind[] = [
      "sidecar-unreachable",
      "sidecar-error",
      "probe-rejected",
    ];
    const reports: (HookVerifyReport | undefined)[] = [
      undefined,
      report({ overall: "ok", results: [verifyResult()] }),
      report({
        overall: "partial",
        results: [verifyResult({ file_status: "partial" })],
      }),
      report({
        overall: "error",
        results: [verifyResult({ file_status: "invalid_json" })],
      }),
      report({ overall: "absent", results: [] }),
      report({
        overall: "absent",
        results: [
          verifyResult({
            file_status: "missing_file",
            found_elsewhere: ["/other/path/settings.local.json"],
          }),
        ],
      }),
    ];
    const lives: (LiveProbeOutcome | undefined)[] = [undefined, ...liveKinds];
    const failures: (RequestFailure | undefined)[] = [
      undefined,
      ...failureKinds.map((kind) => ({ kind, message: `${kind} happened` })),
    ];

    for (const r of reports) {
      for (const l of lives) {
        for (const sessionPingConnected of [true, false]) {
          for (const f of failures) {
            const copy = verifyBarCopy(r, l, sessionPingConnected, f);
            expect(copy.message).not.toMatch(/start a .*session/i);
          }
        }
      }
    }
  });
});
