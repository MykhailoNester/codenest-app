/**
 * The onboarding shell: step order, forward/back navigation, the commit
 * handshake each step registers, and the one write that ends the flow.
 *
 * This flow runs exactly once, on a database with `onboarding_completed`
 * unset, so it cannot be clicked through in review — these assertions are the
 * only thing standing between a regression and a broken first run. The seven
 * steps are stubbed so the shell's own behaviour is what is under test;
 * each step's internals have their own suites.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

const mockComplete = vi.fn();
const mockCompleteState = { isPending: false };
vi.mock("../../../lib/api", () => ({
  useCompleteOnboarding: () => ({
    mutateAsync: mockComplete,
    get isPending() {
      return mockCompleteState.isPending;
    },
  }),
}));

/**
 * Every step gets the same stub: it renders its name and registers a commit
 * that the test can make succeed or throw. `stepCommit` is what the current
 * step would do on Continue.
 */
let stepCommit: () => Promise<void> = async () => undefined;

function stubStep(name: string) {
  return function Step({
    registerCommit,
  }: {
    registerCommit: (fn: () => Promise<void>) => void;
  }) {
    registerCommit(() => stepCommit());
    return <div>step-body:{name}</div>;
  };
}

vi.mock("../welcome-step", () => ({ WelcomeStep: stubStep("welcome") }));
vi.mock("../import-first-project-step", () => ({
  ImportFirstProjectStep: stubStep("import"),
}));
vi.mock("../provider-setup-step", () => ({
  ProviderSetupStep: stubStep("provider"),
}));
vi.mock("../agents-review-step", () => ({
  AgentsReviewStep: stubStep("agents"),
}));
vi.mock("../hooks-step", () => ({ HooksStep: stubStep("hooks") }));
vi.mock("../budgets-step", () => ({ BudgetsStep: stubStep("budgets") }));
vi.mock("../done-step", () => ({ DoneStep: stubStep("done") }));

const { OnboardingPage } = await import("../onboarding-page");

/** The flow's steps, in the order the shell must run them. */
const ORDER = [
  "welcome",
  "import",
  "provider",
  "agents",
  "hooks",
  "budgets",
  "done",
];

function body(): string {
  return screen.getByText(/^step-body:/).textContent ?? "";
}

function continueBtn(): HTMLButtonElement {
  // The primary's label changes per step, so it is found by position in the
  // footer rather than by text — the label itself is asserted separately.
  return screen.getByRole("navigation").querySelectorAll("button")[1] as HTMLButtonElement;
}

function backBtn(): HTMLButtonElement {
  return screen.getByRole("button", { name: /Back/ });
}

/**
 * Click Continue and wait for the shell to settle. `handleContinue` awaits the
 * step's commit, so the re-render lands a microtask or more later — waiting on
 * the observable change rather than on a bare tick, which is timing-dependent
 * and passed alone while failing in a full run.
 */
async function advance(expected?: string): Promise<void> {
  const before = body();
  fireEvent.click(continueBtn());
  if (expected !== undefined) {
    await waitFor(() => expect(body()).toBe(`step-body:${expected}`));
    return;
  }
  await waitFor(() => expect(body()).not.toBe(before));
}

