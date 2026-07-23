/**
 * Unit tests for OSC handler pure functions in terminal-pane.tsx (task 16.6).
 *
 * These tests exercise the handler bodies in isolation — no Terminal instance,
 * no React, no Tauri APIs.
 */

import { describe, it, expect } from "vitest";
import { decodeOsc7, decodeOscTitle } from "../osc-handlers";

// ---------------------------------------------------------------------------
// OSC 7 — file://host/path → POSIX path
// ---------------------------------------------------------------------------

describe("decodeOsc7", () => {
  it("decodes a standard file:// URL with empty host", () => {
    expect(decodeOsc7("file:///Users/alice/projects/foo")).toBe(
      "/Users/alice/projects/foo",
    );
  });

  it("decodes a file:// URL with a hostname", () => {
    expect(decodeOsc7("file://mymac/Users/alice/projects/foo")).toBe(
      "/Users/alice/projects/foo",
    );
  });

  it("percent-decodes spaces in the path", () => {
    expect(decodeOsc7("file:///Users/alice/my%20project/src")).toBe(
      "/Users/alice/my project/src",
    );
  });

  it("percent-decodes unicode characters", () => {
    expect(decodeOsc7("file:///Users/alice/%C3%A9t%C3%A9")).toBe(
      "/Users/alice/été",
    );
  });

  it("returns null when the payload is not a file URL", () => {
    expect(decodeOsc7("https://example.com")).toBeNull();
  });

  it("returns null when the path component is empty after stripping scheme+host", () => {
    // file://host with no trailing slash is not a valid path.
    expect(decodeOsc7("file://host")).toBeNull();
  });

  it("returns null on an empty string", () => {
    expect(decodeOsc7("")).toBeNull();
  });

  it("returns null when percent-decoding fails", () => {
    // '%zz' is not valid percent-encoded.
    expect(decodeOsc7("file:///path/%zz/foo")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OSC 0 / OSC 2 — terminal title
// ---------------------------------------------------------------------------

describe("decodeOscTitle", () => {
  it("returns the payload when it contains a non-empty string", () => {
    expect(decodeOscTitle("my shell title")).toBe("my shell title");
  });

  it("trims surrounding whitespace", () => {
    expect(decodeOscTitle("  vim foo.ts  ")).toBe("vim foo.ts");
  });

  it("returns null for an empty payload", () => {
    expect(decodeOscTitle("")).toBeNull();
  });

  it("returns null for a whitespace-only payload", () => {
    expect(decodeOscTitle("   ")).toBeNull();
  });

  it("preserves inner whitespace in the title", () => {
    expect(decodeOscTitle("cargo build --release")).toBe(
      "cargo build --release",
    );
  });
});
