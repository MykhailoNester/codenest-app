import { describe, it, expect } from "vitest";

// Reproduces the app's module load order: importing api.ts first triggers its
// import of sse-registry, which previously imported SIDECAR_BASE_URL back from
// api.ts (a cycle) and read it at module top-level -> TDZ ReferenceError ->
// black screen. This must load cleanly.
describe("module load order (no import-cycle TDZ)", () => {
  it("imports api -> sse-registry without throwing and resolves the base URL", async () => {
    const api = await import("../api");
    expect(typeof api.SIDECAR_BASE_URL).toBe("string");
    expect(api.SIDECAR_BASE_URL.length).toBeGreaterThan(0);
    const reg = await import("../sse-registry");
    expect(reg.sseRegistry).toBeDefined();
  });
});
