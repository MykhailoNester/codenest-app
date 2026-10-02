/**
 * StartupSplash, on Deck (#283).
 *
 * The splash had no test. It is the first surface of every launch and the
 * only one rendered with no app tree above it, which is exactly the shape of
 * the Deck migration's worst failure: a surface outside the `.deck` root
 * renders every token as nothing and ships a white box. So the root's own
 * `deck` class is asserted here rather than left to the eye.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StartupSplash } from "../startup-splash";

afterEach(cleanup);

describe("StartupSplash", () => {
  it("roots the surface in `.deck` so Deck's tokens resolve", () => {
    const { container } = render(<StartupSplash />);
    // Nothing above this component carries `.deck` — `App.tsx`'s gate renders
    // it instead of the app tree — so the root element must opt in itself.
    const root = container.firstElementChild;
    expect(root?.classList.contains("deck")).toBe(true);
  });

  it("announces itself as a live status", () => {
    render(<StartupSplash />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByLabelText("Starting Codenest")).toBeTruthy();
    // The sweeping bar is gone; the running glyph is what says "live", and it
    // carries a word rather than being a bare CSS ::before.
    expect(screen.getByLabelText("running")).toBeTruthy();
  });

  it("keeps the wordmark and the product mark", () => {
    const { container } = render(<StartupSplash />);
    expect(screen.getByText("Codenest")).toBeTruthy();
    expect(container.querySelector("img")).toBeTruthy();
  });

  it("shows the calm copy and no Retry until the deadline elapses", () => {
    render(<StartupSplash />);
    expect(screen.getByText("Initializing workspace…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("swaps the copy and offers Retry once slow", () => {
    const onRetry = vi.fn();
    render(<StartupSplash slow onRetry={onRetry} />);
    expect(screen.getByText("Still starting the workspace engine…")).toBeTruthy();
    expect(screen.getByText(/nothing is lost/)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("omits Retry when slow with no handler, rather than a dead button", () => {
    render(<StartupSplash slow />);
    expect(screen.getByText("Still starting the workspace engine…")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
