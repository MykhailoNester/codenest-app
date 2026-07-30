import { describe, it, expect } from "vitest";
import {
  CODENEST_PATHS_MIME,
  writePathDragPayload,
  readPathDragPayload,
} from "../drag-payload";

// jsdom 29 does not implement `DataTransfer` (absent from
// `node_modules/.pnpm/jsdom@29.1.1/.../living/interfaces.js`), so
// `new DataTransfer()` would throw. A minimal `{ types, setData, getData }`
// stub over a Map is all either helper touches.
class FakeDataTransfer {
  effectAllowed = "none";
  dropEffect = "none";
  private store = new Map<string, string>();

  setData(type: string, value: string): void {
    this.store.set(type, value);
  }

  getData(type: string): string {
    return this.store.get(type) ?? "";
  }

  get types(): string[] {
    return [...this.store.keys()];
  }
}

function fakeDataTransfer(): DataTransfer {
  return new FakeDataTransfer() as unknown as DataTransfer;
}

describe("writePathDragPayload", () => {
  it("sets the codenest MIME with a JSON array", () => {
    const dt = fakeDataTransfer();
    writePathDragPayload(dt, ["/Users/me/repo/a.ts", "/Users/me/repo/b.ts"]);

    // This is the cross-branch contract's guard — renaming the MIME type
    // breaks this assertion loudly for whoever changes it.
    expect(CODENEST_PATHS_MIME).toBe("application/x-codenest-paths");
    expect(JSON.parse(dt.getData(CODENEST_PATHS_MIME))).toEqual([
      "/Users/me/repo/a.ts",
      "/Users/me/repo/b.ts",
    ]);
    expect(dt.effectAllowed).toBe("copy");
  });

  it("sets a newline-joined text/plain fallback", () => {
    const dt = fakeDataTransfer();
    writePathDragPayload(dt, ["/a/one.ts", "/a/two.ts"]);
    expect(dt.getData("text/plain")).toBe("/a/one.ts\n/a/two.ts");
  });

  it("a single path yields just that path in the text/plain fallback", () => {
    const dt = fakeDataTransfer();
    writePathDragPayload(dt, ["/a/solo.ts"]);
    expect(dt.getData("text/plain")).toBe("/a/solo.ts");
  });
});

describe("readPathDragPayload", () => {
  it("round-trips what write wrote", () => {
    const dt = fakeDataTransfer();
    writePathDragPayload(dt, ["/x/one.py", "/x/two.py"]);
    expect(readPathDragPayload(dt)).toEqual(["/x/one.py", "/x/two.py"]);
  });

  it("returns null when the custom type is absent", () => {
    const dt = fakeDataTransfer();
    dt.setData("text/plain", "/some/path.ts");
    expect(readPathDragPayload(dt)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const dt = fakeDataTransfer();
    dt.setData(CODENEST_PATHS_MIME, "{not json");
    expect(readPathDragPayload(dt)).toBeNull();
  });

  it("returns null for a JSON object instead of an array", () => {
    const dt = fakeDataTransfer();
    dt.setData(CODENEST_PATHS_MIME, JSON.stringify({ path: "/a.ts" }));
    expect(readPathDragPayload(dt)).toBeNull();
  });

  it("returns null for an array of non-strings", () => {
    const dt = fakeDataTransfer();
    dt.setData(CODENEST_PATHS_MIME, JSON.stringify([1, 2, 3]));
    expect(readPathDragPayload(dt)).toBeNull();
  });

  it("returns null for an empty array", () => {
    const dt = fakeDataTransfer();
    dt.setData(CODENEST_PATHS_MIME, JSON.stringify([]));
    expect(readPathDragPayload(dt)).toBeNull();
  });
});
