// macOS puts NSRightArrowFunctionKey (U+F703) straight into the field when
// WebKit does not resolve an arrow press to an editing command, so pressing
// Right five times used to leave five tofu boxes in the draft.
//
// Every codepoint under test is written as an escape rather than pasted
// literally: they have no glyph, so a literal would be invisible in the
// source and impossible to review.

import { describe, it, expect } from "vitest";
import { isTypeable, sanitizeComposerInput, stripUntypeable } from "../composer-input";

const UP = "\uF700"; // NSUpArrowFunctionKey
const DOWN = "\uF701";
const LEFT = "\uF702";
const RIGHT = "\uF703";
const ESC = "\u001B";

describe("stripUntypeable", () => {
  it("drops the macOS arrow-key codepoints \u2014 the reported bug", () => {
    expect(stripUntypeable(RIGHT.repeat(5))).toBe("");
    expect(stripUntypeable(`hel${RIGHT}lo`)).toBe("hello");
    for (const key of [UP, DOWN, LEFT, RIGHT]) {
      expect(stripUntypeable(`a${key}b`)).toBe("ab");
    }
  });

  it("covers the whole AppKit function-key range, not just the arrows", () => {
    // F-keys, Home/End and Page Up/Down live in the same reserved block.
    expect(stripUntypeable("x\uF704y\uF729z\uF72Bw")).toBe("xyzw");
    // Both ends of the reserved range are inside the filter.
    expect(stripUntypeable("e\uF700d\uF8FFge")).toBe("edge");
  });

  it("strips ANSI escapes out of pasted terminal output", () => {
    expect(stripUntypeable(`${ESC}[0mplain${ESC}[31mred`)).toBe("[0mplain[31mred");
    expect(stripUntypeable("bell\u0007null\u0000")).toBe("bellnull");
  });

  it("keeps tab, newline and carriage return \u2014 a textarea legitimately holds them", () => {
    expect(stripUntypeable("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("leaves ordinary text, emoji and non-Latin scripts alone", () => {
    for (const text of ["hello world", "\u0432\u0456\u0442\u0435\u0440", "\u65E5\u672C\u8A9E", "\uD83C\uDF89 ship it", "a/b \u2014 c"]) {
      expect(stripUntypeable(text)).toBe(text);
    }
  });
});

describe("isTypeable", () => {
  it("is not fooled by lastIndex on a repeated call \u2014 the /g regex trap", () => {
    // A module-level `/g` regex whose `lastIndex` survived the previous call
    // would resume mid-string and report the second call clean.
    expect(isTypeable(`a${RIGHT}b`)).toBe(false);
    expect(isTypeable(`a${RIGHT}b`)).toBe(false);
  });

  it("alternates correctly between dirty and clean input", () => {
    expect(isTypeable(`x${RIGHT}`)).toBe(false);
    expect(isTypeable("clean")).toBe(true);
    expect(isTypeable(`y${RIGHT}`)).toBe(false);
    expect(isTypeable("clean")).toBe(true);
  });
});

describe("sanitizeComposerInput", () => {
  it("pulls the caret back past a character dropped before it", () => {
    // "hi" then a Right press: the box lands at offset 2, caret at 3.
    expect(sanitizeComposerInput(`hi${RIGHT}`, 3)).toEqual({ text: "hi", caret: 2 });
  });

  it("leaves the caret alone when the dropped character sits after it", () => {
    expect(sanitizeComposerInput(`ab${RIGHT}cd`, 1)).toEqual({ text: "abcd", caret: 1 });
  });

  it("accounts for several dropped characters before the caret", () => {
    expect(sanitizeComposerInput(`${RIGHT}a${RIGHT}b`, 4)).toEqual({ text: "ab", caret: 2 });
  });

  it("returns clean input untouched, caret included", () => {
    expect(sanitizeComposerInput("hello", 2)).toEqual({ text: "hello", caret: 2 });
  });

  it("clamps a caret outside the value instead of reporting a negative one", () => {
    expect(sanitizeComposerInput(`ab${RIGHT}`, 99)).toEqual({ text: "ab", caret: 2 });
    expect(sanitizeComposerInput(`${RIGHT}ab`, -5)).toEqual({ text: "ab", caret: 0 });
  });
});
