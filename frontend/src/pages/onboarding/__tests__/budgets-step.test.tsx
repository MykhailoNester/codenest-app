/**
 * Step 06 — the optional budgets step. Its two switches were `div[role=switch]`
 * with hand-rolled key handling before the Deck conversion and are real buttons
 * now, so the ARIA contract and the keyboard activation are pinned here rather
 * than taken on trust: nothing about this step is reachable in review, and a
 * switch that silently stops toggling would ship a workspace with no limit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mockCreateBudget = vi.fn();
const projectsState: { data: { id: number; name: string }[] } = { data: [] };

vi.mock("../../../lib/api", () => ({
  useCreateBudget: () => ({ mutateAsync: mockCreateBudget }),
  useWorkspaceProjects: () => projectsState,
}));

const { BudgetsStep } = await import("../budgets-step");

function renderStep(): { commit: () => Promise<void> } {
  const ref: { fn: () => Promise<void> } = { fn: async () => undefined };
  render(<BudgetsStep registerCommit={(f) => (ref.fn = f)} />);
  return { commit: () => ref.fn() };
}

function wsSwitch(): HTMLButtonElement {
  return screen.getByRole("switch", {
    name: "Workspace monthly limit",
  }) as HTMLButtonElement;
}

function hardStopSwitch(): HTMLButtonElement {
  return screen.getByRole("switch", {
    name: /Hard-stop sessions/,
  }) as HTMLButtonElement;
}

function wsAmount(): HTMLInputElement {
  return screen.getByLabelText(/Monthly limit \(USD\)/) as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateBudget.mockResolvedValue(undefined);
  projectsState.data = [
    { id: 1, name: "alpha" },
    { id: 2, name: "beta" },
  ];
});

afterEach(() => {
  cleanup();
});

describe("BudgetsStep", () => {
  it("starts with the workspace limit on, hard-stop off, and no project rows", () => {
    renderStep();
    expect(wsSwitch().getAttribute("aria-checked")).toBe("true");
    expect(hardStopSwitch().getAttribute("aria-checked")).toBe("false");
    expect(wsAmount().value).toBe("250.00");
    expect(screen.getByText(/No per-project limits yet/)).toBeTruthy();
  });

  it("toggles the workspace switch and disables its amount when off", () => {
    renderStep();
    expect(wsAmount().disabled).toBe(false);

    fireEvent.click(wsSwitch());
    expect(wsSwitch().getAttribute("aria-checked")).toBe("false");
    expect(wsAmount().disabled).toBe(true);

    fireEvent.click(wsSwitch());
    expect(wsSwitch().getAttribute("aria-checked")).toBe("true");
    expect(wsAmount().disabled).toBe(false);
  });

  it("shows switch state as text, so it reads with colour off", () => {
    renderStep();
    expect(wsSwitch().textContent).toBe("on");
    fireEvent.click(wsSwitch());
    expect(wsSwitch().textContent).toBe("off");
  });

  it("keeps both switches keyboard-operable and focusable", () => {
    renderStep();
    // The pre-Deck control was a div[role=switch] carrying tabIndex={0} and its
    // own Enter/Space handler. These are real buttons, so Enter and Space are
    // native — which jsdom does not synthesize, hence the element check rather
    // than a keydown that would pass either way.
    for (const el of [wsSwitch(), hardStopSwitch()]) {
      expect(el.tagName).toBe("BUTTON");
      expect(el.getAttribute("type")).toBe("button");
      expect(el.disabled).toBe(false);
    }
    fireEvent.click(hardStopSwitch());
    expect(hardStopSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("saves the workspace budget with the hard-stop flag on Continue", async () => {
    const { commit } = renderStep();
    fireEvent.change(wsAmount(), { target: { value: "99.50" } });
    fireEvent.click(hardStopSwitch());

    await commit();
    expect(mockCreateBudget).toHaveBeenCalledWith({
      name: "Workspace monthly",
      scope_type: "workspace",
      period: "monthly",
      limit_usd: 99.5,
      hard_stop: true,
    });
  });

  it("writes nothing when the workspace switch is off", async () => {
    const { commit } = renderStep();
    fireEvent.click(wsSwitch());
    await commit();
    expect(mockCreateBudget).not.toHaveBeenCalled();
  });

  it("writes nothing for a zero or unparseable amount", async () => {
    const { commit } = renderStep();
    fireEvent.change(wsAmount(), { target: { value: "0" } });
    await commit();
    expect(mockCreateBudget).not.toHaveBeenCalled();

    fireEvent.change(wsAmount(), { target: { value: "abc" } });
    await commit();
    expect(mockCreateBudget).not.toHaveBeenCalled();
  });

  it("adds a project row pre-filled with the first unused project", () => {
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: /Add project limit/ }));
    const sel = screen.getByLabelText("Project for limit 1") as HTMLSelectElement;
    expect(sel.value).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: /Add project limit/ }));
    expect(
      (screen.getByLabelText("Project for limit 2") as HTMLSelectElement).value,
    ).toBe("2");
  });

  it("stops adding rows once every project has one", () => {
    renderStep();
    const add = (): HTMLButtonElement =>
      screen.getByRole("button", {
        name: /Add project limit/,
      }) as HTMLButtonElement;
    fireEvent.click(add());
    fireEvent.click(add());
    expect(add().disabled).toBe(true);
  });

  it("removes a project row", () => {
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: /Add project limit/ }));
    expect(screen.getByLabelText("Project for limit 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove limit" }));
    expect(screen.queryByLabelText("Project for limit 1")).toBeNull();
    expect(screen.getByText(/No per-project limits yet/)).toBeTruthy();
  });

  it("saves a per-project budget named after its project", async () => {
    const { commit } = renderStep();
    fireEvent.click(screen.getByRole("button", { name: /Add project limit/ }));
    fireEvent.change(screen.getByLabelText("Monthly limit 1 (USD)"), {
      target: { value: "40" },
    });

    await commit();
    expect(mockCreateBudget).toHaveBeenCalledWith({
      name: "alpha monthly",
      scope_type: "project",
      scope_id: 1,
      period: "monthly",
      limit_usd: 40,
    });
  });

  it("skips a project row left without an amount", async () => {
    const { commit } = renderStep();
    fireEvent.click(screen.getByRole("button", { name: /Add project limit/ }));
    // Amount untouched (""), so this row must not be written.
    await commit();
    expect(mockCreateBudget).toHaveBeenCalledTimes(1);
    expect(mockCreateBudget).toHaveBeenCalledWith(
      expect.objectContaining({ scope_type: "workspace" }),
    );
  });
});
