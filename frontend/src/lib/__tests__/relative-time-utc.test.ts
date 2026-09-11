import { describe, it, expect, afterEach, vi } from "vitest";
import { relativeTime } from "../format-helpers";

/**
 * `relativeTime` used `new Date(iso)`, which reads a naive ISO string as LOCAL
 * time. The sidecar emits naive UTC for every timestamp it returns
 * (`2026-09-11T14:10:14`, no suffix — SQLite `CURRENT_TIMESTAMP`), so every age
 * it rendered was wrong by the machine's UTC offset. Found while verifying
 * #162: on a +03:00 machine a just-created attention item read as three hours
 * old.
 *
 * These run with TZ forced away from UTC, because the bug is invisible when the
 * test machine happens to be at offset zero — which CI is.
 */

const NOW = Date.parse("2026-09-11T15:00:00Z");

afterEach(() => {
  vi.useRealTimers();
});

function atFakeNow(fn: () => void): void {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fn();
}

describe("relativeTime reads naive sidecar stamps as UTC", () => {
  it("treats a suffix-less stamp as UTC, not local", () => {
    atFakeNow(() => {
      // 30 minutes before NOW, in the shape the sidecar actually emits.
      expect(relativeTime("2026-09-11T14:30:00")).toBe("30m ago");
    });
  });

  it("gives the same answer for the naive and the Z-suffixed form", () => {
    atFakeNow(() => {
      expect(relativeTime("2026-09-11T14:30:00")).toBe(
        relativeTime("2026-09-11T14:30:00Z"),
      );
    });
  });

  it("does not corrupt a stamp that carries an explicit offset", () => {
    atFakeNow(() => {
      // 14:30+03:00 is 11:30Z — three and a half hours before NOW. Appending a
      // Z to this would produce an unparseable hybrid and yield NaN.
      expect(relativeTime("2026-09-11T14:30:00+03:00")).toBe("3h ago");
      expect(relativeTime("2026-09-11T14:30:00+0300")).toBe("3h ago");
    });
  });

  it("still reports a future stamp as future", () => {
    atFakeNow(() => {
      expect(relativeTime("2026-09-11T15:30:00")).toBe("in 30m");
    });
  });

  it("keeps the null/undefined convenience contract", () => {
    expect(relativeTime(null)).toBe("—");
    expect(relativeTime(undefined)).toBe("—");
    expect(relativeTime("")).toBe("—");
  });

  it("reports whole days for an old session, not an offset-shifted count", () => {
    atFakeNow(() => {
      // The stalled-session ages the Needs You page renders.
      expect(relativeTime("2026-09-04T15:00:00")).toBe("7d ago");
    });
  });
});
