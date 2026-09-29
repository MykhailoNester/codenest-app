import { describe, it, expect } from "vitest";
import { sessionFromDelta, sessionIdFromDelta } from "../sse-session-envelope";

// The shape agent_service._broadcast actually publishes.
const delta = {
  kind: "update",
  session: { session_id: "s-1", profile: "claude", status: "active" },
  event: { id: 9 },
};

describe("sessionFromDelta", () => {
  it("reads the nested session, not the envelope", () => {
    expect(sessionFromDelta(delta)?.session_id).toBe("s-1");
  });

  it("rejects the envelope being mistaken for the session", () => {
    // The regression: casting the whole payload yields session_id undefined,
    // which appended a junk row and crashed the avatar renderer.
    expect(sessionFromDelta({ kind: "update" })).toBeNull();
    expect(sessionFromDelta({ kind: "update", session: null })).toBeNull();
    expect(sessionFromDelta(null)).toBeNull();
    expect(sessionFromDelta("nope")).toBeNull();
  });

  it("rejects a nested session with no usable id", () => {
    expect(sessionFromDelta({ session: { profile: "claude" } })).toBeNull();
    expect(sessionFromDelta({ session: { session_id: "" } })).toBeNull();
  });
});

describe("sessionIdFromDelta", () => {
  it("finds the id nested, which is where ended events carry it", () => {
    expect(sessionIdFromDelta(delta)).toBe("s-1");
  });

  it("still accepts a top-level id", () => {
    expect(sessionIdFromDelta({ session_id: "s-2" })).toBe("s-2");
  });

  it("returns null when there is none", () => {
    expect(sessionIdFromDelta({ kind: "session_ended" })).toBeNull();
  });
});
