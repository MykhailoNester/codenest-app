// Pure, React-free copy/classification helpers for the onboarding hook-verify
// step. Kept out of `hooks-step.tsx` because that file must keep exporting
// only its component (`react-refresh/only-export-components`), and because
// this is what the required diff/copy tests target directly (see
// `__tests__/hook-verify-copy.test.ts`).
//
// `HookProbeResult` is imported type-only so `@tauri-apps/api/core` never
// enters this module's graph under vitest; the `api.ts` types are likewise
// type-only, with a single value import of `SidecarError` (safe under
// vitest — pinned by `lib/__tests__/module-load-order.test.ts`).
import { SidecarError } from "../../lib/api";
import type {
  HookEventVerdict,
  HookSelfTestReceipt,
  HookVerifyReport,
} from "../../lib/api";
import type { HookProbeResult } from "../../lib/ipc";

// ─── Live probe classification ───────────────────────────────────────────────

export type LiveProbeKind =
  | "ok"
  | "curl-missing"
  | "unreachable"
  | "bad-status"
  | "wrong-server"
  | "expired";

export interface LiveProbeOutcome {
  kind: LiveProbeKind;
  message: string;
}

/**
 * Classify the outcome of a live self-test probe (a real `curl` run by the
 * Rust shell, observed server-side via the minted token's receipt).
 *
 * Order matters — see the decision table in the plan: `curlMissing` and "no
 * HTTP response at all" are checked before the receipt is even consulted,
 * since neither implies anything reached the sidecar.
 */
export function classifyLiveProbe(
  probe: HookProbeResult,
  receipt: HookSelfTestReceipt | null,
  url: string,
): LiveProbeOutcome {
  if (probe.curlMissing) {
    return {
      kind: "curl-missing",
      message:
        "curl is not on your PATH — the hook command cannot run in any shell.",
    };
  }
  if (probe.httpStatus === null) {
    const exitPart = `curl exit ${probe.exitCode ?? "unknown"}`;
    const stderrPart = probe.stderr ? `: ${probe.stderr}` : "";
    return {
      kind: "unreachable",
      message: `Nothing answered at ${url} (${exitPart}${stderrPart}). The app's API is not reachable on that host and port.`,
    };
  }
  if (probe.httpStatus !== 200) {
    return {
      kind: "bad-status",
      message: `Got HTTP ${probe.httpStatus} from ${url} — something else is listening on that port.`,
    };
  }
  if (receipt === null || !receipt.known) {
    return {
      kind: "expired",
      message: "The test token expired. Run the live test again.",
    };
  }
  if (!receipt.received) {
    return {
      kind: "wrong-server",
      message: `Something answered at ${url}, but it was not this app. Another process is holding that port.`,
    };
  }
  const elapsed = receipt.elapsed_ms ?? "?";
  return {
    kind: "ok",
    message: `Live test passed — a real POST from curl reached the sidecar in ${elapsed} ms.`,
  };
}

// ─── Request-failure classification ──────────────────────────────────────────
//
// Every state in this feature arrives through an awaited call that can
// reject, and the rejection is a first-class outcome distinct from a failed
// verdict about the user's settings.json — see hooks-step.tsx's onTestHooks /
// onLiveTest for where these are caught.

export type RequestFailureKind =
  "sidecar-unreachable" | "sidecar-error" | "probe-rejected";

export interface RequestFailure {
  kind: RequestFailureKind;
  message: string;
}

type RequestFailureSource = "verify" | "mint" | "receipt" | "probe";

const REQUEST_FAILURE_VERBS: Record<
  Exclude<RequestFailureSource, "probe">,
  string
> = {
  verify: "checking your settings.json",
  mint: "starting the live test",
  receipt: "reading the live-test receipt",
};

/**
 * Turn a caught, unknown error from one of the four awaited sidecar/shell
 * calls into a `RequestFailure` the bar can render — distinguishing "sidecar
 * unreachable" from "sidecar answered but with an error" from "the shell
 * refused to run the probe", none of which are a verdict on the user's file.
 */
