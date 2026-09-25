import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { RootErrorBoundary } from "../root-error-boundary";

afterEach(cleanup);

function Boom({ fail }: { fail: boolean }) {
  if (fail) throw new Error("kaboom from a child");
  return <p>rendered fine</p>;
}

describe("RootErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <RootErrorBoundary>
        <Boom fail={false} />
      </RootErrorBoundary>,
    );
    expect(screen.getByText("rendered fine")).toBeTruthy();
  });

  it("shows the error instead of a blank screen", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <RootErrorBoundary>
        <Boom fail={true} />
      </RootErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/kaboom from a child/)).toBeTruthy();
    spy.mockRestore();
  });

  it("recovers when the cause is gone", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <RootErrorBoundary>
        <Boom fail={true} />
      </RootErrorBoundary>,
    );
    rerender(
      <RootErrorBoundary>
        <Boom fail={false} />
      </RootErrorBoundary>,
    );
    fireEvent.click(screen.getByText("Try again"));
    expect(screen.getByText("rendered fine")).toBeTruthy();
    spy.mockRestore();
  });
});
