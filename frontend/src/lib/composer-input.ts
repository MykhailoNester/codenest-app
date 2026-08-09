/**
 * The one filter every keystroke the user types into an agent composer passes
 * through, and the reason it exists.
 *
 * On macOS a key that the text system does not resolve to an editing command
 * falls through WebKit's `doCommandBySelector:` into `insertText:`, which
 * inserts the key's *raw* character. AppKit encodes the non-typing keys —
 * arrows, Home/End, the F-keys, Page Up/Down — as codepoints in the range
 * Apple reserves for exactly that purpose, `NSUpArrowFunctionKey` (U+F700)
 * through U+F8FF. They have no glyph in any normal font, so an arrow press
 * that takes this path leaves a tofu box in the draft instead of moving the
 * caret: press Right five times, get five boxes.
 *
 * The fix is subtractive on purpose. The alternative — intercepting
 * ArrowLeft/ArrowRight in `onKeyDown`, calling `preventDefault()` and moving
 * the caret by hand — means reimplementing native caret motion, and native
 * caret motion is much larger than it looks: word-wise jumps with Option,
 * selection extension with Shift, line-wise motion over *visual* lines in a
 * wrapped textarea, and bidirectional text. Getting any of that subtly wrong
 * is worse than the bug being fixed. Dropping characters that could never
 * have been typed leaves the browser's own caret handling entirely alone.
 *
 * It also fixes a second, quieter problem: pasting terminal output into a
 * prompt used to carry its ANSI escapes and control bytes straight into the
 * message sent to the model.
 */

/**
 * Characters that cannot legitimately appear in a prompt:
 *
 * - `U+0000`-`U+0008`, `U+000B`, `U+000C`, `U+000E`-`U+001F`, `U+007F` — the
 *   C0 control block and DEL, minus the three a textarea legitimately holds:
 *   tab (`U+0009`), line feed (`U+000A`) and carriage return (`U+000D`). This
 *   is what strips the `ESC` out of a pasted `\x1b[0m` colour code.
 * - `U+F700`-`U+F8FF` — the range AppKit documents as reserved for function
 *   keys. Some icon fonts also squat in the upper part of this range, so a
 *   pasted Nerd Font glyph from terminal output could be dropped here; that is
 *   the accepted trade, since a decorative glyph surviving matters far less
 *   than the arrow keys working.
 */
// `no-control-regex` exists to catch control characters that landed in a
// pattern by accident. Here they are the entire subject of the pattern —
// this is the filter whose whole job is to match them — so the rule has
// nothing left to warn about.
// eslint-disable-next-line no-control-regex
const UNTYPEABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uF700-\uF8FF]/g;

/** `text` with every untypeable character removed. */
export function stripUntypeable(text: string): string {
  return text.replace(UNTYPEABLE, "");
}

/** True when `text` contains nothing this filter would remove — the cheap
 *  check callers use to skip work on the overwhelmingly common keystroke.
 *  Resets `lastIndex` first: `UNTYPEABLE` is a module-level `/g` regex, and
 *  `test` on a sticky-indexed regex would otherwise resume mid-string and
 *  miss a match on the very next call. */
export function isTypeable(text: string): boolean {
  UNTYPEABLE.lastIndex = 0;
  return !UNTYPEABLE.test(text);
}

/**
 * `stripUntypeable`, but also reporting where the caret belongs afterwards.
 *
 * The caret has to move back by however many characters were dropped *before*
 * it, not by the total: dropping one character at offset 2 while the caret
 * sits at offset 8 leaves the caret at 7, and dropping a character that sits
 * after the caret must not move it at all. Without this, filtering a
 * mid-draft paste would jump the caret.
 */
export function sanitizeComposerInput(
  value: string,
  caret: number,
): { text: string; caret: number } {
  if (isTypeable(value)) return { text: value, caret };
  const clamped = Math.max(0, Math.min(caret, value.length));
  const head = value.slice(0, clamped);
  const removedBeforeCaret = head.length - stripUntypeable(head).length;
  return { text: stripUntypeable(value), caret: clamped - removedBeforeCaret };
}
