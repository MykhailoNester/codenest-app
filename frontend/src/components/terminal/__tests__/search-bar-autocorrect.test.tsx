// Guards the terminal find bar's OS-autocorrect opt-out. A find query is
// matched literally, or compiled as a regex when the `.*` toggle is on, so a
// substituted character there changes or invalidates the pattern.

import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SearchBar } from "../search-bar";

function expectOptedOut(el: Element): void {
  expect(el.getAttribute("autocorrect")).toBe("off");
  expect(el.getAttribute("autocapitalize")).toBe("off");
  expect(el.getAttribute("spellcheck")).toBe("false");
  expect(el.getAttribute("autocomplete")).toBe("off");
}

afterEach(() => {
  cleanup();
});

describe("terminal find bar autocorrect opt-out", () => {
  it("the find field opts out of OS autocorrect, capitalisation, spellcheck and autofill", () => {
    render(<SearchBar searchAddon={null} onClose={() => undefined} />);

    expectOptedOut(screen.getByLabelText("Search terminal"));
  });

  it("renders with no search addon attached", () => {
    render(<SearchBar searchAddon={null} onClose={() => undefined} />);

    const input = screen.getByLabelText("Search terminal");
    expect(input).toBeTruthy();
    expectOptedOut(input);
  });
});