/** Click Continue where the step is expected NOT to change. */
async function advanceStaying(): Promise<void> {
  fireEvent.click(continueBtn());
  await waitFor(() => expect(continueBtn().disabled).toBe(false));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCompleteState.isPending = false;
  stepCommit = async () => undefined;
  mockComplete.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("OnboardingPage", () => {
  it("starts on the first step and shows its crumb", () => {
    render(<OnboardingPage />);
    expect(body()).toBe("step-body:welcome");
    // The crumb, not the rail row — both carry the step's name.
    expect(screen.getByText("First-Run Setup").parentElement?.textContent).toBe(
      "First-Run Setup/Welcome",
    );
    expect(screen.getByText(/Step 01 \/ 07/)).toBeTruthy();
  });

  it("runs the seven steps in order", async () => {
    render(<OnboardingPage />);
    for (const [i, name] of ORDER.entries()) {
      expect(body()).toBe(`step-body:${name}`);
      expect(
        screen.getByText(new RegExp(`Step 0${i + 1} / 07`)),
      ).toBeTruthy();
      if (i < ORDER.length - 1) await advance(ORDER[i + 1]);
    }
  });

  it("calls the current step's commit before advancing", async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    stepCommit = commit;
    render(<OnboardingPage />);
    await advance("import");
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("stays on the step when its commit rejects", async () => {
    stepCommit = () => Promise.reject(new Error("validation failed"));
    render(<OnboardingPage />);
    await advanceStaying();
    // The step toasts its own error; the shell's job is only to not advance.
    expect(body()).toBe("step-body:welcome");
    expect(screen.getByText(/Step 01 \/ 07/)).toBeTruthy();
  });

  it("re-enables Continue after a failed commit so the user can retry", async () => {
    stepCommit = () => Promise.reject(new Error("nope"));
    render(<OnboardingPage />);
    await advanceStaying();
    expect(continueBtn().disabled).toBe(false);
  });

  it("disables Back on the first step and enables it from the second on", async () => {
    render(<OnboardingPage />);
    expect(backBtn().disabled).toBe(true);
    await advance("import");
    expect(backBtn().disabled).toBe(false);
  });

  it("goes back a step without running any commit", async () => {
    render(<OnboardingPage />);
    await advance("import");

    const commit = vi.fn().mockResolvedValue(undefined);
    stepCommit = commit;
    fireEvent.click(backBtn());
    expect(body()).toBe("step-body:welcome");
    expect(commit).not.toHaveBeenCalled();
  });

  it("labels the primary per position in the flow", async () => {
    render(<OnboardingPage />);
    expect(continueBtn().textContent).toBe("Continue →");
    for (let i = 1; i <= 5; i++) await advance(ORDER[i]);
    // Second to last (budgets).
    expect(body()).toBe("step-body:budgets");
    expect(continueBtn().textContent).toBe("Finish →");
    await advance("done");
    expect(continueBtn().textContent).toBe("✓ Enter Command Center");
  });

  it("writes onboarding_completed and enters the command center on the last step", async () => {
    render(<OnboardingPage />);
    for (let i = 1; i <= 6; i++) await advance(ORDER[i]);
    expect(body()).toBe("step-body:done");

    fireEvent.click(continueBtn());
    await waitFor(() => expect(mockComplete).toHaveBeenCalledTimes(1));
    expect(mockNavigate).toHaveBeenCalledWith("/command", { replace: true });
  });

  it("does not navigate when the completion write fails", async () => {
    mockComplete.mockRejectedValue(new Error("sidecar down"));
    render(<OnboardingPage />);
    for (let i = 1; i <= 6; i++) await advance(ORDER[i]);
    fireEvent.click(continueBtn());
    await waitFor(() => expect(mockComplete).toHaveBeenCalledTimes(1));
    // Navigating anyway would bounce back through OnboardingGate; staying put
    // leaves the button live for a retry.
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(continueBtn().disabled).toBe(false);
  });

  it("lets the rail jump back to a reached step but not forward past it", async () => {
    render(<OnboardingPage />);
    await advance("import");
    await advance("provider");

    // Already reached — clickable.
    fireEvent.click(screen.getByRole("button", { name: /Welcome/ }));
    expect(body()).toBe("step-body:welcome");

    // Never reached — the rail must not offer it.
    expect(
      (screen.getByRole("button", { name: /Connect hooks/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // Reached earlier, so still reachable after going back.
    expect(
      (screen.getByRole("button", { name: /AI provider/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("disables both footer buttons while the completion write is in flight", () => {
    mockCompleteState.isPending = true;
    render(<OnboardingPage />);
    expect(continueBtn().disabled).toBe(true);
    expect(continueBtn().textContent).toBe("Working…");
    expect(backBtn().disabled).toBe(true);
  });
});
