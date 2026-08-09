// Guards the parallel-runs prompt's OS-autocorrect opt-out. This one prompt
// is fanned out verbatim to N agents in N git worktrees, so a substituted
// word here is acted on N times.

import type { ReactNode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ParallelRunsPage } from "../parallel-runs";

vi.mock("../../components/layout/shell", () => ({
  Shell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../lib/api", () => ({
  useProjects: () => ({
    data: [{ id: 1, name: "Demo", path: "/tmp/demo" }],
  }),
  useParallelRuns: () => ({ data: { runs: [] }, isPending: false }),
  useCreateParallelRun: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteParallelRun: () => ({ mutate: vi.fn(), isPending: false }),
  useParallelRun: vi.fn(),
  useParallelAttemptDiff: vi.fn(),
  useMergeParallelAttempt: vi.fn(),
}));

function expectOptedOut(el: Element): void {
  expect(el.getAttribute("autocorrect")).toBe("off");
  expect(el.getAttribute("autocapitalize")).toBe("off");
  expect(el.getAttribute("spellcheck")).toBe("false");
  expect(el.getAttribute("autocomplete")).toBe("off");
}

afterEach(() => {
  cleanup();
});

describe("parallel-runs prompt autocorrect opt-out", () => {
  it("the parallel-run prompt opts out of OS autocorrect, capitalisation, spellcheck and autofill", () => {
    render(<ParallelRunsPage />);

    expectOptedOut(screen.getByLabelText("Prompt (describe the task)"));
  });

  it("renders the opted-out prompt with no runs yet", () => {
    render(<ParallelRunsPage />);

    const input = screen.getByLabelText("Prompt (describe the task)");
    expect(input).toBeTruthy();
    expectOptedOut(input);
  });
});