export function describeRequestFailure(
  source: RequestFailureSource,
  error: unknown,
  sidecarBaseUrl: string,
): RequestFailure {
  if (source === "probe") {
    return {
      kind: "probe-rejected",
      message: `The desktop shell refused to run the probe: ${String(error)}. The sidecar URL must be a loopback address — check CODENEST_SIDECAR_URL.`,
    };
  }
  if (error instanceof SidecarError) {
    return {
      kind: "sidecar-error",
      message: `The app's API answered ${error.status} for ${error.path}. That is a problem in the app, not in your settings.json — try again, and restart the app if it persists.`,
    };
  }
  const verb = REQUEST_FAILURE_VERBS[source];
  return {
    kind: "sidecar-unreachable",
    message: `Could not reach the app's API at ${sidecarBaseUrl} while ${verb}. The app's API is not answering — it may still be starting, or it stopped. Wait a moment and run the test again.`,
  };
}

// ─── Verification bar copy ───────────────────────────────────────────────────

export type VerifyTone = "idle" | "ok" | "warn" | "error";

const LIVE_PROBE_TONE: Record<LiveProbeKind, VerifyTone> = {
  ok: "ok",
  "curl-missing": "error",
  unreachable: "error",
  "bad-status": "error",
  "wrong-server": "error",
  expired: "warn",
};

/**
 * The single source of truth for the verification bar's tone + message.
 *
 * Priority (highest first): a request failure always wins — it is the
 * outcome of the user's most recent click, and rendering anything else over
 * it is what produces "you did something wrong when you did not". Then a
 * live session ping, then a live-probe result, then the settings.json diff
 * report, then idle. No branch, for any input, ever tells the user to start
 * a Claude Code session — that is the defect this bar exists to fix.
 */
export function verifyBarCopy(
  report: HookVerifyReport | undefined,
  live: LiveProbeOutcome | undefined,
  sessionPingConnected: boolean,
  failure?: RequestFailure,
): { tone: VerifyTone; message: string } {
  if (failure) {
    return { tone: "error", message: failure.message };
  }
  if (sessionPingConnected) {
    return {
      tone: "ok",
      message:
        "Live hook ping received — Claude Code is reporting to the sidecar.",
    };
  }
  if (live) {
    return { tone: LIVE_PROBE_TONE[live.kind], message: live.message };
  }
  if (report) {
    return reportBarCopy(report);
  }
  return {
    tone: "idle",
    message: "Not verified yet — paste the block above, then run Test hooks.",
  };
}

function reportBarCopy(report: HookVerifyReport): {
  tone: VerifyTone;
  message: string;
} {
  if (report.overall === "ok") {
    return {
      tone: "ok",
      message: "All six hook events verified in settings.json.",
    };
  }
  if (report.overall === "error") {
    return {
      tone: "error",
      message:
        "Could not parse settings.json — fix the JSON, then run Test hooks again.",
    };
  }
  if (report.overall === "absent") {
    const withHit = report.results.find((r) => r.found_elsewhere.length > 0);
    const otherPath = withHit?.found_elsewhere[0];
    if (withHit && otherPath !== undefined) {
      return {
        tone: "warn",
        message: `Found the hook block in ${otherPath}, but this provider reads ${withHit.settings_path}. Move it there.`,
      };
    }
    return {
      tone: "warn",
      message:
        "Hook block not found yet — paste it into the file shown on each card, then run Test hooks again.",
    };
  }
  // "partial"
  return {
    tone: "warn",
    message:
      "Some hook events are missing or stale in settings.json — check the cards above, then run Test hooks again.",
  };
}

// ─── Per-event chip tone ─────────────────────────────────────────────────────

export function eventChipTone(
  status: HookEventVerdict["status"],
): "ok" | "warn" | "error" {
  if (status === "ok") return "ok";
  if (status === "missing") return "warn";
  return "error"; // "mismatch" | "malformed"
}
