import { describe, it, expect } from "vitest";
import {
  beginPathDrag,
  clearPathDrag,
  consumePathDrag,
  peekPathDrag,
} from "../active-path-drag";

describe("active-path-drag", () => {
  it("records a drag and hands the paths over exactly once", () => {
    beginPathDrag(["/a"]);
    expect(consumePathDrag()).toEqual(["/a"]);
    expect(consumePathDrag()).toBeNull();
  });

  it("peek reads the record without claiming it", () => {
    beginPathDrag(["/a"]);
    expect(peekPathDrag()).toEqual(["/a"]);
    expect(peekPathDrag()).toEqual(["/a"]);
    expect(consumePathDrag()).toEqual(["/a"]);
  });

  it("a new drag replaces an unconsumed record", () => {
    beginPathDrag(["/a"]);
    beginPathDrag(["/b"]);
    expect(consumePathDrag()).toEqual(["/b"]);
  });

  it("clearPathDrag discards without returning", () => {
    beginPathDrag(["/a"]);
    clearPathDrag();
    expect(consumePathDrag()).toBeNull();
  });

  it("an empty path list records nothing", () => {
    beginPathDrag([]);
    expect(consumePathDrag()).toBeNull();
  });

  it("the record is a copy", () => {
    const paths = ["/a"];
    beginPathDrag(paths);
    paths.push("/mutated");
    const peeked = peekPathDrag();
    expect(peeked).toEqual(["/a"]);
    peeked?.push("/also-mutated");
    expect(consumePathDrag()).toEqual(["/a"]);
  });
});
